//! Bead 3zb slice B1b: the generic native crypto primitives.
//!
//! HERMETIC BY NECESSITY, not preference. Node cannot be the runtime oracle
//! here: `node-crypto-provider.js` imports `node:crypto`, which the embedded
//! loader correctly refuses, and the `linux-host` CI job has no `setup-node`
//! step. So every expectation below is a PUBLISHED FIXED VECTOR hardcoded as a
//! constant -- which is a stronger oracle than differencing against Node, since
//! Node is just OpenSSL.
//!
//! SHA-256 vectors are the FIPS 180-4 standard test messages. AES-256-GCM
//! vectors are GCM test cases 13/14/15 (McGrew-Viega), carried into NIST CAVP
//! `gcmEncryptExtIV256`.
//!
//! ONLY EMPTY-AAD VECTORS ARE USED, deliberately. The Images crypto-provider
//! contract has no AAD parameter -- it is unexpressible -- so a host that
//! accepted one would be a semantic widening. GCM test case 16 (same key/iv/pt
//! with a 20-byte AAD) is therefore excluded on purpose, not overlooked.

use lagrange_host_linux::js_env::actor::JsEnvActor;
use lagrange_host_linux::js_env::EmbeddedLoader;

async fn eval(actor: &JsEnvActor, expr: &str) -> String {
    actor.eval_async(expr).await.expect("eval failed")
}

async fn json(actor: &JsEnvActor, expr: &str) -> serde_json::Value {
    serde_json::from_str(&eval(actor, expr).await).expect("valid json")
}

async fn thrown(actor: &JsEnvActor, expr: &str) -> String {
    let raw = eval(
        actor,
        &format!(
            "(() => {{ try {{ {expr}; return 'NO-THROW'; }} \
               catch (e) {{ return (e && e.name) + ': ' + (e && e.message); }} }})()"
        ),
    )
    .await;
    serde_json::from_str::<String>(&raw).unwrap_or(raw)
}

fn actor() -> JsEnvActor {
    JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor")
}

/// `new Uint8Array([...])` literal from hex.
fn u8s(hex: &str) -> String {
    let bytes: Vec<String> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex").to_string())
        .collect();
    format!("new Uint8Array([{}])", bytes.join(","))
}

