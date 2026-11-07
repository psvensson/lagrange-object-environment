//! Generic, deliberately bounded WebAssembly host realization (Bead sl1).
//!
//! This is the sole QuickJS <-> Wasmtime interaction owner. The public surface
//! is installed by `host-wasm.js`: binary Module/Instance constructors and
//! Promise-returning compile/instantiate(Module), with i32 function boundaries.
//! Wasmtime owns execution, private globals and validation. No memory/table or
//! non-function import/export is admitted. Fuel bounds Wasm instructions only,
//! not compilation, JavaScript import bodies, or an entire nested invocation.
//!
//! SAFETY/GC: rquickjs native Function closures have an empty Trace. Every
//! captured value below is therefore Rust-only. JS wrappers retain imports in
//! ordinary traced closures and pass a dispatcher on EACH call. The scoped
//! TLS borrows that call's dispatcher; static Wasmtime callbacks capture only
//! import indices. No stored Ctx, JS value, runtime lock re-entry or lifetime
//! extension is needed. Re-entry into another instance nests/restores scope;
//! the same instance is explicitly refused by try_borrow_mut.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use rquickjs::function::Constructor;
use rquickjs::{Array, Ctx, Error, Exception, Function, Object, Result, TypedArray, Value};
use scoped_tls_hkt::scoped_thread_local;
use wasmtime::{
    Config, Engine, Extern, ExternType, Func, FuncType, Instance, Module, Store, StoreLimits,
    StoreLimitsBuilder, Val, ValType,
};

const MAX_MODULE_BYTES: usize = 8 * 1024 * 1024;
const FUEL_PER_ENTRY: u64 = 1_000_000;

scoped_thread_local!(static DISPATCH: for<'a> &'a (dyn Fn(usize, &[i32]) -> wasmtime::Result<i32> + 'a));

thread_local! {
    static LIVE_STORES: Cell<usize> = const { Cell::new(0) };
}

/// Owner-thread diagnostic for lifecycle proofs. Not exposed to JavaScript.
pub fn live_store_count() -> usize {
    LIVE_STORES.with(Cell::get)
}

struct StoreData {
    limits: StoreLimits,
}

impl StoreData {
    fn new() -> Self {
        LIVE_STORES.with(|n| n.set(n.get() + 1));
        Self {
            limits: StoreLimitsBuilder::new()
                .instances(1)
                .memories(0)
                .tables(0)
                .memory_size(0)
                .table_elements(0)
                .build(),
        }
    }
}

impl Drop for StoreData {
    fn drop(&mut self) {
        LIVE_STORES.with(|n| n.set(n.get() - 1));
    }
}

fn typed_error<'js>(ctx: &Ctx<'js>, class: &Constructor<'js>, message: String) -> Error {
    match class.construct::<_, Value>((message,)) {
        Ok(value) => ctx.throw(value),
        Err(error) => error,
    }
}

fn public_function(ty: ExternType) -> wasmtime::Result<FuncType> {
    let ExternType::Func(ty) = ty else {
        wasmtime::bail!("only function imports and exports are supported");
    };
    if !ty.params().all(|t| matches!(t, ValType::I32))
        || !ty.results().all(|t| matches!(t, ValType::I32))
        || ty.results().len() > 1
    {
        wasmtime::bail!("only i32 function parameters and zero or one i32 result are supported");
    }
    Ok(ty)
}

/// Borrows JS handles only for this synchronous entry. A caught JS value lives
/// on this stack, never in the Store or the native Function closure.
fn with_dispatch<'js, T>(
    ctx: &Ctx<'js>,
    dispatcher: Function<'js>,
    error_class: &Constructor<'js>,
    body: impl FnOnce() -> wasmtime::Result<T>,
) -> Result<T> {
    let thrown = RefCell::new(None);
    let dispatch = |index: usize, args: &[i32]| -> wasmtime::Result<i32> {
        match dispatcher.call::<_, i32>((index, args.to_vec())) {
            Ok(value) => Ok(value),
            Err(error) => {
                // Keep arbitrary thrown values, including undefined, by identity.
                let value = if matches!(error, Error::Exception) {
                    ctx.catch()
                } else {
                    Exception::throw_message(ctx, &error.to_string());
                    ctx.catch()
                };
                *thrown.borrow_mut() = Some(value);
                wasmtime::bail!("JavaScript import threw")
            }
        }
    };
    let result = DISPATCH.set(&dispatch, body);
    if let Some(value) = thrown.into_inner() {
        return Err(ctx.throw(value));
    }
    result.map_err(|error| typed_error(ctx, error_class, format!("{error:#}")))
}

