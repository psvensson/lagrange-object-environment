//! B0 probe: load the REAL lagrange-images `src/portable-runtime.js` closure
//! under the REAL rquickjs owner/loader, under actual non-Node guest conditions
//! (`process === undefined`, no `Buffer`, no Node builtin resolver, no `node:*`
//! shims). Bead lagrange-object-environment-3zb step 0.
//!
//! RESULT (Bead lagrange-object-environment-0fg, resolved 2026-09-02): B0 is
//! **GREEN**. The full 107-module portable-runtime closure now LINKS, EVALUATES,
//! exports the portable API, and preserves the crypto-provider contract under the
//! pinned runtime — asserted by `full_closure_links_and_exports_api`.
//!
//!   ROOT CAUSE (0fg) — a QuickJS-NG module-linker defect, NOT a Node-compat gap,
//!   NOT a missing host global, NOT an Images semantic:
//!   `js_inner_module_linking` (quickjs.c:30806, `var_ref->header.ref_count++`)
//!   dereferenced a NULL `var_ref` when a module in a CIRCULAR `export {…} from`
//!   (indirect re-export) graph re-exports a name from a cycle-mate still being
//!   linked. Minimized to a 3-module synthetic cycle with NO Lagrange code; the
//!   re-export indirection and entry order are essential. Fixed upstream by
//!   QuickJS-NG commit `ef7a3a748b36acc6bb301488111ec57fda2e65a7` ("Fix crash on
//!   cyclic re-export of an imported binding"), first shipped in QuickJS-NG
//!   0.16.0. Released rquickjs 0.12.2 bundles QuickJS-NG 0.15.1 (RED); the only
//!   green rquickjs path is PR DelSkayn/rquickjs#723, pinned by EXACT rev
//!   `810b2b661ebee5f632e664fc93084f0f21258341` (quickjs-ng 2c620e4) in
//!   `Cargo.toml`'s `[patch.crates-io]`. No released green rquickjs exists; the
//!   pin moves to a release when one ships the fix.
//!
//! Proven GREEN below:
//!   - guest conditions are non-Node (process/Buffer/require undefined);
//!   - the path-preserving loader resolves and loads the real per-module graph
//!     (incl. `language/index`, `backend/create-backend`, `image/graph-image-service`)
//!     with ZERO node:/bare-builtin resolution requests (the closure IS portable
//!     per module — PR #163's composition-root work is confirmed clean);
//!   - the crypto-provider CONTRACT (the 3zb-B boundary) loads and behaves:
//!     `getDefaultCryptoProvider()` throws the explicit "no crypto provider
//!     installed" TypeError; `setDefaultCryptoProvider(stub)` installs;
//!     `assertCryptoProvider` rejects an incomplete provider;
//!   - the FULL closure links + evaluates + exports the portable API
//!     (`createPortableRuntime`, …) — the former SIGSEGV leg, now green.
//!
//! NOTE (host globals): the full closure's top-level (composite-codec's
//! `utf8Encode('LGIC')`) needs the standard web-API `TextEncoder`/`TextDecoder`
//! UTF-8 coders ("standard on every ES host" per the closure). These are NOT
//! Node and NOT an engine feature; the host is expected to provide them exactly
//! like setTimeout/AbortController. For 0fg they are installed TEST-LOCALLY below to
//! keep the production `js_env` host-global surface at its 3zb-A-reviewed scope;
//! 3zb-B decides the production surface.
//!
//! The loader reads the checked-in lagrange-images sources from the sibling repo
//! (the approved probe mechanism): path-preserving, no node_modules/package.json,
//! a resolved name maps to exactly one file, a missing one fails loudly, and a
//! node:/bare-builtin specifier is recorded AND fails loudly (proving no Node
//! resolution occurs for the modules that DO load).

use lagrange_host_linux::js_env::actor::JsEnvActor;
use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::{Ctx, Error, Module, Result};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn images_src_root() -> PathBuf {
    if let Ok(p) = std::env::var("LAGRANGE_IMAGES_SRC") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../lagrange-images/src")
}