const JS_HEX: &str = "const hex = (a) => [...a].map(b => b.toString(16).padStart(2,'0')).join('');";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sha256_matches_fips_180_4_vectors() {
    let a = actor();
    let v = json(
        &a,
        &format!(
            r#"(() => {{ {JS_HEX}
  const enc = new TextEncoder();
  const million = new Uint8Array(1000000).fill(97); // 'a' x 1,000,000
  return {{
    empty:  hex(__jsenv_crypto_sha256(new Uint8Array(0))),
    abc:    hex(__jsenv_crypto_sha256(enc.encode('abc'))),
    b448:   hex(__jsenv_crypto_sha256(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    b896:   hex(__jsenv_crypto_sha256(enc.encode('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'))),
    mil:    hex(__jsenv_crypto_sha256(million)),
    len:    __jsenv_crypto_sha256(new Uint8Array(0)).length,
  }};
}})()"#
        ),
    )
    .await;
    assert_eq!(v["empty"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_eq!(v["abc"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert_eq!(v["b448"], "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    assert_eq!(v["b896"], "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
    // The only multi-buffer streaming case, and cheap.
    assert_eq!(v["mil"], "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    assert_eq!(v["len"], 32);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sha256_hashes_the_view_not_the_backing_buffer() {
    let a = actor();
    // Images passes subarray views; hashing the whole buffer would be a silent
    // and catastrophic difference.
    let v = json(
        &a,
        &format!(
            r#"(() => {{ {JS_HEX}
  const buf = new Uint8Array([0,0,97,98,99,0,0]);   // 'abc' at offset 2
  const view = buf.subarray(2, 5);
  return {{viewHash: hex(__jsenv_crypto_sha256(view)), offset: view.byteOffset}};
}})()"#
        ),
    )
    .await;
    assert_eq!(v["offset"], 2, "the test input really is an offset view");
    assert_eq!(
        v["viewHash"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "a subarray must hash its OWN bytes, not the whole backing buffer"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aes256gcm_matches_nist_vectors_with_ciphertext_and_tag_pinned_separately() {
    let a = actor();

    // GCM test case 13: empty plaintext. The case a naive `len-16` split of a
    // combined buffer gets wrong, which is why the host uses the detached API.
    let k0 = u8s(&"00".repeat(32));
    let i0 = u8s(&"00".repeat(12));
    let v = json(
        &a,
        &format!(
            r#"(() => {{ {JS_HEX}
  const r = __jsenv_crypto_aes256gcm_encrypt({k0}, {i0}, new Uint8Array(0));
  return {{ct: hex(r.ciphertext), tag: hex(r.tag), ctLen: r.ciphertext.length, tagLen: r.tag.length}};
}})()"#
        ),
    )
    .await;
    assert_eq!(v["ct"], "", "TC13 ciphertext is empty");
    assert_eq!(v["tag"], "530f8afbc74536b9a963b4f1c4cb738b", "TC13 tag");
    assert_eq!(v["ctLen"], 0);
    assert_eq!(v["tagLen"], 16);

    // GCM test case 14: 16 zero bytes.
    let p1 = u8s(&"00".repeat(16));
    let v = json(
        &a,
        &format!(
            r#"(() => {{ {JS_HEX}
  const r = __jsenv_crypto_aes256gcm_encrypt({k0}, {i0}, {p1});
  return {{ct: hex(r.ciphertext), tag: hex(r.tag)}};
}})()"#
        ),
    )
    .await;
    assert_eq!(v["ct"], "cea7403d4d606b6e074ec5d3baf39d18", "TC14 ciphertext");
    assert_eq!(v["tag"], "d0d1c8a799996bf0265b98b5d48ab919", "TC14 tag");

    // GCM test case 15: 60-byte plaintext, real key and IV.
    let k2 = u8s("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308");
    let i2 = u8s("cafebabefacedbaddecaf888");
    let p2 = u8s("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39");
    let v = json(
        &a,
        &format!(
            r#"(() => {{ {JS_HEX}
  const r = __jsenv_crypto_aes256gcm_encrypt({k2}, {i2}, {p2});
  const back = __jsenv_crypto_aes256gcm_decrypt({k2}, {i2}, r.ciphertext, r.tag);
  return {{ct: hex(r.ciphertext), tag: hex(r.tag), roundTrip: hex(back)}};
}})()"#
        ),
    )
    .await;
    assert_eq!(
        v["ct"],
        "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662",
        "TC15 ciphertext"
    );
    assert_eq!(v["tag"], "eb9f796c8d356fc31a8433884b696f4f", "TC15 tag");
    assert_eq!(
        v["roundTrip"],
        "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
        "decrypt must return the original plaintext"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aes256gcm_refuses_tampering_rather_than_returning_bytes() {
    let a = actor();
    let k = u8s(&"00".repeat(32));
    let i = u8s(&"00".repeat(12));
    let p = u8s(&"00".repeat(16));

    // THE security property Images depends on: `image-observation-binding`
    // classifies ANY throw from decrypt as an integrity failure, so a decrypt
    // that returned empty or unauthenticated bytes would turn a FORGED token
    // into an accepted one.
    for (mutate, what) in [
        ("r.tag[0] ^= 1", "a flipped tag byte"),
        ("r.tag[15] ^= 0x80", "a flipped tag byte at the end"),
        ("r.ciphertext[0] ^= 1", "a flipped ciphertext byte"),
    ] {
        let got = thrown(
            &a,
            &format!(
                "(() => {{ const r = __jsenv_crypto_aes256gcm_encrypt({k}, {i}, {p}); \
                   {mutate}; return __jsenv_crypto_aes256gcm_decrypt({k}, {i}, r.ciphertext, r.tag); }})()"
            ),
        )
        .await;
        assert!(
            got.starts_with("TypeError:") && got.contains("authentication failed"),
            "{what} must make decrypt THROW, got: {got}"
        );
    }

    // Wrong key and wrong IV must also fail authentication, not return garbage.
    let wrong_k = u8s(&"01".repeat(32));
    let wrong_i = u8s(&"01".repeat(12));
    for (kk, ii, what) in [(&wrong_k, &i, "a wrong key"), (&k, &wrong_i, "a wrong iv")] {
        let got = thrown(
            &a,
            &format!(
                "(() => {{ const r = __jsenv_crypto_aes256gcm_encrypt({k}, {i}, {p}); \
                   return __jsenv_crypto_aes256gcm_decrypt({kk}, {ii}, r.ciphertext, r.tag); }})()"
            ),
        )
        .await;
        assert!(got.starts_with("TypeError:"), "{what} must throw, got: {got}");
    }

    // The un-tampered round trip still works (the checks above are not vacuous).
    let v = json(
        &a,
        &format!(
            r#"(() => {{ {JS_HEX}
  const r = __jsenv_crypto_aes256gcm_encrypt({k}, {i}, {p});
  return {{ok: hex(__jsenv_crypto_aes256gcm_decrypt({k}, {i}, r.ciphertext, r.tag))}};
}})()"#
        ),
    )
    .await;
    assert_eq!(v["ok"], "00000000000000000000000000000000");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wrong_lengths_refuse_loudly_rather_than_truncating_or_padding() {
    let a = actor();
    let k = u8s(&"00".repeat(32));
    let i = u8s(&"00".repeat(12));
    let p = u8s("00");

    for (expr, what) in [
        (format!("__jsenv_crypto_aes256gcm_encrypt({}, {i}, {p})", u8s(&"00".repeat(31))), "a 31-byte key"),
        (format!("__jsenv_crypto_aes256gcm_encrypt({}, {i}, {p})", u8s(&"00".repeat(33))), "a 33-byte key"),
        (format!("__jsenv_crypto_aes256gcm_encrypt({k}, {}, {p})", u8s(&"00".repeat(11))), "an 11-byte iv"),
        (format!("__jsenv_crypto_aes256gcm_encrypt({k}, {}, {p})", u8s(&"00".repeat(16))), "a 16-byte iv"),
        (
            format!("__jsenv_crypto_aes256gcm_decrypt({k}, {i}, {p}, {})", u8s(&"00".repeat(15))),
            "a 15-byte tag",
        ),
    ] {
        let got = thrown(&a, &expr).await;
        assert!(
            got.starts_with("TypeError:") && (got.contains("bytes") || got.contains("rejected")),
            "{what} must be refused loudly, got: {got}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secure_random_bytes_respects_length_and_refuses_nonsense() {
    let a = actor();
    let v = json(
        &a,
        r#"(() => {
  const lens = [0, 1, 12, 16, 32, 4096];
  const out = {};
  for (const n of lens) {
    const r = __jsenv_crypto_random_bytes(n);
    out['len' + n] = r.length;
    out['isU8_' + n] = r instanceof Uint8Array;
  }
  return out;
})()"#,
    )
    .await;
    for n in [0, 1, 12, 16, 32, 4096] {
        assert_eq!(v[format!("len{n}")], n, "requested length must be respected exactly");
        assert_eq!(v[format!("isU8_{n}")], true);
    }

    // NOT a statistical test: nonsense lengths must be refused before allocating.
    for (expr, what) in [
        ("__jsenv_crypto_random_bytes(-1)", "a negative length"),
        ("__jsenv_crypto_random_bytes(1.5)", "a fractional length"),
        ("__jsenv_crypto_random_bytes(NaN)", "NaN"),
        ("__jsenv_crypto_random_bytes(Infinity)", "Infinity"),
        ("__jsenv_crypto_random_bytes(1e9)", "an unreasonable length"),
    ] {
        let got = thrown(&a, expr).await;
        assert!(got.starts_with("TypeError:"), "{what} must be refused, got: {got}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uuid_is_rfc4122_v4() {
    let a = actor();
    let v = json(
        &a,
        r#"(() => {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const ids = Array.from({length: 32}, () => __jsenv_crypto_uuid());
  return {
    allStrings: ids.every(id => typeof id === 'string'),
    allWellFormed: ids.every(id => re.test(id)),
    // Version nibble and variant bits, checked structurally rather than by regex alone.
    version4: ids.every(id => id[14] === '4'),
    variant10: ids.every(id => '89ab'.includes(id[19])),
    sample: ids[0],
  };
})()"#,
    )
    .await;
    assert_eq!(v["allStrings"], true);
    assert_eq!(v["allWellFormed"], true, "sample: {}", v["sample"]);
    assert_eq!(v["version4"], true, "RFC 4122 version nibble must be 4");
    assert_eq!(v["variant10"], true, "RFC 4122 variant bits must be 10xx");
}

