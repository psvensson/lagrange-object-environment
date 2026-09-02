//! Bead 3zb slice B1a: the web-standard UTF-8 coders installed as PRODUCTION
//! host globals by `js_env::install_host_globals`.
//!
//! WHY THIS SUITE EXISTS. The real `lagrange-images` portable closure needs
//! `TextEncoder`/`TextDecoder`, and the minimal shim that was adequate for the
//! 0fg probe is NOT adequate in production. Two concrete holes it would leave:
//!
//!   1. SURROGATE SMUGGLING. `smalltalk-primitives-bytes.js`'s `decodeUtf8Strict`
//!      is the closure's ONLY UTF-8 validity check and it validates by ROUND
//!      TRIP: `bytesEqual(utf8Encode(utf8DecodeLossy(bytes)), bytes)`. A decoder
//!      that maps `ED A0 80` (the UTF-8 encoding of U+D800) back to a lone
//!      surrogate makes that round trip SUCCEED, so malformed bytes validate and
//!      mint an Images `Text` holding a lone surrogate.
//!   2. DIVERGENT DURABLE IDENTITY. `utf8Encode` feeds `sha256` and
//!      `base64urlEncode` on the type-fingerprint/version-token/derivation-cache
//!      paths, and `composite-codec` encodes string values with no
//!      well-formedness guard. An encoder emitting WTF-8 `ED A0 80` instead of
//!      `EF BF BD` yields a DIFFERENT digest and version token than the Node
//!      reference for the same logical value.
//!
//! HERMETIC ON PURPOSE. Every expectation below is a hardcoded constant. The
//! `linux-host` CI job installs Rust/GTK/Mesa and has NO `setup-node` step, so
//! shelling out to `node` would make the suite depend on whatever the runner
//! image happens to ship. Node WAS used once, off-line, as a cross-check oracle
//! while deriving these constants (recorded in the Bead); the spec is the real
//! oracle and these constants encode it.
//!
//! THE FALSIFIER is `shim_is_red_where_production_is_green`: it runs the OLD
//! minimal shim against the four cases that actually discriminate and asserts it
//! behaves DIFFERENTLY. Without it, a green suite would not distinguish a
//! spec-faithful implementation from the tempting minimal one — most malformed
//! inputs are rejected by the shim too, but for the wrong reason (its mojibake
//! happens not to round-trip).

use lagrange_host_linux::js_env::actor::JsEnvActor;
use lagrange_host_linux::js_env::EmbeddedLoader;

/// Evaluate `expr` in a runtime with the production host globals installed and
/// return its JSON-encoded value. `eval_async` already JSON-encodes its result,
/// so the expression is evaluated as-is (wrapping it in `JSON.stringify` here
/// would double-encode).
async fn eval_json(actor: &JsEnvActor, expr: &str) -> String {
    actor.eval_async(expr).await.expect("eval failed")
}

/// `[...new TextEncoder().encode(s)]` as a JSON array string.
async fn encode(actor: &JsEnvActor, js_string_literal: &str) -> String {
    eval_json(actor, &format!("[...new TextEncoder().encode({js_string_literal})]")).await
}

/// Code points of decoding `bytes` losslessly-lossy, as a JSON array of hex
/// strings — code points rather than the string itself so a lone surrogate in
/// the OUTPUT is visible rather than mangled by the JSON channel.
async fn decode_code_points(actor: &JsEnvActor, bytes: &[u8]) -> String {
    let literal = format!(
        "new Uint8Array([{}])",
        bytes.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(",")
    );
    eval_json(
        actor,
        &format!("[...new TextDecoder().decode({literal})].map(c => c.codePointAt(0).toString(16))"),
    )
    .await
}

/// Replicates `smalltalk-primitives-bytes.js`'s `decodeUtf8Strict` round-trip
/// check: decode lossily, re-encode, compare to the original bytes. `true` means
/// Images would ACCEPT these bytes as valid UTF-8.
async fn strict_accepts(actor: &JsEnvActor, bytes: &[u8]) -> bool {
    let literal = format!(
        "new Uint8Array([{}])",
        bytes.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(",")
    );
    let expr = format!(
        "(() => {{ const b = {literal}; \
           const round = new TextEncoder().encode(new TextDecoder().decode(b)); \
           if (round.length !== b.length) return false; \
           for (let i = 0; i < b.length; i++) if (round[i] !== b[i]) return false; \
           return true; }})()"
    );
    eval_json(actor, &expr).await == "true"
}

