//! Bead 3zb slice B1c ACCEPTANCE: the production host globals are what actually
//! unlock real `lagrange-images` execution in-process.
//!
//! The headline is deliberately stronger than "our clone corpus passes":
//!
//!   production host globals
//!       -> real lagrange-images portable closure
//!       -> mock backend
//!       -> real observation binding
//!       -> a real cursor returned AND resumed
//!
//! Nothing here is an Environment or OE module: no `createImageClientAdapter`,
//! no injected executor registry, no `ensureSchema`. `createPortableRuntime`
//! already registers the observation executor and already exposes
//! `runtime.authority`, so this is Images composing itself, driven from Rust.
//! The recipe mirrors Images' OWN test (`test/image-observation-binding.test.js`)
//! rather than OE's B3 composition, so a failure here is attributable to the
//! host facilities and not to Environment wiring.
//!
//! WHAT IT PROVES FOR B1C SPECIFICALLY. Composing a runtime fails at
//! `LanguagePlatform.register` without `structuredClone`, and the hot paths
//! underneath this flow lean on it continuously: `mock-backend` clones EVERY
//! value entering and leaving storage, and `graph-image-service` clones every
//! durable put record and history event. A cursor cannot be returned and
//! resumed unless those clone paths ran correctly, so this exercises the real
//! implementation rather than asserting it exists.
//!
//! CRYPTO IS DELIBERATELY A DETERMINISTIC TEST PROVIDER HERE. B1c is about host
//! globals; the NATIVE crypto provider is Bead 3zb slice B1b, which will replace
//! the stub below and add the NIST/FIPS vectors and the tamper falsifier. The
//! stub is honest about being one: it is not a security claim, and it is the
//! reason this file makes no assertion about cursor confidentiality.
//!
//! The Images sources are read from the SIBLING REPO CHECKOUT, which is
//! probe/development machinery, not the production module-source mechanism.
//! Slice B2 replaces it with the Images-owned `lagrange-images-portable-runtime/v1`
//! artifact; this test should then swap loaders and keep asserting the same
//! things.

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

/// Path-preserving loader over the sibling Images `src/` tree. Deliberately
/// boring: a resolved specifier maps to exactly one file and a missing one fails
/// loudly. Development machinery only (see the module header).
#[derive(Clone)]
struct RepoTreeLoader {
    root: PathBuf,
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

impl Resolver for RepoTreeLoader {
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

impl Loader for RepoTreeLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attrs: Option<ImportAttributes<'js>>,
    ) -> Result<Module<'js, rquickjs::module::Declared>> {
        let path = self.root.join(format!("{name}.js"));
        let src = std::fs::read_to_string(&path)
            .map_err(|e| Error::new_loading_message(name, format!("{}: {e}", path.display())))?;
        Module::declare(ctx.clone(), name, src)
    }
}