/// A path-preserving repo-tree loader (probe-only; a reviewed version is
/// promoted to production only when 3zb-B is unblocked).
#[derive(Clone)]
struct RepoTreeLoader {
    root: PathBuf,
    node_requests: Arc<Mutex<Vec<String>>>,
}

fn is_node_builtin(name: &str) -> bool {
    name.starts_with("node:")
        || matches!(
            name,
            "crypto" | "buffer" | "fs" | "fs/promises" | "path" | "os" | "util" | "stream"
                | "events" | "url" | "assert" | "worker_threads" | "module" | "process"
                | "child_process" | "net" | "http" | "https" | "zlib" | "vm"
        )
}

fn normalize_repo_path(base: &str, name: &str) -> String {
    let joined = if name.starts_with('.') {
        let dir = match base.rfind('/') {
            Some(i) => &base[..i],
            None => "",
        };
        if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") }
    } else {
        name.to_string()
    };
    let mut out: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    let p = out.join("/");
    p.strip_suffix(".js").unwrap_or(&p).to_string()
}

impl Resolver for RepoTreeLoader {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> Result<String> {
        if is_node_builtin(name) {
            self.node_requests.lock().unwrap().push(name.to_string());
            return Err(Error::new_loading_message(
                name,
                "NODE-BUILTIN resolution request (forbidden in the portable closure)",
            ));
        }
        Ok(normalize_repo_path(base, name))
    }
}

impl Loader for RepoTreeLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> Result<Module<'js, rquickjs::module::Declared>> {
        let path = self.root.join(format!("{name}.js"));
        let source = std::fs::read_to_string(&path)
            .map_err(|e| Error::new_loading_message(name, format!("cannot read {}: {e}", path.display())))?;
        Module::declare(ctx.clone(), name, source)
    }
}

fn spawn_images_actor() -> (JsEnvActor, Arc<Mutex<Vec<String>>>) {
    let root = images_src_root();
    assert!(
        root.join("portable-runtime.js").exists(),
        "lagrange-images portable-runtime.js not found at {} (set LAGRANGE_IMAGES_SRC)",
        root.display()
    );
    let node_requests = Arc::new(Mutex::new(Vec::new()));
    let loader = RepoTreeLoader { root, node_requests: Arc::clone(&node_requests) };
    (JsEnvActor::spawn(loader).expect("spawn actor with repo-tree loader"), node_requests)
}

