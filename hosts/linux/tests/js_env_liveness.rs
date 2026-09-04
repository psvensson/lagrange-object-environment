//! 3zb-A liveness regression: a spawned-capability continuation must run even
//! after a command's `WithFuture` steals the scheduler's single waker slot.
//!
//! The scenario the slice-4 review exposed (distinct from the bare-job drain in
//! `js_env_shell.rs`'s timer-continuation test):
//!
//!   - `WithFuture::poll` (rquickjs context/async/future.rs) — used by EVERY
//!     `eval_async` / push delivery — polls the spawned-task scheduler with the
//!     COMMAND-LOOP task's waker whenever the command's promise pends on a job
//!     hop while a spawned future is pending. The scheduler keeps a SINGLE waker
//!     slot (`should_poll.waker().register(cx)`, schedular.rs:145, last-poller-wins),
//!     so that STEALS the slot from the parked `DriveFuture`.
//!   - If the command then completes with no `spawner.push`, a later
//!     capability-oneshot resolution re-queues the spawned task and wakes the
//!     STALE command-loop waker. The command loop re-parks without polling the
//!     scheduler, so the spawned continuation stalls — in a command-quiet,
//!     timer-quiet embedding. A Ctx-level bare-job drain cannot reach it (the
//!     stalled work is a SPAWNED task, not a bare QuickJS job).
//!
//! The fix (`actor::drain_jobs`'s trailing `ctx.spawn(async {})`) kicks the
//! `DriveFuture` via a `spawner.push` after each command, so it re-polls,
//! re-registers its OWN waker in the slot, and drains the re-queued task. This
//! test encodes the correct behavior: the continuation MUST run with ZERO
//! further JS commands. It goes RED without the kick (the continuation stalls).

use lagrange_host_linux::js_env::actor::{JsEnvActor, ShutdownOutcome};
use lagrange_host_linux::js_env::EmbeddedLoader;

use rquickjs::prelude::Async;
use rquickjs::Function;
use std::future::Future;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

const BOUNDED: std::time::Duration = std::time::Duration::from_secs(3);

async fn bounded<F: Future>(label: &str, future: F) -> F::Output {
    tokio::time::timeout(BOUNDED, future)
        .await
        .unwrap_or_else(|_| panic!("{label} exceeded {BOUNDED:?}"))
}

