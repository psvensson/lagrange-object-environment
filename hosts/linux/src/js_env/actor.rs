//! 3zb-A slice 2: the dedicated-owner-thread actor.
//!
//! The slice-1 `JsEnvOwner` lets the caller drive the runtime on whatever thread
//! calls it. The slice-2 falsifier PROVED that is insufficient for thread
//! ownership: `tokio::spawn(runtime.drive())` on a multi-thread runtime lets the
//! drive task MIGRATE across worker threads, so a JS continuation can resume on
//! a different thread than the one that spawned the driver (measured: owner
//! ThreadId(2) vs continuation ThreadId(4)). `rquickjs`'s `parallel` feature
//! ENABLES cross-thread wake mechanics but does NOT establish one owner.
//!
//! So the real model is a DEDICATED OWNER THREAD:
//!
//!   - ONE OS thread owns the JS runtime. It runs a `current_thread` tokio
//!     runtime + `LocalSet`, constructs the AsyncRuntime/AsyncContext there,
//!     spawns `drive()` locally there, and processes commands. EVERY piece of
//!     QuickJS contact (eval, push delivery, capability-fn setup, driving JS
//!     continuations) happens on THAT thread, by construction.
//!   - All other threads are non-JS. They interact ONLY via channels:
//!       * a capability resolver completes a `tokio::oneshot` (waking the
//!         runtime waker -> the owner's drive task resumes the JS continuation
//!         ON the owner thread);
//!       * a push producer sends a `HostPush` on the owner's command mpsc
//!         (-> the owner injects it into JS on the owner thread).
//!     Neither ever touches QuickJS.
//!   - Shutdown (Bead b41): `shutdown()` / `shutdown_within(grace)` is a BOUNDED
//!     DRAIN — see "Shutdown policy" below. Dropping the actor WITHOUT calling
//!     shutdown is NOT a full shutdown: `Drop` only records the default deadline
//!     and enqueues `Shutdown` (non-blocking, no join), so a leaked actor's owner
//!     thread self-terminates instead of parking forever; a pending capability's
//!     oneshot sender drop rejects the JS promise (no use-after-free).
//!
//! # Shutdown policy (Bead b41): a bounded drain, never a cancel of finite work
//!
//! `EvalAsync`/`Push` are serialized: the owner loop does NOT poll for later
//! commands while one is in flight (`await_command_with_timer_pump`), so a queued
//! `Shutdown` is only received after the in-flight command settles. A guest
//! Promise that never settles (no timer, no capability completion) would keep the
//! loop there forever. Policy:
//!
//!   - Shutdown never cancels FINITE work: a command that settles before the
//!     deadline completes normally and its caller gets its real result (the 9sp
//!     contract, `shutdown_queued_behind_timer_command_drains_in_order`).
//!   - The bound is ONE absolute deadline for the WHOLE drain (recorded before the
//!     `Shutdown` command is enqueued): `shutdown()` uses `DEFAULT_SHUTDOWN_GRACE`,
//!     `shutdown_within(grace)` makes it explicit. It is checked at the TOP of every
//!     pump iteration (never as a trailing `select!` branch: a continuously-ready
//!     timer branch — `wait == 0` with the 1 ms clamped observation follow — would
//!     starve it) and the pump's sleep is clamped to it.
//!   - Past the deadline the in-flight async command is ABANDONED: its pinned
//!     `async_with` future is dropped and its caller receives an EXPLICIT error
//!     naming the command kind (the std-channel `push_blocking` producer unblocks
//!     with it too); never a silent drop. Every later `EvalAsync`/`Push` dequeued
//!     before `Shutdown` is abandoned the same way. `shutdown*` reports
//!     `ShutdownOutcome::AbandonedInFlight` (or the combined ready-jobs variant;
//!     see below). Ready QuickJS jobs are drained in bounded lock-holding batches
//!     with no fixed total cap; if the same deadline passes while a raw ready-job
//!     chain remains, that work is abandoned and reported separately. Otherwise
//!     shutdown is `Clean`; `OwnerGone` means the owner exited without answering.
//!   - Abandonment abandons the OBSERVATION, not the guest computation: the
//!     normal post-command `drain_jobs` + no-op-spawn kick still runs (it also
//!     repairs the scheduler waker slot on this path), so ready continuations of
//!     the abandoned chain may still execute before the runtime is dropped.
//!   - Dropping the abandoned future frees JS values OUTSIDE the runtime lock
//!     (`Value::drop`/`Ctx::drop` call `JS_FreeValue`/`JS_FreeContext` immediately;
//!     upstream routes `AsyncContext` handle drops through a deferred channel for
//!     this class of problem but defers no value frees). That is sound here ONLY
//!     because of this architecture: all QuickJS contact is on the owner thread,
//!     and between polls no other task on it runs and no other thread can hold
//!     the lock. Do not move the drop elsewhere.
//!   - Ready QuickJS jobs are drained to quiescence with NO fixed total job cap,
//!     but in bounded batches which release the runtime lock and re-observe the
//!     same whole-drain deadline between batches. While raw jobs remain, this
//!     actor is their exclusive driver: it does not wake/yield to rquickjs's
//!     `DriveFuture`, whose own raw-job drain is unbounded. Past the deadline,
//!     remaining ready jobs are abandoned; the owner skips further timer/job
//!     drains and proceeds directly through the serialized queue to `Shutdown`.
//!   - NOT covered by the bound (documented escape hatches): ANY non-returning
//!     SYNCHRONOUS JavaScript, whichever command carries it — a sync `Eval`/
//!     `WithContext`, or a `while(true){}` inside an `EvalAsync`/`Push` body (the
//!     pump cannot preempt a single poll; needs a QuickJS interrupt handler — a
//!     separate semantic decision); and a sync command dequeued after the
//!     deadline (it still runs to completion).
//!
//! This is the "one explicit JS-runtime execution owner" the charter demands,
//! established by the wrapper rather than assumed from `parallel`.
//!
//! # RE-ENTRANCY INVARIANT (load-bearing for the renderer/Images ports)
//!
//! A host-callable (an `Async` capability fn, a renderer op) runs its Rust
//! closure WHILE the drive task holds the runtime lock (the JS continuation is
//! driven by `drive()`'s scheduler poll; `drive()` acquires and RELEASES the
//! lock per poll). Therefore a host-callable MUST resolve its work via a
//! cross-thread WAKER — complete a `tokio::oneshot`, which wakes the runtime
//! waker and lets the owner's drive task resume the continuation — and MUST
//! NEVER synchronously `send` an `OwnerCommand` and `.await` its `done` from
//! within that lock. Doing so is a single-thread self-deadlock: the owner would
//! block waiting for a command that it itself must process, while the lock the
//! command needs is held. The renderer port gets its OWN channel (structurally
//! distinct from `OwnerCommand`) precisely so the deadlocking path is not the
//! path of least resistance. If you find yourself wanting to send an
//! `OwnerCommand` from inside a capability/renderer closure, the design is
//! wrong — resolve via a oneshot instead.
//!
//! # `with_context` / capability-closure contract
//!
//! `with_context` runs its closure under the runtime lock on the owner thread.
//! The closure (and any host fn it installs) MUST NOT (a) await an
//! `OwnerCommand` completion, or (b) smuggle a `Ctx`/`AsyncContext` clone out to
//! another thread (the `JsEnvOwner` accessors are `pub(crate)` so only this
//! crate can reach them; do not widen that). Capturing a `oneshot::Sender` (to
//! resolve later from a worker thread) is the intended pattern.

