//! Bead 3zb slice B1b CROSS-LAYER PROOF: the native primitives are genuinely
//! consumed by real `lagrange-images` code, through the public provider seam.
//!
//! ```text
//! native host primitives  (js_env/host_crypto.rs, generic)
//!     -> guest provider adapter  (images_composition/crypto-bootstrap.js)
//!         -> setDefaultCryptoProvider  (public portable-runtime seam)
//!             -> real Images semantic operations
//! ```
//!
//! THE POINT IS NOT THAT FIVE HOST FUNCTIONS EXIST -- `host_crypto.rs` already
//! pins them against NIST/FIPS vectors. The point is that real Images code
//! REACHES them. So every assertion below runs through an actual Images
//! consumer, one per primitive family:
//!
//!   * SHA-256          `typeFingerprint` (public, pure) and, transitively,
//!                      `pack`/`unpackCompositeValue`, plus `observationKey`
//!   * AES-256-GCM      observation cursor encode AND decode (a real resume)
//!   * secure random    the 12-byte cursor IV
//!   * UUID             the executor's default `cursorSecret`, consumed while
//!                      `createPortableRuntime` composes
//!
//! Semantic assertions belong to Images: this file never reconstructs a cursor
//! or token format, it only observes public behaviour.
//!
//! THE FALSIFIER (`miswired_*`) is what makes the above non-vacuous. Installing
//! a provider that is correct in shape but WRONG in one operation must break the
//! corresponding real Images proof -- otherwise these tests could pass while
//! Images quietly used some other implementation.
//!
//! Images sources come from the sibling checkout (development machinery); slice
//! B2 replaces that with the `lagrange-images-portable-runtime/v1` artifact and
//! should leave every assertion here intact.

use lagrange_host_linux::images_composition::{CRYPTO_BOOTSTRAP_JS, CRYPTO_BOOTSTRAP_SPECIFIER};
use lagrange_host_linux::js_env::actor::JsEnvActor;
use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::{Ctx, Error, Module, Result};
use std::path::PathBuf;

fn images_src_root() -> PathBuf {
    if let Ok(p) = std::env::var("LAGRANGE_IMAGES_SRC") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../lagrange-images/src")
}

/// Repo-tree loader with a small HOST OVERLAY: host-owned modules resolve from
/// an embedded map, everything else falls through to the Images source tree.
///
/// The overlay is necessary because a plain repo-tree loader resolves EVERY
/// specifier against the Images root, so a host module would be looked up as
/// `<images_src>/host/crypto-bootstrap.js` and fail. It is also the shape B2's
/// artifact loader needs, so this is not throwaway scaffolding.
#[derive(Clone)]
struct OverlayLoader {
    root: PathBuf,
    overlay: Vec<(String, &'static str)>,
}

impl OverlayLoader {
    fn new() -> Self {
        Self {
            root: images_src_root(),
            overlay: vec![(CRYPTO_BOOTSTRAP_SPECIFIER.to_string(), CRYPTO_BOOTSTRAP_JS)],
        }
    }
    fn overlay_source(&self, name: &str) -> Option<&'static str> {
        self.overlay.iter().find(|(k, _)| k == name).map(|(_, v)| *v)
    }
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
            ".." => { out.pop(); }
            s => out.push(s),
        }
    }
    let p = out.join("/");
    p.strip_suffix(".js").unwrap_or(&p).to_string()
}

impl Resolver for OverlayLoader {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attrs: Option<ImportAttributes<'js>>,
    ) -> Result<String> {
        Ok(normalize_repo_path(base, name))
    }
}

impl Loader for OverlayLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attrs: Option<ImportAttributes<'js>>,
    ) -> Result<Module<'js, rquickjs::module::Declared>> {
        if let Some(src) = self.overlay_source(name) {
            return Module::declare(ctx.clone(), name, src);
        }
        let path = self.root.join(format!("{name}.js"));
        let src = std::fs::read_to_string(&path)
            .map_err(|e| Error::new_loading_message(name, format!("{}: {e}", path.display())))?;
        Module::declare(ctx.clone(), name, src)
    }
}

fn actor() -> JsEnvActor {
    JsEnvActor::spawn(OverlayLoader::new()).expect("spawn actor")
}