async fn wait_flag(label: &str, flag: &AtomicBool) {
    bounded(label, async {
        while !flag.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await;
}

async fn install_gated_capability(
    actor: &JsEnvActor,
    name: &'static str,
) -> (tokio::sync::oneshot::Sender<()>, Arc<AtomicBool>) {
    let (gate_tx, gate_rx) = tokio::sync::oneshot::channel::<()>();
    let started = Arc::new(AtomicBool::new(false));
    let started_in_cap = Arc::clone(&started);
    let gate = Arc::new(tokio::sync::Mutex::new(Some(gate_rx)));
    actor
        .with_context(move |ctx| {
            let cap = Function::new(
                ctx.clone(),
                Async(move || {
                    let started = Arc::clone(&started_in_cap);
                    let gate = Arc::clone(&gate);
                    async move {
                        started.store(true, Ordering::SeqCst);
                        if let Some(rx) = gate.lock().await.take() {
                            let _ = rx.await;
                        }
                        7
                    }
                }),
            )
            .map_err(rquickjs::Error::from)?;
            ctx.globals().set(name, cap)?;
            Ok(())
        })
        .await
        .expect("install gated capability");
    (gate_tx, started)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capability_resolution_after_command_slot_steal() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let done = Arc::new(AtomicBool::new(false));
    let (gate_tx, gate_rx) = tokio::sync::oneshot::channel::<()>();

    // Install a GATED Async capability (`__cap`: its spawned future parks on the
    // gate oneshot) and a sync Rust-side signal for the JS continuation.
    {
        let done = Arc::clone(&done);
        let gate = Arc::new(tokio::sync::Mutex::new(Some(gate_rx)));
        actor
            .with_context(move |ctx| {
                let cap = Function::new(
                    ctx.clone(),
                    Async(move || {
                        let gate = Arc::clone(&gate);
                        async move {
                            let rx = gate.lock().await.take();
                            if let Some(rx) = rx {
                                let _ = rx.await;
                            }
                        }
                    }),
                )
                .map_err(rquickjs::Error::from)?;
                ctx.globals().set("__cap", cap)?;
                let signal = Function::new(ctx.clone(), move || {
                    done.store(true, Ordering::SeqCst);
                })
                .map_err(rquickjs::Error::from)?;
                ctx.globals().set("__jsenv_signal_done", signal)?;
                Ok(())
            })
            .await
            .expect("install host fns");
    }

    // Command 1 (fire-and-forget): spawn the gated capability future; register the
    // continuation. After this, the DriveFuture has polled the capability future
    // -> pending, and the scheduler slot is registered to the DriveFuture.
    actor
        .eval(r#"(async () => { __cap().then(() => { __jsenv_signal_done(); }); })()"#)
        .await
        .expect("start gated capability chain");

    // Command 2 (SLOT STEAL): a job-only async eval that SPAWNS NOTHING but pends
    // on a genuine job hop (`.then(x=>x)` on a settled promise enqueues a reaction
    // JOB, so the result promise pends and `WithFuture::poll` polls the scheduler,
    // registering the command-loop waker in the single slot). `Promise.resolve(1)`
    // alone would NOT work — it is already settled, so WithFuture never pends and
    // never polls the scheduler. No `spawner.push` follows, so without the fix the
    // slot stays registered to the command loop.
    actor
        .eval_async("Promise.resolve(1).then((x) => x)")
        .await
        .expect("job-only async eval (slot steal)");

    // Resolve the capability gate from this non-owner thread. The capability
    // future's scheduler waker fires, re-queueing it and waking the SINGLE slot.
    // The continuation MUST run with ZERO further JS commands — only possible if
    // the DriveFuture's waker (not the stale command-loop one) is in the slot.
    gate_tx.send(()).expect("resolve capability gate");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !done.load(Ordering::SeqCst) {
        if std::time::Instant::now() > deadline {
            panic!(
                "spawned-capability continuation stalled after a command's WithFuture \
                 stole the scheduler's single waker slot (the actor's post-command \
                 DriveFuture kick did not re-register it)"
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    actor.shutdown().await;
}

/// A timer registered and awaited by the SAME `eval_async` command must advance
/// while that command is in flight. Before Bead 9sp the owner loop awaited the
/// command future directly, so it could not reach its timer pump and this one
/// 5ms timer hung forever.
///
/// The nested second timer also proves the command future is pinned and polled
/// continuously rather than reconstructed (which would evaluate the body more
/// than once). The outer Tokio timeout turns the old infinite hang into a fast,
/// named failure.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn eval_async_awaits_nested_timers_without_restarting() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let json = bounded(
        "eval_async awaiting nested guest timers",
        actor.eval_async(
            r#"(async () => {
  globalThis.__evalStarts = (globalThis.__evalStarts ?? 0) + 1;
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 5));
  return {value: 42, starts: globalThis.__evalStarts, elapsed: Date.now() - started};
})()"#,
        ),
    )
    .await
    .expect("timer-bound eval must complete");
    let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
    assert_eq!(value["value"], 42);
    assert_eq!(value["starts"], 1, "the command body must run exactly once");
    assert!(
        value["elapsed"].as_u64().unwrap_or(0) >= 10,
        "two sequential 5ms timers fired early: {value}"
    );
    actor.shutdown().await;
}