/// Everything provable WITHOUT linking the full closure: non-Node guest, the
/// per-module graph loads with zero Node requests, and the crypto-provider
/// contract behaves.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn b0_reachable_surface_is_green() {
    let (actor, node_requests) = spawn_images_actor();

    // Guest conditions: the non-Node environment the portable closure must tolerate.
    let cond = actor
        .eval_async("({ process: typeof process, Buffer: typeof Buffer, require: typeof require, crypto: typeof crypto })")
        .await
        .expect("guest conditions");
    let cond: serde_json::Value = serde_json::from_str(&cond).unwrap();
    assert_eq!(cond["process"], "undefined");
    assert_eq!(cond["Buffer"], "undefined");
    assert_eq!(cond["require"], "undefined");

    // Per-module loads (the big subgraphs) succeed — the closure is portable
    // module-by-module, even though the FULL link crashes (see the other test).
    let mods = actor
        .eval_async(
            r#"(async () => {
  const out = {};
  for (const m of ['support/default-crypto', 'support/crypto-provider',
                   'backend/create-backend', 'image/graph-image-service',
                   'language/index', 'language/smalltalk-kernel']) {
    try { const ns = await import(m); out[m] = 'ok:' + Object.keys(ns).length; }
    catch (e) { out[m] = 'ERR:' + (e && e.name) + ':' + (e && e.message); }
  }
  return out;
})()"#,
        )
        .await
        .expect("per-module loads");
    let mods: serde_json::Value = serde_json::from_str(&mods).unwrap();
    println!("B0-PER-MODULE {mods}");
    for (m, r) in mods.as_object().unwrap() {
        assert!(r.as_str().unwrap().starts_with("ok:"), "module {m} failed to load: {r}");
    }

    // The crypto-provider CONTRACT (the 3zb-B boundary): explicit no-provider
    // error; stub install; incomplete-provider rejection.
    let crypto = actor
        .eval_async(
            r#"(async () => {
  const dc = await import('support/default-crypto');
  const cp = await import('support/crypto-provider');
  const out = {};
  try { dc.getDefaultCryptoProvider(); out.noProvider = 'NO-THROW'; }
  catch (e) { out.noProvider = (e && e.name) + ': ' + (e && e.message); }
  dc.setDefaultCryptoProvider({
    secureRandomBytes: (n) => new Uint8Array(n),
    sha256: (b) => new Uint8Array(32),
    aes256gcmEncrypt: (k, n, p, a) => new Uint8Array(p.length + 16),
    aes256gcmDecrypt: (k, n, c, a) => new Uint8Array(Math.max(0, c.length - 16)),
    uuid: () => '00000000-0000-4000-8000-000000000000',
  });
  out.installed = typeof dc.getDefaultCryptoProvider().uuid;
  try { cp.assertCryptoProvider({ uuid: () => 'x' }); out.incomplete = 'NO-THROW'; }
  catch (e) { out.incomplete = (e && e.name) + ': ' + (e && e.message); }
  return out;
})()"#,
        )
        .await
        .expect("crypto contract");
    let crypto: serde_json::Value = serde_json::from_str(&crypto).unwrap();
    println!("B0-CRYPTO {crypto}");
    assert!(
        crypto["noProvider"].as_str().unwrap().contains("no crypto provider installed"),
        "explicit no-provider error expected: {}",
        crypto["noProvider"]
    );
    assert_eq!(crypto["installed"], "function", "stub provider installed");
    assert!(
        crypto["incomplete"].as_str().unwrap().contains("crypto provider must supply"),
        "incomplete provider rejected explicitly: {}",
        crypto["incomplete"]
    );

    // No Node module resolution request occurred across ALL the loads above.
    let node_reqs = node_requests.lock().unwrap().clone();
    println!("B0-NODE-REQUESTS {node_reqs:?}");
    assert!(node_reqs.is_empty(), "Node resolution requests occurred: {node_reqs:?}");

    actor.shutdown().await;
}

/// Standard web-API UTF-8 coders the full closure's top-level needs
/// (`composite-codec`'s `utf8Encode('LGIC')`). NOT Node, NOT an engine feature;
/// installed TEST-LOCALLY here (see the module header) so 0fg keeps the
/// production `js_env` host-global surface at its 3zb-A-reviewed scope.
///
/// DELIBERATELY MINIMAL, NOT spec-faithful: correct UTF-8 for all scalar values
/// incl. surrogate pairs, but lone surrogates encode as CESU-8 (not U+FFFD) and
/// the decoder ignores `{fatal:true}`/labels and mojibakes invalid input. That is
/// fine for this probe (the only top-level use is the pure-ASCII 'LGIC'), but if
/// 3zb-B promotes coders to PRODUCTION it must use a spec-faithful implementation.
const TEXT_CODERS_SHIM: &str = r#"
globalThis.TextEncoder = globalThis.TextEncoder ?? class TextEncoder {
  encode(s) {
    s = String(s);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        const c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
};
globalThis.TextDecoder = globalThis.TextDecoder ?? class TextDecoder {
  decode(bytes) {
    bytes = new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b < 0x80) { s += String.fromCharCode(b); }
      else if (b < 0xE0) { s += String.fromCharCode(((b & 31) << 6) | (bytes[++i] & 63)); }
      else if (b < 0xF0) { s += String.fromCharCode(((b & 15) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63)); }
      else { let cp = ((b & 7) << 18) | ((bytes[++i] & 63) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63); cp -= 0x10000; s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023)); }
    }
    return s;
  }
};
"#;

