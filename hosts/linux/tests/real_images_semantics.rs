//! Bead 3zb-B3 part 1: the unchanged `ImageClientAdapter` and real portable
//! Images coexist in-process under rquickjs.
//!
//! This is deliberately headless and adapter-only. It does not exercise or
//! claim ObjectNavigator, EnvironmentShell, CommandRouter, a renderer, GTK, or
//! the plain-data/WIT-shaped Images capability boundary. The independent fake
//! acceptance remains the proof of that boundary; this test proves real Images
//! integration semantics behind the same Environment-owned adapter.

#[path = "support/public_entry_composition_loader.rs"]
mod public_entry_composition_loader;

use lagrange_host_linux::images_composition::portable_artifact::PORTABLE_RUNTIME_ALIAS;
use lagrange_host_linux::js_env::{actor::JsEnvActor, EmbeddedLoader};
use public_entry_composition_loader::{ExternalArtifactResolutions, PublicEntryCompositionLoader};
use serde_json::{json, Value};

const COMPOSITION: &str = include_str!("real-images-composition.mjs");
const FULL_ACCEPTANCE_COMPOSITION: &str = include_str!("real-images-acceptance-composition.mjs");

fn actor() -> (JsEnvActor, ExternalArtifactResolutions) {
    let environment = EmbeddedLoader::new()
        .with_module("model", include_str!("../../../src/model.js"))
        .with_module(
            "image-observation",
            include_str!("../../../src/image-observation.js"),
        )
        .with_module(
            "command-dispatcher",
            include_str!("../../../src/command-dispatcher.js"),
        )
        .with_module(
            "perspective-projection",
            include_str!("../../../src/perspective-projection.js"),
        )
        .with_module(
            "image-client-adapter",
            include_str!("../../../src/image-client-adapter.js"),
        )
        .with_module("test/real-images-composition", COMPOSITION);
    let (loader, external_artifact_resolutions) = PublicEntryCompositionLoader::new(environment)
        .expect("construct combined public-entry composition loader");

    // Ordering is load-bearing: the artifact resolver must claim and
    // canonicalize `portable-runtime` before EmbeddedLoader sees the bare name.
    let actor = JsEnvActor::spawn(loader).expect("spawn combined artifact/Env actor");
    (actor, external_artifact_resolutions)
}

fn skip_js_trivia(source: &[u8], cursor: &mut usize) {
    loop {
        while source.get(*cursor).is_some_and(u8::is_ascii_whitespace) {
            *cursor += 1;
        }
        if source.get(*cursor..*cursor + 2) == Some(b"//") {
            *cursor += 2;
            while source
                .get(*cursor)
                .is_some_and(|byte| !matches!(*byte, b'\r' | b'\n'))
            {
                *cursor += 1;
            }
            continue;
        }
        if source.get(*cursor..*cursor + 2) == Some(b"/*") {
            *cursor += 2;
            while *cursor + 1 < source.len() && &source[*cursor..*cursor + 2] != b"*/" {
                *cursor += 1;
            }
            *cursor = (*cursor + 2).min(source.len());
            continue;
        }
        break;
    }
}

fn skip_js_string(source: &[u8], cursor: &mut usize) -> Option<String> {
    let quote = *source.get(*cursor)?;
    if !matches!(quote, b'\'' | b'"' | b'`') {
        return None;
    }
    *cursor += 1;
    let start = *cursor;
    while let Some(byte) = source.get(*cursor) {
        if *byte == b'\\' {
            *cursor = (*cursor + 2).min(source.len());
        } else if *byte == quote {
            let value = String::from_utf8_lossy(&source[start..*cursor]).into_owned();
            *cursor += 1;
            return Some(value);
        } else {
            *cursor += 1;
        }
    }
    None
}

fn is_js_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$')
}