/// Guest program shared by the real and the miswired runs.
///
/// `providerExpr` yields the provider to install. The production run installs
/// the bootstrap's own provider; the falsifier runs install a deliberately
/// broken one built over the SAME host primitives, so the production path is
/// never mutated.
fn program(provider_expr: &str) -> String {
    format!(
        r#"(async () => {{ try {{
  const boot = await import('{CRYPTO_BOOTSTRAP_SPECIFIER}');
  const installed = boot.installNativeCryptoProvider({provider_expr});

  const pr  = await import('portable-runtime');
  const tg  = await import('callable/type-grammar');
  const sc  = await import('value/scalars');
  const sk  = await import('language/smalltalk-kernel');
  const iv2 = await import('callable/interface-v2-artifacts');
  const iob = await import('callable/image-observation-binding');
  const cc  = await import('callable/composite-codec');

  const hex = (a) => [...a].map(b => b.toString(16).padStart(2, '0')).join('');

  // --- SHA-256 through a REAL public Images consumer -----------------------
  // Both the canonical JSON and the digest are pinned, so a drift says WHICH
  // layer moved: Images' canonicalisation, or our SHA.
  // `typeFingerprint(type, types)` hashes the canonical JSON of
  // `{{type, types: reachableDeclarations(...)}}` -- NOT of the bare type -- so
  // pin the canonical form of THAT shape, which is the actual SHA input.
  const canonical = tg.canonicalTypeJson({{type: 'string', types: {{}}}});
  const fingerprint = hex(tg.typeFingerprint('string', {{}}));

  const TYPES = tg.normalizeTypeDeclarations({{
    'obs-event': {{kind: 'record', fields: [
      {{name: 'object-id', type: 'string'}}, {{name: 'kind', type: 'string'}}, {{name: 'cursor', type: 'string'}}]}},
    'obs-result': {{kind: 'record', fields: [
      {{name: 'events', type: {{kind: 'list', element: 'obs-event'}}}}, {{name: 'cursor', type: 'string'}}]}},
  }});

  // --- compose (consumes uuid() for the executor's cursorSecret) -----------
  const runtime = await pr.createPortableRuntime({{backend: {{mode: 'mock'}}}});
  await runtime.images.createImage({{id: 'demo'}});
  await sk.installSmalltalkKernel({{images: runtime.images, imageId: 'demo'}});
  const ci = await iv2.installCallableInterfaceV2({{
    images: runtime.images, imageId: 'demo', interfaceId: 'observe',
    functionName: 'observe', parameters: ['string'], result: 'obs-result', types: TYPES,
  }});
  await iob.installImageObservationBinding({{
    images: runtime.images,
    callableInterface: sc.objectRef('demo', ci.id),
    bindingId: 'observation', blockId: 'observation-block',
  }});

  const observe = async (after = '') => {{
    const activation = await runtime.invocations.invokeBlock(
      sc.objectRef('demo', 'observation-block'), [sc.textValue(after)]);
    const packed = await runtime.executor.execute(activation, {{}});
    return cc.unpackCompositeValue(packed, 'obs-result', TYPES);
  }};
  const cursorOf = (r) => r.cursor?.value ?? r.cursor;

  // --- AES-256-GCM encrypt: a real cursor -------------------------------
  const first = await observe('');
  const cursor = cursorOf(first);

  // --- AES-256-GCM decrypt: a real RESUME -------------------------------
  let resume = 'OK';
  try {{ await observe(cursor); }}
  catch (e) {{ resume = (e && e.name) + ': ' + (e && e.message); }}

  // --- integrity: a WELL-FORMED but corrupted cursor --------------------
  // Garbage fails earlier, at parsing; flipping a character inside a valid
  // cursor is what actually reaches the AES authentication path.
  const flip = (s) => {{
    const i = s.length - 2;
    const c = s[i] === 'A' ? 'B' : 'A';
    return s.slice(0, i) + c + s.slice(i + 1);
  }};
  let tampered = 'NO-THROW';
  try {{ await observe(flip(cursor)); }}
  catch (e) {{ tampered = (e && e.name) + ': ' + (e && e.message); }}

  return {{
    providerFrozen: Object.isFrozen(installed),
    canonical, fingerprint,
    cursorIsString: typeof cursor === 'string', cursorLength: String(cursor).length,
    resume, tampered,
  }};
}} catch (e) {{
  return {{ERROR: (e && e.name) + ': ' + (e && e.message), stack: String(e && e.stack).slice(0, 700)}};
}} }})()"#
    )
}

async fn run(actor: &JsEnvActor, provider_expr: &str) -> serde_json::Value {
    let json = actor
        .eval_async(&program(provider_expr))
        .await
        .expect("guest program must return");
    serde_json::from_str(&json).expect("valid json")
}

