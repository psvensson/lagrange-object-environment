//! 3zb-A slice-3B acceptance: the TEST Images capability at the Env<->Images port.
//!
//! Proves the scripted outcomes cross the JS<->host port with NAME- and
//! CODE-faithful error reconstruction, and that the mutation->observation
//! ordering guarantee holds (the host commits before completing, so a poll
//! issued after the mutation sees the event). This capability is the permanent
//! boundary/conformance proof for the port; it has scripted outcomes over OPAQUE
//! tokens, NOT substrate semantics. The real image-client-adapter + substrate
//! codec are 3zb-B (via the B0 probe), not exercised here.
//!
//! All JS contact routes through the dedicated-owner-thread actor. The images
//! capability host is serviced by its OWN dedicated thread (never blocks on JS),
//! so these tests need NO GTK and NO pump loop — unlike the renderer port.

use lagrange_host_linux::js_env::actor::JsEnvActor;
use lagrange_host_linux::js_env::images_capability::{install_images_capability, ImagesCapabilityHost};
use lagrange_host_linux::js_env::EmbeddedLoader;

/// Spawn the actor and a scripted images capability, install the guest port, and
/// return the actor. Canned objects: `obj-1` (title/count), `obj-denied-read`
/// (read denied), `obj-denied-mutate` (mutation denied).
async fn spawn_with_capability() -> JsEnvActor {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let (host, tx, script) = ImagesCapabilityHost::new();
    script.add_object("obj-1", serde_json::json!({"title": "original", "count": 0}));
    script.add_object("obj-denied-read", serde_json::json!({"title": "secret"}));
    script.deny_read("obj-denied-read");
    script.add_object("obj-denied-mutate", serde_json::json!({"title": "frozen"}));
    script.deny_mutate("obj-denied-mutate");
    // An object carrying indexed rows (the lane's third return field).
    script.add_object_full(
        "obj-indexed",
        serde_json::json!({"title": "indexed-obj"}),
        vec![serde_json::json!({"index": "by-title", "key": "indexed-obj"})],
    );
    host.start();

    actor
        .with_context(move |ctx| install_images_capability(&ctx, tx, "imagesCapability"))
        .await
        .expect("install images capability");
    actor
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_success_returns_canned_slots_and_opaque_token() {
    let actor = spawn_with_capability().await;
    let json = actor
        .eval_async(
            r#"(async () => {
  const rec = await imagesCapability.readObject('obj-1');
  return { title: rec.slots.title, count: rec.slots.count, token: rec.versionToken };
})()"#,
        )
        .await
        .expect("read obj-1");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["title"], "original");
    assert_eq!(v["count"], 0);
    assert_eq!(v["token"], "v1", "the opaque version token is host-minted");

    // The lane's third return field: indexed rows cross too (review Finding 6).
    let json = actor
        .eval_async(
            r#"(async () => {
  const rec = await imagesCapability.readObject('obj-indexed');
  return { indexed: rec.indexed };
})()"#,
        )
        .await
        .expect("read obj-indexed");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    let indexed = v["indexed"].as_array().expect("indexed array");
    assert_eq!(indexed.len(), 1);
    assert_eq!(indexed[0]["index"], "by-title");
    actor.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_deny_and_not_found_cross_with_name_and_code() {
    let actor = spawn_with_capability().await;
    // read-deny -> AuthorityError (name preserved); read-not-found -> code
    // OBJECT_NOT_FOUND (the navigator's unavailable-vs-unauthorized discriminator).
    let json = actor
        .eval_async(
            r#"(async () => {
  const out = {};
  try { await imagesCapability.readObject('obj-denied-read'); out.deny = 'NO-THROW'; }
  catch (e) { out.deny = { name: e.name, code: e.code ?? null }; }
  try { await imagesCapability.readObject('obj-missing'); out.missing = 'NO-THROW'; }
  catch (e) { out.missing = { name: e.name, code: e.code ?? null }; }
  return out;
})()"#,
        )
        .await
        .expect("read error lanes");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["deny"]["name"], "AuthorityError", "denied read keeps its name");
    assert_eq!(v["missing"]["code"], "OBJECT_NOT_FOUND", "missing read keeps its stable code");
    assert_ne!(v["missing"]["name"], "AuthorityError", "not-found is NOT an authority error");
    actor.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mutation_success_changes_token_then_stale_token_conflicts() {
    let actor = spawn_with_capability().await;
    let json = actor
        .eval_async(
            r#"(async () => {
  const before = await imagesCapability.readObject('obj-1');
  const t0 = before.versionToken;
  // Mutation SUCCESS with the current token: the token MUST change.
  const ok = await imagesCapability.mutateObject('obj-1', { title: 'edited' }, t0);
  const after = await imagesCapability.readObject('obj-1');
  // STALE conflict: re-present the now-stale t0 on the SAME object that just
  // mutated (proven-stale, not a guessed token).
  let conflict = null;
  try { await imagesCapability.mutateObject('obj-1', { title: 'stale-write' }, t0); conflict = 'NO-THROW'; }
  catch (e) { conflict = { name: e.name }; }
  // NON-APPLICATION (review Finding 3): the rejected stale write must have had NO
  // effect — value unchanged, token unchanged, and no new observation event.
  const finalRec = await imagesCapability.readObject('obj-1');
  const pull = await imagesCapability.observePull('0');
  return { t0, t1: ok.versionToken, readBack: after.slots.title, readToken: after.versionToken,
           conflict, finalTitle: finalRec.slots.title, finalToken: finalRec.versionToken, eventCount: pull.events.length };
})()"#,
        )
        .await
        .expect("mutation + conflict");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["t0"], "v1");
    assert_eq!(v["t1"], "v2", "success bumps the token (CHANGED, not reused)");
    assert_eq!(v["readBack"], "edited", "the mutation is applied");
    assert_eq!(v["readToken"], "v2", "the read reflects the bumped version");
    assert_eq!(
        v["conflict"]["name"], "ObjectMutationConflictError",
        "a proven-stale token on the just-mutated object conflicts with the conflict name"
    );
    assert_eq!(v["finalTitle"], "edited", "the stale write did NOT apply (value unchanged)");
    assert_eq!(v["finalToken"], "v2", "the stale write did NOT bump the token");
    assert_eq!(v["eventCount"], 1, "the stale write recorded NO observation event");
    actor.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn denied_mutation_crosses_as_authority_error() {
    let actor = spawn_with_capability().await;
    let json = actor
        .eval_async(
            r#"(async () => {
  let err = null;
  try { await imagesCapability.mutateObject('obj-denied-mutate', { title: 'x' }, 'v1'); err = 'NO-THROW'; }
  catch (e) { err = { name: e.name }; }
  // NON-APPLICATION (review Finding 3): the denied mutation must have had NO
  // effect — value and token unchanged, no observation event.
  const rec = await imagesCapability.readObject('obj-denied-mutate');
  const pull = await imagesCapability.observePull('0');
  return { err, title: rec.slots.title, token: rec.versionToken, eventCount: pull.events.length };
})()"#,
        )
        .await
        .expect("denied mutation");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["err"]["name"], "AuthorityError", "denied mutation keeps its authority name");
    assert_eq!(v["title"], "frozen", "the denied mutation did NOT apply");
    assert_eq!(v["token"], "v1", "the denied mutation did NOT bump the token");
    assert_eq!(v["eventCount"], 0, "the denied mutation recorded NO observation event");
    actor.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mutation_commit_is_visible_to_a_later_observe_pull() {
    let actor = spawn_with_capability().await;
    // The olm ordering guarantee (review Finding 7): the host commits the
    // mutation (and records the observation event) BEFORE completing the mutation
    // oneshot, so an observePull issued AFTER the mutation resolves MUST see it.
    let json = actor
        .eval_async(
            r#"(async () => {
  const before = await imagesCapability.readObject('obj-1');
  await imagesCapability.mutateObject('obj-1', { title: 'observed-edit' }, before.versionToken);
  // Pull from the beginning ('0') to observe the backlog event deterministically.
  const pull = await imagesCapability.observePull('0');
  return { events: pull.events, cursor: pull.cursor };
})()"#,
        )
        .await
        .expect("observe after mutation");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    let events = v["events"].as_array().expect("events array");
    assert_eq!(events.len(), 1, "exactly one observation event after one mutation");
    assert_eq!(events[0]["objectId"], "obj-1");
    assert_eq!(events[0]["kind"], "object.put", "the lane's RAW kind (image-observation normalizes it Env-side)");
    assert!(events[0]["cursor"].is_string(), "an opaque cursor rides the event");
    actor.shutdown().await;
}