fn instantiate<'js>(
    ctx: Ctx<'js>,
    module: &Module,
    dispatcher: Function<'js>,
    error_class: Constructor<'js>,
) -> Result<Array<'js>> {
    let mut store = Store::new(module.engine(), StoreData::new());
    store.limiter(|data| &mut data.limits);
    let (instance, exports) = with_dispatch(&ctx, dispatcher, &error_class, || {
        store.set_fuel(FUEL_PER_ENTRY)?;
        let mut imports = Vec::new();
        for (index, import) in module.imports().enumerate() {
            let ty = public_function(import.ty())?;
            let function = Func::try_new(&mut store, ty, move |_caller, params, results| {
                let args: Vec<i32> = params
                    .iter()
                    .map(|v| v.i32().expect("validated i32 type"))
                    .collect();
                wasmtime::ensure!(DISPATCH.is_set(), "WebAssembly import outside a call scope");
                let value = DISPATCH.with(|dispatch| dispatch(index, &args))?;
                if let Some(result) = results.first_mut() {
                    *result = Val::I32(value);
                }
                Ok(())
            })?;
            imports.push(Extern::Func(function));
        }
        let instance = Instance::new(&mut store, module, &imports)?;
        let exports: Vec<(Func, usize)> = module
            .exports()
            .map(|export| {
                let function = instance
                    .get_func(&mut store, export.name())
                    .expect("validated function export");
                let results = function.ty(&store).results().len();
                (function, results)
            })
            .collect();
        Ok((instance, exports))
    })?;
    // Instance/Func handles are Store-owned. Each native closure retains the
    // same Store; dropping the last closure drops it, with no global registry.
    let state = Rc::new(RefCell::new((store, instance)));
    let out = Array::new(ctx.clone())?;
    for (index, (function, result_count)) in exports.into_iter().enumerate() {
        let state = state.clone();
        let call = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  args: Vec<i32>,
                  dispatcher: Function<'js>,
                  error_class: Constructor<'js>|
                  -> Result<Value<'js>> {
                let mut state = state.try_borrow_mut().map_err(|_| {
                    typed_error(
                        &ctx,
                        &error_class,
                        "same-instance WebAssembly re-entry is unsupported".into(),
                    )
                })?;
                let params: Vec<Val> = args.into_iter().map(Val::I32).collect();
                let mut results = vec![Val::I32(0); result_count];
                with_dispatch(&ctx, dispatcher, &error_class, || {
                    state.0.set_fuel(FUEL_PER_ENTRY)?;
                    function.call(&mut state.0, &params, &mut results)
                })?;
                Ok(match results.first() {
                    Some(Val::I32(value)) => Value::new_int(ctx, *value),
                    None => Value::new_undefined(ctx),
                    _ => unreachable!("validated i32 result"),
                })
            },
        )?;
        out.set(index, call)?;
    }
    Ok(out)
}

fn compile<'js>(
    ctx: Ctx<'js>,
    engine: &Engine,
    bytes: TypedArray<'js, u8>,
    error_class: Constructor<'js>,
) -> Result<Object<'js>> {
    let bytes = bytes
        .as_bytes()
        .ok_or_else(|| Exception::throw_type(&ctx, "detached module bytes"))?;
    if bytes.len() > MAX_MODULE_BYTES {
        return Err(typed_error(
            &ctx,
            &error_class,
            "module exceeds the 8 MiB host limit".into(),
        ));
    }
    let module = Module::from_binary(engine, bytes)
        .map_err(|e| typed_error(&ctx, &error_class, format!("{e:#}")))?;
    let resources = module.resources_required();
    if resources.num_memories != 0 || resources.num_tables != 0 {
        return Err(typed_error(
            &ctx,
            &error_class,
            "module memory and tables are unsupported".into(),
        ));
    }
    let imports = Array::new(ctx.clone())?;
    for (index, import) in module.imports().enumerate() {
        let ty = public_function(import.ty())
            .map_err(|e| typed_error(&ctx, &error_class, e.to_string()))?;
        let entry = Object::new(ctx.clone())?;
        entry.set("module", import.module())?;
        entry.set("name", import.name())?;
        entry.set("results", ty.results().len())?;
        imports.set(index, entry)?;
    }
    let exports = Array::new(ctx.clone())?;
    for (index, export) in module.exports().enumerate() {
        let ty = public_function(export.ty())
            .map_err(|e| typed_error(&ctx, &error_class, e.to_string()))?;
        let entry = Object::new(ctx.clone())?;
        entry.set("name", export.name())?;
        entry.set("params", ty.params().len())?;
        exports.set(index, entry)?;
    }
    let out = Object::new(ctx.clone())?;
    out.set("imports", imports)?;
    out.set("exports", exports)?;
    out.set(
        "instantiate",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, dispatcher: Function<'js>, error_class: Constructor<'js>| {
                instantiate(ctx, &module, dispatcher, error_class)
            },
        )?,
    )?;
    Ok(out)
}

pub(crate) fn install_host_wasm<'js>(ctx: &Ctx<'js>) -> Result<()> {
    let mut config = Config::new();
    config.consume_fuel(true).parallel_compilation(false);
    let engine = Engine::new(&config)
        .map_err(|e| Exception::throw_message(ctx, &format!("WebAssembly engine: {e}")))?;
    let native_compile = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, bytes: TypedArray<'js, u8>, error_class: Constructor<'js>| {
            compile(ctx, &engine, bytes, error_class)
        },
    )?;
    let install: Function = ctx.eval(include_str!("host-wasm.js"))?;
    install.call((native_compile,))
}
