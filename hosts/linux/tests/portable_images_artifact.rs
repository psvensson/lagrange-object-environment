//! Supply-chain pin for the embedded Images portable-runtime source artifact.
//!
//! Images owns production, canonical validation and identity. This test proves
//! only that OE embedded the exact reviewed canonical bytes from the recorded
//! revision; it does not reconstruct Images' closure or artifact validator.

use lagrange_host_linux::images_composition::{
    portable_artifact::{PortableImagesArtifactLoader, PORTABLE_RUNTIME_ALIAS},
    PORTABLE_RUNTIME_ARTIFACT_BYTES, PORTABLE_RUNTIME_ARTIFACT_ENTRY,
    PORTABLE_RUNTIME_ARTIFACT_FORMAT, PORTABLE_RUNTIME_CONTENT_IDENTITY,
    PORTABLE_RUNTIME_SOURCE_REVISION,
};
use lagrange_host_linux::js_env::actor::JsEnvActor;
use rquickjs::loader::Resolver;
use sha2::{Digest, Sha256};

#[test]
fn embedded_portable_runtime_artifact_is_the_pinned_canonical_material() {
    assert_eq!(
        PORTABLE_RUNTIME_SOURCE_REVISION,
        "ccd8321fba3dcdb8f50f5ed481512ac38ad4e138"
    );
    assert_eq!(PORTABLE_RUNTIME_ARTIFACT_BYTES.len(), 1283741);
    assert_eq!(PORTABLE_RUNTIME_ARTIFACT_BYTES.last(), Some(&b'}'));

    let digest = Sha256::digest(PORTABLE_RUNTIME_ARTIFACT_BYTES);
    let actual = format!("sha256:{digest:x}");
    assert_eq!(actual, PORTABLE_RUNTIME_CONTENT_IDENTITY);

    // Minimal consumer compatibility facts only. Closure completeness,
    // canonical ordering/path rules and validation remain Images-owned.
    let artifact: serde_json::Value =
        serde_json::from_slice(PORTABLE_RUNTIME_ARTIFACT_BYTES).expect("pinned artifact is JSON");
    assert_eq!(artifact["format"], PORTABLE_RUNTIME_ARTIFACT_FORMAT);
    assert_eq!(artifact["entry"], PORTABLE_RUNTIME_ARTIFACT_ENTRY);
    assert_eq!(artifact["modules"].as_array().map(Vec::len), Some(117));
    assert!(
        artifact.get("provenance").is_none(),
        "canonical material must not contain the external source provenance"
    );
}

/// ONE Images revision, two consumers: the vendored artifact (native lane) and
/// the CI sibling checkout (JS real-runtime integration lane) must agree, and
/// `PORTABLE_RUNTIME_SOURCE_REVISION` is the authoritative value. A bump that
/// moves one without the other is a hard failure here, never a silent drift.
#[test]
fn ci_sibling_checkout_pins_the_same_images_revision_as_the_artifact() {
    let workflow = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.github/workflows/ci.yml");
    let text = std::fs::read_to_string(&workflow)
        .unwrap_or_else(|e| panic!("the CI workflow must be readable at {}: {e}", workflow.display()));
    // Exactly ONE Images checkout block may exist; a second (with its own ref)
    // would otherwise be invisible to the anchor below.
    assert_eq!(
        text.matches("repository: psvensson/lagrange-images").count(),
        1,
        "ci.yml must check out psvensson/lagrange-images exactly once"
    );
    // Anchor on the sibling-checkout block, then take its `ref:` line. NOTE: the
    // key order `repository:` -> `ref:` -> `path:` is load-bearing for this
    // parse (YAML itself does not require it); a reordering fails CLOSED here.
    let block_start = text
        .find("repository: psvensson/lagrange-images")
        .expect("ci.yml must check out the pinned psvensson/lagrange-images sibling");
    let refs: Vec<&str> = text[block_start..]
        .lines()
        .take_while(|line| !line.trim_start().starts_with("path:"))
        .filter_map(|line| line.trim().strip_prefix("ref:"))
        .map(str::trim)
        .collect();
    assert_eq!(
        refs.len(),
        1,
        "exactly one `ref:` must follow the lagrange-images checkout block, found {refs:?}"
    );
    assert_eq!(
        refs[0], PORTABLE_RUNTIME_SOURCE_REVISION,
        "the JS lane's sibling checkout (src/runtime.js) and the native lane's vendored artifact (src/portable-runtime.js) must consume ONE Images revision: PORTABLE_RUNTIME_SOURCE_REVISION is authoritative"
    );
}