/// `Push` is the other owner command that awaits an `AsyncContext::async_with`
/// guest Promise. Its timer semantics must match `EvalAsync`; otherwise an
/// async push handler can deadlock the owner and its std-channel producer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn push_handler_can_await_a_guest_timer() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    // The escape makes the RED/reversal leg terminate causally. Under the old
    // implementation the timer cannot fire while Push is in flight, but this
    // async capability can still be resolved from Rust through the DriveFuture.
    // The assertion below requires the TIMER to win; the escape exists only to
    // unblock and join the producer before reporting a failure.
    let (escape_tx, escape_started) = install_gated_capability(&actor, "__pushEscape").await;
    actor
        .eval(
            r#"globalThis.__pushStarts = 0;
globalThis.__pushResult = null;
globalThis.__jsenv_on_push = async (payload) => {
  globalThis.__pushStarts += 1;
  const winner = await Promise.race([
    new Promise((resolve) => setTimeout(() => resolve('timer'), 5)),
    __pushEscape().then(() => 'escape'),
  ]);
  globalThis.__pushResult = {payload, winner};
};"#,
        )
        .await
        .expect("install async push handler");

    let sender = actor.clone_sender();
    let mut producer = tokio::task::spawn_blocking(move || sender.push_blocking("pushed"));
    wait_flag("push escape capability did not start", &escape_started).await;
    let delivery = match tokio::time::timeout(std::time::Duration::from_secs(1), &mut producer).await {
        Ok(joined) => joined.expect("push producer task"),
        Err(_) => {
            escape_tx.send(()).expect("release push cleanup escape");
            bounded("join push producer after cleanup escape", producer)
                .await
                .expect("push producer task after escape")
                .expect("push cleanup delivery");
            panic!("push handler did not complete from its guest timer; cleanup escape won");
        }
    };
    delivery.expect("push delivery");
    // Let the losing race arm settle so teardown leaves no gated capability.
    let _ = escape_tx.send(());

    let json = actor
        .eval_async("({starts: globalThis.__pushStarts, result: globalThis.__pushResult})")
        .await
        .expect("read push outcome");
    let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
    assert_eq!(
        value,
        serde_json::json!({"starts": 1, "result": {"payload": "pushed", "winner": "timer"}})
    );
    actor.shutdown().await;
}

/// The initially-no-timer race: an external capability resolves, its guest
/// continuation registers a timer, and no unrelated owner command arrives to
/// wake the loop. `Notify` must make the in-flight command recompute the timer
/// registry and complete.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capability_continuation_can_register_an_awaited_timer() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let (gate_tx, started) = install_gated_capability(&actor, "__capThenTimer").await;
    let sender = actor.clone_sender();
    let task = tokio::spawn(async move {
        sender
            .eval_async(
                r#"(async () => {
  const value = await __capThenTimer();
  await new Promise((resolve) => setTimeout(resolve, 5));
  return value + 1;
})()"#,
            )
            .await
    });
    wait_flag("capability did not start", &started).await;
    gate_tx.send(()).expect("release capability");
    let json = bounded("capability -> timer command", task)
        .await
        .expect("eval task")
        .expect("eval result");
    assert_eq!(json, "8");
    actor.shutdown().await;
}

/// The reverse handoff: a bare QuickJS timer continuation starts a spawned
/// async capability. The existing `drain_jobs` no-op spawn kick must hand work
/// back to the long-lived DriveFuture without another owner command.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timer_continuation_can_await_an_async_capability() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let (gate_tx, started) = install_gated_capability(&actor, "__timerThenCap").await;
    let sender = actor.clone_sender();
    let task = tokio::spawn(async move {
        sender
            .eval_async(
                r#"(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return (await __timerThenCap()) + 2;
})()"#,
            )
            .await
    });
    wait_flag("timer continuation did not start capability", &started).await;
    gate_tx.send(()).expect("release capability");
    let json = bounded("timer -> capability command", task)
        .await
        .expect("eval task")
        .expect("eval result");
    assert_eq!(json, "9");
    actor.shutdown().await;
}

/// Timer re-entry must not turn command handling concurrent. A second command
/// queued after the first has causally started remains queued until the first
/// timer-bound command completes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timer_pump_preserves_owner_command_serialization() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let (gate_tx, gate_started) = install_gated_capability(&actor, "__serializationGate").await;
    actor.eval("globalThis.__order = []").await.expect("initialize order");

    let first_sender = actor.clone_sender();
    let first = tokio::spawn(async move {
        first_sender
            .eval_async(
                r#"(async () => {
  globalThis.__order.push('first-start');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await __serializationGate();
  globalThis.__order.push('first-end');
  return true;
})()"#,
            )
            .await
    });
    // This is causal evidence that the timer fired and the first command is now
    // still pending on the explicit gate.
    wait_flag("first command did not reach its post-timer gate", &gate_started).await;

    let second_sender = actor.clone_sender();
    let second = second_sender
        .eval_async("globalThis.__order.push('second'); return globalThis.__order");
    tokio::pin!(second);
    assert!(
        matches!(futures::poll!(&mut second), std::task::Poll::Pending),
        "the second command must be causally enqueued behind the gated first command"
    );
    gate_tx.send(()).expect("release first command gate");
    bounded("serialized first command", first)
        .await
        .expect("first task")
        .expect("first result");
    let json = bounded("queued second command", &mut second)
        .await
        .expect("second result");
    let order: Vec<String> = serde_json::from_str(&json).expect("valid order JSON");
    assert_eq!(order, ["first-start", "first-end", "second"]);
    actor.shutdown().await;
}