fn extract_static_from(source: &[u8], cursor: &mut usize, specifiers: &mut Vec<String>) {
    while *cursor < source.len() && source[*cursor] != b';' {
        skip_js_trivia(source, cursor);
        if source.get(*cursor) == Some(&b'`') {
            specifiers.push("<unsupported-template-literal>".to_string());
            let _ = skip_js_string(source, cursor);
            continue;
        }
        if source.get(*cursor) == Some(&b'/') {
            specifiers.push("<unsupported-slash-token>".to_string());
            *cursor += 1;
            continue;
        }
        if matches!(source.get(*cursor).copied(), Some(b'\'' | b'"')) {
            let _ = skip_js_string(source, cursor);
            continue;
        }
        if source
            .get(*cursor)
            .is_some_and(|byte| is_js_identifier_byte(*byte))
        {
            let start = *cursor;
            while source
                .get(*cursor)
                .is_some_and(|byte| is_js_identifier_byte(*byte))
            {
                *cursor += 1;
            }
            if &source[start..*cursor] == b"from" {
                skip_js_trivia(source, cursor);
                specifiers.push(
                    skip_js_string(source, cursor)
                        .unwrap_or_else(|| "<non-literal-static-dependency>".to_string()),
                );
                break;
            }
        } else {
            *cursor += 1;
        }
    }
}

