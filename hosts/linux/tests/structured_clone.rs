//! Bead 3zb slice B1c: `structuredClone` as a PRODUCTION host global.
//!
//! WHY THIS SLICE EXISTS. The pinned QuickJS-NG has no `structuredClone`, and
//! the real `lagrange-images` portable closure cannot compose without one:
//! `LanguagePlatform.register` clones every language descriptor (the first
//! failure when composing a runtime), `mock-backend` clones EVERY value entering
//! and leaving storage, and `graph-image-service` clones every durable put
//! record. 3zb-A correctly excluded it — no Environment module uses it, and the
//! census's hits were all below the capability port — but B1b is the first slice
//! to run the real Images closure IN-PROCESS, which makes it a host obligation.
//!
//! SCOPE RULE: this is the STANDARD global, not an Images-specific deep clone.
//! It supports the value space Lagrange can realistically put through it plus
//! the obvious standard structures, and refuses everything else LOUDLY.
//!
//! THE LOAD-BEARING PROPERTY IS ALIASING, NOT DEEP EQUALITY. A structural
//! comparison would pass for a clone that duplicated shared references and
//! turned one object into two — which would silently change the shape of a
//! durable record written through `graph-image-service`. Every identity case
//! below therefore asserts reference identity, not value equality.

use lagrange_host_linux::js_env::actor::JsEnvActor;
use lagrange_host_linux::js_env::EmbeddedLoader;

async fn eval(actor: &JsEnvActor, expr: &str) -> String {
    actor.eval_async(expr).await.expect("eval failed")
}

/// Evaluate an expression expected to throw; return "name: message".
/// `eval_async` JSON-encodes its result, so the returned JS string arrives
/// quoted -- decode it so callers compare against plain text.
async fn thrown(actor: &JsEnvActor, expr: &str) -> String {
    let json = eval(
        actor,
        &format!(
            "(() => {{ try {{ {expr}; return 'NO-THROW'; }} \
               catch (e) {{ return (e && e.name) + ': ' + (e && e.message); }} }})()"
        ),
    )
    .await;
    serde_json::from_str::<String>(&json).unwrap_or(json)
}

