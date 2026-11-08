//! sl1: one actual imported YAXO application, executed in QuickJS + native
//! Wasmtime, navigated and changed through the real Environment/GTK boundary.
//! No Node subprocess, sibling checkout, saved graph, or private Images helper.
#[path = "support/public_entry_composition_loader.rs"]
mod public_entry_composition_loader;

use std::collections::{HashSet, VecDeque};
use std::process::{Child, Command, ExitStatus};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use lagrange_host_linux::images_composition::portable_artifact::PORTABLE_RUNTIME_ALIAS;
use lagrange_host_linux::js_env::actor::{JsEnvActor, ShutdownOutcome};
use lagrange_host_linux::js_env::host_wasm;
use lagrange_host_linux::js_env::renderer_port::{install_renderer_adapter, RendererPortHost};
use lagrange_host_linux::js_env::EmbeddedLoader;
use lagrange_host_linux::linux_adapter::RendererAdapterOps;
use public_entry_composition_loader::PublicEntryCompositionLoader;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MANIFEST: &str = include_str!("../../../test/fixtures/yaxo/manifest.json");
const SCOPE: &str = include_str!("../../../test/fixtures/yaxo/scope.json");
const PROVENANCE: &str = include_str!("../../../test/fixtures/yaxo/provenance.json");
const COMPOSITION: &str = include_str!("native-application-parity.mjs");

fn environment_loader() -> EmbeddedLoader {
    EmbeddedLoader::new()
        .with_module("model", include_str!("../../../src/model.js"))
        .with_module(
            "renderer-errors",
            include_str!("../../../src/renderer-errors.js"),
        )
        .with_module(
            "selection-model",
            include_str!("../../../src/selection-model.js"),
        )
        .with_module(
            "image-observation",
            include_str!("../../../src/image-observation.js"),
        )
        .with_module(
            "command-router",
            include_str!("../../../src/command-router.js"),
        )
        .with_module(
            "command-registry",
            include_str!("../../../src/command-registry.js"),
        )
        .with_module(
            "command-dispatcher",
            include_str!("../../../src/command-dispatcher.js"),
        )
        .with_module(
            "presentation-registry",
            include_str!("../../../src/presentation-registry.js"),
        )
        .with_module(
            "object-navigator",
            include_str!("../../../src/object-navigator.js"),
        )
        .with_module(
            "object-presentation-providers",
            include_str!("../../../src/object-presentation-providers.js"),
        )
        .with_module("compositor", include_str!("../../../src/compositor.js"))
        .with_module(
            "environment-shell",
            include_str!("../../../src/environment-shell.js"),
        )
        .with_module(
            "perspective-projection",
            include_str!("../../../src/perspective-projection.js"),
        )
        .with_module(
            "image-client-adapter",
            include_str!("../../../src/image-client-adapter.js"),
        )
        .with_module(
            "project-browser",
            include_str!("../../../src/project-browser.js"),
        )
        .with_module(
            "native-smalltalk-browser",
            include_str!("../../../src/native-smalltalk-browser.js"),
        )
        .with_module("test/native-application-parity", COMPOSITION)
}

fn verify_source_bytes(manifest: &[u8]) -> Result<(), String> {
    let provenance: Value = serde_json::from_str(PROVENANCE).unwrap();
    if format!("{:x}", Sha256::digest(manifest)) != provenance["output"]["sha256"].as_str().unwrap()
    {
        return Err("canonical Cuis export byte identity".into());
    }
    if format!("{:x}", Sha256::digest(SCOPE.as_bytes()))
        != provenance["output"]["scopeSha256"].as_str().unwrap()
    {
        return Err("exact M4 import scope".into());
    }
    // Runtime admission advances independently of the retained source evidence.
    assert_eq!(
        provenance["imagesRevision"],
        "9462476733e68195c5cd4a97dcba8ec23930f637"
    );
    Ok(())
}