use std::future::Future;
use std::sync::mpsc as std_mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rquickjs::{Error, Result};
use tokio::sync::{mpsc as tokio_mpsc, oneshot, watch};

/// The default whole-drain grace for `shutdown()` (Bead b41). Generous on purpose:
/// every existing caller is a test whose finite work must keep draining first; a
/// hung binary now fails within this bound instead of the CI job timeout.
pub const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Maximum raw QuickJS jobs executed while holding the runtime lock once.
/// This is a batch size, NOT a total limit: finite chains keep draining across
/// batches until quiescence unless the existing shutdown deadline expires.
const READY_JOB_BATCH_SIZE: usize = 64;

/// What a bounded shutdown drain did (Bead b41). `Clean`: every queued command
/// settled before the deadline. `AbandonedInFlight`: at least one `EvalAsync`/
/// `Push` was abandoned past the deadline (each such caller got the explicit
/// abandonment error). `AbandonedReadyJobs`: a command had completed, but raw
/// ready jobs it scheduled were abandoned past the deadline.
/// `AbandonedInFlightAndReadyJobs`: both kinds were abandoned. `OwnerGone`: the
/// owner thread exited or panicked without answering the `Shutdown` command —
/// nothing is known about queued commands (their callers see `owner dropped
/// response`). Deliberately NOT `#[must_use]`: existing statement-position
/// callers are fine ignoring it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownOutcome {
    Clean,
    AbandonedInFlight,
    AbandonedReadyJobs,
    AbandonedInFlightAndReadyJobs,
    OwnerGone,
}