/// Cancelling the caller wait is deliberately NOT command cancellation. Once
/// queued, a finite timer-bound command still completes its side effect and a
/// later command progresses; this preserves the actor contract that predates
/// Bead 9sp.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_eval_waiter_does_not_cancel_the_owner_command() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let started = Arc::new(AtomicBool::new(false));
    let completed = Arc::new(AtomicBool::new(false));
    {
        let started_fn = Arc::clone(&started);
        let completed_fn = Arc::clone(&completed);
        actor
            .with_context(move |ctx| {
                ctx.globals().set(
                    "__cancelStarted",
                    Function::new(ctx.clone(), move || started_fn.store(true, Ordering::SeqCst))
                        .map_err(rquickjs::Error::from)?,
                )?;
                ctx.globals().set(
                    "__cancelCompleted",
                    Function::new(ctx.clone(), move || completed_fn.store(true, Ordering::SeqCst))
                        .map_err(rquickjs::Error::from)?,
                )?;
                Ok(())
            })
            .await
            .expect("install cancellation signals");
    }

    let sender = actor.clone_sender();
    let waiter = tokio::spawn(async move {
        sender
            .eval_async(
                r#"(async () => {
  __cancelStarted();
  await new Promise((resolve) => setTimeout(resolve, 10));
  __cancelCompleted();
  return true;
})()"#,
            )
            .await
    });
    wait_flag("cancelled command did not start", &started).await;
    waiter.abort();
    let cancelled = waiter.await.expect_err("aborted waiter must not complete normally");
    assert!(cancelled.is_cancelled(), "waiter ended for a reason other than cancellation");
    wait_flag("cancelled waiter cancelled the owner command", &completed).await;
    assert_eq!(actor.eval_async("21 * 2").await.expect("later command"), "42");
    actor.shutdown().await;
}

/// Shutdown is a serialized owner command. Queued behind a finite timer-bound
/// evaluation, it drains in order and joins the owner thread rather than racing
/// or abandoning that command.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_queued_behind_timer_command_drains_in_order() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let (gate_tx, gate_started) = install_gated_capability(&actor, "__shutdownGate").await;

    let sender = actor.clone_sender();
    let command = tokio::spawn(async move {
        sender
            .eval_async(
                r#"(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await __shutdownGate();
  return 'finished-before-shutdown';
})()"#,
            )
            .await
    });
    wait_flag("pre-shutdown command did not reach its post-timer gate", &gate_started).await;
    let shutdown = actor.shutdown();
    tokio::pin!(shutdown);
    assert!(
        matches!(futures::poll!(&mut shutdown), std::task::Poll::Pending),
        "shutdown must be causally enqueued behind the gated command"
    );
    gate_tx.send(()).expect("release pre-shutdown command gate");
    assert_eq!(
        bounded("finite command before shutdown", command)
            .await
            .expect("command task")
            .expect("command result"),
        "\"finished-before-shutdown\""
    );
    bounded("serialized shutdown", &mut shutdown).await;
}

