// Bead 3zb slice B1b: the Env <-> Images crypto BINDING.
//
// This module is COMPOSITION code, not host code, and the directory it lives in
// is the ownership statement:
//
//   Rust js_env host            generic primitives only
//           |
//           v
//   THIS MODULE                 builds the Images provider object
//           |
//           v
//   lagrange-images             assertCryptoProvider / setDefaultCryptoProvider
//           |
//           v
//   createPortableRuntime
//
// It MAY import public portable `lagrange-images` modules precisely because it
// is composition; `hosts/linux/src/js_env/` may NOT, and the structural guard
// enforces that. Everything below is adaptation and sequencing: no cryptography
// is implemented here, and no Images semantics are reproduced here.
//
// WHAT THE ADAPTATION ACTUALLY IS. The host exposes generic POSITIONAL
// primitives; the Images contract declares OBJECT-form AES operations. Turning
// one into the other is the entire job of this file. Keeping the host positional
// and generic is deliberate: it stops the shape of an Images contract from
// leaking into the native layer, so the contract can change without touching
// Rust.
//
// VALIDATION IS IMAGES-OWNED. We do not re-implement `assertCryptoProvider`:
// `setDefaultCryptoProvider` runs it internally, so installing through the
// public seam IS the validation. If the provider we assemble were incomplete or
// misshapen, that call is what rejects it.
//
// ORDERING IS MANDATORY, NOT DEFENSIVE. `createPortableRuntime` calls
// `getDefaultCryptoProvider()` at its top specifically to fail fast when a host
// forgot to install a provider, so "install, then compose" is enforced by Images
// itself. Linking and evaluating the closure is provider-free (the provider is
// resolved lazily per call, and no module calls one at top level), but semantic
// use is gated behind installation regardless.

import {setDefaultCryptoProvider} from 'portable-runtime';

/// Build the Images-contract provider object over the generic host primitives.
///
/// Exported separately from installation so a caller can inspect or wrap it --
/// and so a test can install a DELIBERATELY MISWIRED variant over the same host
/// primitives without touching the production path.
function createNativeCryptoProvider(primitives = globalThis) {
  const randomBytes = primitives.__jsenv_crypto_random_bytes;
  const sha256 = primitives.__jsenv_crypto_sha256;
  const encrypt = primitives.__jsenv_crypto_aes256gcm_encrypt;
  const decrypt = primitives.__jsenv_crypto_aes256gcm_decrypt;
  const uuid = primitives.__jsenv_crypto_uuid;

  for (const [name, fn] of Object.entries({randomBytes, sha256, encrypt, decrypt, uuid})) {
    if (typeof fn !== 'function') {
      // Loud and specific: a missing primitive means the host globals were not
      // installed, which is a very different fault from a rejected provider.
      throw new TypeError(`native crypto primitive '${name}' is not available on this host`);
    }
  }

  return {
    secureRandomBytes: (length) => randomBytes(length),
    sha256: (bytes) => sha256(bytes),
    // Object form in, positional out: this is the adaptation.
    aes256gcmEncrypt: ({key, iv, plaintext}) => encrypt(key, iv, plaintext),
    aes256gcmDecrypt: ({key, iv, ciphertext, tag}) => decrypt(key, iv, ciphertext, tag),
    uuid: () => uuid(),
  };
}

/// Install the native provider through the PUBLIC Images seam.
///
/// Returns whatever `setDefaultCryptoProvider` returns, so the caller observes
/// the Images-owned, validated and frozen provider rather than our input object.
function installNativeCryptoProvider(provider = createNativeCryptoProvider()) {
  return setDefaultCryptoProvider(provider);
}

export {createNativeCryptoProvider, installNativeCryptoProvider};