/// Ordinary operations retain the existing 30-second bound. The imported
/// tokenizer's combined bootstrap has its separately measured budget below.
fn run_js(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    js: &str,
) -> Value {
    run_js_with_budget(runtime, actor, host, js, Duration::from_secs(30))
}

fn run_js_with_budget(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    js: &str,
    budget: Duration,
) -> Value {
    let sender = actor.clone_sender();
    // Preserve guest error details across the actor's plain JSON result seam;
    // rquickjs::Error::Exception alone does not carry the thrown JS value.
    let source = format!("(async () => {{ try {{ return {{ok:true,value:await ({js})}}; }} catch (error) {{ return {{ok:false,name:String(error?.name),message:String(error?.message),stack:String(error?.stack)}}; }} }})()");
    let (done_tx, mut done_rx) = tokio::sync::oneshot::channel();
    let work = runtime.spawn(async move {
        let _ = done_tx.send(sender.eval_async(&source).await);
    });
    let deadline = Instant::now() + budget;
    loop {
        host.pump();
        match done_rx.try_recv() {
            Ok(result) => {
                let out = result.unwrap_or_else(|error| {
                    panic!("native parity JS failed: {error}; source={js}")
                });
                let mut envelope: Value = serde_json::from_str(&out)
                    .unwrap_or_else(|error| panic!("invalid parity JSON: {error}; {out}"));
                assert_eq!(
                    envelope["ok"], true,
                    "native parity guest failure: {envelope}; source={js}"
                );
                return envelope["value"].take();
            }
            Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                panic!("native parity JS task ended without a result")
            }
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
        }
        if Instant::now() >= deadline {
            work.abort();
            panic!("native parity stage exceeded {budget:?}; source={js}");
        }
        // GTK remains responsive without spinning a second CPU while the JS
        // owner performs work. This does not yield or modify guest execution.
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn stage(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    name: &str,
    js: &str,
) -> Value {
    stage_with_budget(runtime, actor, host, name, js, Duration::from_secs(30))
}

fn stage_with_budget(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    name: &str,
    js: &str,
    budget: Duration,
) -> Value {
    let start = Instant::now();
    eprintln!("{}", json!({"nativeParityStage": name, "phase": "start"}));
    let value = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_js_with_budget(runtime, actor, host, js, budget)
    }));
    eprintln!(
        "{}",
        json!({"nativeParityStage": name, "phase": if value.is_ok() { "end" } else { "failed" }, "elapsedMs": start.elapsed().as_millis()})
    );
    match value {
        Ok(value) => value,
        Err(failure) => std::panic::resume_unwind(failure),
    }
}

fn stores_after_gc(runtime: &tokio::runtime::Runtime, actor: &JsEnvActor) -> usize {
    let count = Arc::new(AtomicUsize::new(usize::MAX));
    let target = Arc::clone(&count);
    runtime
        .block_on(actor.with_context(move |ctx| {
            ctx.run_gc();
            target.store(host_wasm::live_store_count(), Ordering::SeqCst);
            Ok(())
        }))
        .expect("collect guest closures and inspect native stores on their owner thread");
    count.load(Ordering::SeqCst)
}

fn poll(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    js: &str,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let value = run_js(runtime, actor, host, js);
        if value["done"] == true {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "native parity poll timed out: {js}; last={value}"
        );
    }
}

fn push(runtime: &tokio::runtime::Runtime, actor: &JsEnvActor, handle: &str, intent: Value) {
    // The shell's onIntent starts async work without awaiting renderer ops.
    // Thus this push returns before GTK work; the following poll keeps pumping.
    runtime
        .block_on(actor.push(&json!({"intent": intent, "surfaceHandle": handle}).to_string()))
        .expect("deliver real GTK intent to the Environment shell");
}