/// Waiting only on an external capability must not start a fixed timer tick.
/// Count calls to the guest timer-fire hook after the capability is in flight;
/// the count must remain stable until that capability is explicitly released.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capability_only_wait_does_not_busy_poll_the_timer_hook() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let (gate_tx, started) = install_gated_capability(&actor, "__noTimerCap").await;
    let fire_calls = Arc::new(AtomicUsize::new(0));
    {
        let fire_calls = Arc::clone(&fire_calls);
        actor
            .with_context(move |ctx| {
                let count_fire = Function::new(ctx.clone(), move |_now: f64| {
                    fire_calls.fetch_add(1, Ordering::SeqCst);
                    0
                })
                .map_err(rquickjs::Error::from)?;
                ctx.globals().set("__jsenv_fire_due", count_fire)?;
                Ok(())
            })
            .await
            .expect("install timer-fire counter");
    }

    let sender = actor.clone_sender();
    let command = tokio::spawn(async move { sender.eval_async("__noTimerCap()").await });
    wait_flag("no-timer capability did not start", &started).await;
    let baseline = fire_calls.load(Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        fire_calls.load(Ordering::SeqCst),
        baseline,
        "the in-flight pump must sleep on capability/Notify, not tick"
    );
    gate_tx.send(()).expect("release capability");
    assert_eq!(
        bounded("no-timer capability command", command)
            .await
            .expect("command task")
            .expect("command result"),
        "7"
    );
    actor.shutdown().await;
}

// ---------------------------------------------------------------------------
// Bead b41: shutdown is a BOUNDED DRAIN (see actor.rs "Shutdown policy").
// ---------------------------------------------------------------------------

const SHORT_GRACE: std::time::Duration = std::time::Duration::from_millis(100);
const LONG_GRACE: std::time::Duration = std::time::Duration::from_secs(60);
const ABANDONED: &str = "abandoned past the shutdown deadline";

/// A never-settling guest Promise (no timer, no capability) keeps the in-flight
/// command open forever. Shutdown must still complete within its grace, report
/// the abandonment, and hand the command's caller the SPECIFIC abandonment
/// error (a bare `is_err()` would also pass under a thread-kill implementation,
/// which yields "owner dropped response").
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_abandons_never_settling_eval_within_grace() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let started = Arc::new(AtomicBool::new(false));
    {
        let started_fn = Arc::clone(&started);
        actor
            .with_context(move |ctx| {
                ctx.globals().set(
                    "__neverStarted",
                    Function::new(ctx.clone(), move || started_fn.store(true, Ordering::SeqCst))
                        .map_err(rquickjs::Error::from)?,
                )?;
                Ok(())
            })
            .await
            .expect("install start signal");
    }
    let sender = actor.clone_sender();
    let waiter = tokio::spawn(async move {
        sender.eval_async("(async () => { __neverStarted(); await new Promise(() => {}); })()").await
    });
    wait_flag("never-settling command did not start", &started).await;

    let outcome = bounded("bounded shutdown behind a never-settling command", actor.shutdown_within(SHORT_GRACE)).await;
    assert_eq!(outcome, ShutdownOutcome::AbandonedInFlight);
    let err = bounded("abandoned waiter", waiter).await.expect("join").expect_err("abandoned command must error");
    let text = format!("{err}");
    assert!(text.contains(ABANDONED) && text.contains("EvalAsync"), "unexpected error: {text}");
}

/// The same bound must reach a `push_blocking` producer: a plain OS thread
/// blocked on the Push's std channel is the only path with a foreseeable
/// production caller (the GTK intent hot path) and the worst failure mode (a
/// permanently blocked thread). It must unblock with the explicit error and join.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_abandons_never_settling_push_and_unblocks_the_producer_thread() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let started = Arc::new(AtomicBool::new(false));
    {
        let started_fn = Arc::clone(&started);
        actor
            .with_context(move |ctx| {
                ctx.globals().set(
                    "__pushStarted",
                    Function::new(ctx.clone(), move || started_fn.store(true, Ordering::SeqCst))
                        .map_err(rquickjs::Error::from)?,
                )?;
                Ok(())
            })
            .await
            .expect("install start signal");
    }
    actor
        .eval("globalThis.__jsenv_on_push = () => { __pushStarted(); return new Promise(() => {}); };")
        .await
        .expect("install never-settling push handler");
    let sender = actor.clone_sender();
    let producer = std::thread::spawn(move || sender.push_blocking("{\"kind\":\"never\"}"));
    wait_flag("never-settling push did not start", &started).await;

    let outcome = bounded("bounded shutdown behind a never-settling push", actor.shutdown_within(SHORT_GRACE)).await;
    assert_eq!(outcome, ShutdownOutcome::AbandonedInFlight);
    let joined = tokio::task::spawn_blocking(move || producer.join());
    let result = bounded("producer thread join", joined).await.expect("spawn_blocking").expect("producer did not panic");
    let text = result.expect_err("abandoned push must error");
    assert!(text.contains(ABANDONED) && text.contains("Push"), "unexpected error: {text}");
}

