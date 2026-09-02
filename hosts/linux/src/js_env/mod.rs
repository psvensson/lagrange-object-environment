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
//!       * `TextEncoder`/`TextDecoder` (Bead 3zb slice B1a) — WEB-STANDARD host
//!         facilities, NOT Node compatibility and NOT an engine feature (both
//!         are `undefined` in the pinned QuickJS-NG). The real `lagrange-images`
//!         portable closure needs them: `src/support/portable-bytes.js` is its
//!         only coder user, and `composite-codec.js` calls `utf8Encode('LGIC')`
//!         at MODULE TOP LEVEL — so they must exist BEFORE module evaluation,
//!         which is why they are installed here with the other host globals.
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

use rquickjs::{AsyncContext, AsyncRuntime, Ctx, Error, Exception, Function, Module, Result, TypedArray};
use rquickjs::loader::{ImportAttributes, Loader, Resolver};

pub mod actor;
pub mod images_capability;
pub mod renderer_port;

/// The canonical module name for an Environment source file.
///
/// The loader is deliberately boring: a fixed map from a canonical module name
/// to the checked-in source bytes. It is NOT a resolver/search path/package
/// framework — if a name is not in the map, loading fails loudly.
#[derive(Default, Clone)]
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
    /// Signaled by the guest `setTimeout`/`clearTimeout` (via the
    /// `__jsenv_timer_changed` host fn) so the owner's command loop wakes to
    /// recompute the next-due timer — even when a timer is registered by a
    /// continuation resumed from a capability oneshot while the loop was parked
    /// with no pending timers (the slice-3B missed-wakeup liveness fix).
    timer_notify: std::sync::Arc<tokio::sync::Notify>,
}

impl JsEnvOwner {
    /// Build the owner with the given module loader/resolver and the minimal
    /// host globals installed. Generic over the loader: the Environment closure
    /// uses `EmbeddedLoader`; the lagrange-images portable-runtime closure (B0 /
    /// 3zb-B) uses a path-preserving repo-tree loader. Async because
    /// AsyncRuntime/AsyncContext construction is async in rquickjs.
    pub async fn new<L>(loader: L) -> Result<Self>
    where
        L: Resolver + Loader + Clone + 'static,
    {
        let runtime = AsyncRuntime::new()?;
        runtime.set_loader(loader.clone(), loader).await;
        let context = AsyncContext::full(&runtime).await?;
        let owner = Self {
            runtime,
            context,
            timer_notify: std::sync::Arc::new(tokio::sync::Notify::new()),
        };
        owner.install_host_globals().await?;
        Ok(owner)
    }