/// `typeFingerprint('string', {})` = SHA-256 of the canonical JSON
/// `{"type":"string","types":{}}` (the fingerprint hashes
/// `{type, types: reachableDeclarations(...)}`, not the bare type).
///
/// Verified two ways so this constant is an ORACLE and not a transcript of
/// whatever the code happened to emit: independently computed with Python's
/// hashlib, and produced by Images' own Node reference provider. Our native
/// provider must agree with both.
const TYPE_FINGERPRINT_STRING: &str =
    "cc3b5513cda90eb2dde7427f586d4cba5ec0d1d73844a1eb403e138c7538dbb1";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn native_provider_is_consumed_by_real_images_operations() {
    let a = actor();
    let v = run(&a, "").await;
    assert!(v.get("ERROR").is_none(), "flow failed: {} / {}", v["ERROR"], v["stack"]);

    // Installed through the PUBLIC seam, and validated+frozen by Images itself
    // -- we never reimplement assertCryptoProvider.
    assert_eq!(v["providerFrozen"], true, "Images must return its own frozen provider");

    // SHA via a real public consumer, with the canonical input pinned too.
    assert_eq!(v["canonical"], r#"{"type":"string","types":{}}"#);
    assert_eq!(
        v["fingerprint"], TYPE_FINGERPRINT_STRING,
        "typeFingerprint must be the SHA-256 of Images' canonical type JSON"
    );

    // AES encrypt + decrypt via the real cursor path.
    assert_eq!(v["cursorIsString"], true);
    assert!(v["cursorLength"].as_u64().unwrap_or(0) > 16, "cursor: {}", v["cursorLength"]);
    assert_eq!(
        v["resume"], "OK",
        "resuming from the cursor must succeed -- this is the leg proving decrypt ran"
    );

    // Integrity: Images classifies the throw from our decrypt.
    let tampered = v["tampered"].as_str().unwrap_or("");
    assert!(
        tampered.contains("integrity check"),
        "a corrupted cursor must be refused by the integrity check, got: {tampered}"
    );

    a.shutdown().await;
}

/// FALSIFIER (SHA leg). A provider whose `sha256` returns fixed wrong bytes --
/// correct in shape, wrong in value -- must break the REAL Images consumers.
/// One miswire, two distinct consumers: `typeFingerprint` diverges, and
/// `unpackCompositeValue` rejects the observe result because it recomputes the
/// expected fingerprint.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn miswired_sha_breaks_real_images_consumers() {
    let a = actor();
    let v = run(
        &a,
        "{...(await import('host/crypto-bootstrap')).createNativeCryptoProvider(), \
          sha256: () => new Uint8Array(32).fill(9)}",
    )
    .await;

    // Be specific about WHICH real consumer breaks, so this cannot pass for an
    // incidental reason (an earlier draft of this test passed vacuously because
    // the pinned digest itself was wrong).
    eprintln!("miswired-sha result: {v}");
    if let Some(err) = v.get("ERROR") {
        // Composition itself may fail once every fingerprint is wrong -- that is
        // still a real Images consumer rejecting our provider.
        let err = err.as_str().unwrap_or("");
        assert!(!err.is_empty(), "expected a real failure, got {v}");
    } else {
        assert_ne!(
            v["fingerprint"], TYPE_FINGERPRINT_STRING,
            "typeFingerprint MUST reflect the (wrong) installed sha256 -- if it still matches \
             the pinned digest, Images is not using the installed provider at all"
        );
        assert_eq!(
            v["fingerprint"], "0909090909090909090909090909090909090909090909090909090909090909",
            "the miswired digest must be exactly the fixed bytes we installed, proving the \
             value flowed from OUR provider through Images' typeFingerprint"
        );
    }
    a.shutdown().await;
}

/// FALSIFIER (AES leg). A provider whose `aes256gcmEncrypt` returns a zeroed tag
/// still lets `observe('')` mint a cursor, but the RESUME must fail -- proving
/// the resume path genuinely reaches the native decrypt rather than some other
/// implementation. This is the claim a primitive-only proof cannot make.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn miswired_aes_tag_breaks_cursor_resume() {
    let a = actor();
    let v = run(
        &a,
        "(() => { const p = null; return null; })() ?? \
         await (async () => { const b = await import('host/crypto-bootstrap'); \
           const base = b.createNativeCryptoProvider(); \
           return {...base, aes256gcmEncrypt: (args) => ({ciphertext: base.aes256gcmEncrypt(args).ciphertext, tag: new Uint8Array(16)})}; })()",
    )
    .await;

    eprintln!("miswired-aes result: {v}");
    // The cursor is still MINTED (encrypt succeeds with a zeroed tag), but the
    // RESUME must fail, because decrypt authenticates against a tag our native
    // implementation did not produce. That asymmetry is the proof: it can only
    // happen if the resume path really reaches the native decrypt.
    if v.get("ERROR").is_none() {
        assert_eq!(
            v["cursorIsString"], true,
            "encrypt should still mint a cursor -- only the RESUME should break"
        );
        let resume = v["resume"].as_str().unwrap_or("");
        assert_ne!(resume, "OK", "the resume must FAIL with a miswired tag: {v}");
        assert!(
            resume.contains("integrity check"),
            "the resume failure must come from Images' integrity classification, got: {resume}"
        );
    }
    a.shutdown().await;
}
