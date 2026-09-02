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

use lagrange_host_linux::js_env::actor::JsEnvActor;
use lagrange_host_linux::js_env::EmbeddedLoader;

use rquickjs::prelude::Async;
use rquickjs::Function;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

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