    /// The Notify the guest timer registry signals on every setTimeout /
    /// clearTimeout. The actor's command loop selects on this to recompute the
    /// next-due timer (see the field doc).
    pub fn timer_notify(&self) -> std::sync::Arc<tokio::sync::Notify> {
        std::sync::Arc::clone(&self.timer_notify)
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

    /// Install the minimal host globals: AbortController/AbortSignal,
    /// setTimeout/clearTimeout and the web-standard UTF-8 coders.
    /// Promise/queueMicrotask/atob/btoa are native and need no installation.
    /// `process` is intentionally NOT defined.
    async fn install_host_globals(&self) -> Result<()> {
        let timer_notify = self.timer_notify();
        self.with(|ctx| {
            install_abort_controller(&ctx)?;
            install_timers(&ctx, timer_notify)?;
            install_text_coders(&ctx)?;
            Ok::<_, Error>(())
        })
        .await?;
        Ok(())
    }
}

// The loader is used as BOTH resolver and loader (set_loader takes them
// separately); JsEnvOwner::new clones it into both slots. EmbeddedLoader
// implements Resolver directly (resolution is pure name normalization).

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
fn install_timers(ctx: &Ctx, timer_notify: std::sync::Arc<tokio::sync::Notify>) -> Result<()> {
    // A sync host fn the guest setTimeout/clearTimeout call after mutating the
    // registry, so the owner's command loop wakes to recompute the next-due
    // timer. Without this the loop can park in `rx.recv()` with no pending
    // timers and miss a timer registered by a continuation resumed from a
    // capability oneshot (the slice-3B missed-wakeup liveness fix).
    {
        use rquickjs::Function;
        let notify = timer_notify;
        let f = Function::new(ctx.clone(), move || {
            notify.notify_one();
        })?;
        ctx.globals().set("__jsenv_timer_changed", f)?;
    }
    ctx.eval::<(), _>(
        r#"
globalThis.__jsenv_timers = new Map();   // id -> {due, fn}
globalThis.__jsenv_next_timer_id = 1;
globalThis.setTimeout = function setTimeout(fn, ms, ...args) {
  const id = globalThis.__jsenv_next_timer_id++;
  // Clamp to a 1ms minimum (the Node/browser timer floor). The shell's follow
  // hardcodes intervalMs:0; without the floor setTimeout(0) would fire on every
  // command-loop turn, making the follow a hot spin that floods the serial
  // images host. Node clamps nested timeouts to ~1ms; matching that keeps the
  // follow's poll rate faithful instead of unbounded. Non-finite ms (NaN/
  // Infinity) would otherwise make `due` NaN so `due <= now` is false forever —
  // coerce those to the floor too (Node/browsers coerce to ~0/1ms).
  const msNum = (typeof ms === 'number' && Number.isFinite(ms)) ? ms : 0;
  const due = Date.now() + Math.max(1, msNum);
  globalThis.__jsenv_timers.set(id, { due, fn: () => fn(...args) });
  globalThis.__jsenv_timer_changed();
  return id;
};
globalThis.clearTimeout = function clearTimeout(id) {
  globalThis.__jsenv_timers.delete(id);
  globalThis.__jsenv_timer_changed();
};
// Owner-pump entry: fire every timer whose due <= now, in due order. Returns
// the number fired. Runs ON the owner thread (called from the owner pump).
globalThis.__jsenv_fire_due = function __jsenv_fire_due(now) {
  const due = [...globalThis.__jsenv_timers.entries()]
    .filter(([, t]) => t.due <= now)
    .sort((a, b) => a[1].due - b[1].due);
  let fired = 0;
  for (const [id, t] of due) {
    // A clearTimeout from an earlier callback in this same batch must win: the
    // batch is snapshotted before firing, so re-check registration per timer.
    if (!globalThis.__jsenv_timers.has(id)) continue;
    globalThis.__jsenv_timers.delete(id);
    fired++;
    try {
      t.fn();
    } catch (e) {
      // A throwing guest timer callback must NOT abort the rest of the batch or
      // vanish silently. Record it on a host-drained channel (the owner logs
      // it); the owner stays alive and later timers still fire.
      (globalThis.__jsenv_timer_errors = globalThis.__jsenv_timer_errors ?? []).push(String((e && e.stack) || e));
    }
  }
  return fired;
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


// ---------------------------------------------------------------------------
// Web-standard UTF-8 coders (Bead 3zb slice B1a)
// ---------------------------------------------------------------------------
//
// WHY THESE ARE HERE AT ALL. The real `lagrange-images` portable closure needs
// `TextEncoder`/`TextDecoder`. They are WEB-STANDARD host facilities, not Node
// compatibility (`portable-bytes.js` itself calls them "standard on every ES
// host") and not an engine feature — both are `undefined` in the pinned
// QuickJS-NG, alongside `crypto`. Only `src/support/portable-bytes.js` touches
// them, and exactly two operations are reached by the portable closure:
// `utf8Encode` (`TextEncoder.encode`) and `utf8DecodeLossy`
// (`new TextDecoder('utf-8', {fatal:false}).decode`). `utf8DecodeStrict`
// (`fatal:true`) is exported but has zero callers there.
//
// WHY SPEC FIDELITY IS LOAD-BEARING (not pedantry — two concrete holes):
//
//  1. SURROGATE SMUGGLING ON DECODE. `smalltalk-primitives-bytes.js`'s
//     `decodeUtf8Strict` is the ONLY UTF-8 validity check in the closure, and it
//     validates by ROUND TRIP: `bytesEqual(utf8Encode(utf8DecodeLossy(b)), b)`.
//     A decoder that maps the UTF-8-encoded surrogate range (`ED A0 80` =
//     U+D800) back to a lone surrogate makes that round trip SUCCEED, so the
//     bytes validate and mint an Images `Text` containing a lone surrogate.
//     WHATWG requires `ED A0 80` -> three U+FFFD, which does not round-trip and
//     is correctly refused.
//
//  2. DIVERGENT DURABLE IDENTITY ON ENCODE. `utf8Encode` feeds `sha256`
//     (project/model, callable/type-grammar, compilation/derivation-cache,
//     graph/bundle) and `base64urlEncode` (object/version-token,
//     smalltalk-kernel, smalltalk-class-builder, authority/object-resource), and
//     `composite-codec.js` encodes string values with NO well-formedness guard.
//     An encoder that emits WTF-8 `ED A0 80` for a lone surrogate where the spec
//     emits `EF BF BD` therefore produces a DIFFERENT DIGEST, a different
//     version token and a different durable identity than the Node reference
//     implementation — for the same logical value.
//
// WHY THE ENCODER IS PURE JS AND THE DECODER IS RUST-BACKED. This asymmetry is
// forced by the engine, not chosen for taste. A JS string holding a LONE
// SURROGATE CANNOT CROSS INTO RUST: `JS_ToCStringLen2` keeps unmatched
// surrogates as WTF-8, and `rquickjs`'s `String::to_string` then fails
// `str::from_utf8` and raises "Conversion from string failed: invalid utf-8
// sequence". There is no rquickjs API exposing UTF-16 units or a CESU-8 mode.
// So the exact input a spec-faithful encoder must map to U+FFFD is precisely the
// input that cannot reach Rust — a Rust-backed encoder would throw a HOST error
// where WHATWG mandates a replacement character, on unguarded Images paths.
// Decoding has no such problem, and `String::from_utf8_lossy` implements the
// WHATWG maximal-subpart U+FFFD substitution bit-exactly (verified against
// Node's `TextDecoder` across the full corpus in `tests/text_coders.rs`), which
// is the part that is genuinely easy to get wrong by hand.
//
// DELIBERATELY NARROW, AND LOUD ABOUT IT. Only `encode` and `decode` are
// implemented. `{stream:true}`, `ignoreBOM`, `encodeInto` and any label other
// than utf-8 THROW rather than silently degrading, and `fatal:true` really does
// decode strictly — `utf8DecodeStrict` is exported by `portable-bytes.js`, so a
// shim that quietly ignored `fatal` would downgrade a strict decode to a lossy
// one, which is the very bug class this slice exists to close.

/// Rust half of `TextDecoder`: WHATWG UTF-8 decode with `fatal:false`.
///
/// Named `fn` item on purpose: `TypedArray<'js, T>` and `String<'js>` are
/// INVARIANT in `'js`, so a closure cannot express the higher-ranked bound
/// `Function::new` needs ("lifetime may not live long enough").
fn jsenv_utf8_decode_lossy<'js>(
    ctx: Ctx<'js>,
    bytes: TypedArray<'js, u8>,
) -> Result<rquickjs::String<'js>> {
    // `as_ref()` honours byteOffset/length, which is load-bearing: the Images
    // observation binding hands us `payload.subarray(0, 12)` / `(12, 28)` /
    // `(28)` rather than whole buffers.
    let decoded = String::from_utf8_lossy(bytes.as_ref());
    // WHATWG strips ONE leading U+FEFF when `ignoreBOM` is false (the default).
    // `from_utf8_lossy` does not, and the difference is observable: Images on
    // Node REJECTS `EF BB BF 61` through `decodeUtf8Strict` (the re-encode has
    // lost the BOM) and we must reject it identically.
    let stripped = decoded.strip_prefix('\u{FEFF}').unwrap_or(&decoded);
    rquickjs::String::from_str(ctx, stripped)
}

/// Rust half of `TextDecoder` with `{fatal: true}`: WHATWG UTF-8 decode that
/// raises `TypeError` on malformed input. Unreached by today's portable closure
/// (`utf8DecodeStrict` has no callers), but implemented rather than stubbed so
/// the option can never silently degrade to a lossy decode.
fn jsenv_utf8_decode_fatal<'js>(
    ctx: Ctx<'js>,
    bytes: TypedArray<'js, u8>,
) -> Result<rquickjs::String<'js>> {
    match std::str::from_utf8(bytes.as_ref()) {
        Ok(text) => {
            let stripped = text.strip_prefix('\u{FEFF}').unwrap_or(text);
            rquickjs::String::from_str(ctx, stripped)
        }
        // `Exception::throw_type` (NOT `Error::new_from_js_message`) so the
        // message Images sees is ours, not a mangled conversion diagnostic
        // leaking into an image-observation-binding `{cause}` chain.
        Err(_) => Err(Exception::throw_type(
            &ctx,
            "TextDecoder: the encoded data was not valid UTF-8",
        )),
    }
}