fn activate(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    from: &str,
    index: usize,
    authority: &str,
) -> Value {
    let prepared = run_js(
        runtime,
        actor,
        host,
        &format!(
            "__parity.prepareAction({}, {}, {})",
            json!(from),
            index,
            json!(authority)
        ),
    );
    let handle = prepared["handle"].as_str().unwrap();
    let intent = host
        .adapter()
        .activate_gtk_action(handle, index as i64)
        .unwrap()
        .expect("real GTK action");
    let intent = serde_json::to_value(intent).unwrap();
    assert_eq!(
        intent,
        json!({"kind": "activate-item", "key": index}),
        "GTK emits descriptor-local keys only"
    );
    push(runtime, actor, handle, intent);
    let result = poll(runtime, actor, host, "__parity.actionState()");
    result["descriptor"].clone()
}

fn assert_denial(descriptor: &Value) {
    assert_eq!(
        descriptor["kind"], "unauthorized-reference",
        "relationships confer no target authority"
    );
    assert!(descriptor["parameters"].get("fields").is_none());
    assert!(descriptor["parameters"].get("references").is_none());
}

fn submit(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    handle: &str,
    source: &str,
    denied: bool,
    error: Option<&str>,
) -> Value {
    run_js(
        runtime,
        actor,
        host,
        &format!("__parity.prepareReplacement({denied})"),
    );
    let intent = host
        .adapter()
        .submit_gtk_input(handle, 0, source)
        .unwrap()
        .expect("current GTK method input");
    let intent = serde_json::to_value(intent).unwrap();
    assert_eq!(
        intent,
        json!({"kind": "submit-input", "key": 0, "text": source}),
        "source traverses real GTK TextBuffer and submit control unchanged"
    );
    push(runtime, actor, handle, intent);
    let result = poll(
        runtime,
        actor,
        host,
        &format!("__parity.replacementState({})", json!(error)),
    );
    assert_eq!(
        host.adapter().gtk_descriptor(handle).unwrap().unwrap(),
        result["descriptor"],
        "the authoritative guest descriptor was realized on the same GTK surface"
    );
    result["descriptor"].clone()
}

fn edit_state(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    handle: &str,
    submitted: &str,
    expected_text: &str,
    denied: bool,
    after_commit: Option<&str>,
    error: Option<&str>,
) -> Value {
    run_js(
        runtime,
        actor,
        host,
        &format!(
            "__parity.prepareStateEdit({}, {})",
            denied,
            json!(after_commit)
        ),
    );
    let intent = host
        .adapter()
        .edit_gtk_field(handle, 0, submitted)
        .unwrap()
        .expect("current GTK editable field");
    let intent = serde_json::to_value(intent).unwrap();
    assert_eq!(
        intent,
        json!({"kind": "edit-field", "key": 0, "text": submitted}),
        "field edit traverses real GTK Entry and activate commit unchanged"
    );
    push(runtime, actor, handle, intent);
    let result = poll(
        runtime,
        actor,
        host,
        &format!(
            "__parity.stateEditState({}, {}, {})",
            json!(submitted),
            json!(expected_text),
            json!(error)
        ),
    );
    assert_eq!(
        host.adapter().gtk_descriptor(handle).unwrap().unwrap(),
        result["descriptor"],
        "the authoritative guest inspector descriptor was realized on the same GTK surface"
    );
    let expected_entry_text = if error == Some("CommandAuthorizationError") {
        submitted
    } else {
        expected_text
    };
    assert_eq!(
        host.adapter().gtk_editable_texts(handle).unwrap(),
        vec![(0, expected_entry_text.to_string())],
        "GTK Entry reflects authoritative post-edit/reread text (or un-reread buffer on denied write)"
    );
    result["descriptor"].clone()
}

const CHILD_ENV: &str = "LOE_NATIVE_PARITY_CHILD";
const CHILD_TEST: &str = "imported_yaxo_executes_navigates_and_replaces_through_native_gtk";

#[derive(Debug)]
enum ChildOutcome {
    Exited(ExitStatus),
    TimedOut(ExitStatus),
}