/// Result of awaiting one asynchronous owner command under the shutdown deadline.
enum CommandOutcome<T> {
    Completed(T),
    /// The whole-drain deadline passed while the command was in flight; its
    /// future was dropped (see the module doc "Shutdown policy").
    Abandoned { ready_jobs: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DrainJobsOutcome {
    Quiescent,
    MoreReadyJobs,
    AbandonedReadyJobs,
}

use super::JsEnvOwner;

/// A command sent to the owner thread. Each carries a completion channel so the
/// caller can wait CAUSALLY for the owner to finish (no sleeps).
pub enum OwnerCommand {
    /// Evaluate a JS snippet on the owner thread.
    Eval {
        source: String,
        done: oneshot::Sender<Result<()>>,
    },
    /// Evaluate a JS snippet that yields a Promise, driving it to completion ON
    /// the owner thread and returning its value as a JSON string. For
    /// module-import / async evaluations that must resolve on the owner thread.
    EvalAsync {
        source: String,
        done: oneshot::Sender<Result<String>>,
    },
    /// Run a boxed closure against the context on the owner thread. Used to
    /// install host functions/capabilities from another thread.
    WithContext {
        f: Box<dyn FnOnce(&rquickjs::Ctx) -> Result<()> + Send>,
        done: oneshot::Sender<Result<()>>,
    },
    /// Deliver a host push (observation/intent) to the registered JS handler.
    /// The completion is a STD channel so a non-JS producer thread can block on
    /// it directly WITHOUT spinning up a throwaway tokio runtime per push (the
    /// GTK intent hot path must not build a runtime per event).
    Push {
        payload: String,
        done: std_mpsc::Sender<Result<()>>,
    },
    /// Shut the owner down: drain (bounded by the recorded deadline) and exit the
    /// thread loop, reporting whether anything was abandoned.
    Shutdown { done: oneshot::Sender<ShutdownOutcome> },
}

/// Handle to the dedicated JS-runtime owner thread. Cheap to clone the sender
/// side for non-JS producers; the join handle is held by the owner.
pub struct JsEnvActor {
    tx: tokio_mpsc::UnboundedSender<OwnerCommand>,
    thread: Option<JoinHandle<()>>,
    /// The whole-drain shutdown deadline (None until a shutdown is requested).
    /// Owner-visible through the paired receiver; see the module doc.
    shutdown_deadline: watch::Sender<Option<Instant>>,
    /// The OS thread id of the owner thread (for ownership assertions).
    owner_thread: std::thread::ThreadId,
}

impl JsEnvActor {
    /// Spawn the dedicated JS-runtime owner thread with the given loader. The
    /// thread constructs the runtime/context, installs host globals, spawns
    /// `drive()` on its `LocalSet`, and runs the command loop. Returns once the
    /// owner thread is ready (causal handshake). Generic over the loader (the
    /// Environment closure uses `EmbeddedLoader`; the lagrange-images portable
    /// runtime uses the pinned-artifact `PortableImagesArtifactLoader` for B0 /
    /// 3zb-B).
    pub fn spawn<L>(loader: L) -> std::result::Result<Self, String>
    where
        L: rquickjs::loader::Resolver + rquickjs::loader::Loader + Clone + Send + 'static,
    {
        let (tx, mut rx) = tokio_mpsc::unbounded_channel::<OwnerCommand>();
        let (ready_tx, ready_rx) = std_mpsc::channel::<std::result::Result<std::thread::ThreadId, String>>();
        let (shutdown_deadline, mut deadline_rx) = watch::channel::<Option<Instant>>(None);

        let thread = std::thread::Builder::new()
            .name("js-env-owner".to_string())
            .spawn(move || {
                // A current_thread runtime + LocalSet so drive() and all JS work
                // run on THIS thread and never migrate.
                let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    Ok(rt) => rt,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("build owner runtime: {e}")));
                        return;
                    }
                };
                let local = tokio::task::LocalSet::new();
                local.block_on(&rt, async {
                    let owner = match JsEnvOwner::new(loader).await {
                        Ok(o) => o,
                        Err(e) => {
                            let _ = ready_tx.send(Err(format!("build JsEnvOwner: {e}")));
                            return;
                        }
                    };
                    // Spawn the long-lived drive task on THIS thread's LocalSet. It
                    // owns SPAWNED runtime futures (capability `Async` host fns): it
                    // parks on the scheduler and is woken by `spawner.push` when such a
                    // future is spawned or by the future's own waker when its cross-thread
                    // oneshot completes. It is NOT sufficient on its own, though: a guest
                    // promise resolved by a SYNC host callback (`fire_due_timers`, a
                    // fire-and-forget push handler) enqueues a BARE QuickJS job that wakes
                    // nobody, so the command loop must ALSO drain ready jobs itself (see
                    // `drain_jobs` below) or those continuations stall whenever no
                    // `eval_async` happens to be in flight (the slice-4 OLM stall).
                    let _drive = owner.runtime().drive();
                    tokio::task::spawn_local(_drive);

                    // Woken by the guest setTimeout/clearTimeout (via the
                    // __jsenv_timer_changed host fn) so the loop recomputes the
                    // next-due timer even when parked with no pending timers (the
                    // slice-3B missed-wakeup liveness fix).
                    let timer_notify = owner.timer_notify();

                    // Handshake: report this thread's id as the owner.
                    let _ = ready_tx.send(Ok(std::thread::current().id()));

                    // Set when an in-flight async command is abandoned past the
                    // shutdown deadline; reported through Shutdown's completion.
                    let mut abandoned_in_flight = false;
                    // Set when a raw ready-job chain remains at the same deadline.
                    // Once set, never enter timer/job draining again: doing so would
                    // immediately re-enter the work shutdown deliberately abandoned.
                    let mut abandoned_ready_jobs = false;

                    // Command loop: process commands; drive() runs concurrently on
                    // the LocalSet so JS continuations progress between commands.
                    // The loop ALSO wakes to fire due guest setTimeout timers (the
                    // 3B correction: image-observation depends on guest setTimeout;
                    // the shell tests only fired timers manually). The guest timer
                    // registry uses Date.now() (epoch-ms); the owner reads the same
                    // clock domain via SystemTime.
                    loop {
                        // Once ready work has been abandoned, go directly to the
                        // serialized command queue. Firing/draining again would re-enter
                        // the abandoned storm before the queued Shutdown can be received.
                        let next_due_ms = if abandoned_ready_jobs {
                            None
                        } else {
                            // Fire any timers already due, then compute when the next
                            // is due (None = no pending timers -> wait indefinitely).
                            fire_due_timers(&owner).await;
                            // Firing a timer resolves a guest `setTimeout` promise via a
                            // SYNC host callback, enqueuing a bare QuickJS job that wakes
                            // nobody. Drain those ready continuations on the owner thread.
                            if drain_jobs(&owner, &deadline_rx).await
                                == DrainJobsOutcome::AbandonedReadyJobs
                            {
                                abandoned_ready_jobs = true;
                                None
                            } else {
                                next_timer_due_ms(&owner).await
                            }
                        };

                        // Wait for the next command, the next timer's due time,
                        // OR a timer-registry change (a setTimeout registered by a
                        // continuation resumed from a capability oneshot) —
                        // whichever comes first. The timer_notify branch is the
                        // missed-wakeup fix: without it a timer registered while
                        // the loop is parked (esp. in the no-pending-timers branch)
                        // would never fire until an unrelated command arrived.
                        let cmd = if abandoned_ready_jobs {
                            rx.recv().await
                        } else if let Some(due_ms) = next_due_ms {
                            let now_ms = epoch_ms();
                            let wait = due_ms.saturating_sub(now_ms);
                            tokio::select! {
                                cmd = rx.recv() => cmd,
                                _ = tokio::time::sleep(std::time::Duration::from_millis(wait)) => {
                                    continue; // Timer due: loop back to fire it.
                                }
                                _ = timer_notify.notified() => {
                                    continue; // Registry changed: recompute next_due.
                                }
                            }
                        } else {
                            tokio::select! {
                                cmd = rx.recv() => cmd,
                                _ = timer_notify.notified() => {
                                    continue; // A timer appeared: recompute next_due.
                                }
                            }
                        };

                        let Some(cmd) = cmd else { break }; // channel closed
                        match cmd {
                            OwnerCommand::Eval { source, done } => {
                                let r = owner.with(|ctx| ctx.eval::<(), _>(source.as_str())).await;
                                let _ = done.send(r);
                            }
                            OwnerCommand::EvalAsync { source, done } => {
                                let r = match await_command_with_timer_pump(
                                    &owner,
                                    eval_async_on_owner(&owner, &source),
                                    &mut deadline_rx,
                                )
                                .await
                                {
                                    CommandOutcome::Completed(r) => r,
                                    CommandOutcome::Abandoned { ready_jobs } => {
                                        abandoned_in_flight = true;
                                        abandoned_ready_jobs |= ready_jobs;
                                        Err(abandonment_error("EvalAsync"))
                                    }
                                };
                                let _ = done.send(r);
                            }
                            OwnerCommand::WithContext { f, done } => {
                                let r = owner.with(|ctx| f(&ctx)).await;
                                let _ = done.send(r);
                            }
                            OwnerCommand::Push { payload, done } => {
                                let r = match await_command_with_timer_pump(
                                    &owner,
                                    deliver_push_on_owner(&owner, payload),
                                    &mut deadline_rx,
                                )
                                .await
                                {
                                    CommandOutcome::Completed(r) => r,
                                    CommandOutcome::Abandoned { ready_jobs } => {
                                        abandoned_in_flight = true;
                                        abandoned_ready_jobs |= ready_jobs;
                                        Err(abandonment_error("Push"))
                                    }
                                };
                                let _ = done.send(r); // std channel: wakes any blocked producer
                            }
                            OwnerCommand::Shutdown { done } => {
                                let outcome = match (abandoned_in_flight, abandoned_ready_jobs) {
                                    (false, false) => ShutdownOutcome::Clean,
                                    (true, false) => ShutdownOutcome::AbandonedInFlight,
                                    (false, true) => ShutdownOutcome::AbandonedReadyJobs,
                                    (true, true) => {
                                        ShutdownOutcome::AbandonedInFlightAndReadyJobs
                                    }
                                };
                                let _ = done.send(outcome);
                                break;
                            }
                        }
                        // A delivered push starts a FIRE-AND-FORGET chain whose initial
                        // continuation is a bare QuickJS job (the push handler's promise
                        // is pre-resolved, so push delivery drains nothing). Drain ready
                        // jobs on the owner thread so those chains progress even when no
                        // eval is in flight; then yield so the drive task runs spawned
                        // (capability) futures on this thread.
                        if !abandoned_ready_jobs {
                            if drain_jobs(&owner, &deadline_rx).await
                                == DrainJobsOutcome::AbandonedReadyJobs
                            {
                                abandoned_ready_jobs = true;
                            } else {
                                tokio::task::yield_now().await;
                            }
                        }
                    }
                });
            })
            .map_err(|e| format!("spawn js-env-owner thread: {e}"))?;

        let owner_thread = ready_rx
            .recv()
            .map_err(|e| format!("owner handshake: {e}"))??;

        Ok(Self { tx, thread: Some(thread), owner_thread, shutdown_deadline })
    }

    /// The OS thread id of the dedicated JS-runtime owner.
    pub fn owner_thread_id(&self) -> std::thread::ThreadId {
        self.owner_thread
    }

    /// Evaluate JS on the owner thread; wait causally for completion.
    pub async fn eval(&self, source: &str) -> Result<()> {
        let (done, rx) = oneshot::channel();
        self.tx
            .send(OwnerCommand::Eval { source: source.to_string(), done })
            .map_err(|_| Error::new_from_js("actor", "owner thread gone"))?;
        rx.await.map_err(|_| Error::new_from_js("actor", "owner dropped response"))?
    }

    /// Evaluate a JS snippet yielding a Promise (or plain value), driven to
    /// completion ON the owner thread; returns the JSON-stringified result.
    pub async fn eval_async(&self, source: &str) -> Result<String> {
        let (done, rx) = oneshot::channel();
        self.tx
            .send(OwnerCommand::EvalAsync { source: source.to_string(), done })
            .map_err(|_| Error::new_from_js("actor", "owner thread gone"))?;
        rx.await.map_err(|_| Error::new_from_js("actor", "owner dropped response"))?
    }

    /// Run a closure against the JS context on the owner thread (e.g. to install
    /// a host function or capability). Wait causally for completion.
    pub async fn with_context<F>(&self, f: F) -> Result<()>
    where
        F: FnOnce(&rquickjs::Ctx) -> Result<()> + Send + 'static,
    {
        let (done, rx) = oneshot::channel();
        self.tx
            .send(OwnerCommand::WithContext { f: Box::new(f), done })
            .map_err(|_| Error::new_from_js("actor", "owner thread gone"))?;
        rx.await.map_err(|_| Error::new_from_js("actor", "owner dropped response"))?
    }

    /// Deliver a host push to the registered JS handler on the owner thread.
    pub async fn push(&self, payload: &str) -> Result<()> {
        let (done, rx) = std_mpsc::channel();
        self.tx
            .send(OwnerCommand::Push { payload: payload.to_string(), done })
            .map_err(|_| Error::new_from_js("actor", "owner thread gone"))?;
        // Bridge the std-channel recv into async without a busy loop.
        let out = tokio::task::spawn_blocking(move || rx.recv())
            .await
            .map_err(|_| Error::new_from_js("actor", "push wait panicked"))?;
        out.map_err(|_| Error::new_from_js("actor", "owner dropped response"))?
    }

    /// A clonable handle for non-JS producer threads (GTK, observation sources,
    /// capability resolvers) to send commands to the owner without holding the
    /// actor. This is the ONLY way a non-JS thread interacts with the JS owner.
    pub fn clone_sender(&self) -> JsEnvSender {
        JsEnvSender { tx: self.tx.clone() }
    }

    /// Shut the owner thread down and join it: a bounded drain with the default
    /// grace (`DEFAULT_SHUTDOWN_GRACE`). See the module doc "Shutdown policy".
    pub async fn shutdown(self) -> ShutdownOutcome {
        self.shutdown_within(DEFAULT_SHUTDOWN_GRACE).await
    }

    /// Shut the owner thread down and join it, completing the WHOLE drain within
    /// `grace`: finite queued work drains first; past the deadline any in-flight
    /// `EvalAsync`/`Push` is abandoned with an explicit error to its caller.
    pub async fn shutdown_within(mut self, grace: Duration) -> ShutdownOutcome {
        let (done, rx) = oneshot::channel();
        self.request_shutdown(grace, done);
        let outcome = rx.await.unwrap_or(ShutdownOutcome::OwnerGone);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        outcome
    }

    /// Record the whole-drain deadline BEFORE enqueuing `Shutdown`, so the owner
    /// observes the bound while still inside any in-flight command. A deadline
    /// only ever TIGHTENS: a later request (e.g. `Drop` after an abandoned
    /// `shutdown_within(50 ms)` future) never lengthens one already in force.
    fn request_shutdown(&self, grace: Duration, done: oneshot::Sender<ShutdownOutcome>) {
        let requested = Instant::now().checked_add(grace).unwrap_or_else(far_future);
        let deadline = match *self.shutdown_deadline.borrow() {
            Some(existing) => existing.min(requested),
            None => requested,
        };
        let _ = self.shutdown_deadline.send(Some(deadline));
        let _ = self.tx.send(OwnerCommand::Shutdown { done });
    }
}