/// The observation lane's cursor semantics (review Finding 2): the real
/// observeChanges lane's DEFAULT (no afterCursor / '') means "live-follow from
/// the current high-water, NO backlog replay"; an explicit cursor means
/// incremental (events with cursor > after). This pins the differentiation a
/// naive fake (always full backlog, or ignores the cursor) would get wrong.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observe_pull_cursor_semantics_live_follow_vs_incremental() {
    let actor = spawn_with_capability().await;
    let json = actor
        .eval_async(
            r#"(async () => {
  const t0 = (await imagesCapability.readObject('obj-1')).versionToken;
  // One mutation BEFORE the follow starts.
  await imagesCapability.mutateObject('obj-1', { count: 1 }, t0);
  // DEFAULT pull (no afterCursor): live-follow from current end -> NO backlog.
  const def = await imagesCapability.observePull(null);
  // '' behaves identically (the observeChanges lane's initial cursor).
  const empty = await imagesCapability.observePull('');
  // Resume from the high-water: still nothing new.
  const resumed = await imagesCapability.observePull(def.cursor);
  // A SECOND mutation after the high-water: the incremental pull sees ONLY it.
  const t1 = (await imagesCapability.readObject('obj-1')).versionToken;
  await imagesCapability.mutateObject('obj-1', { count: 2 }, t1);
  const incr = await imagesCapability.observePull(def.cursor);
  // Idempotent resume from the new high-water: nothing.
  const incrAgain = await imagesCapability.observePull(incr.cursor);
  return {
    defCount: def.events.length, defCursor: def.cursor,
    emptyCount: empty.events.length,
    resumedCount: resumed.events.length,
    incrEvents: incr.events, incrAgainCount: incrAgain.events.length,
  };
})()"#,
        )
        .await
        .expect("cursor semantics");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["defCount"], 0, "default pull replays NO backlog (live-follow from high-water)");
    assert_eq!(v["emptyCount"], 0, "'' is the same live-follow default");
    assert_eq!(v["resumedCount"], 0, "resume from high-water sees nothing new");
    let incr = v["incrEvents"].as_array().unwrap();
    assert_eq!(incr.len(), 1, "incremental pull sees ONLY the post-high-water mutation");
    assert_eq!(incr[0]["objectId"], "obj-1");
    assert_eq!(v["incrAgainCount"], 0, "idempotent resume from the new high-water");
    actor.shutdown().await;
}