/// Test-local process custody. In particular, a panic or wait error cannot
/// abandon a native child that is stuck inside QuickJS (Bead 5ms).
struct ReapChild {
    child: Child,
    reaped: bool,
}

impl Drop for ReapChild {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn supervise(mut command: Command, budget: Duration) -> Result<ChildOutcome, String> {
    // stdout/stderr are inherited: no undrained pipe can block a child.
    let mut owned = ReapChild {
        child: command
            .spawn()
            .map_err(|e| format!("spawn native child: {e}"))?,
        reaped: false,
    };
    let deadline = Instant::now() + budget;
    loop {
        match owned.child.try_wait() {
            Ok(Some(status)) => {
                owned.reaped = true;
                return Ok(ChildOutcome::Exited(status));
            }
            Ok(None) => {}
            Err(error) => return Err(format!("wait native child: {error}")),
        }
        if Instant::now() >= deadline {
            // A natural exit can race with kill. Always wait before inspecting
            // either result; TimedOut carries a status only after reaping.
            let kill = owned.child.kill();
            let wait = owned.child.wait();
            return match wait {
                Ok(status) => {
                    owned.reaped = true;
                    Ok(ChildOutcome::TimedOut(status))
                }
                Err(error) => Err(format!("reap timed-out child: {error}; kill={kill:?}")),
            };
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn child_command(executable: &std::path::Path, mode: &str) -> Command {
    let mut command = Command::new(executable);
    command
        .args([CHILD_TEST, "--exact", "--nocapture", "--test-threads=1"])
        // gtk4::init() calls setlocale(LC_ALL, ""); keep LC_NUMERIC=C so QuickJS
        // strtod-backed JSON.parse does not treat ',' as a decimal separator on
        // comma-decimal locales (e.g. sv_SE.UTF-8) when parsing wasm-module/v2
        // (host-wide follow-up: Bead pon).
        .env("LC_NUMERIC", "C")
        .env(CHILD_ENV, mode);
    command
}

#[test]
fn imported_yaxo_executes_navigates_and_replaces_through_native_gtk() {
    match std::env::var(CHILD_ENV) {
        Ok(mode) if mode == "run" => return run_native_parity(),
        Ok(mode) if mode == "watchdog-probe" => {
            // Finite and before GTK/actor creation. Removing the timeout branch
            // makes the parent see Exited, so this control then fails.
            std::thread::sleep(Duration::from_secs(2));
            return;
        }
        Ok(mode) => panic!("unknown native parity child mode {mode:?}"),
        Err(std::env::VarError::NotPresent) => {}
        Err(error) => panic!("invalid native parity child mode: {error}"),
    }
    let executable = std::env::current_exe().expect("native test executable");
    let listing = Command::new(&executable)
        .arg("--list")
        .output()
        .expect("list native tests");
    assert!(
        listing.status.success(),
        "native test listing failed: {:?}",
        listing.status
    );
    let exact_line = format!("{CHILD_TEST}: test");
    let has_test = |listing: &str| listing.lines().any(|line| line == exact_line);
    assert!(
        !has_test(&format!("{CHILD_TEST}_renamed: test")),
        "prefix is not an exact test"
    );
    assert!(
        has_test(&String::from_utf8_lossy(&listing.stdout)),
        "exact native test missing; refusing a vacuous zero-test child"
    );

    let probe = supervise(
        child_command(&executable, "watchdog-probe"),
        Duration::from_millis(100),
    )
    .expect("supervise finite watchdog control");
    match probe {
        ChildOutcome::TimedOut(status) => {
            assert!(
                !status.success(),
                "watchdog control must be killed and reaped"
            );
        }
        outcome => panic!("watchdog did not enforce its deadline: {outcome:?}"),
    }
    match supervise(child_command(&executable, "run"), Duration::from_secs(180))
        .expect("supervise actual native parity")
    {
        ChildOutcome::Exited(status) => {
            assert!(status.success(), "native parity child failed: {status}")
        }
        ChildOutcome::TimedOut(status) => {
            panic!("native parity exceeded 180s; child reaped: {status}")
        }
    }
}

fn run_native_parity() {
    verify_source_bytes(MANIFEST.as_bytes()).expect("canonical source provenance");
    let mut changed = MANIFEST.as_bytes().to_vec();
    *changed.last_mut().unwrap() ^= 1;
    assert_eq!(
        verify_source_bytes(&changed),
        Err("canonical Cuis export byte identity".into())
    );
    gtk4::init().expect("run native parity under Xvfb/xvfb-run");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let (loader, audit) = PublicEntryCompositionLoader::new(environment_loader()).unwrap();
    let actor = JsEnvActor::spawn(loader).unwrap();
    let (mut host, tx) = RendererPortHost::new(Box::new(|_| {
        Err("no graphics runner in YAXO tool proof".into())
    }));
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime
            .block_on(actor.with_context(move |ctx| {
                install_renderer_adapter(&ctx, tx, "rendererAdapter")?;
                ctx.globals().set("__yaxoManifest", MANIFEST)?;
                ctx.globals().set("__yaxoScope", SCOPE)?;
                let started = Instant::now();
                ctx.globals().set(
                    "__parityStage",
                    rquickjs::Function::new(ctx.clone(), move |name: String, phase: String| {
                        eprintln!(
                            "{}",
                            json!({"nativeParitySubstage": name, "phase": phase,
                            "elapsedMs": started.elapsed().as_millis()})
                        );
                    })?,
                )?;
                Ok(())
            }))
            .expect("install renderer and canonical source bytes");

        stage(
            &runtime,
            &actor,
            &mut host,
            "public runtime bootstrap",
            "(async () => (await import('test/native-application-parity')).setup())()",
        );
        stage(
            &runtime,
            &actor,
            &mut host,
            "standard image",
            "__parity.standardImage()",
        );
        stage(
            &runtime,
            &actor,
            &mut host,
            "native YAXO import",
            "__parity.importYaxo()",
        );
        // O2 measured 40.217s for this combined imported 256-entry table
        // initialization plus readStream (O0: 116.824s). This bootstrap-only
        // budget has 2.24x measured headroom; ordinary operations stay at 30s.
        stage_with_budget(
            &runtime,
            &actor,
            &mut host,
            "tokenizer initialization",
            "__parity.initializeTokenizer()",
            Duration::from_secs(90),
        );
        assert_eq!(
            stage(
                &runtime,
                &actor,
                &mut host,
                "native parse and independent oracle",
                "__parity.parseAndCheck()"
            ),
            json!({"text": "Tove", "attribute": "en"})
        );
        let opened = stage(
            &runtime,
            &actor,
            &mut host,
            "Environment Project",
            "__parity.openEnvironment()",
        );
        let root_index = opened["rootIndex"].as_u64().unwrap() as usize;
        let inspector_handle = opened["inspectorHandle"].as_str().unwrap();

        assert_denial(&activate(
            &runtime, &actor, &mut host, "project", root_index, "project",
        ));
        let root = activate(&runtime, &actor, &mut host, "project", root_index, "target");
        let mut denied_targets = Vec::new();
        for index in 0..root["parameters"]["references"].as_array().unwrap().len() {
            activate(&runtime, &actor, &mut host, "project", root_index, "target");
            let denied = activate(&runtime, &actor, &mut host, "inspector", index, "root");
            assert_denial(&denied);
            denied_targets.push(denied["subject"].clone());
        }

        // Breadth-first traversal stores only displayed action-index paths. Native
        // parser oracle refs never choose a path or an authority in the consumer.
        let mut queue = VecDeque::from([Vec::<usize>::new()]);
        let mut seen = HashSet::new();
        let mut descriptors = Vec::new();
        let mut editable_path: Option<Vec<usize>> = None;
        let mut paths = 0;
        while let Some(path) = queue.pop_front() {
            paths += 1;
            assert!(
                paths + queue.len() < 100,
                "small native application traversal remains bounded"
            );
            let mut descriptor =
                activate(&runtime, &actor, &mut host, "project", root_index, "target");
            for index in path.iter().copied() {
                descriptor = activate(&runtime, &actor, &mut host, "inspector", index, "target");
            }
            assert_eq!(descriptor["kind"], "inspector");
            assert_eq!(
                host.adapter()
                    .gtk_descriptor(inspector_handle)
                    .unwrap()
                    .unwrap(),
                descriptor,
                "ordinary application descriptor is actually realized in GTK"
            );
            if !seen.insert(descriptor["subject"].to_string()) {
                continue;
            }
            let editable_texts = host
                .adapter()
                .gtk_editable_texts(inspector_handle)
                .unwrap();
            if descriptor["parameters"]["fields"]
                .as_object()
                .unwrap()
                .values()
                .any(|value| value == &json!({"kind":"text","value":"Tove"}))
            {
                assert!(
                    host.adapter()
                        .gtk_visible_text(inspector_handle)
                        .unwrap()
                        .iter()
                        .any(|text| text.contains("Tove")),
                    "the parsed value is visible in native controls"
                );
                assert_eq!(
                    editable_texts,
                    vec![(0, "Tove".to_string())],
                    "XMLStringNode realizes one editable GTK Entry with initial text"
                );
                editable_path = Some(path.clone());
            } else {
                assert_eq!(
                    editable_texts,
                    Vec::<(i64, String)>::new(),
                    "non-editable application objects realize no editable GTK Entry"
                );
            }
            for index in 0..descriptor["parameters"]["references"]
                .as_array()
                .unwrap()
                .len()
            {
                let mut next = path.clone();
                next.push(index);
                queue.push_back(next);
            }
            descriptors.push(descriptor);
        }
        let traversal = stage(
            &runtime,
            &actor,
            &mut host,
            "authorized GTK traversal proof",
            &format!(
                "__parity.verifyTraversal({}, {})",
                json!(descriptors),
                json!(denied_targets)
            ),
        );
        assert!(traversal["objects"].as_u64().unwrap() >= 5);

        // Native E5 (Bead u4k): navigate to the discovered editable XMLStringNode
        // solely via displayed GTK actions, then drive real GTK Entry state edits.
        let editable_path = editable_path.expect("discovered editable XMLStringNode via GTK actions");
        let mut editable_descriptor =
            activate(&runtime, &actor, &mut host, "project", root_index, "target");
        for index in editable_path.iter().copied() {
            editable_descriptor =
                activate(&runtime, &actor, &mut host, "inspector", index, "target");
        }
        assert_eq!(
            host.adapter()
                .gtk_descriptor(inspector_handle)
                .unwrap()
                .unwrap(),
            editable_descriptor
        );
        assert_eq!(
            host.adapter()
                .gtk_editable_texts(inspector_handle)
                .unwrap(),
            vec![(0, "Tove".to_string())]
        );
        assert!(host
            .adapter()
            .edit_gtk_field(inspector_handle, 999, "missing key")
            .unwrap()
            .is_none());

        edit_state(
            &runtime,
            &actor,
            &mut host,
            inspector_handle,
            "Ada",
            "Ada",
            false,
            None,
            None,
        );
        // Post-commit competing write before reread: the fresh authorized reread
        // displays the winning value ("Grace") and pairs its token, never the
        // submitted text ("Hopper") or the mutation receipt.
        edit_state(
            &runtime,
            &actor,
            &mut host,
            inspector_handle,
            "Hopper",
            "Grace",
            false,
            Some("Grace"),
            None,
        );
        // Follow-up edit succeeds because the reread paired "Grace"'s token.
        let lin_descriptor = edit_state(
            &runtime,
            &actor,
            &mut host,
            inspector_handle,
            "Lin",
            "Lin",
            false,
            None,
            None,
        );
        let denied_state = edit_state(
            &runtime,
            &actor,
            &mut host,
            inspector_handle,
            "Denied state",
            "Lin",
            true,
            None,
            Some("CommandAuthorizationError"),
        );
        assert_eq!(
            denied_state, lin_descriptor,
            "denied state edit does not change displayed inspector descriptor"
        );
        let outside_state = stage(
            &runtime,
            &actor,
            &mut host,
            "real intervening state mutation",
            "__parity.mutateStateOutside(\"External state\")",
        );
        assert_eq!(outside_state["value"], "External state");
        assert_eq!(
            host.adapter()
                .gtk_descriptor(inspector_handle)
                .unwrap()
                .unwrap(),
            lin_descriptor,
            "intervening outside write leaves realized inspector descriptor at \"Lin\" until conflict reread"
        );
        edit_state(
            &runtime,
            &actor,
            &mut host,
            inspector_handle,
            "Lost state",
            "External state",
            false,
            None,
            Some("CommandConflictError"),
        );
        // Retry after conflict reread pairs the current token and restores "Tove"
        // before the E3 native method replacement stages.
        edit_state(
            &runtime,
            &actor,
            &mut host,
            inspector_handle,
            "Tove",
            "Tove",
            false,
            None,
            None,
        );

        let native = stage(
            &runtime,
            &actor,
            &mut host,
            "imported native class browse",
            "__parity.openNativeClass()",
        );
        let handle = native["handle"].as_str().unwrap();
        let key = native["key"].as_i64().unwrap();
        assert!(host
            .adapter()
            .submit_gtk_input(handle, 0, "no method displayed")
            .unwrap()
            .is_none());
        let intent = host
            .adapter()
            .activate_gtk_action(handle, key)
            .unwrap()
            .expect("imported class selector GTK action");
        assert_eq!(
            serde_json::to_value(&intent).unwrap(),
            json!({"kind":"activate-item","key":key})
        );
        push(
            &runtime,
            &actor,
            handle,
            serde_json::to_value(intent).unwrap(),
        );
        let initial =
            poll(&runtime, &actor, &mut host, "__parity.methodState()")["descriptor"].clone();
        assert_eq!(
            host.adapter().gtk_descriptor(handle).unwrap().unwrap(),
            initial
        );
        assert!(host
            .adapter()
            .submit_gtk_input(handle, 999, "missing key")
            .unwrap()
            .is_none());
        let original = run_js(
            &runtime,
            &actor,
            &mut host,
            "__parity.verifyExecuted('Tove')",
        );

        let denied = submit(
            &runtime,
            &actor,
            &mut host,
            handle,
            "[ ^ 'Denied replacement' ]",
            true,
            Some("CommandAuthorizationError"),
        );
        assert_eq!(
            denied, initial,
            "denied replacement does not change display"
        );
        assert_eq!(
            run_js(
                &runtime,
                &actor,
                &mut host,
                "__parity.verifyExecuted('Tove')"
            ),
            original,
            "denied replacement preserves both actual result and bound method identity"
        );

        let replaced = submit(
            &runtime,
            &actor,
            &mut host,
            handle,
            "[\n ^ 'Native replacement'\n]",
            false,
            None,
        );
        assert_ne!(
            replaced["parameters"]["smalltalkMethod"]["method"],
            original["method"]
        );
        let committed = run_js(
            &runtime,
            &actor,
            &mut host,
            "__parity.verifyExecuted('Native replacement')",
        );
        assert_eq!(
            committed["method"],
            replaced["parameters"]["smalltalkMethod"]["method"]
        );

        let winner = stage(
            &runtime,
            &actor,
            &mut host,
            "real intervening replacement",
            "__parity.replaceOutside(\"[ ^ 'External winner' ]\")",
        );
        assert_eq!(winner["value"], "External winner");
        assert_ne!(winner["winner"], committed["method"]);
        let conflicted = submit(
            &runtime,
            &actor,
            &mut host,
            handle,
            "[ ^ 'Lost update' ]",
            false,
            Some("CommandConflictError"),
        );
        assert_eq!(
            conflicted["parameters"]["smalltalkMethod"]["method"],
            winner["winner"]
        );
        let after_conflict = run_js(
            &runtime,
            &actor,
            &mut host,
            "__parity.verifyExecuted('External winner')",
        );
        assert_eq!(
            after_conflict["method"], winner["winner"],
            "stale attempt leaves winning method and executed result unchanged"
        );
        // The reread paired a CURRENT token, rather than merely patching the view.
        submit(
            &runtime,
            &actor,
            &mut host,
            handle,
            "[ ^ 'After conflict' ]",
            false,
            None,
        );
        run_js(
            &runtime,
            &actor,
            &mut host,
            "__parity.verifyExecuted('After conflict')",
        );

        // Helper negatives stay on transient host surfaces; no renderer contract op
        // is added, and a stale handle never routes a source submission or field edit.
        let empty_handle = host
            .adapter()
            .create_surface(&json!({"kind":"surface","width":10,"height":10}))
            .unwrap();
        assert!(host
            .adapter()
            .submit_gtk_input(&empty_handle, 0, "empty")
            .unwrap()
            .is_none());
        assert!(host
            .adapter()
            .edit_gtk_field(&empty_handle, 0, "empty")
            .unwrap()
            .is_none());
        host.adapter()
            .attach_presentation(&empty_handle, &initial)
            .unwrap();
        host.adapter().detach_presentation(&empty_handle).unwrap();
        assert!(host
            .adapter()
            .submit_gtk_input(&empty_handle, 0, "detached")
            .unwrap()
            .is_none());
        assert!(host
            .adapter()
            .edit_gtk_field(&empty_handle, 0, "detached")
            .unwrap()
            .is_none());
        host.adapter().destroy_surface(&empty_handle).unwrap();
        assert!(host
            .adapter()
            .submit_gtk_input(&empty_handle, 0, "destroyed")
            .unwrap_err()
            .contains("unknown/destroyed"));
        assert!(host
            .adapter()
            .edit_gtk_field(&empty_handle, 0, "destroyed")
            .unwrap_err()
            .contains("unknown/destroyed"));

        let resolutions = audit.lock().unwrap().clone();
        assert!(
            !resolutions.is_empty(),
            "real application must cross the public Images entry"
        );
        assert!(
            resolutions.iter().all(
                |(_, requested, resolved)| requested == PORTABLE_RUNTIME_ALIAS
                    && resolved.starts_with("src/")
            ),
            "every non-artifact import uses only the public entry: {resolutions:?}"
        );
        let private = run_js(&runtime, &actor, &mut host,
        "(async () => { try { await import('src/value/scalars.js'); return false; } catch (e) { return e.message.includes('public portable-runtime alias'); } })()");
        assert_eq!(private, true, "private semantic imports fail closed");
        assert!(
            stores_after_gc(&runtime, &actor) > 0,
            "actual native execution populated the live Images instance pool"
        );
        assert_eq!(
            stage(&runtime, &actor, &mut host, "teardown", "__parity.close()"),
            json!({"closed":true})
        );
        assert_eq!(stores_after_gc(&runtime, &actor), 0,
        "releasing the runtime, executor caches/pools and composition closures disposes every native Store before actor shutdown");
    }));
    let shutdown_started = Instant::now();
    let shutdown = runtime.block_on(actor.shutdown());
    eprintln!(
        "{}",
        json!({"nativeParityStage":"actor shutdown",
        "elapsedMs": shutdown_started.elapsed().as_millis(), "outcome": format!("{shutdown:?}")})
    );
    if let Err(failure) = outcome {
        eprintln!("native parity failure cleanup: actor shutdown={shutdown:?}");
        std::panic::resume_unwind(failure);
    }
    assert_eq!(shutdown, ShutdownOutcome::Clean);
}