impl Drop for JsEnvActor {
    /// Dropping the actor without `shutdown*` is NOT a full shutdown (nothing is
    /// joined), but it must not leave the owner thread parked forever either:
    /// record the default deadline and enqueue `Shutdown`, non-blocking. A
    /// blocking join here would deadlock a `current_thread` runtime and would
    /// duplicate lifecycle policy in a second locus.
    fn drop(&mut self) {
        if self.thread.is_some() {
            let (done, _rx) = oneshot::channel();
            self.request_shutdown(DEFAULT_SHUTDOWN_GRACE, done);
        }
    }
}

/// A deadline that never arrives (for a grace too large to add to `Instant::now()`).
fn far_future() -> Instant {
    Instant::now() + Duration::from_secs(60 * 60 * 24 * 365)
}

/// The explicit error an abandoned command's caller receives (never a silent
/// drop). The command was either in flight when the deadline passed or was
/// dequeued after it (whole-drain bound: it is then never polled at all).
fn abandonment_error(kind: &str) -> Error {
    let message = format!(
        "owner shutting down: {kind} abandoned past the shutdown deadline (bounded drain, Bead b41)"
    );
    eprintln!("js_env: {message}");
    Error::new_from_js_message("actor", "shutdown", message)
}

/// A clonable sender for non-JS threads to reach the JS owner. Holds only the
/// command channel — it can NEVER touch QuickJS directly, only ask the owner to.
#[derive(Clone)]
pub struct JsEnvSender {
    tx: tokio_mpsc::UnboundedSender<OwnerCommand>,
}