fn extract_indirect_export(source: &[u8], cursor: &mut usize, specifiers: &mut Vec<String>) {
    let mut probe = *cursor;
    skip_js_trivia(source, &mut probe);

    match source.get(probe).copied() {
        Some(b'{') => {
            let mut depth = 0usize;
            loop {
                skip_js_trivia(source, &mut probe);
                match source.get(probe).copied() {
                    Some(b'{') => {
                        depth += 1;
                        probe += 1;
                    }
                    Some(b'}') => {
                        depth -= 1;
                        probe += 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    Some(b'`') => {
                        specifiers.push("<unsupported-template-literal>".to_string());
                        return;
                    }
                    Some(b'/') => {
                        specifiers.push("<unsupported-slash-token>".to_string());
                        return;
                    }
                    Some(b'\'' | b'"') => {
                        specifiers.push("<unsupported-export-string>".to_string());
                        return;
                    }
                    Some(_) => probe += 1,
                    None => {
                        specifiers.push("<unterminated-export-list>".to_string());
                        return;
                    }
                }
            }
            // A local `export {name}` has no dependency. Commit only through
            // the closing brace so a semicolonless following import remains
            // visible to the main scanner.
            *cursor = probe;
        }
        Some(b'*') => {
            probe += 1;
            skip_js_trivia(source, &mut probe);
            if source.get(probe..probe + 2) == Some(b"as")
                && !source
                    .get(probe + 2)
                    .is_some_and(|byte| is_js_identifier_byte(*byte))
            {
                probe += 2;
                skip_js_trivia(source, &mut probe);
                if matches!(source.get(probe).copied(), Some(b'\'' | b'"')) {
                    if skip_js_string(source, &mut probe).is_none() {
                        specifiers.push("<unterminated-export-alias>".to_string());
                        return;
                    }
                } else {
                    let alias_start = probe;
                    while source
                        .get(probe)
                        .is_some_and(|byte| is_js_identifier_byte(*byte))
                    {
                        probe += 1;
                    }
                    if alias_start == probe {
                        specifiers.push("<unsupported-export-alias>".to_string());
                        return;
                    }
                }
            }
            *cursor = probe;
        }
        // `export const/function/class/default ...` may contain a dynamic
        // import. Do not consume any of the declaration; the main scanner must
        // see every following token.
        _ => return,
    }

    skip_js_trivia(source, &mut probe);
    let from_start = probe;
    while source
        .get(probe)
        .is_some_and(|byte| is_js_identifier_byte(*byte))
    {
        probe += 1;
    }
    if &source[from_start..probe] != b"from" {
        return;
    }
    skip_js_trivia(source, &mut probe);
    specifiers.push(
        skip_js_string(source, &mut probe)
            .unwrap_or_else(|| "<non-literal-static-dependency>".to_string()),
    );
    *cursor = probe;
}

/// Extract every literal ESM dependency form used by JavaScript: static
/// `import ... from 'x'`, side-effect `import 'x'`, dynamic `import('x')`, and
/// indirect `export ... from 'x'`. Comments and string contents are skipped,
/// so prose cannot satisfy the fence.
fn import_specifiers(source: &str) -> Vec<String> {
    // The audit intentionally supports the ASCII-only lexical subset used by
    // the bounded composition. QuickJS recognizes additional Unicode spaces
    // and line terminators, so rejecting any non-ASCII byte prevents those
    // forms from desynchronizing comment or token boundaries.
    if !source.is_ascii() {
        return vec!["<unsupported-non-ascii-source>".to_string()];
    }

    let source = source.as_bytes();
    let mut cursor = 0;
    let mut specifiers = Vec::new();

    while cursor < source.len() {
        skip_js_trivia(source, &mut cursor);
        let Some(byte) = source.get(cursor).copied() else {
            break;
        };
        // This deliberately small audit fails closed on JavaScript lexical
        // constructs it does not model. Template interpolation can execute an
        // import inside `${...}`, and a quote-bearing regex can desynchronize a
        // hand-written string scanner. The bounded composition needs neither
        // templates nor regex/division, so either token breaks the allowlist.
        if byte == b'`' {
            specifiers.push("<unsupported-template-literal>".to_string());
            let _ = skip_js_string(source, &mut cursor);
            continue;
        }
        if byte == b'/' {
            specifiers.push("<unsupported-slash-token>".to_string());
            cursor += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"') {
            let _ = skip_js_string(source, &mut cursor);
            continue;
        }
        if !is_js_identifier_byte(byte) {
            cursor += 1;
            continue;
        }

        let word_start = cursor;
        while source
            .get(cursor)
            .is_some_and(|byte| is_js_identifier_byte(*byte))
        {
            cursor += 1;
        }
        let keyword = &source[word_start..cursor];
        if keyword == b"export" {
            extract_indirect_export(source, &mut cursor, &mut specifiers);
            continue;
        }
        if keyword == b"eval" || keyword == b"Function" {
            specifiers.push("<unsupported-dynamic-code>".to_string());
            continue;
        }
        if keyword != b"import" {
            continue;
        }

        skip_js_trivia(source, &mut cursor);
        match source.get(cursor).copied() {
            // `import.meta` is not a module load.
            Some(b'.') => continue,
            // Dynamic import. Non-literal specifiers are rejected by recording
            // a sentinel that cannot match the bounded allowlist.
            Some(b'(') => {
                cursor += 1;
                skip_js_trivia(source, &mut cursor);
                if source.get(cursor) == Some(&b'`') {
                    specifiers.push("<unsupported-template-dynamic-import>".to_string());
                    let _ = skip_js_string(source, &mut cursor);
                } else {
                    specifiers.push(
                        skip_js_string(source, &mut cursor)
                            .unwrap_or_else(|| "<non-literal-dynamic-import>".to_string()),
                    );
                    skip_js_trivia(source, &mut cursor);
                    if source.get(cursor) != Some(&b')') {
                        specifiers.push("<unsupported-dynamic-import-expression>".to_string());
                    }
                }
            }
            // Side-effect import.
            Some(b'\'' | b'"') => {
                specifiers.push(skip_js_string(source, &mut cursor).expect("quoted import"));
            }
            // Static declaration: scan its bounded statement for `from`.
            _ => extract_static_from(source, &mut cursor, &mut specifiers),
        }
    }

    specifiers
}

fn is_forbidden_images_specifier(specifier: &str) -> bool {
    specifier.starts_with("src/")
        || specifier.starts_with("lagrange-images")
        || specifier.contains("/lagrange-images/")
        || specifier.starts_with("../")
}

#[test]
fn composition_uses_only_the_public_images_entry() {
    let specifiers = import_specifiers(COMPOSITION);
    assert_eq!(
        specifiers,
        vec![
            "image-client-adapter".to_string(),
            "portable-runtime".to_string(),
            "host/crypto-bootstrap".to_string(),
        ],
        "the bounded composition has one Env root, one public Images root, and one host overlay"
    );
    assert!(
        specifiers
            .iter()
            .all(|specifier| !is_forbidden_images_specifier(specifier)),
        "the composition must not deep-import Images or name a sibling/package path"
    );

    let full_specifiers = import_specifiers(FULL_ACCEPTANCE_COMPOSITION);
    assert_eq!(
        full_specifiers,
        vec![
            "model".to_string(),
            "environment-shell".to_string(),
            "compositor".to_string(),
            "object-navigator".to_string(),
            "command-router".to_string(),
            "command-registry".to_string(),
            "presentation-registry".to_string(),
            "object-presentation-providers".to_string(),
            "selection-model".to_string(),
            "image-client-adapter".to_string(),
            "image-observation".to_string(),
            "portable-runtime".to_string(),
            "host/crypto-bootstrap".to_string(),
        ],
        "the full composition has only flat Environment roots, one public Images root, and one host overlay"
    );
    assert!(
        full_specifiers
            .iter()
            .all(|specifier| !is_forbidden_images_specifier(specifier)),
        "the full composition must not deep-import Images or name a sibling/package path"
    );

    let planted_source = r#"
        import 'src/value/scalars.js';
        const privateModule = await import("lagrange-images/src/value/scalars.js");
        import {objectRef} from '../lagrange-images/src/value/scalars.js';
        export {objectRef} from 'src/value/scalars.js';
        export * from 'src/value/scalars.js';
        export * as scalars from '../lagrange-images/src/value/scalars.js';
        export * as "escape" from "src/value/scalars.js";
    "#;
    let planted_specifiers = import_specifiers(planted_source);
    assert_eq!(
        planted_specifiers.len(),
        7,
        "the fence must extract static-from, side-effect, dynamic, and every indirect re-export dependency"
    );
    for planted in planted_specifiers {
        assert!(
            is_forbidden_images_specifier(&planted),
            "specifier fence missed planted private import {planted:?}"
        );
    }

    let planted_lexical_bypasses = r#"
        const hidden = `${(await import('src/value/scalars.js')).objectRef}`;
        const matcher = /'/; await import('src/value/scalars.js');
    "#;
    let bypass_results = import_specifiers(planted_lexical_bypasses);
    assert!(
        bypass_results.contains(&"<unsupported-template-literal>".to_string()),
        "template interpolation must fail closed rather than hide an executable import"
    );
    assert!(
        bypass_results.contains(&"<unsupported-slash-token>".to_string()),
        "regex/division syntax must fail closed rather than desynchronize quote tracking"
    );

    let planted_export_interactions = r#"
        export const escaped = import('src/value/scalars.js');
        export {escaped}
        import '../lagrange-images/src/value/scalars.js';
    "#;
    let export_interaction_results = import_specifiers(planted_export_interactions);
    assert_eq!(
        export_interaction_results,
        vec![
            "src/value/scalars.js".to_string(),
            "../lagrange-images/src/value/scalars.js".to_string(),
        ],
        "ordinary exports must not hide nested or semicolonless following imports"
    );

    for planted_unicode_boundary in [
        "import\u{00a0}'src/value/scalars.js';",
        "// comment\u{2028}import 'src/value/scalars.js';",
    ] {
        assert_eq!(
            import_specifiers(planted_unicode_boundary),
            vec!["<unsupported-non-ascii-source>".to_string()],
            "Unicode lexical boundaries must fail closed"
        );
    }

    let compound_dynamic_import = "import('portable-runtime' && 'src/value/scalars.js')";
    assert_eq!(
        import_specifiers(compound_dynamic_import),
        vec![
            "portable-runtime".to_string(),
            "<unsupported-dynamic-import-expression>".to_string(),
        ],
        "a quoted prefix must not disguise a compound dynamic-import target"
    );
    assert_eq!(
        import_specifiers("await eval(\"import('src/value/scalars.js')\")"),
        vec!["<unsupported-dynamic-code>".to_string()],
        "string-to-code facilities must fail the bounded source audit"
    );
    assert_eq!(
        import_specifiers("// benign\rawait import('src/value/scalars.js')"),
        vec!["src/value/scalars.js".to_string()],
        "a carriage return must terminate a line comment just as QuickJS does"
    );
}

async fn run(actor: &JsEnvActor, body: &str) -> Value {
    let program = format!(
        r#"(async () => {{
  globalThis.__stage = 'start';
  const stage = (name) => {{ globalThis.__stage = name; }};
  const timeout = new Promise((resolve) => setTimeout(
    () => resolve({{TIMEOUT: true, stage: globalThis.__stage}}), 45000));
  const work = (async () => {{ try {{
    const {{setup}} = await import('test/real-images-composition');
    const imageId = 'demo';
    const ids = {{
      className: 'Probe', shapeId: 'probe-shape',
      interfaceId: 'probe-interface', bindingId: 'probe-binding', blockId: 'probe-block',
      mutationInterfaceId: 'probe-mutate-interface',
      mutationBindingId: 'probe-mutate-binding', mutationBlockId: 'probe-mutate-block',
      readInterfaceId: 'object-read-interface', readBindingId: 'object-read-binding',
      readBlockId: 'object-read-block', observationInterfaceId: 'observation-interface',
      observationBindingId: 'observation-binding', observationBlockId: 'observation-block',
    }};
    const s = await setup({{imageId, ids}});
    {body}
  }} catch (error) {{
    return {{
      ERROR: (error && error.name) + ': ' + (error && error.message),
      stage: globalThis.__stage,
      stack: String(error && error.stack).slice(0, 900),
    }};
  }} }})();
  return Promise.race([work, timeout]);
}})()"#
    );
    let json = tokio::time::timeout(
        std::time::Duration::from_secs(55),
        actor.eval_async(&program),
    )
    .await
    .expect("guest program exceeded the independent 55s host bound")
    .expect("guest program must return");
    serde_json::from_str(&json).expect("guest report must be valid JSON")
}

