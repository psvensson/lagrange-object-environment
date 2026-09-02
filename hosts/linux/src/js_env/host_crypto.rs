//! Bead 3zb slice B1b: GENERIC synchronous host crypto primitives.
//!
//! # The ownership line this file exists to hold
//!
//! ```text
//! Rust js_env host            generic primitives only          <- THIS FILE
//!         |
//!         v
//! guest bootstrap/composition builds the Images provider object
//!         |
//!         v
//! lagrange-images             assertCryptoProvider / setDefaultCryptoProvider
//!         |
//!         v
//! createPortableRuntime
//! ```
//!
//! **The host owns primitives; Images owns crypto semantics and the provider
//! contract; composition owns their binding.**
//!
//! This file therefore exposes only generic, standard cryptographic operations
//! under generic names. It knows NOTHING about observation cursors, version
//! tokens, type fingerprints, derivation identities, authority, or Project
//! semantics — those are `lagrange-images` semantics, and the whole point of the
//! three-layer split is that a native host never learns them. It also performs
//! no provider assembly and no contract validation: `assertCryptoProvider` is
//! Images-owned and must not be reproduced here.
//!
//! Nothing in this module may import or name a `lagrange-images` module. The
//! structural guard enforces that with specifier-shaped needles, because the
//! ownership rule is only a rule if something checks it.
//!
//! # Why these five, and why synchronous
//!
//! They are exactly the operations the Images crypto-provider contract declares,
//! no more. The contract is synchronous because `typeFingerprint` (inside the
//! synchronous `packCompositeValue`), `objectVersionToken`, and observation
//! cursor encode/decode all run deep inside synchronous executor paths, so an
//! async provider is not injectable there. A native host is exactly what that
//! seam was designed for.
//!
//! # Implementation notes that are load-bearing
//!
//! * **Established libraries only.** AES-256-GCM comes from RustCrypto's
//!   `aes-gcm` and SHA-256 from `sha2`; entropy comes from `getrandom`, i.e. the
//!   OS CSPRNG. No hand-rolled cipher, hash, or PRNG.
//! * **Detached AEAD.** `encrypt_in_place_detached` / `decrypt_in_place_detached`
//!   return and take the tag separately, matching the contract's
//!   `{ciphertext, tag}` shape exactly. The combined `Aead::encrypt` API would
//!   force us to hard-code a `len - 16` split in our own code, which is both
//!   fragile and wrong for the empty-plaintext case.
//! * **Empty AAD, always.** The Images contract has no AAD parameter — it is
//!   unexpressible — so accepting one would be a semantic widening. Every call
//!   passes an empty AAD.
//! * **One entropy owner.** `uuid` derives from `secure_random_bytes` rather than
//!   seeding a second generator, so randomness has a single source. This is why
//!   `aes-gcm` is pulled with `default-features = false`: its default `getrandom`
//!   feature exists to provide `AeadCore::generate_nonce`, which we must not use
//!   (Images owns IV generation), and it would drag in a second `rand_core`.
//! * **Throw, never panic.** A Rust panic inside a host function aborts the
//!   JS-owner thread and takes the whole runtime with it, so every argument is
//!   validated and every rejection goes out as a JS `TypeError` via
//!   `Exception::throw_type`.
//! * **Authentication failure MUST throw.** `image-observation-binding` wraps any
//!   throw from decrypt as an integrity failure; a decrypt that returned empty
//!   or garbage instead would silently turn a forged cursor into a valid one.

use aes_gcm::aead::AeadInPlace;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce, Tag};
use rquickjs::{Ctx, Exception, Function, Object, Result, TypedArray};
use sha2::{Digest, Sha256};

/// The only entropy call site in this module: the OS CSPRNG, never a seeded
/// userspace generator.
fn fill_random(out: &mut [u8]) -> std::result::Result<(), getrandom::Error> {
    getrandom::getrandom(out)
}

/// Reject a length that is not a sane non-negative integer BEFORE allocating.
fn checked_len(ctx: &Ctx<'_>, len: f64) -> Result<usize> {
    if !len.is_finite() || len < 0.0 || len.fract() != 0.0 {
        return Err(Exception::throw_type(
            ctx,
            "secureRandomBytes length must be a non-negative integer",
        ));
    }
    // A generous ceiling: large enough for any legitimate use, small enough that
    // a bad caller cannot ask the host to allocate unbounded memory.
    const MAX: f64 = 1024.0 * 1024.0;
    if len > MAX {
        return Err(Exception::throw_type(
            ctx,
            "secureRandomBytes length is unreasonably large",
        ));
    }
    Ok(len as usize)
}

fn expect_len(ctx: &Ctx<'_>, bytes: &[u8], want: usize, label: &str) -> Result<()> {
    if bytes.len() != want {
        return Err(Exception::throw_type(
            ctx,
            &format!("{label} must be {want} bytes, got {}", bytes.len()),
        ));
    }
    Ok(())
}

fn cipher_for<'js>(ctx: &Ctx<'js>, key: &[u8]) -> Result<Aes256Gcm> {
    expect_len(ctx, key, 32, "AES-256-GCM key")?;
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| Exception::throw_type(ctx, "AES-256-GCM key was rejected"))
}