impl JsEnvSender {
    /// Enqueue a host push from a non-JS thread and BLOCK until the owner has
    /// delivered it (causal). For use on a plain OS thread (no async runtime):
    /// the Push completion is a STD channel, so this thread blocks directly on
    /// it — NO throwaway tokio runtime per push (the GTK intent hot path must
    /// not build a runtime per event).
    pub fn push_blocking(&self, payload: &str) -> std::result::Result<(), String> {
        let (done, rx) = std_mpsc::channel();
        self.tx
            .send(OwnerCommand::Push { payload: payload.to_string(), done })
            .map_err(|_| "owner thread gone".to_string())?;
        match rx.recv() {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(format!("push delivery failed: {e}")),
            Err(e) => Err(format!("owner dropped response: {e}")),
        }
    }

    /// Async variant of the actor's `eval_async`, available on the clonable
    /// sender so a non-JS-owner async task can drive JS while another thread
    /// (e.g. the GTK main thread) does other work. Same command, same causal
    /// completion.
    pub async fn eval_async(&self, source: &str) -> Result<String> {
        let (done, rx) = oneshot::channel();
        self.tx
            .send(OwnerCommand::EvalAsync { source: source.to_string(), done })
            .map_err(|_| Error::new_from_js("sender", "owner thread gone"))?;
        rx.await.map_err(|_| Error::new_from_js("sender", "owner dropped response"))?
    }