fn assert_guest_ok(report: &Value) {
    assert!(
        report.get("ERROR").is_none(),
        "guest failed at {}: {} / {}",
        report["stage"],
        report["ERROR"],
        report["stack"]
    );
    assert!(
        report.get("TIMEOUT").is_none(),
        "guest timed out at {}",
        report["stage"]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn real_images_adapter_semantic_chain_runs_in_process() {
    let (actor, external_artifact_resolutions) = actor();
    let report = run(
        &actor,
        r#"
    const {adapter, authorities} = s;
    const errorShape = (error) => ({
      name: error?.name ?? null,
      code: typeof error?.code === 'string' ? error.code : null,
    });
    const captureError = async (operation) => {
      try {
        await operation();
        return {name: 'NO_THROW', code: null};
      } catch (error) {
        return errorShape(error);
      }
    };
    const titleOf = (record) => record.slots?.['probe-title']?.value ?? null;

    stage('create');
    const created = await adapter.createObject({
      imageId,
      classId: s.classId,
      title: 'original',
      subject: s.reference('smalltalk/nil'),
      authority: authorities.create('smalltalk/nil'),
      blockId: ids.blockId,
    });
    const objectId = created.objectId;

    stage('read');
    const readAuthority = authorities.read(objectId);
    const first = await adapter.readObject({
      imageId, objectId, authority: readAuthority, blockId: ids.readBlockId,
    });

    stage('read-errors');
    const deniedExistingRead = await captureError(() => adapter.readObject({
      imageId, objectId, authority: authorities.none(), blockId: ids.readBlockId,
    }));
    const missingObjectId = 'definitely-missing';
    const deniedMissingRead = await captureError(() => adapter.readObject({
      imageId, objectId: missingObjectId, authority: authorities.none(),
      blockId: ids.readBlockId,
    }));
    const authorizedMissingRead = await captureError(() => adapter.readObject({
      imageId, objectId: missingObjectId, authority: authorities.read(missingObjectId),
      blockId: ids.readBlockId,
    }));

    stage('observe-anchor');
    const initialPull = await adapter.observePull({
      imageId,
      afterCursor: '',
      authority: readAuthority,
      blockId: ids.observationBlockId,
    });

    stage('mutate');
    const writeAuthority = authorities.readWrite(objectId);
    const mutated = await adapter.mutateObject({
      imageId,
      objectId,
      value: {title: 'edited'},
      authority: writeAuthority,
      blockId: ids.mutationBlockId,
      versionToken: first.versionToken,
    });

    // Start observation only AFTER the mutation. Delivery therefore requires
    // resuming from the saved nonempty high-water token; silently resetting to
    // live-follow-from-now would miss the event and make this test fail.
    const controller = new AbortController();
    const events = [];
    const lane = adapter.observe(imageId, {
      authority: readAuthority,
      blockId: ids.observationBlockId,
      afterCursor: initialPull.cursor,
      signal: controller.signal,
      intervalMs: s.observeIntervalMs,
    });
    const pump = (async () => {
      for await (const event of lane) events.push(event);
    })();

    stage('observe-deliver');
    const eventDeadline = Date.now() + 15000;
    while (events.length === 0 && Date.now() < eventDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const observed = events[0] ?? null;

    stage('reread');
    const second = await adapter.readObject({
      imageId, objectId, authority: readAuthority, blockId: ids.readBlockId,
    });

    controller.abort();
    await pump.catch(() => {});

    stage('stale');
    const third = await adapter.mutateObject({
      imageId,
      objectId,
      value: {title: 'third'},
      authority: writeAuthority,
      blockId: ids.mutationBlockId,
      versionToken: second.versionToken,
    });
    const staleWrite = await captureError(() => adapter.mutateObject({
      imageId,
      objectId,
      value: {title: 'should-not-land'},
      authority: writeAuthority,
      blockId: ids.mutationBlockId,
      versionToken: second.versionToken,
    }));

    stage('denied-write');
    const readOnlyAuthority = authorities.readOnly(objectId);
    const stillReadable = await adapter.readObject({
      imageId, objectId, authority: readOnlyAuthority, blockId: ids.readBlockId,
    });
    const deniedWrite = await captureError(() => adapter.mutateObject({
      imageId,
      objectId,
      value: {title: 'denied'},
      authority: readOnlyAuthority,
      blockId: ids.mutationBlockId,
      versionToken: stillReadable.versionToken,
    }));
    const final = await adapter.readObject({
      imageId, objectId, authority: readAuthority, blockId: ids.readBlockId,
    });

    stage('project-read');
    const projectRead = await s.readProjectFixture();

    return {
      objectCreated: typeof objectId === 'string' && objectId.length > 0,
      creationTokenWasString: typeof created.versionToken === 'string',
      firstTitle: titleOf(first),
      deniedExistingRead,
      deniedMissingRead,
      authorizedMissingRead,
      initialPullWasEmpty: initialPull.events.length === 0,
      initialHighWaterWasNonempty: typeof initialPull.cursor === 'string' &&
        initialPull.cursor.length > 16,
      mutationAdvancedToken: mutated.versionToken !== first.versionToken,
      observationDelivered: events.length > 0,
      observedObjectMatched: observed?.objectId === objectId,
      observedType: observed?.type ?? null,
      observedKind: observed?.kind ?? null,
      observedCursorWasString: typeof observed?.cursor === 'string',
      observedShapeWasExact: observed !== null &&
        Object.keys(observed).sort().join(',') === 'cursor,kind,objectId,type',
      secondTitle: titleOf(second),
      rereadAdvancedToken: second.versionToken !== first.versionToken,
      staleTokenWasSuperseded: third.versionToken !== second.versionToken,
      staleWrite,
      stillReadableTitle: titleOf(stillReadable),
      deniedWrite,
      finalTitle: titleOf(final),
      projectDescriptor: projectRead.descriptor,
      projectDeniedKinds: projectRead.deniedKinds,
    };
"#,
    )
    .await;
    assert_guest_ok(&report);

    assert_eq!(report["objectCreated"], true);
    assert_eq!(report["creationTokenWasString"], true);
    assert_eq!(report["firstTitle"], "original");

    assert_eq!(
        report["deniedExistingRead"],
        json!({"name": "AuthorityError", "code": null})
    );
    assert_eq!(
        report["deniedMissingRead"],
        json!({"name": "AuthorityError", "code": null}),
        "unauthorized missing reads must not disclose existence"
    );
    assert_eq!(
        report["authorizedMissingRead"],
        json!({"name": "ObjectReadNotFoundError", "code": "OBJECT_NOT_FOUND"})
    );

    assert_eq!(report["initialPullWasEmpty"], true);
    assert_eq!(report["initialHighWaterWasNonempty"], true);
    assert_eq!(report["mutationAdvancedToken"], true);
    assert_eq!(report["observationDelivered"], true);
    assert_eq!(report["observedObjectMatched"], true);
    assert_eq!(report["observedType"], "record.put");
    assert_eq!(report["observedKind"], "object.put");
    assert_eq!(report["observedCursorWasString"], true);
    assert_eq!(
        report["observedShapeWasExact"], true,
        "normalized observation must contain only cursor, kind, objectId, and type"
    );
    assert_eq!(report["secondTitle"], "edited");
    assert_eq!(report["rereadAdvancedToken"], true);

    assert_eq!(report["staleTokenWasSuperseded"], true);
    assert_eq!(
        report["staleWrite"],
        json!({"name": "ObjectMutationConflictError", "code": null})
    );
    assert_eq!(report["stillReadableTitle"], "third");
    assert_eq!(
        report["deniedWrite"],
        json!({"name": "AuthorityError", "code": null})
    );
    assert_eq!(report["finalTitle"], "third");
    assert_eq!(report["projectDescriptor"]["format"], "lagrange-project/v1");
    assert_eq!(report["projectDescriptor"]["projectId"], "portable-project");
    assert_eq!(report["projectDescriptor"]["name"], "Portable Project");
    assert_eq!(report["projectDescriptor"]["namespace"], Value::Null);
    assert_eq!(
        report["projectDescriptor"]["members"],
        json!([
            {"key":"a-first","role":"source","target":{"kind":"ref","imageId":"demo","objectId":"target-a"}},
            {"key":"z-last","role":"test","target":{"kind":"ref","imageId":"demo","objectId":"target-z"}}
        ]),
        "the artifact-backed authorized Project read returns Images' canonical member order"
    );
    assert_eq!(
        report["projectDeniedKinds"],
        json!(["AuthorityError", "AuthorityError"]),
        "denied existing and missing Projects must not expose existence"
    );

    let serialized_report = report.to_string();
    assert!(
        !serialized_report.contains("object-version/v0:")
            && !serialized_report.contains("obs-cursor/v1:"),
        "opaque Images tokens must stay guest-side"
    );

    let private_import_report = actor
        .eval_async(
            r#"(async () => {
  try {
    await import('src/value/scalars.js');
    return {loaded: true, message: null};
  } catch (error) {
    return {loaded: false, message: String(error && error.message)};
  }
})()"#,
        )
        .await
        .expect("private artifact import probe must return");
    let private_import_report: Value = serde_json::from_str(&private_import_report)
        .expect("private artifact import probe must return JSON");
    assert_eq!(private_import_report["loaded"], false);
    assert!(
        private_import_report["message"]
            .as_str()
            .is_some_and(|message| message.contains("public portable-runtime alias")),
        "runtime resolver must reject external private artifact imports: {private_import_report}"
    );

    let external_artifact_resolutions = external_artifact_resolutions
        .lock()
        .expect("artifact resolution audit lock poisoned")
        .clone();
    assert!(
        !external_artifact_resolutions.is_empty(),
        "the composition must actually cross the public Images entry"
    );
    assert!(
        external_artifact_resolutions
            .iter()
            .all(|(_, requested, resolved)| requested == PORTABLE_RUNTIME_ALIAS
                && resolved.starts_with("src/")),
        "every external artifact resolution must use the public Images alias: {external_artifact_resolutions:?}"
    );

    actor.shutdown().await;
}
