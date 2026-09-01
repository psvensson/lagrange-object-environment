//! 3zb-A: bounded Environment-side rquickjs embed (runtime shell ONLY).
//!
//! This module hosts the EXISTING checked-in Environment ESM core (`src/*.js`,
//! unchanged — NO native source fork) inside a native rquickjs (QuickJS) runtime
//! in the Linux client. It is the embedded-JS-runtime host-port owner (see
//! `docs/ownership.md`, "Environment JS <-> embedded JS runtime host").
//!
//! # Scope of THIS slice (3zb-A slice 1 — runtime shell)
//!
//! Only the substrate that can HOST JS, with NO Environment semantics wired:
//!   - ONE explicit JS-runtime execution owner (`JsEnvOwner`): all QuickJS
//!     contact happens on this owner; `rquickjs`'s `parallel` feature enables the
//!     cross-thread mechanism but does NOT establish ownership — this wrapper
//!     does (the owner is the only thread that enters the runtime).
//!   - An embedded-source ESM loader (`EmbeddedLoader`) mapping KNOWN module
//!     names to checked-in source bytes. NO CWD-relative filesystem loading in
//!     production; the module set is an explicit, boring map (NOT a packaging
//!     framework).
//!   - Minimal host globals the census (Bead 3zb) proved the Environment closure
//!     needs, and NOTHING more:
//!       * NATIVE to QuickJS (provided free): Promise, queueMicrotask, atob,
//!         btoa, BigInt, Symbol(+asyncIterator). Used directly.
//!       * SHIMMED here: `AbortController`/`AbortSignal` with correct listener
//!         semantics (addEventListener/removeEventListener/`{once:true}` — the
//!         Environment uses these at environment-shell.js and image-observation.js),
//!         and `setTimeout`/`clearTimeout` integrated with the OWNER pump (a
//!         timeout fires through the owner, not an unrelated thread).
//!   - `process` is ABSENT (asserted in tests). NO Buffer shim, NO crypto shim,
//!     NO node:crypto/fs/process/child_process, NO Node module personality, NO
//!     lagrange-images imports, and NO dependency on the throwaway 64j Node
//!     worker (the structural guard enforces this by source scan).
//!
//! # What this slice deliberately does NOT contain
//!
//! No RendererAdapter port, no Images capability (test or real), no Environment
//! wiring. Those arrive in later slices only after the cross-thread async-port
//! falsifier (slice 2) proves the ownership/threading model. Keeping this slice
//! narrow is the point: the boundary must be reviewed before it accretes
//! runtime features.
//!
//! # Deletion criterion (ADR 0014 fallback)
//!
//! This is a TEMPORARY bounded fallback. The preferred architecture is a real JS
//! WASM Component + WIT, upstream-blocked on async guest imports (ComponentizeJS
//! #335). When JS guest async imports land, this module is removed and the
//! plain-data Images port becomes the WIT boundary. NOT a precedent for
//! per-language native bridges.

use std::collections::HashMap;

use rquickjs::{AsyncContext, AsyncRuntime, Ctx, Error, Module, Result};
use rquickjs::loader::{ImportAttributes, Loader, Resolver};

pub mod actor;

/// The canonical module name for an Environment source file.
///
/// The loader is deliberately boring: a fixed map from a canonical module name
/// to the checked-in source bytes. It is NOT a resolver/search path/package
/// framework — if a name is not in the map, loading fails loudly.
#[derive(Default)]
pub struct EmbeddedLoader {
    /// canonical module name -> ESM source bytes (checked-in, embedded).
    modules: HashMap<String, &'static str>,
}

impl EmbeddedLoader {
    pub fn new() -> Self {
        Self { modules: HashMap::new() }
    }

    /// Register one module under a canonical name. Slice 1 registers no
    /// Environment modules; tests register their own tiny graph to prove the
    /// loader. Later slices register the real `src/*.js` via `include_str!`.
    pub fn with_module(mut self, name: &str, source: &'static str) -> Self {
        self.modules.insert(name.to_string(), source);
        self
    }
}

/// Resolve a (possibly relative) import against a base module name.
///
/// Environment modules import each other by relative path (`./model.js`,
/// `./compositor.js`). The canonical name scheme is the file stem relative to
/// the Environment `src/` root. The resolver normalizes `./x` / `../x` against
/// the base so the loader can look up the canonical name. It does NOT search the
/// filesystem; an unknown target simply won't be in the loader's map and will
/// fail loudly there.
impl Resolver for EmbeddedLoader {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> Result<String> {
        Ok(normalize_module_name(base, name))
    }
}

impl Loader for EmbeddedLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> Result<Module<'js, rquickjs::module::Declared>> {
        let canonical = strip_js_suffix(name);
        match self.modules.get(canonical.as_str()).or_else(|| self.modules.get(name)) {
            Some(source) => Module::declare(ctx.clone(), name, *source),
            None => Err(Error::new_loading_message(
                name,
                "module not in the embedded-source map (no filesystem/CWD loading)",
            )),
        }
    }
}