    /// Async variant of `with_context` on the clonable sender.
    pub async fn with_context<F>(&self, f: F) -> Result<()>
    where
        F: FnOnce(&rquickjs::Ctx) -> Result<()> + Send + 'static,
    {
        let (done, rx) = oneshot::channel();
        self.tx
            .send(OwnerCommand::WithContext { f: Box::new(f), done })
            .map_err(|_| Error::new_from_js("sender", "owner thread gone"))?;
        rx.await.map_err(|_| Error::new_from_js("sender", "owner dropped response"))?
    }
}

/// Evaluate a JS snippet that yields a Promise (or a plain value) and drive it
/// to completion ON the owner thread, returning the result JSON-stringified. The
/// snippet is wrapped so a module `import()` or an async IIFE both work.
async fn eval_async_on_owner(owner: &JsEnvOwner, source: &str) -> Result<String> {
    owner
        .context()
        .async_with(async |ctx| {
            // Wrap the snippet in an async arrow-body. If the source is a single
            // expression (no semicolon/newline), its value is the result. If it
            // is statements, the caller must use an explicit trailing `return`
            // OR (simpler) the shell tests use `eval_json` for statement bodies.
            // Here we always wrap as an expression-position async IIFE that
            // returns the source's value when it is an expression, else expects
            // the source to `return` explicitly.
            // Discriminate expression vs statement body. An EXPRESSION source —
            // an async IIFE `(async()=>{...})()`, an object literal `({...})`,
            // `import(...)`, `Promise.resolve(...)` — starts with `(` or is a
            // single line; its value is the result. A STATEMENT body (starts
            // with `const`/`let`/`return`/`globalThis`/etc.) is wrapped in an
            // async IIFE and must produce its value via an explicit trailing
            // `return`. Wrapping an async-IIFE EXPRESSION as a statement block
            // would call it but discard its promise (resolving to `undefined`).
            let trimmed = source.trim_start();
            let is_expression = trimmed.starts_with('(')
                || trimmed.starts_with("import(")
                || trimmed.starts_with("Promise.")
                || !trimmed.contains([';', '\n']);
            let wrapped = if is_expression {
                format!("Promise.resolve({})", source)
            } else {
                format!("(async () => {{ {} }})()", source)
            };
            let promise: rquickjs::Promise = ctx.eval(wrapped.as_str())?;
            let resolved: rquickjs::Value = promise.into_future::<rquickjs::Value>().await?;
            // A fire-and-forget eval (select/armHold/releaseGate/destroyAll/…) resolves
            // to `undefined`, which `JSON.stringify` returns as the JS `undefined`
            // (NOT the string "undefined") — inconvertible to String. Coerce to null:
            // `undefined` is not representable on a plain-data JSON return channel.
            let resolved = if resolved.is_undefined() {
                rquickjs::Value::new_null(ctx.clone())
            } else {
                resolved
            };
            // JSON.stringify the result for a plain-data return across the channel.
            let json: rquickjs::Function = ctx
                .globals()
                .get::<_, rquickjs::Object>("JSON")?
                .get("stringify")?;
            let s: String = json.call((resolved,))?;
            Ok::<_, Error>(s)
        })
        .await
}

