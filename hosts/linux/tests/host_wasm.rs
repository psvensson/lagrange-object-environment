//! Generic WebAssembly host boundary proofs, independent of application ABIs.
//! Tiny binary fixtures below expose the exact operations being tested; there
//! is no source-language compiler, Node runtime or browser in this oracle.
use lagrange_host_linux::js_env::{
    actor::{JsEnvActor, ShutdownOutcome},
    host_wasm, EmbeddedLoader,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn actor() -> JsEnvActor {
    JsEnvActor::spawn(EmbeddedLoader::new()).expect("actor")
}
async fn eval(a: &JsEnvActor, source: &str) -> serde_json::Value {
    let result = a.eval_async(source).await.expect("guest evaluation");
    serde_json::from_str(&result).expect("JSON result")
}
async fn clean(a: JsEnvActor) {
    assert_eq!(a.shutdown().await, ShutdownOutcome::Clean);
}
async fn stores(a: &JsEnvActor) -> usize {
    let count = Arc::new(AtomicUsize::new(usize::MAX));
    let target = count.clone();
    a.with_context(move |ctx| {
        ctx.run_gc();
        target.store(host_wasm::live_store_count(), Ordering::SeqCst);
        Ok(())
    })
    .await
    .unwrap();
    count.load(Ordering::SeqCst)
}
fn leb(mut n: u32) -> Vec<u8> {
    let mut out = vec![];
    loop {
        let b = (n & 127) as u8;
        n >>= 7;
        out.push(b | if n == 0 { 0 } else { 128 });
        if n == 0 {
            return out;
        }
    }
}
fn name(s: &str) -> Vec<u8> {
    let mut b = leb(s.len() as u32);
    b.extend(s.as_bytes());
    b
}
fn section(id: u8, payload: Vec<u8>, out: &mut Vec<u8>) {
    out.push(id);
    out.extend(leb(payload.len() as u32));
    out.extend(payload);
}
fn bytes_literal(bytes: &[u8]) -> String {
    format!("new Uint8Array({})", serde_json::to_string(bytes).unwrap())
}
// Types, function imports, function bodies, exports and optional raw sections.
fn binary(
    types: &[(&[u8], &[u8])],
    imports: &[(&str, &str, u32)],
    funcs: &[(u32, &[u8])],
    exports: &[(&str, u32)],
    extra: &[(u8, Vec<u8>)],
) -> Vec<u8> {
    let mut out = b"\0asm\x01\0\0\0".to_vec();
    let mut sections = vec![];
    let mut t = leb(types.len() as u32);
    for (params, results) in types {
        t.push(0x60);
        t.extend(leb(params.len() as u32));
        t.extend(*params);
        t.extend(leb(results.len() as u32));
        t.extend(*results);
    }
    sections.push((1, t));
    if !imports.is_empty() {
        let mut i = leb(imports.len() as u32);
        for (module, field, ty) in imports {
            i.extend(name(module));
            i.extend(name(field));
            i.push(0);
            i.extend(leb(*ty));
        }
        sections.push((2, i));
    }
    if !funcs.is_empty() {
        let mut f = leb(funcs.len() as u32);
        let mut c = leb(funcs.len() as u32);
        for (ty, code) in funcs {
            f.extend(leb(*ty));
            c.extend(leb(code.len() as u32 + 1));
            c.push(0);
            c.extend(*code);
        }
        sections.push((3, f));
        sections.push((10, c));
    }
    if !exports.is_empty() {
        let mut e = leb(exports.len() as u32);
        for (field, index) in exports {
            e.extend(name(field));
            e.push(0);
            e.extend(leb(*index));
        }
        sections.push((7, e));
    }
    sections.extend(extra.iter().cloned());
    sections.sort_by_key(|(id, _)| *id);
    for (id, payload) in sections {
        section(id, payload, &mut out);
    }
    out
}
fn unary() -> String {
    bytes_literal(&binary(
        &[(&[0x7f], &[0x7f])],
        &[],
        &[(0, &[0x20, 0, 0x0b])],
        &[("run", 0)],
        &[],
    ))
}
fn callback() -> String {
    bytes_literal(&binary(
        &[(&[0x7f], &[0x7f])],
        &[("env", "call", 0)],
        &[(0, &[0x20, 0, 0x10, 0, 0x0b])],
        &[("run", 1)],
        &[],
    ))
}
fn instantiate(bytes: &str) -> String {
    format!("new WebAssembly.Instance(new WebAssembly.Module({bytes}))")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn constructors_async_surface_view_bytes_and_unforgeable_brands() {
    let a = actor();
    let got = eval(&a, &format!(r#"(async () => {{
      const bytes = {}; const padded = new Uint8Array(bytes.length + 4); padded.set(bytes, 2);
      const inputs = [bytes.buffer, padded.subarray(2, 2 + bytes.length),
        new DataView(padded.buffer, 2, bytes.length)];
      const answers = inputs.map(b => new WebAssembly.Instance(new WebAssembly.Module(b)).exports.run(42));
      const promise = WebAssembly.compile(bytes); const m = await promise;
      const ip = WebAssembly.instantiate(m); const instance = await ip;
      const failures = [];
      for (const f of [() => new WebAssembly.Module([0,97,115,109]),
        () => new WebAssembly.Instance(Object.create(WebAssembly.Module.prototype)),
        () => Object.getOwnPropertyDescriptor(WebAssembly.Instance.prototype, 'exports').get.call({{}}),
        () => WebAssembly.Module(bytes), () => WebAssembly.Instance(m)]) {{
        try {{ f(); failures.push(false); }} catch(e) {{ failures.push(e instanceof TypeError); }}
      }}
      let refusedBytes = false;
      try {{ await WebAssembly.instantiate(bytes); }} catch(e) {{ refusedBytes = e instanceof TypeError; }}
      return {{answers, promises: promise instanceof Promise && ip instanceof Promise,
        module: m instanceof WebAssembly.Module, instance: instance instanceof WebAssembly.Instance,
        value: instance.exports.run(43), failures, refusedBytes,
        subset: ['Memory','Table','Global','compileStreaming','instantiateStreaming'].every(k => WebAssembly[k] === undefined)}};
    }})()"#, unary())).await;
    assert_eq!(got["answers"], serde_json::json!([42, 42, 42]));
    for k in ["promises", "module", "instance", "refusedBytes", "subset"] {
        assert_eq!(got[k], true, "{k}");
    }
    assert_eq!(got["value"], 43);
    assert_eq!(
        got["failures"],
        serde_json::json!([true, true, true, true, true])
    );
    clean(a).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compile_errors_refuse_invalid_large_and_unsupported_modules() {
    let a = actor();
    let mut cases = vec![
        "new Uint8Array([0,1,2])".to_string(),
        "new TextEncoder().encode('(module)')".into(),
    ];
    for ty in [0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f] {
        for (params, results) in [(vec![ty], vec![]), (vec![], vec![ty])] {
            cases.push(bytes_literal(&binary(
                &[(&params, &results)],
                &[],
                &[(0, &[0, 0x0b])],
                &[("run", 0)],
                &[],
            )));
        }
    }
    cases.push(bytes_literal(&binary(
        &[(&[], &[0x7f, 0x7f])],
        &[],
        &[(0, &[0, 0x0b])],
        &[("run", 0)],
        &[],
    )));
    cases.push(bytes_literal(&binary(
        &[(&[0x7e], &[])],
        &[("env", "bad", 0)],
        &[],
        &[],
        &[],
    )));
    // Internal, unexported memory/table still exceed the supported profile.
    for extra in [(5, vec![1, 0, 1]), (4, vec![1, 0x70, 0, 1])] {
        cases.push(bytes_literal(&binary(&[], &[], &[], &[], &[extra])));
    }
    // Non-function imports, including otherwise hidden imported globals.
    for desc in [vec![2, 0, 1], vec![1, 0x70, 0, 1], vec![3, 0x7f, 0]] {
        let mut import = vec![1];
        import.extend(name("env"));
        import.extend(name("bad"));
        import.extend(desc);
        cases.push(bytes_literal(&binary(&[], &[], &[], &[], &[(2, import)])));
    }
    let mut export = vec![1];
    export.extend(name("state"));
    export.extend([3, 0]);
    cases.push(bytes_literal(&binary(
        &[],
        &[],
        &[],
        &[],
        &[(6, vec![1, 0x7f, 0, 0x41, 0, 0x0b]), (7, export)],
    )));
    for (index, bytes) in cases.iter().enumerate() {
        assert_eq!(eval(&a, &format!(r#"(() => {{ try {{ new WebAssembly.Module({bytes}); return false; }}
          catch(e) {{ return e instanceof WebAssembly.CompileError && e.name === 'CompileError'; }} }})()"#)).await, true, "compile case {index}");
    }
    assert_eq!(
        eval(&a, &format!("{}.exports.run(9)", instantiate(&unary()))).await,
        9
    );
    clean(a).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn module_byte_limit_distinguishes_valid_binary_at_and_above_limit() {
    let a = actor();
    let got = eval(
        &a,
        r#"(() => {
      // A legal empty-name custom section pads an otherwise valid empty module.
      // Both payload lengths need four LEB bytes: header(8)+id(1)+length(4).
      function padded(size) {
        const bytes = new Uint8Array(size);
        bytes.set([0,97,115,109,1,0,0,0]);
        const length = [];
        for (let n = size - 13;; n >>>= 7) {
          length.push((n & 127) | (n > 127 ? 128 : 0));
          if (n <= 127) break;
        }
        if (length.length !== 4) throw new Error('fixture length encoding');
        bytes.set([0, ...length, 0], 8);
        return bytes;
      }
      const atLimit = new WebAssembly.Module(padded(8*1024*1024));
      let overLimit = false;
      try { new WebAssembly.Module(padded(8*1024*1024+1)); }
      catch(e) { overLimit = e instanceof WebAssembly.CompileError && /8 MiB/.test(e.message); }
      return {atLimit: atLimit instanceof WebAssembly.Module, overLimit};
    })()"#,
    )
    .await;
    assert_eq!(got, serde_json::json!({"atLimit":true,"overLimit":true}));
    clean(a).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn i32_conversion_uses_to_int32_in_both_directions_and_void_ignores_result() {
    let a = actor();
    let void = bytes_literal(&binary(
        &[(&[], &[])],
        &[("env", "call", 0)],
        &[(0, &[0x10, 0, 0x0b])],
        &[("run", 1)],
        &[],
    ));
    let got = eval(&a, &format!(r#"(() => {{
      const run = {}.exports.run;
      const values = [undefined, null, NaN, Infinity, -Infinity, 2.9, -2.9, 4294967297, 2147483648, '12', true];
      const converted = values.map(x => run(x));
      let big = false, symbol = false;
      try {{ run(1n); }} catch(e) {{ big = e instanceof TypeError; }}
      try {{ run(Symbol()); }} catch(e) {{ symbol = e instanceof TypeError; }}
      let returned = 4294967298;
      const imported = new WebAssembly.Instance(new WebAssembly.Module({}), {{env:{{call:x => returned}}}}).exports.run;
      const importValue = imported(0); returned = 2n;
      let importBig = false; try {{ imported(0); }} catch(e) {{ importBig = e instanceof TypeError; }}
      const v = new WebAssembly.Instance(new WebAssembly.Module({void}), {{env:{{call:() => 3n}}}}).exports.run;
      return {{converted, big, symbol, importValue, importBig, void: v() === undefined, missing: run(), extras: run(2, 1n)}};
    }})()"#, instantiate(&unary()), callback())).await;
    assert_eq!(
        got["converted"],
        serde_json::json!([0, 0, 0, 0, 0, 2, -2, 1, -2147483648, 12, 1])
    );
    for k in ["big", "symbol", "importBig", "void"] {
        assert_eq!(got[k], true, "{k}");
    }
    assert_eq!(got["importValue"], 2);
    assert_eq!(got["missing"], 0);
    assert_eq!(got["extras"], 2);
    clean(a).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn imports_snapshot_once_report_link_errors_and_preserve_thrown_identity() {
    let a = actor();
    let got = eval(&a, &format!(r#"(() => {{
      const module = new WebAssembly.Module({}); const failures = [];
      for (const imports of [undefined, {{}}, {{env:{{}}}}, {{env:{{call:1}}}}]) {{
        try {{ new WebAssembly.Instance(module, imports); failures.push(false); }}
        catch(e) {{ failures.push(e instanceof WebAssembly.LinkError && e.name === 'LinkError'); }}
      }}
      let reads = 0, nsReads = 0, capturedThis = 1;
      const env = {{get call() {{ reads++; return function(x) {{ 'use strict'; capturedThis = this; return x + 1; }}; }}}};
      const imports = {{get env() {{ nsReads++; return env; }}}};
      const instance = new WebAssembly.Instance(module, imports);
      Object.defineProperty(env, 'call', {{value: () => 99}});
      const answer = instance.exports.run(4);
      const objects = [{{kind:'marker'}}, new Error('marker'), undefined, null, Symbol('marker'), 123];
      const identity = objects.map(marker => {{
        const f = new WebAssembly.Instance(module, {{env:{{call:() => {{throw marker;}}}}}}).exports.run;
        try {{f(0); return false;}} catch(e) {{return e === marker;}}
      }});
      const marker = {{getter:true}}; let getterIdentity = false;
      try {{new WebAssembly.Instance(module, {{env:{{get call() {{throw marker;}}}}}});}}
      catch(e) {{getterIdentity = e === marker;}}
      return {{failures, reads, nsReads, answer, thisUndefined: capturedThis === undefined, identity, getterIdentity}};
    }})()"#, callback())).await;
    assert_eq!(got["failures"], serde_json::json!([true, true, true, true]));
    assert_eq!(got["reads"], 1);
    assert_eq!(got["nsReads"], 1);
    assert_eq!(got["answer"], 5);
    assert_eq!(got["thisUndefined"], true);
    assert_eq!(got["getterIdentity"], true);
    assert_eq!(
        got["identity"],
        serde_json::json!([true, true, true, true, true, true])
    );
    clean(a).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trap_and_start_and_export_fuel_are_bounded_with_clean_recovery() {
    let a = actor();
    let trap = bytes_literal(&binary(
        &[(&[], &[])],
        &[],
        &[(0, &[0, 0x0b])],
        &[("run", 0)],
        &[],
    ));
    let looping = &[0x03, 0x40, 0x0c, 0, 0x0b, 0x0b];
    let loop_export = bytes_literal(&binary(
        &[(&[], &[])],
        &[],
        &[(0, looping)],
        &[("run", 0)],
        &[],
    ));
    let loop_start = bytes_literal(&binary(
        &[(&[], &[])],
        &[],
        &[(0, looping)],
        &[],
        &[(8, vec![0])],
    ));
    for expr in [
        format!("{}.exports.run()", instantiate(&trap)),
        format!("{}.exports.run()", instantiate(&loop_export)),
        instantiate(&loop_start),
    ] {
        assert_eq!(eval(&a,&format!(r#"(() => {{try {{{expr};return false;}} catch(e) {{return e instanceof WebAssembly.RuntimeError && e.name === 'RuntimeError';}}}})()"#)).await,true);
    }
    assert_eq!(
        stores(&a).await,
        0,
        "failed instantiation/calls must not leak stores"
    );
    assert_eq!(
        eval(&a, &format!("{}.exports.run(5)", instantiate(&unary()))).await,
        5
    );
    clean(a).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_invokes_imports_and_keeps_arbitrary_js_throw() {
    let a = actor();
    let start = bytes_literal(&binary(
        &[(&[], &[])],
        &[("env", "call", 0)],
        &[(0, &[0x10, 0, 0x0b])],
        &[],
        &[(8, vec![1])],
    ));
    let got = eval(
        &a,
        &format!(
            r#"(() => {{
      const module = new WebAssembly.Module({start}); let calls = 0;
      new WebAssembly.Instance(module, {{env:{{call:()=>{{calls++;}}}}}});
      const marker = {{start:true}}; let identical = false;
      try {{new WebAssembly.Instance(module, {{env:{{call:()=>{{throw marker;}}}}}});}}
      catch(e) {{identical = e === marker;}}
      return {{calls,identical}};
    }})()"#
        ),
    )
    .await;
    assert_eq!(got, serde_json::json!({"calls":1,"identical":true}));
    assert_eq!(stores(&a).await, 0);
    clean(a).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nested_different_instances_restore_scope_same_instance_is_refused() {
    let a = actor();
    // Calls the import twice: the second callback detects a lost outer scope.
    let twice = bytes_literal(&binary(
        &[(&[0x7f], &[0x7f])],
        &[("env", "call", 0)],
        &[(0, &[0x20, 0, 0x10, 0, 0x10, 0, 0x0b])],
        &[("run", 1)],
        &[],
    ));
    let got = eval(&a,&format!(r#"(() => {{
      const module = new WebAssembly.Module({});
      const inner = new WebAssembly.Instance(module, {{env:{{call:x => x + 10}}}});
      let outerCalls = 0;
      const outer = new WebAssembly.Instance(new WebAssembly.Module({twice}), {{env:{{call:x => {{outerCalls++; return inner.exports.run(x) + 1;}}}}}});
      const nested = outer.exports.run(1);
      let recursive; recursive = new WebAssembly.Instance(module, {{env:{{call:x => recursive.exports.run(x)}}}});
      let refused = false; try {{recursive.exports.run(1);}} catch(e) {{refused = e instanceof WebAssembly.RuntimeError && /re-entry/.test(e.message);}}
      return {{nested,outerCalls,refused,recovered:outer.exports.run(2)}};
    }})()"#,callback())).await;
    assert_eq!(
        got,
        serde_json::json!({"nested":23,"outerCalls":2,"refused":true,"recovered":24})
    );
    clean(a).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_globals_are_per_instance_and_every_export_entry_refuels() {
    let a = actor();
    let counter = bytes_literal(&binary(
        &[(&[], &[0x7f])],
        &[],
        &[(0, &[0x23, 0, 0x41, 1, 0x6a, 0x24, 0, 0x23, 0, 0x0b])],
        &[("run", 0)],
        &[(6, vec![1, 0x7f, 1, 0x41, 0, 0x0b])],
    ));
    let got = eval(
        &a,
        &format!(
            r#"(() => {{
      const module = new WebAssembly.Module({counter});
      const a = new WebAssembly.Instance(module), b = new WebAssembly.Instance(module);
      const first = [a.exports.run(),a.exports.run(),b.exports.run()];
      for (let i=0;i<250000;i++) a.exports.run();
      return {{first, last:a.exports.run(), independent:b.exports.run()}};
    }})()"#
        ),
    )
    .await;
    assert_eq!(
        got,
        serde_json::json!({"first":[1,2,1],"last":250003,"independent":2})
    );
    clean(a).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exports_retain_imports_after_wrapper_gc_then_release_store_including_cycles() {
    let a = actor();
    assert_eq!(stores(&a).await, 0);
    eval(
        &a,
        &format!(
            r#"(() => {{
      let module = new WebAssembly.Module({});
      let instance = new WebAssembly.Instance(module, {{env:{{call:x => x+7}}}});
      globalThis.retained = instance.exports.run;
      module = null; instance = null;
      return true;
    }})()"#,
            callback()
        ),
    )
    .await;
    assert_eq!(stores(&a).await, 1);
    assert_eq!(
        eval(&a, "retained(5)").await,
        12,
        "retained export must keep import callback alive"
    );
    eval(&a, "retained = null; true").await;
    assert_eq!(
        stores(&a).await,
        0,
        "last export collection must dispose native Store"
    );
    // A callback cycle is traceable through JS WeakMap ephemerons; a Rust
    // capture of the import would make this Store permanently unreachable/leaked.
    eval(&a,&format!(r#"(() => {{
      let instance;
      instance = new WebAssembly.Instance(new WebAssembly.Module({}), {{env:{{call:x => instance ? x : 0}}}});
      return instance.exports.run(4);
    }})()"#,callback())).await;
    assert_eq!(
        stores(&a).await,
        0,
        "cyclic import/instance/export graph must be collectable"
    );
    clean(a).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actors_have_isolated_scopes_and_drop_live_exports_on_shutdown() {
    let a = actor();
    let b = actor();
    for (actor, increment) in [(&a, 3), (&b, 9)] {
        eval(
            actor,
            &format!(
                r#"globalThis.run = new WebAssembly.Instance(new WebAssembly.Module({}),
          {{env:{{call:x=>x+({increment})}}}}).exports.run; true"#,
                callback()
            ),
        )
        .await;
    }
    assert_eq!(eval(&a, "run(1)").await, 4);
    assert_eq!(eval(&b, "run(1)").await, 10);
    assert_eq!(stores(&a).await, 1);
    assert_eq!(stores(&b).await, 1);
    clean(a).await;
    assert_eq!(eval(&b, "run(2)").await, 11);
    clean(b).await;
}