/// Normalize an import specifier against a base module name into a canonical
/// module name. Handles `./x`, `../x`, and an optional `.js` suffix.
fn normalize_module_name(base: &str, name: &str) -> String {
    if !name.starts_with('.') {
        // Bare/canonical specifier: use as-is (stripped of .js).
        return strip_js_suffix(name);
    }
    // The Environment `src/` graph is FLAT: every cross-module import is a
    // same-directory `./x.js`. There are NO `../` imports in the real closure.
    // Honor that invariant loudly: reject `../` rather than silently collapsing
    // it into the flat namespace (a silent collapse would mask a real import
    // that escapes src/, contradicting the "boring, fails loudly" loader).
    if name.starts_with("../") {
        // Return a name guaranteed NOT to be in the map so the loader fails
        // loudly with a clear message, rather than resolving to the wrong module.
        return format!("__unsupported_parent_import__:{name}");
    }
    // `./x.js` (or `./x`): same-directory import -> the flat canonical name.
    // The base does not affect resolution because the namespace is flat.
    let _ = base;
    strip_js_suffix(name.trim_start_matches("./"))
}

fn strip_js_suffix(name: &str) -> String {
    name.strip_suffix(".js").unwrap_or(name).to_string()
}

/// The single JS-runtime execution owner.
///
/// All QuickJS contact happens through this owner. Construct it on the thread
/// that will own JS execution; the runtime/context are bound to it. Later
/// slices drive the pump (host events, capability resolutions, GTK intents)
/// through this owner; slice 1 only constructs the shell and proves the host
/// globals + loader behave.
pub struct JsEnvOwner {
    runtime: AsyncRuntime,
    context: AsyncContext,
}

impl JsEnvOwner {
    /// Build the owner with the embedded-source loader and the minimal host
    /// globals installed. Async because AsyncRuntime/AsyncContext construction
    /// is async in rquickjs.
    pub async fn new(loader: EmbeddedLoader) -> Result<Self> {
        let runtime = AsyncRuntime::new()?;
        runtime.set_loader(loader.clone_resolver(), loader).await;
        let context = AsyncContext::full(&runtime).await?;
        let owner = Self { runtime, context };
        owner.install_host_globals().await?;
        Ok(owner)
    }

    /// Access the context for running JS on the owner thread. CRATE-PRIVATE:
    /// `AsyncContext` is `Clone + Send + Sync` under `parallel`, so a public
    /// accessor would let ANY thread clone it and poll `drive()`/`with()` —
    /// re-opening the multi-thread-migration bug the slice-2 falsifier killed.
    /// The ONLY public path to QuickJS is `actor::JsEnvActor`'s command channel
    /// (one owner by CONSTRUCTION, not by convention). Only the actor (same
    /// crate) may reach these.
    pub(crate) fn context(&self) -> &AsyncContext {
        &self.context
    }

    /// Access the runtime (e.g. to drive the job queue from the owner thread).
    /// CRATE-PRIVATE for the same single-owner reason as `context()`.
    pub(crate) fn runtime(&self) -> &AsyncRuntime {
        &self.runtime
    }

    /// Run a closure against the JS context. CRATE-PRIVATE: MUST be called on
    /// the owner thread. One owner is enforced BY CONSTRUCTION: these accessors
    /// are `pub(crate)`, so the ONLY public path to QuickJS is
    /// `actor::JsEnvActor`'s dedicated-owner-thread command channel. (The
    /// slice-2 review's "code-reviewed invariant, not a type bound" gap is now
    /// closed — it IS a visibility bound.)
    pub(crate) async fn with<F, R>(&self, f: F) -> R
    where
        F: for<'js> FnOnce(Ctx<'js>) -> R + rquickjs::markers::ParallelSend,
        R: rquickjs::markers::ParallelSend,
    {
        self.context.with(f).await
    }

    /// Install the minimal host globals: AbortController/AbortSignal and
    /// setTimeout/clearTimeout. Promise/queueMicrotask/atob/btoa are native and
    /// need no installation. `process` is intentionally NOT defined.
    async fn install_host_globals(&self) -> Result<()> {
        self.with(|ctx| {
            install_abort_controller(&ctx)?;
            install_timers(&ctx)?;
            Ok::<_, Error>(())
        })
        .await?;
        Ok(())
    }
}

// The loader is used as BOTH resolver and loader (set_loader takes them
// separately). EmbeddedLoader is cheap to share; we hand out a resolver view.
impl EmbeddedLoader {
    fn clone_resolver(&self) -> EmbeddedResolver {
        EmbeddedResolver
    }
}

/// The resolver half (kept separate so `set_loader` can own both). Resolution is
/// pure (name normalization), so it shares no state with the loader's map.
pub struct EmbeddedResolver;

impl Resolver for EmbeddedResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> Result<String> {
        Ok(normalize_module_name(base, name))
    }
}