/// Deliver a push to `globalThis.__jsenv_on_push` on the owner thread, driving
/// the handler's promise to completion on this thread.
async fn deliver_push_on_owner(owner: &JsEnvOwner, payload: String) -> Result<()> {
    owner
        .context()
        .async_with(async |ctx| {
            let handler: rquickjs::Function = ctx
                .globals()
                .get("__jsenv_on_push")
                .map_err(|_| Error::new_from_js_message("globals", "__jsenv_on_push", "no handler"))?;
            let promise: rquickjs::Promise = handler.call((payload,))?;
            promise.into_future::<()>().await?;
            Ok::<_, Error>(())
        })
        .await
}

/// Await one already-constructed asynchronous owner command while continuing to
/// service the guest timer registry on the same owner thread.
///
/// `EvalAsync` and `Push` both await an `AsyncContext::async_with` future. That
/// future releases the rquickjs runtime lock whenever it returns `Pending`, so
/// this OUTER driver may safely reacquire the owner context between polls to
/// inspect/fire timers. Putting the pump inside `async_with` would instead try
/// to acquire the lock while the same future holds it and self-deadlock.
///
/// The command future is pinned ONCE: recreating it after a timer wake would
/// re-evaluate the source or re-deliver the push. We deliberately do not poll
/// `OwnerCommand::recv` here, so later commands remain serialized behind the
/// in-flight command. Globally due guest timers may run while it is suspended,
/// which is the event-loop re-entry required for an awaited `setTimeout`.
async fn await_command_with_timer_pump<F>(
    owner: &JsEnvOwner,
    command: F,
    shutdown_deadline: &mut watch::Receiver<Option<Instant>>,
) -> CommandOutcome<F::Output>
where
    F: Future,
{
    tokio::pin!(command);
    let timer_notify = owner.timer_notify();
    // Once the actor handle (the watch sender) is gone the deadline is final;
    // stop polling `changed()` (it would resolve Err immediately, every poll).
    let mut deadline_closed = false;

    loop {
        // SHUTDOWN BOUND (Bead b41): checked FIRST, every iteration, never as a
        // trailing select branch (a continuously-ready timer branch would starve
        // it). Returning here drops `command`: that IS the abandonment; see the
        // module doc for why the off-lock drop is sound.
        let deadline = *shutdown_deadline.borrow_and_update();
        if let Some(deadline) = deadline {
            if Instant::now() >= deadline {
                return CommandOutcome::Abandoned { ready_jobs: false };
            }
        }

        // The registry is authoritative. Notify intentionally coalesces changes;
        // after every wake we re-read the earliest deadline rather than trying to
        // associate a notification with one particular timer. The sleep is
        // clamped to the shutdown deadline when one is recorded.
        let next_due_ms = next_timer_due_ms(owner).await;
        let timer_wait = next_due_ms.map(|due_ms| Duration::from_millis(due_ms.saturating_sub(epoch_ms())));
        let deadline_wait = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        let wait = match (timer_wait, deadline_wait) {
            (Some(t), Some(d)) => Some(t.min(d)),
            (Some(t), None) => Some(t),
            (None, Some(d)) => Some(d),
            (None, None) => None,
        };
        let sleep = async {
            match wait {
                Some(d) => tokio::time::sleep(d).await,
                None => std::future::pending::<()>().await,
            }
        };
        let deadline_changed = async {
            if deadline_closed {
                std::future::pending::<()>().await
            } else if shutdown_deadline.changed().await.is_err() {
                deadline_closed = true;
            }
        };
        tokio::select! {
            // Prefer a command that completed at the same instant as a timer;
            // its normal post-command drain below remains responsible for any
            // already-ready jobs.
            biased;
            output = &mut command => return CommandOutcome::Completed(output),
            _ = sleep => {}
            _ = timer_notify.notified() => {}
            // A (re)recorded shutdown deadline changes nothing in the guest: go
            // straight back to the top-of-loop check and re-clamp the sleep —
            // no timer fire, no drain (a deadline is not a tick).
            _ = deadline_changed => continue,
        }

        // A deadline or registry change woke us. Fire what is now due, flush the
        // bare promise jobs synchronously queued by those callbacks, and retain
        // drain_jobs' no-op-spawn kick so the long-lived DriveFuture reclaims the
        // pinned scheduler waker before the command is polled again.
        fire_due_timers(owner).await;
        if drain_jobs(owner, shutdown_deadline).await
            == DrainJobsOutcome::AbandonedReadyJobs
        {
            return CommandOutcome::Abandoned { ready_jobs: true };
        }
    }
}