/// Compose the real portable runtime and drive a real observation round trip.
/// Returns a JSON report; every failure is reported as `{ERROR, stack}` so a
/// regression names the Images call site rather than surfacing as an opaque
/// rquickjs `Exception`.
const OBSERVE: &str = r#"(async () => { try {
  const dc = await import('support/default-crypto');
  // DETERMINISTIC TEST PROVIDER (see the module header): B1b replaces this with
  // the native one. Not a security claim.
  let uuidCalls = 0;
  dc.setDefaultCryptoProvider({
    secureRandomBytes: (len) => new Uint8Array(len).fill(7),
    sha256: (b) => { const o = new Uint8Array(32); for (let i = 0; i < b.length; i++) o[i % 32] ^= b[i]; return o; },
    aes256gcmEncrypt: ({plaintext}) => ({ciphertext: new Uint8Array(plaintext), tag: new Uint8Array(16).fill(3)}),
    aes256gcmDecrypt: ({ciphertext, tag}) => {
      for (const t of tag) if (t !== 3) throw new TypeError('authentication failed');
      return new Uint8Array(ciphertext);
    },
    uuid: () => `00000000-0000-4000-8000-${String(++uuidCalls).padStart(12, '0')}`,
  });

  const pr  = await import('portable-runtime');
  const tg  = await import('callable/type-grammar');
  const sc  = await import('value/scalars');
  const sk  = await import('language/smalltalk-kernel');
  const iv2 = await import('callable/interface-v2-artifacts');
  const iob = await import('callable/image-observation-binding');
  const cc  = await import('callable/composite-codec');

  const TYPES = tg.normalizeTypeDeclarations({
    'obs-event': {kind: 'record', fields: [
      {name: 'object-id', type: 'string'}, {name: 'kind', type: 'string'}, {name: 'cursor', type: 'string'}]},
    'obs-result': {kind: 'record', fields: [
      {name: 'events', type: {kind: 'list', element: 'obs-event'}}, {name: 'cursor', type: 'string'}]},
  });

  const runtime = await pr.createPortableRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: 'demo'});
  await sk.installSmalltalkKernel({images: runtime.images, imageId: 'demo'});

  const ci = await iv2.installCallableInterfaceV2({
    images: runtime.images, imageId: 'demo', interfaceId: 'observe',
    functionName: 'observe', parameters: ['string'], result: 'obs-result', types: TYPES,
  });
  await iob.installImageObservationBinding({
    images: runtime.images,
    callableInterface: sc.objectRef('demo', ci.id),
    bindingId: 'observation', blockId: 'observation-block',
  });

  const observe = async (after = '') => {
    const activation = await runtime.invocations.invokeBlock(
      sc.objectRef('demo', 'observation-block'), [sc.textValue(after)]);
    const packed = await runtime.executor.execute(activation, {});
    return cc.unpackCompositeValue(packed, 'obs-result', TYPES);
  };
  const cursorOf = (r) => r.cursor?.value ?? r.cursor;

  const first = await observe('');
  const cursor = cursorOf(first);
  const resumed = await observe(cursor);

  // A malformed cursor is refused BEFORE any scan.
  let malformed = 'NO-THROW';
  try { await observe('!!!not-a-cursor!!!'); }
  catch (e) { malformed = (e && e.name) + ': ' + (e && e.message); }

  return {
    cursorIsString: typeof cursor === 'string',
    cursorLength: String(cursor).length,
    resumedCursorIsString: typeof cursorOf(resumed) === 'string',
    malformed,
    uuidCalls,
    structuredCloneUsed: typeof structuredClone,
  };
} catch (e) {
  return {ERROR: (e && e.name) + ': ' + (e && e.message), stack: String(e && e.stack).slice(0, 900)};
} })()"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn production_host_globals_unlock_real_images_observation() {
    let actor = JsEnvActor::spawn(RepoTreeLoader { root: images_src_root() }).expect("spawn actor");
    let json = actor.eval_async(OBSERVE).await.expect("observe flow must not raise");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert!(
        v.get("ERROR").is_none(),
        "real Images observation failed: {} / {}",
        v["ERROR"], v["stack"]
    );
    assert_eq!(
        v["structuredCloneUsed"], "function",
        "the production structuredClone must be the one in play"
    );
    assert_eq!(v["cursorIsString"], true, "observe('') must return a real cursor");
    assert!(
        v["cursorLength"].as_u64().unwrap_or(0) > 16,
        "the cursor must be a real opaque token, got length {}",
        v["cursorLength"]
    );
    assert_eq!(
        v["resumedCursorIsString"], true,
        "resuming from the returned cursor must succeed -- this is the leg that proves \
         encode AND decode both ran through the provider"
    );
    // A malformed cursor is rejected at PARSING, before the integrity check.
    // (The AES authentication path needs a well-formed but corrupted cursor;
    // that falsifier belongs to B1b, with the native provider.)
    assert!(
        v["malformed"].as_str().unwrap_or("").starts_with("TypeError:"),
        "a malformed cursor must be refused, got {}",
        v["malformed"]
    );
    assert!(
        v["uuidCalls"].as_u64().unwrap_or(0) > 0,
        "composing the runtime must consume the installed provider"
    );

    actor.shutdown().await;
}

/// NON-VACUITY: the test above must be GREEN *because of* B1c, not incidentally.
/// Removing `structuredClone` from an otherwise identical runtime must break
/// composition at the exact Images call site the spike originally hit -- so this
/// pins the claim "this is the missing host facility that unlocks Images
/// execution" rather than merely asserting the global exists.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn without_structured_clone_real_images_cannot_even_compose() {
    let actor = JsEnvActor::spawn(RepoTreeLoader { root: images_src_root() }).expect("spawn actor");
    let json = actor
        .eval_async(
            r#"(async () => { try {
  delete globalThis.structuredClone;
  const dc = await import('support/default-crypto');
  dc.setDefaultCryptoProvider({
    secureRandomBytes: (len) => new Uint8Array(len).fill(7),
    sha256: () => new Uint8Array(32),
    aes256gcmEncrypt: ({plaintext}) => ({ciphertext: new Uint8Array(plaintext), tag: new Uint8Array(16)}),
    aes256gcmDecrypt: ({ciphertext}) => new Uint8Array(ciphertext),
    uuid: () => '00000000-0000-4000-8000-000000000000',
  });
  const pr = await import('portable-runtime');
  await pr.createPortableRuntime({backend: {mode: 'mock'}});
  return {composed: 'UNEXPECTED-SUCCESS'};
} catch (e) {
  return {name: e && e.name, message: String(e && e.message), stack: String(e && e.stack).slice(0, 300)};
} })()"#,
        )
        .await
        .expect("probe must return");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_ne!(
        v["composed"], "UNEXPECTED-SUCCESS",
        "composing real Images without structuredClone must FAIL; if this ever succeeds, \
         either Images stopped needing it or the acceptance test above proves less than it claims"
    );
    assert_eq!(v["name"], "ReferenceError", "expected the missing-global failure, got {v}");
    assert!(
        v["message"].as_str().unwrap_or("").contains("structuredClone"),
        "the failure must name structuredClone, got {}",
        v["message"]
    );
    // The call site is Images' language registration -- recorded so a future
    // reader can see WHERE the dependency bites, not just that it exists.
    assert!(
        v["stack"].as_str().unwrap_or("").contains("language-platform"),
        "expected the failure at language/language-platform (LanguagePlatform.register \
         clones every descriptor), got stack: {}",
        v["stack"]
    );

    actor.shutdown().await;
}