/// Not a statistical randomness test -- the one runtime leg a SEEDED PRNG
/// actually fails. A fixed-seed generator restarts identically in a fresh
/// runtime; an OS CSPRNG does not.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_fresh_runtimes_do_not_repeat_random_output() {
    let a1 = actor();
    let a2 = actor();
    let expr = "(() => { const hex = (x) => [...x].map(b => b.toString(16).padStart(2,'0')).join(''); \
                 return {r: hex(__jsenv_crypto_random_bytes(32)), u: __jsenv_crypto_uuid()}; })()";
    let v1 = json(&a1, expr).await;
    let v2 = json(&a2, expr).await;
    assert_ne!(
        v1["r"], v2["r"],
        "two fresh runtimes produced IDENTICAL first random bytes -- that is what a seeded \
         PRNG does, and it must not be what this host does"
    );
    assert_ne!(v1["u"], v2["u"], "two fresh runtimes produced the same first UUID");
}

/// Durable identity depends on the VIEW, not only the bytes:
/// `smalltalk-equality.js` reads `new DataView(d.buffer, d.byteOffset, d.byteLength)`
/// over a sha256 result to derive bucket placement, so a returned array whose
/// buffer geometry is off would produce correct-looking bytes and a wrong hash.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn byte_returning_primitives_have_coherent_view_geometry() {
    let a = actor();
    let v = json(
        &a,
        &format!(
            r#"(() => {{
  const enc = new TextEncoder();
  const check = (r) => ({{
    isU8: r instanceof Uint8Array,
    zeroOffset: r.byteOffset === 0,
    wholeBuffer: r.byteLength === r.buffer.byteLength,
  }});
  const digest = __jsenv_crypto_sha256(enc.encode('abc'));
  const dv = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const enc2 = __jsenv_crypto_aes256gcm_encrypt({}, {}, new Uint8Array(0));
  return {{
    digest: check(digest),
    random: check(__jsenv_crypto_random_bytes(8)),
    tag: check(enc2.tag),
    // First 8 bytes of the 'abc' digest read through a DataView.
    dvHigh: dv.getBigUint64(0, false).toString(16),
  }};
}})()"#,
            u8s(&"00".repeat(32)),
            u8s(&"00".repeat(12))
        ),
    )
    .await;
    for key in ["digest", "random", "tag"] {
        assert_eq!(v[key]["isU8"], true, "{key} must be a Uint8Array");
        assert_eq!(v[key]["zeroOffset"], true, "{key} must start at byteOffset 0");
        assert_eq!(v[key]["wholeBuffer"], true, "{key} must span its whole backing buffer");
    }
    // ba7816bf8f01cfea -> the first 8 bytes of SHA-256('abc').
    assert_eq!(
        v["dvHigh"], "ba7816bf8f01cfea",
        "a DataView over the digest must read the pinned bytes"
    );
}