/// The current time in epoch-ms (the SAME clock domain as the guest's
/// `Date.now()`, which the timer registry uses for `due`).
fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Drain READY QuickJS jobs on the owner thread until quiescence or shutdown.
///
/// A guest promise resolved by a SYNC host callback (`fire_due_timers`, a
/// fire-and-forget push handler's synchronous routing) enqueues a bare QuickJS
/// job WITHOUT waking the parked `DriveFuture` (only `spawner.push` wakes it).
/// Left undrained, those continuations stall in any command-quiet embedding
/// (production, not a poll-happy test harness) — the environment stops reacting.
///
/// There is deliberately no fixed TOTAL job limit. Each runtime-lock acquisition
/// executes at most `READY_JOB_BATCH_SIZE` jobs; finite chains continue across as
/// many batches as they need. Between batches the lock is released and the
/// existing whole-drain shutdown deadline is re-observed synchronously.
///
/// While raw jobs remain this function MUST NOT wake or yield to rquickjs's
/// `DriveFuture`: its poll implementation drains the raw job queue without a
/// bound before it polls spawned futures, recreating c4g outside this deadline
/// loop. The no-op spawn kick is therefore performed only at raw-job quiescence.
async fn drain_jobs(
    owner: &JsEnvOwner,
    shutdown_deadline: &watch::Receiver<Option<Instant>>,
) -> DrainJobsOutcome {
    loop {
        let deadline_reached = shutdown_deadline
            .borrow()
            .is_some_and(|deadline| Instant::now() >= deadline);

        let outcome = owner
            .with(|ctx| {
                // `Ctx::execute_pending_job` calls `JS_ExecutePendingJob` directly:
                // it drains ONE raw QuickJS job and never polls the spawned-task
                // scheduler. `JS_IsJobPending` likewise inspects only QuickJS's raw
                // job list; `AsyncRuntime::is_job_pending` is intentionally unusable
                // here because it also counts spawned futures.
                let raw_jobs_pending = || {
                    // SAFETY: `owner.with` holds the rquickjs runtime lock, `ctx` is
                    // live for this closure, and JS_GetRuntime returns its owning
                    // runtime. JS_IsJobPending is a read-only query on that runtime.
                    unsafe {
                        let runtime = rquickjs::qjs::JS_GetRuntime(ctx.as_raw().as_ptr());
                        rquickjs::qjs::JS_IsJobPending(runtime)
                    }
                };

                if deadline_reached {
                    if raw_jobs_pending() {
                        return DrainJobsOutcome::AbandonedReadyJobs;
                    }
                    // Raw jobs are quiescent, so it is now safe to wake DriveFuture.
                    ctx.spawn(async {});
                    return DrainJobsOutcome::Quiescent;
                }

                for _ in 0..READY_JOB_BATCH_SIZE {
                    if !ctx.execute_pending_job() {
                        // A command's `WithFuture` may have stolen the scheduler's
                        // single waker slot. At raw-job quiescence, a no-op spawn safely
                        // wakes DriveFuture so it reclaims that slot.
                        ctx.spawn(async {});
                        return DrainJobsOutcome::Quiescent;
                    }
                }

                if raw_jobs_pending() {
                    // Do NOT spawn/yield here. Return from owner.with to release the
                    // lock, then let this same task synchronously re-check the deadline.
                    DrainJobsOutcome::MoreReadyJobs
                } else {
                    ctx.spawn(async {});
                    DrainJobsOutcome::Quiescent
                }
            })
            .await;

        match outcome {
            DrainJobsOutcome::Quiescent => return DrainJobsOutcome::Quiescent,
            DrainJobsOutcome::MoreReadyJobs => {
                let deadline_reached = shutdown_deadline
                    .borrow()
                    .is_some_and(|deadline| Instant::now() >= deadline);
                if deadline_reached {
                    return DrainJobsOutcome::AbandonedReadyJobs;
                }
                // More raw jobs remain, but no deadline has passed. Continue in this
                // task immediately: even yield_now would let DriveFuture enter its own
                // unbounded raw-job drain before scheduler work.
            }
            DrainJobsOutcome::AbandonedReadyJobs => {
                return DrainJobsOutcome::AbandonedReadyJobs;
            }
        }
    }
}

/// Fire every guest timer whose `due <= now` on the owner thread. Called by the
/// command loop before waiting, so timers registered by prior commands fire even
/// with no new command arriving.
async fn fire_due_timers(owner: &JsEnvOwner) {
    let now = epoch_ms();
    owner
        .with(move |ctx| {
            let fire: rquickjs::Function = ctx
                .globals()
                .get("__jsenv_fire_due")
                .unwrap_or_else(|_| ctx.eval("() => 0").unwrap());
            let _: i64 = fire.call((now as f64,)).unwrap_or(0);
            // Surface any guest timer callback that threw (recorded guest-side by
            // __jsenv_fire_due so it is neither swallowed nor batch-aborting). Drain
            // and log host-side; the owner stays alive and later timers still fire.
            if let Ok(errors) = ctx.globals().get::<_, rquickjs::Array>("__jsenv_timer_errors") {
                for i in 0..errors.len() {
                    if let Ok(e) = errors.get::<String>(i) {
                        eprintln!("js_env: guest timer callback threw: {e}");
                    }
                }
                let _ = ctx.globals().set("__jsenv_timer_errors", rquickjs::Array::new(ctx.clone()));
            }
        })
        .await;
}

/// The earliest pending timer's `due` (epoch-ms), or None if no timers pending.
/// The command loop uses this to wake in time to fire the next timer.
async fn next_timer_due_ms(owner: &JsEnvOwner) -> Option<u64> {
    owner
        .with(|ctx| {
            let next: rquickjs::Function = ctx
                .globals()
                .get("__jsenv_next_due")
                .unwrap_or_else(|_| ctx.eval("() => null").unwrap());
            let v: rquickjs::Value = next.call(()).unwrap_or(rquickjs::Value::new_null(ctx.clone()));
            if v.is_null() || v.is_undefined() {
                None
            } else {
                v.as_float().map(|f| f as u64)
            }
        })
        .await
}