#[test]
fn resolver_has_one_artifact_identity_and_a_closed_namespace() {
    let mut loader = PortableImagesArtifactLoader::from_embedded()
        .expect("construct loader from the pinned artifact")
        .with_host_module("host/probe", "export const marker = 'host-overlay';")
        .expect("register exact host overlay");
    let runtime = rquickjs::Runtime::new().expect("runtime");
    let context = rquickjs::Context::full(&runtime).expect("context");

    context.with(|ctx| {
        let resolve = |loader: &mut PortableImagesArtifactLoader, base: &str, name: &str| {
            Resolver::resolve(loader, &ctx, base, name, None)
        };

        assert_eq!(
            resolve(&mut loader, "host/probe", PORTABLE_RUNTIME_ALIAS).unwrap(),
            PORTABLE_RUNTIME_ARTIFACT_ENTRY
        );
        assert_eq!(
            resolve(
                &mut loader,
                PORTABLE_RUNTIME_ARTIFACT_ENTRY,
                "./support/default-crypto.js"
            )
            .unwrap(),
            "src/support/default-crypto.js"
        );
        assert_eq!(
            resolve(&mut loader, "host/probe", "host/probe").unwrap(),
            "host/probe"
        );

        for forbidden in [
            "support/default-crypto",
            "fs",
            "node:fs",
            "src/not-in-the-artifact.js",
        ] {
            assert!(
                resolve(&mut loader, PORTABLE_RUNTIME_ARTIFACT_ENTRY, forbidden).is_err(),
                "unexpectedly resolved forbidden/unknown specifier {forbidden:?}"
            );
        }
        assert!(
            resolve(
                &mut loader,
                "src/support/default-crypto.js",
                "../../outside.js"
            )
            .is_err(),
            "relative import must not escape the artifact src/ root"
        );
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loader_links_the_artifact_and_preserves_alias_identity() {
    let loader = PortableImagesArtifactLoader::from_embedded()
        .expect("construct loader from the pinned artifact")
        .with_host_module("host/probe", "export const marker = 'host-overlay';")
        .expect("register exact host overlay");
    assert_eq!(loader.entry(), PORTABLE_RUNTIME_ARTIFACT_ENTRY);

    let actor = JsEnvActor::spawn(loader).expect("spawn artifact-backed actor");
    let report = actor
        .eval_async(
            r#"(async () => {
              const exact = await import('src/portable-runtime.js');
              const alias = await import('portable-runtime');
              const host = await import('host/probe');
              const requiredEnvironmentExports = [
                'installSmalltalkKernel',
                'findSmalltalkKernel',
                'defineClass',
                'installCallableInterfaceV2',
                'installImageCreationBinding',
                'installImageMutationBinding',
                'installImageObjectReadBinding',
                'installImageObservationBinding',
                'objectRef',
                'textValue',
                'referencesOfValue',
                'objectResource',
                'parseObjectResource',
                'objectVersionToken',
                'packCompositeValue',
                'unpackCompositeValue',
                'normalizeTypeDeclarations',
                'authorizedReadProject',
                'authorizedRenameProject',
                'createProject',
                'addProjectMember',
                'projectObjectId',
                // Images ADR 0087. Promoted from the admission list below to a
                // REQUIREMENT by Object Environment E1: createImageClientAdapter
                // now refuses to construct without it, so both native
                // compositions genuinely need it from the artifact.
                'authorizedDescribeSmalltalkClass',
                // Images ADR 0087's METHOD seam, promoted from an admission fact to a
                // REQUIREMENT by Object Environment E2: createImageClientAdapter now refuses
                // to construct without it, so both native compositions genuinely need it.
                'authorizedDescribeSmalltalkMethod',
                // Images #218's E3 pair. The FORWARD COMMITMENT recorded here by the
                // admission slice (#80) has been KEPT: Bead eij.3 makes both present-tense
                // facts. NativeSmalltalkBrowser's method read IS
                // authorizedReadSmalltalkMethodForUpdate -- the writer-facing read, so the
                // position token is paired with the descriptor the user is actually shown --
                // and the replace-native-method Command calls
                // authorizedReplaceSmalltalkMethod through the ordinary authorized dispatch
                // lane. Requiring the read without the replacement would have admitted a
                // revision that can show an editable method and never edit it.
                'authorizedReadSmalltalkMethodForUpdate',
                'authorizedReplaceSmalltalkMethod',
                // Images ccd8321 (#231): the METHOD-POSITION AUTHORITY VOCABULARY. A public
                // method read now authorizes `smalltalk-method/read` on the logical
                // {image, Class/Metaclass, selector} position BEFORE resolving anything,
                // instead of `object/read` on the current Block -- so a caller no longer has
                // to predict which immutable revision occupies the position, which is exactly
                // what made E3's post-write reread unobtainable.
                //
                // TENSE, stated precisely because the two lanes differ here: the vocabulary is
                // ALREADY in present-tense use by the JS integration lane, whose composition
                // builds the grant from `src/runtime.js`. Over THIS surface -- the portable
                // artifact the NATIVE compositions consume -- it is still a forward commitment,
                // because the native lane browses only the probe class, which has no selectors
                // to read (Bead aov). Required here anyway, for the reason every admission
                // slice requires ahead: a revision that cannot supply the vocabulary the next
                // slice needs is refused before that slice starts.
                'smalltalkMethodPositionResource',
              ];
              // A CONSTANT, not a function, so it needs its own kind check: the list above is
              // filtered on `typeof !== 'function'` and would report a perfectly present string
              // as missing.
              const requiredEnvironmentConstants = ['SMALLTALK_METHOD_READ_OPERATION'];
              // The authorized native Smalltalk browsing seams the Environment consumes
              // (Images ADR 0087). E1 required only the class seam and said the method seam
              // would join when something called it; E2 called it, so the pair became the
              // consumed contract.
              //
              // PRECISE AFTER E3, because the obvious reading is now wrong: the BROWSER's
              // method read moved to authorizedReadSmalltalkMethodForUpdate, since a
              // replacement token must be paired with the descriptor that is DISPLAYED and a
              // second read beside it would pair a token with a resolution nobody was shown.
              // authorizedDescribeSmalltalkMethod stays required and stays exposed as the
              // adapter's LOOK-ONLY method capability -- Images keeps the reader/writer split
              // deliberately -- and E3's acceptance exercises it as the INDEPENDENT
              // cross-check that both seams answer the same revision after a replacement. It
              // is no longer on a production display path, and saying otherwise here would be
              // the kind of stale justification this list exists to prevent.
              //
              // Images' class-building and Cuis-import helpers are STILL not required: the
              // native lane deliberately cannot construct a class or install a selector, and
              // that gap is Bead lagrange-object-environment-aov, not something to paper over
              // by widening this list.
              const consumedNativeBrowseSeams = [
                'authorizedDescribeSmalltalkClass',
                'authorizedDescribeSmalltalkMethod',
                // E3's writer-facing read. Same owner as the two describe seams, so it belongs
                // to this group and its owner identity is proven by the same comparison.
                'authorizedReadSmalltalkMethodForUpdate',
              ];
              // E3's REPLACEMENT seam has a DIFFERENT owner module, so it cannot ride on the
              // browse group's identity check: comparing it against smalltalk-browse.js would
              // compare `undefined === undefined` and pass vacuously at any revision. It gets
              // its own group named after its own owner.
              const consumedNativeReplacementSeams = ['authorizedReplaceSmalltalkMethod'];
              // Owners E3's adapter is forbidden to use: it must not mint or parse a position
              // token, nor call reconciliation directly.
              //
              // WHAT THIS ACTUALLY PROVES, stated narrowly because the obvious stronger reading
              // is FALSE: the portable-runtime BARREL does not re-export them. It does NOT make
              // them unreachable. All four modules are inside the artifact closure, and the
              // loader resolves any bare `src/...` specifier from any base -- the owner-identity
              // checks above rely on exactly that to import their owner modules -- so one deep
              // import still reaches every one of them. Verified by probe, not assumed.
              //
              // So this is a REGRESSION DETECTOR, not an enforcement mechanism: it fails loudly
              // if a later revision promotes one of these to the public barrel, which is the
              // moment to re-decide rather than quietly start depending on it. The rule that
              // E3's adapter does not import them is enforced by review and by a fence over the
              // Environment's OWN source, which belongs with the E3 slice that adds the adapter
              // -- not here. Bead recorded.
              // The method-position authority vocabulary is a THIRD owner module, so it gets
              // its own identity group for the same reason the replacement seam did: comparing
              // it against smalltalk-browse.js would compare `undefined === undefined` and pass
              // vacuously at any revision.
              const consumedMethodPositionAuthority = [
                'SMALLTALK_METHOD_READ_OPERATION',
                'smalltalkMethodPositionResource',
              ];
              const forbiddenPrivateOwners = [
                'smalltalkMethodPositionToken',
                'parseSmalltalkMethodPositionToken',
                'reconcileMethodsFromSource',
                'reconcileMethods',
              ];
              return {
                sameModule: exact.setDefaultCryptoProvider === alias.setDefaultCryptoProvider,
                marker: host.marker,
                exportedCreate: typeof exact.createPortableRuntime,
                requiredEnvironmentExportCount: requiredEnvironmentExports.length,
                missingEnvironmentExports: requiredEnvironmentExports.filter(
                  (name) => typeof alias[name] !== 'function',
                ),
                // BY NAME, not by count. The count above is a non-vacuity/closure check --
                // it catches a list silently shrinking -- while THESE are the semantic
                // contract: the exact functions the Environment calls are exported, callable,
                // and named by the requirement list.
                consumedNativeBrowseSeamNames: consumedNativeBrowseSeams,
                uncallableNativeBrowseSeams: consumedNativeBrowseSeams.filter(
                  (name) => typeof alias[name] !== 'function',
                ),
                unrequiredNativeBrowseSeams: consumedNativeBrowseSeams.filter(
                  (name) => !requiredEnvironmentExports.includes(name),
                ),
                // The seam reached through the public alias must be the EXACT function the
                // OWNER module defines, not a wrapper the barrel built. Comparing the alias to
                // the canonical entry would prove nothing -- the alias RESOLVES to that entry,
                // so both names denote one module namespace and `===` holds for every key,
                // `undefined === undefined` included. The owner module is the only comparison
                // that can fail, and it also fails CLOSED at a revision whose closure does not
                // carry it (import throws -> false).
                browseSeamsAreOwnerFunctions: await (async () => {
                  let owner = null;
                  try {
                    owner = await import('src/language/smalltalk-browse.js');
                  } catch {
                    return false;
                  }
                  return consumedNativeBrowseSeams.every(
                    (name) => typeof owner[name] === 'function' && owner[name] === alias[name],
                  );
                })(),
                consumedNativeReplacementSeamNames: consumedNativeReplacementSeams,
                uncallableNativeReplacementSeams: consumedNativeReplacementSeams.filter(
                  (name) => typeof alias[name] !== 'function',
                ),
                unrequiredNativeReplacementSeams: consumedNativeReplacementSeams.filter(
                  (name) => !requiredEnvironmentExports.includes(name),
                ),
                // Same owner-identity rule as the browse group, against the replacement seam's
                // OWN owner module.
                replacementSeamsAreOwnerFunctions: await (async () => {
                  let owner = null;
                  try {
                    owner = await import('src/language/smalltalk-authorized-method-replacement.js');
                  } catch {
                    return false;
                  }
                  return consumedNativeReplacementSeams.every(
                    (name) => typeof owner[name] === 'function' && owner[name] === alias[name],
                  );
                })(),
                consumedMethodPositionAuthorityNames: consumedMethodPositionAuthority,
                missingEnvironmentConstants: requiredEnvironmentConstants.filter(
                  (name) => typeof alias[name] !== 'string' || alias[name].length === 0,
                ),
                unrequiredMethodPositionAuthority: consumedMethodPositionAuthority.filter(
                  (name) => !requiredEnvironmentExports.includes(name)
                    && !requiredEnvironmentConstants.includes(name),
                ),
                // Owner identity, per KIND: the function by reference, the operation by value
                // (string equality IS value identity). Both guarded against the vacuous
                // `undefined === undefined`, and a failed import returns false.
                methodPositionAuthorityAreOwnerValues: await (async () => {
                  let owner = null;
                  try {
                    owner = await import('src/language/smalltalk-method-position-resource.js');
                  } catch {
                    return false;
                  }
                  return typeof owner.SMALLTALK_METHOD_READ_OPERATION === 'string'
                    && owner.SMALLTALK_METHOD_READ_OPERATION.length > 0
                    && owner.SMALLTALK_METHOD_READ_OPERATION === alias.SMALLTALK_METHOD_READ_OPERATION
                    && typeof owner.smalltalkMethodPositionResource === 'function'
                    && owner.smalltalkMethodPositionResource === alias.smalltalkMethodPositionResource;
                })(),
                // The WIRE VALUE a composition writes into a grant, read from the artifact.
                methodPositionOperation: alias.SMALLTALK_METHOD_READ_OPERATION ?? null,
                // THE PROPERTY THE ENVIRONMENT ACTUALLY DEPENDS ON: the resource is nameable
                // from public vocabulary ALONE. Called here against an image that does not
                // exist in this runtime at all -- no graph state, no Block id, nothing read --
                // and it must still answer a stable value that varies with the selector.
                methodPositionResourceIsPureVocabulary: (() => {
                  const classRef = {kind: 'ref', imageId: 'no-such-image', objectId: 'smalltalk/class/X'};
                  let a; let b; let c;
                  try {
                    a = alias.smalltalkMethodPositionResource('no-such-image', classRef, 'foo');
                    b = alias.smalltalkMethodPositionResource('no-such-image', classRef, 'foo');
                    c = alias.smalltalkMethodPositionResource('no-such-image', classRef, 'bar');
                  } catch {
                    return false;
                  }
                  return typeof a === 'string' && a.length > 0 && a === b && a !== c;
                })(),
                exposedPrivateOwners: forbiddenPrivateOwners.filter(
                  (name) => alias[name] !== undefined,
                ),
              };
            })()"#,
        )
        .await
        .expect("link and evaluate pinned artifact closure");
    let report: serde_json::Value = serde_json::from_str(&report).expect("JSON report");
    assert_eq!(report["sameModule"], true);
    assert_eq!(report["marker"], "host-overlay");
    assert_eq!(report["exportedCreate"], "function");
    // A NON-VACUITY / closure check only: it catches the requirement list silently
    // shrinking. The semantic contract is the by-name assertions below.
    assert_eq!(report["requiredEnvironmentExportCount"], 27);
    assert_eq!(
        report["missingEnvironmentExports"],
        serde_json::json!([]),
        "every B3 composition helper must be callable through the sole public portable-runtime alias"
    );
    // The consumed-seam list itself, pinned against silent shrinkage. This pair of
    // literals is artifact-INDEPENDENT and cannot fail for any Images revision -- it has
    // the same non-vacuity role as the count above, and is not itself the semantic
    // contract. The contract is the three assertions after it, which do read the artifact.
    assert_eq!(
        report["consumedNativeBrowseSeamNames"],
        serde_json::json!([
            "authorizedDescribeSmalltalkClass",
            "authorizedDescribeSmalltalkMethod",
            "authorizedReadSmalltalkMethodForUpdate"
        ])
    );
    assert_eq!(
        report["uncallableNativeBrowseSeams"],
        serde_json::json!([]),
        "the pinned revision must LINK and expose both ADR 0087 browse seams through the public alias"
    );
    assert_eq!(
        report["unrequiredNativeBrowseSeams"],
        serde_json::json!([]),
        "the Environment's requirement list must NAME each consumed seam, not merely be long enough"
    );
    assert_eq!(
        report["browseSeamsAreOwnerFunctions"], true,
        "the alias must expose each browse seam as the exact function src/language/smalltalk-browse.js defines"
    );
    // E3's replacement seam: a separate owner, so a separate identity proof.
    assert_eq!(
        report["consumedNativeReplacementSeamNames"],
        serde_json::json!(["authorizedReplaceSmalltalkMethod"])
    );
    // Images ccd8321 (#231): the method-position authority vocabulary, by name and by
    // owner, on the same rules as the two seam groups above.
    assert_eq!(
        report["consumedMethodPositionAuthorityNames"],
        serde_json::json!(["SMALLTALK_METHOD_READ_OPERATION", "smalltalkMethodPositionResource"])
    );
    assert_eq!(
        report["missingEnvironmentConstants"],
        serde_json::json!([]),
        "the pinned revision must expose the method-read operation constant through the public alias"
    );
    assert_eq!(
        report["unrequiredMethodPositionAuthority"],
        serde_json::json!([]),
        "the requirement lists must NAME each consumed authority value, not merely be long enough"
    );
    assert_eq!(
        report["methodPositionAuthorityAreOwnerValues"], true,
        "the alias must expose the exact values src/language/smalltalk-method-position-resource.js defines"
    );
    assert_eq!(
        report["methodPositionOperation"], "smalltalk-method/read",
        "the operation a composition writes into a grant is read from the artifact, never assumed"
    );
    assert_eq!(
        report["methodPositionResourceIsPureVocabulary"], true,
        "a method-position resource must be nameable from the image id, class ref and selector \
         alone -- no graph state, no Block id -- which is the whole property that makes E3's \
         post-write reread obtainable"
    );
    assert_eq!(
        report["uncallableNativeReplacementSeams"],
        serde_json::json!([]),
        "the pinned revision must LINK and expose the E3 replacement seam through the public alias"
    );
    assert_eq!(
        report["unrequiredNativeReplacementSeams"],
        serde_json::json!([]),
        "the Environment's requirement list must NAME the replacement seam it consumes"
    );
    assert_eq!(
        report["replacementSeamsAreOwnerFunctions"], true,
        "the alias must expose the replacement seam as the exact function \
         src/language/smalltalk-authorized-method-replacement.js defines"
    );
    assert_eq!(
        report["exposedPrivateOwners"],
        serde_json::json!([]),
        "the portable surface must not offer the token mint/parser or the reconciliation owners. \
         This is a REGRESSION DETECTOR on the public barrel, not enforcement -- the block comment \
         at the list says why, and a deep import still reaches every one of them. Enforcement over \
         the Environment's OWN source belongs with the E3 slice that adds the adapter (Bead 04f)"
    );

    actor.shutdown().await;
}