fn actor() -> JsEnvActor {
    JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preserves_shared_references_and_cycles() {
    let a = actor();
    // The canonical aliasing case: two properties referencing ONE child, plus a
    // self-cycle. A clone that deep-copied naively would produce two children
    // and either infinite-loop or break the cycle.
    let json = eval(
        &a,
        r#"(() => {
  const child = {x: 1};
  const src = {a: child, b: child};
  src.self = src;
  const clone = structuredClone(src);
  return {
    notSameRoot:   clone !== src,
    childCopied:   clone.a !== child,
    aliasPreserved: clone.a === clone.b,
    cyclePreserved: clone.self === clone,
    valueCarried:  clone.a.x,
    srcUnchanged:  src.a === child && src.self === src,
  };
})()"#,
    )
    .await;
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["notSameRoot"], true, "clone must not be the source");
    assert_eq!(v["childCopied"], true, "nested object must be copied, not shared with the source");
    assert_eq!(v["aliasPreserved"], true, "ONE shared child must remain ONE object after cloning");
    assert_eq!(v["cyclePreserved"], true, "a self-cycle must remain a self-cycle");
    assert_eq!(v["valueCarried"], 1);
    assert_eq!(v["srcUnchanged"], true, "cloning must not mutate the source");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mutual_cycles_and_repeated_arrays() {
    let a = actor();
    let json = eval(
        &a,
        r#"(() => {
  const x = {name: 'x'}, y = {name: 'y'};
  x.peer = y; y.peer = x;                 // mutual cycle
  const shared = [1, 2];
  const src = {x, y, l1: shared, l2: shared};
  const c = structuredClone(src);
  return {
    mutualX: c.x.peer === c.y,
    mutualY: c.y.peer === c.x,
    notSourceX: c.x !== x,
    arrayAlias: c.l1 === c.l2,
    arrayCopied: c.l1 !== shared,
    arrayValue: c.l1[1],
  };
})()"#,
    )
    .await;
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["mutualX"], true, "mutual cycle must survive");
    assert_eq!(v["mutualY"], true, "mutual cycle must survive in both directions");
    assert_eq!(v["notSourceX"], true);
    assert_eq!(v["arrayAlias"], true, "a repeated array reference must stay ONE array");
    assert_eq!(v["arrayCopied"], true);
    assert_eq!(v["arrayValue"], 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn primitives_and_edge_numbers() {
    let a = actor();
    let json = eval(
        &a,
        r#"(() => {
  const src = {
    u: undefined, n: null, t: true, s: 'text', big: 10n ** 20n,
    nan: NaN, pinf: Infinity, ninf: -Infinity, negZero: -0, zero: 0,
  };
  const c = structuredClone(src);
  return {
    hasU: 'u' in c, uIsUndefined: c.u === undefined,
    n: c.n === null, t: c.t, s: c.s,
    bigOk: typeof c.big === 'bigint' && c.big === 10n ** 20n,
    nanOk: Number.isNaN(c.nan),
    pinf: c.pinf === Infinity, ninf: c.ninf === -Infinity,
    // -0 must survive as -0: Object.is distinguishes it from 0, === does not.
    negZeroOk: Object.is(c.negZero, -0),
    zeroOk: Object.is(c.zero, 0),
    bigIntDirect: structuredClone(7n) === 7n,
    undefinedDirect: structuredClone(undefined) === undefined,
  };
})()"#,
    )
    .await;
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    for key in [
        "hasU", "uIsUndefined", "n", "t", "bigOk", "nanOk", "pinf", "ninf", "negZeroOk", "zeroOk",
        "bigIntDirect", "undefinedDirect",
    ] {
        assert_eq!(v[key], true, "{key} must round-trip exactly");
    }
    assert_eq!(v["s"], "text");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn buffers_are_copied_not_aliased_and_keep_view_geometry() {
    let a = actor();
    let json = eval(
        &a,
        r#"(() => {
  const buf = new ArrayBuffer(8);
  const full = new Uint8Array(buf);
  full.set([1,2,3,4,5,6,7,8]);
  const view = new Uint8Array(buf, 2, 3);      // byteOffset 2, length 3
  const dv = new DataView(buf, 4, 4);
  const src = {buf, full, view, dv};
  const c = structuredClone(src);

  // Mutating the SOURCE must not be visible in the clone: the bytes are copied.
  full[0] = 99;

  return {
    bufCopied:   c.buf !== buf,
    viewCopied:  c.view !== view,
    bytesCopied: c.full[0] === 1,                       // still 1, not 99
    sourceMutated: full[0] === 99,
    // Two views over ONE buffer must still share ONE cloned buffer.
    sharedBuffer: c.full.buffer === c.view.buffer && c.view.buffer === c.dv.buffer,
    clonedBufferIsTheClonedOne: c.full.buffer === c.buf,
    // Geometry preserved, not flattened by a slice().
    viewOffset: c.view.byteOffset, viewLength: c.view.length,
    viewBytes: [...c.view].join(','),
    dvOffset: c.dv.byteOffset, dvLength: c.dv.byteLength,
    isU8: c.view instanceof Uint8Array,
    isDV: c.dv instanceof DataView,
  };
})()"#,
    )
    .await;
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["bufCopied"], true);
    assert_eq!(v["viewCopied"], true);
    assert_eq!(v["bytesCopied"], true, "backing bytes must be COPIED, not aliased to the source");
    assert_eq!(v["sourceMutated"], true, "the source really was mutated (test is not vacuous)");
    assert_eq!(v["sharedBuffer"], true, "views over one buffer must share ONE cloned buffer");
    assert_eq!(v["clonedBufferIsTheClonedOne"], true);
    assert_eq!(v["viewOffset"], 2, "byteOffset must be preserved, not flattened");
    assert_eq!(v["viewLength"], 3);
    assert_eq!(v["viewBytes"], "3,4,5");
    assert_eq!(v["dvOffset"], 4);
    assert_eq!(v["dvLength"], 4);
    assert_eq!(v["isU8"], true);
    assert_eq!(v["isDV"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn typed_array_flavours_date_regexp_map_set() {
    let a = actor();
    let json = eval(
        &a,
        r#"(() => {
  const d = new Date(1730000000000);
  const re = /ab+c/gi;
  const key = {k: 1};
  const m = new Map([['s', 1], [key, {deep: true}]]);
  const st = new Set([1, 'two', key]);
  const i32 = new Int32Array([-1, 0, 7]);
  const f64 = new Float64Array([0.5, -0]);
  const bi = new BigInt64Array([-9007199254740993n]);
  const c = structuredClone({d, re, m, st, i32, f64, bi});
  return {
    dateOk: c.d instanceof Date && c.d.getTime() === 1730000000000 && c.d !== d,
    reOk: c.re instanceof RegExp && c.re.source === 'ab+c' && c.re.flags === re.flags && c.re !== re,
    mapOk: c.m instanceof Map && c.m.size === 2 && c.m.get('s') === 1 && c.m !== m,
    mapKeyCloned: [...c.m.keys()].some(k => typeof k === 'object' && k !== key && k.k === 1),
    // The SAME object used as a Map key and a Set member must stay ONE object.
    keyAliasKept: [...c.m.keys()].filter(k => typeof k === 'object')[0] === [...c.st].filter(x => typeof x === 'object')[0],
    setOk: c.st instanceof Set && c.st.size === 3 && c.st.has(1) && c.st.has('two'),
    i32Ok: c.i32 instanceof Int32Array && [...c.i32].join(',') === '-1,0,7',
    f64Ok: c.f64 instanceof Float64Array && c.f64[0] === 0.5 && Object.is(c.f64[1], -0),
    biOk: c.bi instanceof BigInt64Array && c.bi[0] === -9007199254740993n,
  };
})()"#,
    )
    .await;
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    for key in [
        "dateOk", "reOk", "mapOk", "mapKeyCloned", "keyAliasKept", "setOk", "i32Ok", "f64Ok", "biOk",
    ] {
        assert_eq!(v[key], true, "{key}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn arrays_preserve_holes_and_extra_keys() {
    let a = actor();
    let json = eval(
        &a,
        r#"(() => {
  const sparse = [1, , 3];              // index 1 is a HOLE, not undefined
  sparse.tag = 'meta';
  const c = structuredClone(sparse);
  const nested = structuredClone({o: Object.create(null)});
  return {
    len: c.length,
    holeKept: !(1 in c),
    v0: c[0], v2: c[2],
    extraKey: c.tag,
    nullProtoOk: typeof nested.o === 'object' && nested.o !== null,
    emptyOk: structuredClone([]).length === 0,
  };
})()"#,
    )
    .await;
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["len"], 3);
    assert_eq!(v["holeKept"], true, "a sparse array must not densify into undefineds");
    assert_eq!(v["v0"], 1);
    assert_eq!(v["v2"], 3);
    assert_eq!(v["extraKey"], "meta", "own enumerable non-index keys travel with the array");
    assert_eq!(v["nullProtoOk"], true, "null-prototype objects are plain and cloneable");
    assert_eq!(v["emptyOk"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsupported_inputs_reject_loudly_as_dataclone_errors() {
    let a = actor();

    for (expr, what) in [
        ("structuredClone(() => 1)", "a bare function"),
        ("structuredClone({fn(){}})", "a function reachable through a property"),
        ("structuredClone(Symbol('s'))", "a symbol"),
        ("structuredClone({s: Symbol('s')})", "a symbol reachable through a property"),
        ("structuredClone(new (class Foo { constructor(){ this.a = 1; } })())", "a class instance"),
        ("structuredClone(new Error('x'))", "an Error"),
        ("structuredClone(Promise.resolve(1))", "a Promise"),
        ("structuredClone(new WeakMap())", "a WeakMap"),
    ] {
        let got = thrown(&a, expr).await;
        assert!(
            got.starts_with("DataCloneError:"),
            "{what} must be refused with a DataCloneError-shaped exception, got: {got}"
        );
    }

    // Transfer lists are unsupported and must be LOUD. Silently ignoring them is
    // the worst outcome: the caller would believe buffers were detached and
    // moved when they had merely been copied.
    let got = thrown(&a, "structuredClone({b: new ArrayBuffer(4)}, {transfer: []})").await;
    assert!(
        got.starts_with("DataCloneError:") && got.contains("transfer"),
        "a transfer list must be refused loudly, got: {got}"
    );
    let got = thrown(
        &a,
        "(() => { const b = new ArrayBuffer(4); return structuredClone({b}, {transfer: [b]}); })()",
    )
    .await;
    assert!(got.starts_with("DataCloneError:"), "a non-empty transfer list must be refused, got: {got}");

    // A benign options object is fine.
    assert_eq!(thrown(&a, "structuredClone({a: 1}, {})").await, "NO-THROW");
    assert_eq!(thrown(&a, "structuredClone({a: 1}, undefined)").await, "NO-THROW");
    assert_eq!(thrown(&a, "structuredClone({a: 1}, null)").await, "NO-THROW");
}

/// The FALSIFIER. A naive deep clone — the tempting wrong implementation —
/// passes structural equality but breaks identity and refuses nothing. Asserting
/// that it FAILS the same corpus is what proves the suite above is testing
/// identity rather than shape.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn naive_deep_clone_is_red_where_production_is_green() {
    let a = actor();
    // Install the tempting wrong implementation over the production one.
    eval(
        &a,
        r#"globalThis.structuredClone = function naive(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(naive);
  const o = {};
  for (const k of Object.keys(v)) o[k] = naive(v[k]);
  return o;
}; 1"#,
    )
    .await;

    // 1. Aliasing is LOST: one shared child becomes two objects.
    let json = eval(
        &a,
        r#"(() => {
  const child = {x: 1};
  const src = {a: child, b: child};
  const c = structuredClone(src);
  return {alias: c.a === c.b};
})()"#,
    )
    .await;
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(
        v["alias"], false,
        "the naive clone was expected to LOSE aliasing (this is the property B1c adds)"
    );

    // 2. A cycle blows the stack instead of being preserved.
    let got = thrown(&a, "(() => { const s = {}; s.self = s; return structuredClone(s); })()").await;
    assert_ne!(got, "NO-THROW", "the naive clone was expected to fail on a cycle, got: {got}");

    // 3. Unsupported values are silently accepted instead of refused.
    let got = thrown(&a, "structuredClone(() => 1)").await;
    assert_eq!(got, "NO-THROW", "the naive clone was expected to silently accept a function");

    // 4. Typed arrays are silently mangled into plain objects.
    let json = eval(
        &a,
        "(() => { const c = structuredClone({v: new Uint8Array([1,2,3])}); \
          return {isU8: c.v instanceof Uint8Array}; })()",
    )
    .await;
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["isU8"], false, "the naive clone was expected to mangle a typed array");
}
