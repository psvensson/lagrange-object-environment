//! B0 probe: load the REAL lagrange-images `src/portable-runtime.js` closure
//! under the REAL rquickjs owner/loader, under actual non-Node guest conditions
//! (`process === undefined`, no `Buffer`, no Node builtin resolver, no `node:*`
//! shims). Bead lagrange-object-environment-3zb step 0.
//!
//! RESULT (Bead lagrange-object-environment-0fg, resolved 2026-09-02): B0 is
//! **GREEN**. The full 109-module portable-runtime closure now LINKS, EVALUATES,
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
//!   pin moves to a release when one ships the fix (Bead s3b).
//!
//!   PROVENANCE vs FETCH URL (Bead 2rk) — these are different things, and the
//!   manifest is NOT inconsistent with the paragraph above. The revision's
//!   PROVENANCE is PR DelSkayn/rquickjs#723 (as stated); the URL it is FETCHED
//!   from is a project-owned mirror, `psvensson/rquickjs-pin`, serving that
//!   byte-identical commit. The revision is on no branch of DelSkayn/rquickjs
//!   and was reachable only as `refs/pull/723/head`, which a force-push or a
//!   closed PR could orphan — breaking `cargo fetch` for every fresh clone and
//!   CI run. Do not "restore" the upstream URL and do not pin a branch/tag name;
//!   see the `[patch.crates-io]` comment in `hosts/linux/Cargo.toml`.
//!
//!   PROOF CLASSIFICATION (Bead 25v): `full_closure_links_and_exports_api` is an
//!   integration/portability proof for the exact pinned Images artifact. It is
//!   intentionally NOT the authoritative engine-fix oracle: an artifact bump
//!   could remove the historical trigger and make this test green under a buggy
//!   engine. `quickjs_linker_oracle.rs` owns that regression contract with the
//!   exact recovered three-module fixture, a structural non-vacuity proof, and
//!   production `EmbeddedLoader` + `JsEnvActor` under child-process isolation.
//!
//! Proven GREEN below:
//!   - guest conditions are non-Node (process/Buffer/require undefined);
//!   - the artifact loader resolves and loads the real per-module graph
//!     (incl. `language/index`, `backend/create-backend`, `image/graph-image-service`)
//!     with no filesystem/package/Node fallback (the closure IS portable per
//!     module — PR #163's composition-root work is confirmed clean);
//!   - the crypto-provider CONTRACT (the 3zb-B boundary) loads and behaves:
//!     `getDefaultCryptoProvider()` throws the explicit "no crypto provider
//!     installed" TypeError; `setDefaultCryptoProvider(stub)` installs;
//!     `assertCryptoProvider` rejects an incomplete provider;
//!   - the FULL closure links + evaluates + exports the portable API
//!     (`createPortableRuntime`, …) — the former SIGSEGV leg, now green.
//!
//! NOTE (host globals) — RESOLVED by Bead 3zb slice B1a. The full closure's
//! top-level (composite-codec's `utf8Encode('LGIC')`) needs the standard web-API
//! `TextEncoder`/`TextDecoder` UTF-8 coders ("standard on every ES host" per the
//! closure). These are NOT Node and NOT an engine feature; the host provides them
//! exactly like setTimeout/AbortController. 0fg installed a deliberately minimal
//! shim TEST-LOCALLY here to keep the production `js_env` surface at its
//! 3zb-A-reviewed scope, and deferred the production decision to 3zb-B. B1a made
//! that decision: `js_env::install_host_globals` now installs spec-faithful
//! coders, so this probe installs nothing and simply inherits them — which also
//! means this test now exercises the PRODUCTION coders against the real
//! 109-module closure. The old minimal shim survives only as the FALSIFIER's
//! subject in `tests/text_coders.rs`, where it is asserted to behave differently
//! (it decodes `ED A0 80` to a lone surrogate and encodes `U+D800` as WTF-8,
//! both of which the production coders refuse).
//!
//! The production loader reads the exact pinned
//! `lagrange-images-portable-runtime/v1` artifact in memory. A resolved name maps
//! to exactly one canonical artifact module; missing, bare, and `node:*`
//! specifiers fail loudly with no filesystem/package/Node fallback.

use lagrange_host_linux::images_composition::portable_artifact::PortableImagesArtifactLoader;
use lagrange_host_linux::js_env::actor::JsEnvActor;

fn spawn_images_actor() -> JsEnvActor {
    let loader = PortableImagesArtifactLoader::from_embedded()
        .expect("construct loader from the pinned Images artifact");
    JsEnvActor::spawn(loader).expect("spawn artifact-backed actor")
}

/// Everything provable WITHOUT linking the full closure: non-Node guest, the
/// per-module graph loads through exact artifact paths, and the crypto-provider
/// contract behaves.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn b0_reachable_surface_is_green() {
    let actor = spawn_images_actor();

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
    // module-by-module as well as through the full root below.
    let mods = actor
        .eval_async(
            r#"(async () => {
  const out = {};
  for (const m of ['src/support/default-crypto.js', 'src/support/crypto-provider.js',
                   'src/backend/create-backend.js', 'src/image/graph-image-service.js',
                   'src/language/index.js', 'src/language/smalltalk-kernel.js']) {
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
  const dc = await import('src/support/default-crypto.js');
  const cp = await import('src/support/crypto-provider.js');
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

    actor.shutdown().await;
}

/// Integration/portability proof: the FULL portable-runtime closure now LINKS,
/// EVALUATES, exports the portable API, and preserves the crypto-provider contract
/// under the pinned engine (0fg). Kept behind a child process because this real
/// graph historically reached the engine crash; `quickjs_linker_oracle.rs` is the
/// authoritative minimal engine-fix oracle.
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
            let actor = spawn_images_actor();
            let result = actor
                .eval_async(
                    r#"(async () => {
  const ns = await import('portable-runtime');
  const dc = await import('src/support/default-crypto.js');
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