/// Install `AbortController`/`AbortSignal` with correct listener semantics:
/// `addEventListener('abort', fn)`, `removeEventListener('abort', fn)`, and
/// `{once:true}`. Implemented in JS source against a tiny Rust-free core: the
/// controller/signal are pure JS objects; `abort()` dispatches to registered
/// listeners (once-listeners removed after firing). No Rust callback is needed
/// for slice 1 — the Environment only constructs/aborts these in-process.
///
/// DELIBERATE NARROWING (do not "complete" this to a full DOM EventTarget):
/// the shim provides ONLY what the real Environment closure uses. The two call
/// sites (environment-shell.js ~L202, image-observation.js ~L166-167) register
/// plain arrow listeners that read no event argument and no `this`, and the
/// shell's `throwIfAborted` (image-observation.js ~L139) is the Environment's
/// OWN local helper reading only `signal?.aborted`. OMITTED on purpose:
/// `signal.reason`, `signal.throwIfAborted()`, the `AbortSignal.abort()`/
/// `.timeout()`/`.any()` statics, EventTarget inheritance, and the listener
/// event-argument/`this` binding. If a future Env module needs one of those,
/// add it here deliberately — do not assume full DOM semantics.
fn install_abort_controller(ctx: &Ctx) -> Result<()> {
    ctx.eval::<(), _>(
        r#"
globalThis.AbortSignal = class AbortSignal {
  #aborted = false;
  #listeners = new Set();
  constructor() {}
  get aborted() { return this.#aborted; }
  addEventListener(type, fn, opts) {
    if (type !== 'abort' || typeof fn !== 'function') return;
    this.#listeners.add({ fn, once: Boolean(opts && opts.once) });
  }
  removeEventListener(type, fn) {
    if (type !== 'abort') return;
    for (const entry of this.#listeners) {
      if (entry.fn === fn) { this.#listeners.delete(entry); }
    }
  }
  // Internal: fire the abort, honoring {once:true} and listener removal.
  _fire() {
    if (this.#aborted) return;
    this.#aborted = true;
    for (const entry of [...this.#listeners]) {
      if (entry.once) this.#listeners.delete(entry);
      entry.fn.call(this);
    }
  }
  // Internal factory used by AbortController.
  static _make() { return new AbortSignal(); }
};
globalThis.AbortController = class AbortController {
  constructor() { this.signal = AbortSignal._make(); }
  abort() { this.signal._fire(); }
};
"#,
    )?;
    Ok(())
}

/// Install `setTimeout`/`clearTimeout` integrated with the OWNER pump.
///
/// A timeout must fire through the JS-runtime owner's pump, not an unrelated
/// JS/native thread. The mechanism (the contract slice 2's pump drives):
///   - `setTimeout(fn, ms)` registers `{due, fn}` in `__jsenv_timers` where
///     `due = Date.now() + ms` (GUEST wall clock, epoch-ms — see the clock-domain
///     note below); returns an id. `clearTimeout(id)` removes it.
///   - `__jsenv_next_due()` -> the earliest pending `due` (or null): the pump's
///     wait-until target.
///   - `__jsenv_fire_due(now)` -> fires every timer with `due <= now` in due
///     order and returns the count fired. The OWNER calls this on the owner
///     thread; that is what makes firing owner-thread-bound.
/// Slice 1 proves the registry + owner-driven firing semantics; slice 2 wires
/// the pump's clock/wake around `__jsenv_next_due`/`__jsenv_fire_due`.
///
/// CLOCK-DOMAIN NOTE (slice-2 must honor): `due` is epoch-ms on the guest
/// `Date.now()` clock. Slice 2's pump MUST pass a `now` in the SAME domain
/// (epoch-ms via `SystemTime::now()`), NOT a monotonic `Instant` (arbitrary
/// epoch) — or read `Date.now()` inside the guest fire path. Mixing domains
/// silently misfires the `due <= now` comparison.
fn install_timers(ctx: &Ctx) -> Result<()> {
    ctx.eval::<(), _>(
        r#"
globalThis.__jsenv_timers = new Map();   // id -> {due, fn}
globalThis.__jsenv_next_timer_id = 1;
globalThis.setTimeout = function setTimeout(fn, ms, ...args) {
  const id = globalThis.__jsenv_next_timer_id++;
  const due = Date.now() + (typeof ms === 'number' ? ms : 0);
  globalThis.__jsenv_timers.set(id, { due, fn: () => fn(...args) });
  return id;
};
globalThis.clearTimeout = function clearTimeout(id) {
  globalThis.__jsenv_timers.delete(id);
};
// Owner-pump entry: fire every timer whose due <= now, in due order. Returns
// the number fired. Runs ON the owner thread (called from the owner pump).
globalThis.__jsenv_fire_due = function __jsenv_fire_due(now) {
  const due = [...globalThis.__jsenv_timers.entries()]
    .filter(([, t]) => t.due <= now)
    .sort((a, b) => a[1].due - b[1].due);
  for (const [id, t] of due) {
    globalThis.__jsenv_timers.delete(id);
    t.fn();
  }
  return due.length;
};
// Owner-pump query: the earliest pending due time, or null if none.
globalThis.__jsenv_next_due = function __jsenv_next_due() {
  let min = null;
  for (const t of globalThis.__jsenv_timers.values()) {
    if (min === null || t.due < min) min = t.due;
  }
  return min;
};
"#,
    )?;
    Ok(())
}