/// The resolved blocker: the FULL portable-runtime closure now LINKS, EVALUATES,
/// exports the portable API, and preserves the crypto-provider contract under the
/// pinned engine (0fg). Kept behind a child process as a crash guard: if a future
/// engine change reintroduces the SIGSEGV, the child dies of signal 11 and the
/// parent fails with a clear message instead of crashing this test binary.
///
/// ALL assertions live in the CHILD leg, so the parent's only job is to read the
/// child's EXIT STATUS: clean exit 0 = green; non-zero = a probe assertion
/// failed; signal 11 = the engine crash regressed. (The child's `println!` to a
/// piped/non-tty stdout is not reliably flushed across the actor's runtime exit,
/// so the parent must NOT parse child stdout.)
///
/// Run the child leg only under B0_CHILD_LEG=1 (set by the parent re-invocation).
#[test]
fn full_closure_links_and_exports_api() {
    if std::env::var("B0_CHILD_LEG").is_ok() {
        // Child leg: install the standard host coders, then link + evaluate the
        // full closure and ASSERT its exported API + crypto-provider contract.
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (actor, node_requests) = spawn_images_actor();
            actor.eval_async(TEXT_CODERS_SHIM).await.expect("install text coders");
            let result = actor
                .eval_async(
                    r#"(async () => {
  const ns = await import('portable-runtime');
  const dc = await import('support/default-crypto');
  const out = { apiCount: Object.keys(ns).length, hasCreatePortableRuntime: typeof ns.createPortableRuntime, hasCreateRuntimeCore: typeof ns.createRuntimeCore, hasCreatePortableCodeExecutorRegistry: typeof ns.createPortableCodeExecutorRegistry };
  try { dc.getDefaultCryptoProvider(); out.noProvider = 'NO-THROW'; }
  catch (e) { out.noProvider = (e && e.name) + ': ' + (e && e.message); }
  return out;
})()"#,
                )
                .await
                .expect("full closure link + API probe");
            let v: serde_json::Value = serde_json::from_str(&result).expect("probe result is JSON");
            // A failure here panics -> non-zero child exit -> the parent reports it.
            assert!(v["apiCount"].as_u64().unwrap() >= 3, "portable API surface present: {result}");
            assert_eq!(v["hasCreatePortableRuntime"], "function", "createPortableRuntime exported: {result}");
            assert_eq!(v["hasCreateRuntimeCore"], "function", "createRuntimeCore exported: {result}");
            assert_eq!(v["hasCreatePortableCodeExecutorRegistry"], "function", "createPortableCodeExecutorRegistry exported: {result}");
            assert!(
                v["noProvider"].as_str().unwrap().contains("no crypto provider installed"),
                "crypto-provider contract preserved: {result}"
            );
            let node_reqs = node_requests.lock().unwrap().clone();
            assert!(node_reqs.is_empty(), "no Node resolution requests: {node_reqs:?}");
            actor.shutdown().await;
        });
        return;
    }
    let exe = std::env::current_exe().expect("current exe");
    // Guard against the child-leg test being renamed without updating the filter:
    // a non-matching --exact filter makes the child run ZERO tests and exit 0,
    // which would pass the parent VACUOUSLY (killing the crash guard). Use ONE
    // constant for both the --list assertion and the --exact filter so they cannot
    // drift apart; if the fn is renamed without updating the constant, the --list
    // assertion fails. (`--list` runs no actor runtime, so its stdout is reliable.)
    const CHILD_TEST: &str = "full_closure_links_and_exports_api";
    let list = std::process::Command::new(&exe).arg("--list").output().expect("child --list");
    let list_stdout = String::from_utf8_lossy(&list.stdout);
    assert!(
        list_stdout.lines().any(|l| l.trim_start().starts_with(CHILD_TEST)),
        "child test '{CHILD_TEST}' missing from --list — renamed without updating CHILD_TEST? \
         The --exact child leg would run 0 tests and pass vacuously. --list output: {list_stdout}"
    );
    let status = std::process::Command::new(&exe)
        .arg(CHILD_TEST)
        .arg("--exact")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("B0_CHILD_LEG", "1")
        .status()
        .expect("spawn child full-closure leg");
    use std::os::unix::process::ExitStatusExt;
    assert!(
        status.success() && status.signal().is_none(),
        "full closure must link + evaluate + export the portable API WITHOUT crashing; \
         child status {status:?}. signal 11 = the 0fg engine fix regressed; non-zero exit = \
         a probe assertion failed (run the child leg directly with B0_CHILD_LEG=1 to see it)."
    );
}
