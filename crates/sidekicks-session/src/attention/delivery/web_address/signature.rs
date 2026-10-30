//! The web address's signing secret and each message's signature, the Standard Webhooks way: a
//! 32-byte key shown as `whsec_` and its standard base64, and one `v1,` signature, HMAC-SHA256 over
//! `<id>.<timestamp>.<body>`, recomputed at every attempt from the key read out of the keychain.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, KeyInit as _, Mac as _};
use secrecy::zeroize::Zeroizing;
use secrecy::{ExposeSecret as _, SecretString};
use sha2::Sha256;

/// The text a signing secret starts with, before its key's base64.
const SECRET_PREFIX: &str = "whsec_";

/// The key's length: SHA-256's output, the shortest key HMAC-SHA256 takes at full strength.
const KEY_LENGTH: usize = 32;

/// The stored signing secret does not read as one the app mints.
#[derive(Debug, thiserror::Error)]
#[error("the saved signing secret is not one the app mints")]
pub(crate) struct UnreadableSigningSecret;

/// A fresh signing secret: 32 random bytes from the system's source, as `whsec_` and their padded
/// standard base64. Fails when the system's random source does.
pub(crate) fn mint_signing_secret() -> Result<SecretString, getrandom::Error> {
    let mut key = Zeroizing::new([0; KEY_LENGTH]);
    getrandom::fill(key.as_mut_slice())?;
    let mut secret = String::from(SECRET_PREFIX);
    STANDARD.encode_string(key.as_slice(), &mut secret);
    Ok(SecretString::from(secret))
}

/// The `webhook-signature` of message `message_id` with `body` sent at `timestamp`, in Unix
/// seconds: `v1,` and the base64 HMAC-SHA256 of `<id>.<timestamp>.<body>` under `secret`'s key.
/// Fails with [`UnreadableSigningSecret`] when `secret` is not `whsec_` and standard base64.
pub(crate) fn sign_message(
    secret: &SecretString,
    message_id: &str,
    timestamp: i64,
    body: &[u8],
) -> Result<String, UnreadableSigningSecret> {
    let encoded = secret
        .expose_secret()
        .strip_prefix(SECRET_PREFIX)
        .ok_or(UnreadableSigningSecret)?;
    // The decode failure names a byte of the secret, so it is not kept.
    let key = Zeroizing::new(
        STANDARD
            .decode(encoded)
            .map_err(|_byte_of_the_secret| UnreadableSigningSecret)?,
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).expect("HMAC takes a key of any length");
    mac.update(message_id.as_bytes());
    mac.update(b".");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    Ok(format!(
        "v1,{}",
        STANDARD.encode(mac.finalize().into_bytes())
    ))
}