/// `secureRandomBytes(length) -> Uint8Array`.
fn jsenv_crypto_random_bytes<'js>(ctx: Ctx<'js>, len: f64) -> Result<TypedArray<'js, u8>> {
    let n = checked_len(&ctx, len)?;
    let mut buf = vec![0u8; n];
    fill_random(&mut buf)
        .map_err(|e| Exception::throw_type(&ctx, &format!("secure random source failed: {e}")))?;
    TypedArray::new(ctx, buf)
}

/// `sha256(bytes) -> Uint8Array(32)`.
fn jsenv_crypto_sha256<'js>(
    ctx: Ctx<'js>,
    input: TypedArray<'js, u8>,
) -> Result<TypedArray<'js, u8>> {
    let mut hasher = Sha256::new();
    // `as_ref()` honours byteOffset/length, so a subarray view hashes its own
    // bytes rather than the whole backing buffer.
    hasher.update(input.as_ref() as &[u8]);
    let digest = hasher.finalize();
    TypedArray::new(ctx, digest.to_vec())
}

/// `aes256gcmEncrypt(key, iv, plaintext) -> {ciphertext, tag}`.
///
/// Positional and generic on purpose: adapting this to the Images contract's
/// object form is the guest bootstrap's job, not the host's.
fn jsenv_crypto_aes256gcm_encrypt<'js>(
    ctx: Ctx<'js>,
    key: TypedArray<'js, u8>,
    iv: TypedArray<'js, u8>,
    plaintext: TypedArray<'js, u8>,
) -> Result<Object<'js>> {
    let cipher = cipher_for(&ctx, key.as_ref())?;
    expect_len(&ctx, iv.as_ref(), 12, "AES-256-GCM iv")?;
    let nonce = Nonce::from_slice(iv.as_ref());

    let mut buf = (plaintext.as_ref() as &[u8]).to_vec();
    // Detached: the tag comes back separately, matching the contract shape with
    // no length arithmetic of our own.
    let tag = cipher
        .encrypt_in_place_detached(nonce, &[], &mut buf)
        .map_err(|_| Exception::throw_type(&ctx, "AES-256-GCM encryption failed"))?;

    let out = Object::new(ctx.clone())?;
    out.set("ciphertext", TypedArray::new(ctx.clone(), buf)?)?;
    out.set("tag", TypedArray::new(ctx, tag.to_vec())?)?;
    Ok(out)
}

/// `aes256gcmDecrypt(key, iv, ciphertext, tag) -> Uint8Array`, THROWING on
/// authentication failure.
///
/// The throw is a security property, not an ergonomic one: Images classifies any
/// throw here as an integrity failure, so returning empty or unauthenticated
/// bytes would convert a forged token into an accepted one.
fn jsenv_crypto_aes256gcm_decrypt<'js>(
    ctx: Ctx<'js>,
    key: TypedArray<'js, u8>,
    iv: TypedArray<'js, u8>,
    ciphertext: TypedArray<'js, u8>,
    tag: TypedArray<'js, u8>,
) -> Result<TypedArray<'js, u8>> {
    let cipher = cipher_for(&ctx, key.as_ref())?;
    expect_len(&ctx, iv.as_ref(), 12, "AES-256-GCM iv")?;
    expect_len(&ctx, tag.as_ref(), 16, "AES-256-GCM tag")?;
    let nonce = Nonce::from_slice(iv.as_ref());
    let tag = Tag::from_slice(tag.as_ref());

    let mut buf = (ciphertext.as_ref() as &[u8]).to_vec();
    cipher
        .decrypt_in_place_detached(nonce, &[], &mut buf, tag)
        .map_err(|_| {
            Exception::throw_type(&ctx, "AES-256-GCM authentication failed")
        })?;
    TypedArray::new(ctx, buf)
}

/// `uuid() -> string`, RFC 4122 version 4.
///
/// Derived from the same OS entropy as `secureRandomBytes` so randomness has ONE
/// owner in this module; a separately seeded generator would duplicate that
/// authority for no benefit.
fn jsenv_crypto_uuid(ctx: Ctx<'_>) -> Result<String> {
    let mut b = [0u8; 16];
    fill_random(&mut b)
        .map_err(|e| Exception::throw_type(&ctx, &format!("secure random source failed: {e}")))?;
    b[6] = (b[6] & 0x0F) | 0x40; // version 4
    b[8] = (b[8] & 0x3F) | 0x80; // variant 10xx
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    ))
}

/// Install the five generic primitives as host globals.
///
/// Generic names only: nothing here says "cursor", "token" or "fingerprint", and
/// no provider object is constructed. Assembling these into the Images provider
/// and installing it is the guest composition's responsibility.
pub(crate) fn install_host_crypto(ctx: &Ctx<'_>) -> Result<()> {
    let g = ctx.globals();
    g.set(
        "__jsenv_crypto_random_bytes",
        Function::new(ctx.clone(), jsenv_crypto_random_bytes)?,
    )?;
    g.set(
        "__jsenv_crypto_sha256",
        Function::new(ctx.clone(), jsenv_crypto_sha256)?,
    )?;
    g.set(
        "__jsenv_crypto_aes256gcm_encrypt",
        Function::new(ctx.clone(), jsenv_crypto_aes256gcm_encrypt)?,
    )?;
    g.set(
        "__jsenv_crypto_aes256gcm_decrypt",
        Function::new(ctx.clone(), jsenv_crypto_aes256gcm_decrypt)?,
    )?;
    g.set(
        "__jsenv_crypto_uuid",
        Function::new(ctx.clone(), jsenv_crypto_uuid)?,
    )?;
    Ok(())
}