/// Abandon a command pending on a NEVER-released gated `Async` capability: the
/// spawned capability future is still live in the runtime's scheduler when the
/// owner drops the runtime. Proves that drop is clean (no hang, no panic) with a
/// pending spawned task — a path no earlier test exercised (every gate is
/// released before shutdown elsewhere). The gate sender is kept alive until
/// after shutdown so the future is genuinely pending, not rejected.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_abandons_command_pending_on_unreleased_capability() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let (gate_tx, started) = install_gated_capability(&actor, "__neverReleasedGate").await;
    let sender = actor.clone_sender();
    let waiter = tokio::spawn(async move { sender.eval_async("__neverReleasedGate()").await });
    wait_flag("gated capability did not start", &started).await;

    let outcome = bounded("bounded shutdown behind an unreleased capability", actor.shutdown_within(SHORT_GRACE)).await;
    assert_eq!(outcome, ShutdownOutcome::AbandonedInFlight);
    let err = bounded("abandoned waiter", waiter).await.expect("join").expect_err("abandoned command must error");
    assert!(format!("{err}").contains(ABANDONED));
    drop(gate_tx); // only now; the runtime was dropped with the future pending
}

/// NEGATIVE CONTROL (distinguishes the bounded drain from force-cancel): with a
/// long grace, shutdown queued behind a FINITE gated command stays Pending, the
/// pending-but-not-due deadline introduces NO tick (the guest fire hook is not
/// called across the window), and once the gate is released the drain is Clean
/// and the command's caller gets its REAL result.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn long_grace_shutdown_waits_for_finite_work_without_ticking() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let (gate_tx, started) = install_gated_capability(&actor, "__finiteGate").await;
    let fire_calls = Arc::new(AtomicUsize::new(0));
    {
        let fire_calls = Arc::clone(&fire_calls);
        actor
            .with_context(move |ctx| {
                let count_fire = Function::new(ctx.clone(), move |_now: f64| {
                    fire_calls.fetch_add(1, Ordering::SeqCst);
                    0
                })
                .map_err(rquickjs::Error::from)?;
                ctx.globals().set("__jsenv_fire_due", count_fire)?;
                Ok(())
            })
            .await
            .expect("install timer-fire counter");
    }
    let sender = actor.clone_sender();
    let command = tokio::spawn(async move { sender.eval_async("__finiteGate()").await });
    wait_flag("finite gated command did not start", &started).await;

    let shutdown = actor.shutdown_within(LONG_GRACE);
    tokio::pin!(shutdown);
    // Poll ONCE first: an async fn body runs only when polled, and this first poll
    // is what records the deadline and enqueues Shutdown. Only after it is the
    // new code path live, so the measurement window below is meaningful.
    assert!(
        matches!(futures::poll!(&mut shutdown), std::task::Poll::Pending),
        "shutdown must be causally enqueued behind the gated command"
    );
    let baseline = fire_calls.load(Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(
        matches!(futures::poll!(&mut shutdown), std::task::Poll::Pending),
        "a long-grace shutdown must not abandon finite in-flight work"
    );
    assert_eq!(
        fire_calls.load(Ordering::SeqCst),
        baseline,
        "a pending-but-not-due shutdown deadline must not introduce a tick"
    );
    gate_tx.send(()).expect("release finite gate");
    assert_eq!(
        bounded("finite command before shutdown", command).await.expect("command task").expect("command result"),
        "7"
    );
    assert_eq!(bounded("clean drain", &mut shutdown).await, ShutdownOutcome::Clean);
}