/// Install `TextEncoder`/`TextDecoder`.
///
/// The encoder is pure JS (see the note above: lone surrogates cannot cross into
/// Rust); the decoder delegates to the Rust helpers.
fn install_text_coders(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();
    globals.set(
        "__jsenv_utf8_decode_lossy",
        Function::new(ctx.clone(), jsenv_utf8_decode_lossy)?,
    )?;
    globals.set(
        "__jsenv_utf8_decode_fatal",
        Function::new(ctx.clone(), jsenv_utf8_decode_fatal)?,
    )?;
    ctx.eval::<(), _>(TEXT_CODERS)?;
    Ok(())
}

/// `TextEncoder` (pure JS, WHATWG-faithful incl. lone surrogates -> U+FFFD) and
/// `TextDecoder` (thin JS wrapper enforcing the supported option surface, then
/// delegating the actual decode to Rust).
const TEXT_CODERS: &str = r#"
globalThis.TextEncoder = class TextEncoder {
  get encoding() { return 'utf-8'; }
  encode(input) {
    const s = input === undefined ? '' : String(input);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      let cp = c;
      if (c >= 0xD800 && c <= 0xDBFF) {
        // High surrogate: only a following low surrogate forms a scalar value.
        const next = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
        if (next >= 0xDC00 && next <= 0xDFFF) {
          cp = 0x10000 + ((c - 0xD800) << 10) + (next - 0xDC00);
          i++;
        } else {
          cp = 0xFFFD; // unpaired high surrogate
        }
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        cp = 0xFFFD; // unpaired low surrogate
      }
      if (cp < 0x80) {
        out.push(cp);
      } else if (cp < 0x800) {
        out.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
      } else if (cp < 0x10000) {
        out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else {
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
    }
    return new Uint8Array(out);
  }
  encodeInto() {
    // Deliberately unimplemented: no caller in the portable closure. Loud, so a
    // future caller gets a clear failure instead of silent corruption.
    throw new TypeError('TextEncoder.encodeInto is not implemented by this host');
  }
};

const __JSENV_UTF8_LABELS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8']);

globalThis.TextDecoder = class TextDecoder {
  constructor(label = 'utf-8', options = {}) {
    const normalized = String(label).trim().toLowerCase();
    if (!__JSENV_UTF8_LABELS.has(normalized)) {
      throw new RangeError(`TextDecoder: this host supports only UTF-8, got '${label}'`);
    }
    const opts = options ?? {};
    if (opts.ignoreBOM) {
      throw new TypeError('TextDecoder: ignoreBOM is not implemented by this host');
    }
    this._fatal = Boolean(opts.fatal);
  }
  get encoding() { return 'utf-8'; }
  get fatal() { return this._fatal; }
  get ignoreBOM() { return false; }
  decode(input, options = {}) {
    if ((options ?? {}).stream) {
      // Streaming needs cross-call state we deliberately do not keep; failing
      // loudly beats silently decoding each chunk independently.
      throw new TypeError('TextDecoder: {stream:true} is not implemented by this host');
    }
    let bytes;
    if (input === undefined) bytes = new Uint8Array(0);
    else if (input instanceof Uint8Array) bytes = input;
    else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else throw new TypeError('TextDecoder.decode expects a BufferSource');
    return this._fatal ? __jsenv_utf8_decode_fatal(bytes) : __jsenv_utf8_decode_lossy(bytes);
  }
};
"#;