/// The coders are PRODUCTION host globals, so no module graph is needed — an
/// empty loader still gets the full `install_host_globals` surface.
fn actor() -> JsEnvActor {
    JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn encoder_matches_whatwg_including_unpaired_surrogates() {
    let a = actor();

    // Well-formed scalars across all four UTF-8 lengths.
    assert_eq!(encode(&a, "''").await, "[]", "empty string");
    assert_eq!(encode(&a, "'\\u0000'").await, "[0]", "NUL is one byte, not overlong");
    assert_eq!(encode(&a, "'A'").await, "[65]");
    assert_eq!(encode(&a, "'\\u00E9'").await, "[195,169]", "2-byte");
    assert_eq!(encode(&a, "'\\u20AC'").await, "[226,130,172]", "3-byte");
    assert_eq!(encode(&a, "'\\u{1F600}'").await, "[240,159,152,128]", "4-byte astral");

    // A correct surrogate PAIR must become ONE 4-byte scalar, never CESU-8.
    assert_eq!(
        encode(&a, "'\\uD83D\\uDE00'").await,
        "[240,159,152,128]",
        "surrogate pair must encode as a single scalar, not CESU-8"
    );

    // UNPAIRED surrogates -> U+FFFD (EF BF BD). This is the case a Rust-backed
    // encoder could not express: such a string cannot cross into Rust at all.
    assert_eq!(encode(&a, "'\\uD800'").await, "[239,191,189]", "lone high surrogate");
    assert_eq!(encode(&a, "'\\uDC00'").await, "[239,191,189]", "lone low surrogate");
    assert_eq!(encode(&a, "'\\uDFFF'").await, "[239,191,189]", "lone low surrogate, top");
    assert_eq!(
        encode(&a, "'a\\uD800b'").await,
        "[97,239,191,189,98]",
        "lone surrogate mid-string does not disturb its neighbours"
    );
    assert_eq!(
        encode(&a, "'\\uD800\\uD800'").await,
        "[239,191,189,239,191,189]",
        "high surrogate followed by another high surrogate: both replaced"
    );
    assert_eq!(
        encode(&a, "'\\uDC00\\uD800'").await,
        "[239,191,189,239,191,189]",
        "reversed pair is NOT a scalar value"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn decoder_matches_whatwg_maximal_subpart_substitution() {
    let a = actor();

    // Well-formed input.
    assert_eq!(decode_code_points(&a, &[]).await, "[]", "empty");
    assert_eq!(decode_code_points(&a, &[0x41]).await, "[\"41\"]");
    assert_eq!(decode_code_points(&a, &[0xC3, 0xA9]).await, "[\"e9\"]");
    assert_eq!(decode_code_points(&a, &[0xE2, 0x82, 0xAC]).await, "[\"20ac\"]");
    assert_eq!(decode_code_points(&a, &[0xF0, 0x9F, 0x98, 0x80]).await, "[\"1f600\"]");

    // SURROGATES ENCODED IN UTF-8 -> three U+FFFD each. THE case that matters:
    // a decoder returning U+D800 here lets malformed bytes pass Images'
    // round-trip validity check.
    assert_eq!(
        decode_code_points(&a, &[0xED, 0xA0, 0x80]).await,
        "[\"fffd\",\"fffd\",\"fffd\"]",
        "ED A0 80 (U+D800) must not decode to a lone surrogate"
    );
    assert_eq!(
        decode_code_points(&a, &[0xED, 0xBF, 0xBF]).await,
        "[\"fffd\",\"fffd\",\"fffd\"]",
        "ED BF BF (U+DFFF) must not decode to a lone surrogate"
    );

    // Overlong encodings.
    assert_eq!(decode_code_points(&a, &[0xC0, 0xAF]).await, "[\"fffd\",\"fffd\"]", "overlong '/'");
    assert_eq!(decode_code_points(&a, &[0xC0, 0x80]).await, "[\"fffd\",\"fffd\"]", "overlong NUL");
    assert_eq!(
        decode_code_points(&a, &[0xE0, 0x80, 0xAF]).await,
        "[\"fffd\",\"fffd\",\"fffd\"]",
        "3-byte overlong"
    );

    // Out of range / never-valid lead bytes.
    assert_eq!(
        decode_code_points(&a, &[0xF8, 0x88, 0x80, 0x80, 0x80]).await,
        "[\"fffd\",\"fffd\",\"fffd\",\"fffd\",\"fffd\"]",
        "5-byte sequence: five replacements"
    );
    assert_eq!(
        decode_code_points(&a, &[0xF4, 0x90, 0x80, 0x80]).await,
        "[\"fffd\",\"fffd\",\"fffd\",\"fffd\"]",
        "beyond U+10FFFF"
    );
    assert_eq!(decode_code_points(&a, &[0xFE]).await, "[\"fffd\"]", "FE is never valid");
    assert_eq!(decode_code_points(&a, &[0xFF]).await, "[\"fffd\"]", "FF is never valid");
    assert_eq!(decode_code_points(&a, &[0x80]).await, "[\"fffd\"]", "stray continuation byte");

    // MAXIMAL SUBPART: the U+FFFD COUNT is the discriminating detail. A naive
    // decoder emits one replacement per sequence, or one per byte; WHATWG emits
    // one per maximal subpart.
    assert_eq!(
        decode_code_points(&a, &[0xE1, 0x80, 0xE2, 0x41]).await,
        "[\"fffd\",\"fffd\",\"41\"]",
        "truncated 3-byte, then truncated 3-byte, then ASCII"
    );
    assert_eq!(
        decode_code_points(&a, &[0xF1, 0x80, 0x41]).await,
        "[\"fffd\",\"41\"]",
        "truncated 4-byte then ASCII: ONE replacement, not two"
    );

    // Truncated sequences: exactly one replacement each, not one per byte.
    assert_eq!(decode_code_points(&a, &[0xC3]).await, "[\"fffd\"]", "truncated 2-byte");
    assert_eq!(decode_code_points(&a, &[0xE2, 0x82]).await, "[\"fffd\"]", "truncated 3-byte");
    assert_eq!(decode_code_points(&a, &[0xF0, 0x9F]).await, "[\"fffd\"]", "truncated 4-byte");
    assert_eq!(
        decode_code_points(&a, &[0x61, 0xE2, 0x82]).await,
        "[\"61\",\"fffd\"]",
        "valid then truncated"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn decoder_strips_one_leading_bom() {
    let a = actor();
    // WHATWG removes a leading U+FEFF when ignoreBOM is false (the default).
    // `String::from_utf8_lossy` does NOT, so this is an explicit host behaviour
    // and a live divergence if omitted: Images on Node REJECTS `EF BB BF 61`
    // through its round-trip check, and we must reject it identically.
    assert_eq!(decode_code_points(&a, &[0xEF, 0xBB, 0xBF, 0x61]).await, "[\"61\"]", "BOM stripped");
    assert_eq!(decode_code_points(&a, &[0xEF, 0xBB, 0xBF]).await, "[]", "BOM-only decodes to empty");
    assert_eq!(
        decode_code_points(&a, &[0xEF, 0xBB, 0xBF, 0xEF, 0xBB, 0xBF]).await,
        "[\"feff\"]",
        "only ONE leading BOM is stripped"
    );
    assert_eq!(
        decode_code_points(&a, &[0x61, 0xEF, 0xBB, 0xBF]).await,
        "[\"61\",\"feff\"]",
        "a non-leading BOM is ordinary content"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn round_trip_validity_matches_the_images_strict_check() {
    let a = actor();

    // Well-formed input round-trips, so Images accepts it.
    assert!(strict_accepts(&a, &[]).await, "empty");
    assert!(strict_accepts(&a, b"hello").await, "ascii");
    assert!(strict_accepts(&a, &[0xC3, 0xA9]).await, "2-byte");
    assert!(strict_accepts(&a, &[0xF0, 0x9F, 0x98, 0x80]).await, "astral");

    // Malformed input must NOT round-trip -> Images refuses it.
    for bad in [
        &[0xED, 0xA0, 0x80][..],       // U+D800 as UTF-8: the smuggling case
        &[0xED, 0xBF, 0xBF][..],       // U+DFFF as UTF-8
        &[0xEF, 0xBB, 0xBF, 0x61][..], // BOM: dropped on decode, so cannot round-trip
        &[0xC0, 0xAF][..],             // overlong
        &[0xC0, 0x80][..],             // overlong NUL
        &[0xE0, 0x80, 0xAF][..],       // 3-byte overlong
        &[0xF8, 0x88, 0x80, 0x80, 0x80][..], // 5-byte
        &[0xF4, 0x90, 0x80, 0x80][..], // > U+10FFFF
        &[0xFE][..],
        &[0xFF][..],
        &[0x80][..],
        &[0xC3][..],
        &[0xE2, 0x82][..],
        &[0xE1, 0x80, 0xE2, 0x41][..],
    ] {
        assert!(
            !strict_accepts(&a, bad).await,
            "malformed UTF-8 {bad:02X?} must fail the decode/re-encode round trip"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsupported_options_fail_loudly_rather_than_degrading() {
    let a = actor();
    async fn threw(a: &JsEnvActor, expr: &str) -> bool {
        eval_json(
            a,
            &format!("(() => {{ try {{ {expr}; return false; }} catch (e) {{ return true; }} }})()"),
        )
        .await
            == "true"
    }

    // `utf8DecodeStrict` (fatal:true) is exported by portable-bytes.js with no
    // callers today. It must decode strictly, NOT silently fall back to lossy.
    assert_eq!(
        eval_json(
            &a,
            "new TextDecoder('utf-8', {fatal: true}).decode(new Uint8Array([0x61]))"
        )
        .await,
        "\"a\"",
        "fatal decode of valid input succeeds"
    );
    assert!(
        threw(&a, "new TextDecoder('utf-8', {fatal: true}).decode(new Uint8Array([0xED,0xA0,0x80]))").await,
        "fatal:true MUST throw on malformed input, not return U+FFFD"
    );

    assert!(threw(&a, "new TextDecoder('utf-16')").await, "a non-UTF-8 label must be refused");
    assert!(threw(&a, "new TextDecoder('utf-8', {ignoreBOM: true})").await, "ignoreBOM unimplemented -> throw");
    assert!(
        threw(&a, "new TextDecoder().decode(new Uint8Array([0x61]), {stream: true})").await,
        "stream:true unimplemented -> throw"
    );
    assert!(threw(&a, "new TextEncoder().encodeInto('a', new Uint8Array(4))").await, "encodeInto -> throw");

    // Accepted aliases.
    for label in ["'utf-8'", "'UTF-8'", "'utf8'", "'unicode-1-1-utf-8'"] {
        assert!(!threw(&a, &format!("new TextDecoder({label})")).await, "{label} should be accepted");
    }
}

/// THE FALSIFIER. Runs the OLD minimal shim (verbatim from the 0fg probe) and
/// asserts it behaves DIFFERENTLY from the production coders on exactly the
/// cases that discriminate. If this test ever goes green in the same way as the
/// production tests, the suite above has stopped distinguishing a spec-faithful
/// implementation from the tempting minimal one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shim_is_red_where_production_is_green() {
    let a = actor();
    // Overwrite the production globals with the old shim, in this runtime only.
    a.eval_async(OLD_MINIMAL_SHIM).await.expect("install shim");

    // 1+2. The shim ACCEPTS surrogate-smuggled bytes that production REJECTS.
    assert!(
        strict_accepts(&a, &[0xED, 0xA0, 0x80]).await,
        "the shim was expected to ACCEPT ED A0 80 (this is the hole B1a closes)"
    );
    assert_eq!(
        decode_code_points(&a, &[0xED, 0xA0, 0x80]).await,
        "[\"d800\"]",
        "the shim was expected to decode ED A0 80 to a LONE SURROGATE"
    );

    // 3. The shim ACCEPTS BOM-prefixed bytes that production (and Node) reject.
    assert!(
        strict_accepts(&a, &[0xEF, 0xBB, 0xBF, 0x61]).await,
        "the shim was expected to ACCEPT a BOM (it does not strip one)"
    );

    // 4. The shim encodes a lone surrogate as WTF-8 instead of U+FFFD, which is
    //    what would give a different digest / version token / durable identity.
    assert_eq!(
        encode(&a, "'\\uD800'").await,
        "[237,160,128]",
        "the shim was expected to emit WTF-8 ED A0 80, not EF BF BD"
    );
}

/// The 0fg probe's deliberately-minimal coders, kept here ONLY as the falsifier's
/// subject. This is the implementation B1a replaces; it must never be installed
/// by production code.
const OLD_MINIMAL_SHIM: &str = r#"
globalThis.TextEncoder = class TextEncoder {
  encode(s) {
    s = String(s);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        const c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
};
globalThis.TextDecoder = class TextDecoder {
  decode(bytes) {
    bytes = new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b < 0x80) { s += String.fromCharCode(b); }
      else if (b < 0xE0) { s += String.fromCharCode(((b & 31) << 6) | (bytes[++i] & 63)); }
      else if (b < 0xF0) { s += String.fromCharCode(((b & 15) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63)); }
      else { let cp = ((b & 7) << 18) | ((bytes[++i] & 63) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63); cp -= 0x10000; s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023)); }
    }
    return s;
  }
};
"#;