/// Dropping the actor WITHOUT calling shutdown is not a full shutdown, but it
/// must not leave the owner thread parked forever: `Drop` records the default
/// deadline and enqueues Shutdown non-blocking. Proof: a never-settling command
/// in flight through a clone_sender still gets the explicit abandonment error
/// after the actor handle is dropped (takes ~DEFAULT_SHUTDOWN_GRACE).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_the_actor_still_bounds_a_never_settling_command() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let started = Arc::new(AtomicBool::new(false));
    {
        let started_fn = Arc::clone(&started);
        actor
            .with_context(move |ctx| {
                ctx.globals().set(
                    "__dropStarted",
                    Function::new(ctx.clone(), move || started_fn.store(true, Ordering::SeqCst))
                        .map_err(rquickjs::Error::from)?,
                )?;
                Ok(())
            })
            .await
            .expect("install start signal");
    }
    let sender = actor.clone_sender();
    let waiter = tokio::spawn(async move {
        sender.eval_async("(async () => { __dropStarted(); await new Promise(() => {}); })()").await
    });
    wait_flag("never-settling command did not start", &started).await;
    drop(actor);
    let bound = lagrange_host_linux::js_env::actor::DEFAULT_SHUTDOWN_GRACE + std::time::Duration::from_secs(3);
    let err = tokio::time::timeout(bound, waiter)
        .await
        .expect("dropped actor must still bound the in-flight command")
        .expect("join")
        .expect_err("abandoned command must error");
    assert!(format!("{err}").contains(ABANDONED));
}

// ---------------------------------------------------------------------------
// Bead c4g: ready QuickJS jobs drain in bounded lock-holding batches.
// ---------------------------------------------------------------------------

/// A synchronous Eval can complete after scheduling a Promise reaction whose
/// every run schedules another reaction. The command's response is already
/// delivered, but the old unbounded post-command drain never returns to observe
/// the b41 whole-drain deadline. This characterization must time out before the
/// c4g batching fix and complete with ready-job abandonment afterwards. The
/// first reaction also schedules an async capability; shutdown must remain
/// bounded without handing the still-nonquiescent raw queue to DriveFuture.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_bounds_a_self_perpetuating_ready_job_chain() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let (gate_tx, _started) = install_gated_capability(&actor, "__stormCapability").await;
    actor
        .eval(
            r#"Promise.resolve().then(function startReadyJobStorm() {
  void __stormCapability();
  Promise.resolve().then(function readyJobStorm() {
    Promise.resolve().then(readyJobStorm);
  });
});"#,
        )
        .await
        .expect("schedule self-perpetuating ready-job chain");

    let outcome = bounded(
        "shutdown behind a self-perpetuating ready-job chain",
        actor.shutdown_within(SHORT_GRACE),
    )
    .await;
    assert_eq!(
        outcome,
        ShutdownOutcome::AbandonedReadyJobs,
        "the Eval completed before only its ready-job chain was abandoned"
    );
    drop(gate_tx);
}

/// The batch size is a lock-holding bound, never a total work limit. A finite
/// chain much larger than one batch must reach quiescence before the next queued
/// command observes it, and shutdown must remain clean.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn finite_ready_job_chains_drain_completely_across_batches() {
    const FINITE_JOBS: usize = 10_000;

    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let completed = Arc::new(AtomicUsize::new(0));
    {
        let completed_in_job = Arc::clone(&completed);
        actor
            .with_context(move |ctx| {
                let count_job = Function::new(ctx.clone(), move || {
                    completed_in_job.fetch_add(1, Ordering::SeqCst);
                })
                .map_err(rquickjs::Error::from)?;
                ctx.globals().set("__countFiniteReadyJob", count_job)?;
                Ok(())
            })
            .await
            .expect("install finite ready-job counter");
    }
    let source = format!(
        r#"globalThis.__finiteReadyJobs = 0;
Promise.resolve().then(function finiteReadyJobs() {{
  globalThis.__finiteReadyJobs += 1;
  __countFiniteReadyJob();
  if (globalThis.__finiteReadyJobs < {FINITE_JOBS}) {{
    Promise.resolve().then(finiteReadyJobs);
  }}
}});"#
    );
    actor
        .eval(&source)
        .await
        .expect("schedule finite ready-job chain");

    assert_eq!(actor.shutdown().await, ShutdownOutcome::Clean);
    assert_eq!(
        completed.load(Ordering::SeqCst),
        FINITE_JOBS,
        "shutdown must drain the complete finite chain, not one fixed total batch"
    );
}
