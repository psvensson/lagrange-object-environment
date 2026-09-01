//! B0 probe: load the REAL lagrange-images `src/portable-runtime.js` closure
//! under the REAL rquickjs owner/loader, under actual non-Node guest conditions
//! (`process === undefined`, no `Buffer`, no Node builtin resolver, no `node:*`
//! shims). Bead lagrange-object-environment-3zb step 0.
//!
//! RESULT (classified, 2026-09-01): B0 is **RED at acceptance step 1** — the full
//! 107-module portable-runtime closure cannot be LINKED by QuickJS-NG. The
//! failure is a hard engine crash (SIGSEGV), classified below and asserted by
//! `full_closure_link_segfaults_classified`.
//!
//!   FIRST (and only) FAILURE — QuickJS-NG module-linker defect:
//!   `js_inner_module_linking` (quickjs.c:30806, `var_ref->header.ref_count++`)
//!   dereferences a NULL `var_ref` (gdb: `var_ref = 0x0`) when a module in a
//!   CIRCULAR `export {…} from` (indirect re-export) graph re-exports a name
//!   from a cycle-mate still being linked. The portable closure contains 7
//!   circular cycles, all in the Smalltalk `language/` subsystem (e.g.
//!   smalltalk-kernel <-> smalltalk-method-dictionary-migration). The individual
//!   submodules — even `language/index` (255 exports) — load fine STANDALONE;
//!   only the full re-export closure linking crashes. This is NOT a
//!   Node-compatibility gap, NOT a missing host global, NOT fixable by an OE
//!   host-side shim. It needs an engine fix (newer QuickJS-NG) or an
//!   Images-side flat portable-runtime bundle that eliminates cross-module
//!   circular re-exports. Neither is done here.
//!
//! Everything REACHABLE in-process is proven GREEN below:
//!   - guest conditions are non-Node (process/Buffer/require/crypto undefined);
//!   - the path-preserving loader resolves and loads the real per-module graph
//!     (incl. `language/index`, `backend/create-backend`, `image/graph-image-service`)
//!     with ZERO node:/bare-builtin resolution requests (the closure IS portable
//!     per module — PR #163's composition-root work is confirmed clean);
//!   - the crypto-provider CONTRACT (the 3zb-B boundary) loads and behaves:
//!     `getDefaultCryptoProvider()` throws the explicit "no crypto provider
//!     installed" TypeError; `setDefaultCryptoProvider(stub)` installs;
//!     `assertCryptoProvider` rejects an incomplete provider.
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

/// The classified blocker: linking the FULL portable-runtime closure crashes the
/// engine. Asserted via a child process so the crash doesn't kill this test
/// binary — the parent asserts the child died of SIGSEGV (signal 11), proving the
/// failure is a native engine crash (not a catchable JS error) at module link.
///
/// Run the child leg only under B0_CRASH_CHILD=1 (set by the parent re-invocation).
#[test]
fn full_closure_link_segfaults_classified() {
    if std::env::var("B0_CRASH_CHILD").is_ok() {
        // Child leg: link the full closure. This segfaults the process.
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (actor, _nr) = spawn_images_actor();
            let _ = actor
                .eval_async("(async () => { await import('portable-runtime'); })()")
                .await;
            let _ = actor; // keep alive across the import
        });
        // If we reach here, the closure did NOT crash — report so the parent's
        // signal assertion fails with a clear message.
        eprintln!("B0-CHILD-SURVIVED (closure linked without crashing)");
        return;
    }
    let exe = std::env::current_exe().expect("current exe");
    let out = std::process::Command::new(exe)
        .arg("full_closure_link_segfaults_classified")
        .arg("--exact")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("B0_CRASH_CHILD", "1")
        .output()
        .expect("spawn child crash leg");
    use std::os::unix::process::ExitStatusExt;
    let signal = out.status.signal();
    println!("B0-CHILD-STATUS {:?} signal={signal:?}", out.status);
    println!("B0-CHILD-STDERR {}", String::from_utf8_lossy(&out.stderr).lines().take(3).collect::<Vec<_>>().join(" | "));
    assert_eq!(
        signal,
        Some(11),
        "expected SIGSEGV (11) from QuickJS-NG circular re-export linking; got {:?}. \
         If the child survived or errored differently, the blocker classification changed.",
        out.status
    );
}
