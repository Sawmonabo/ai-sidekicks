//! The statement chain's check: the one Ed25519 signature check every machine and the control plane
//! run on a statement.

use ed25519_dalek::{Signature, SignatureError, VerifyingKey};

/// Why a signature was refused. It names no key and no signature bytes.
#[derive(Debug, thiserror::Error)]
pub enum SignatureRefusal {
    /// The public key is no point on the curve.
    #[error("the public key is not an Ed25519 key")]
    PublicKey(#[source] SignatureError),
    /// The signature does not verify under the key, or the key or the signature's point is of small
    /// order.
    #[error("the signature does not verify under the key")]
    Signature(#[source] SignatureError),
}

/// Checks `signature` over `message` under the Ed25519 `public_key` with the strict check, which
/// refuses a key or a signature point of small order. Fails with [`SignatureRefusal`] when the key
/// is no curve point or the signature does not verify.
pub fn verify_ed25519(
    public_key: &[u8; 32],
    message: &[u8],
    signature: &[u8; 64],
) -> Result<(), SignatureRefusal> {
    let key = VerifyingKey::from_bytes(public_key).map_err(SignatureRefusal::PublicKey)?;
    key.verify_strict(message, &Signature::from_bytes(signature))
        .map_err(SignatureRefusal::Signature)
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};

    use super::{SignatureRefusal, verify_ed25519};

    /// The small-order forgery: the identity point as the key and as the signature's `R`, with
    /// `S = 0`, so the lax check's `[S]B - [k]A` is the identity, whose encoding is `R`.
    fn forgery() -> ([u8; 32], [u8; 64]) {
        let mut public_key = [0_u8; 32];
        public_key[0] = 1;
        let mut signature = [0_u8; 64];
        signature[0] = 1;
        (public_key, signature)
    }

    /// The lax check takes the forgery and `verify_ed25519` refuses it, while a minted key's own
    /// signature verifies. Mutation: `verify_strict` swapped for `verify`, which takes the forgery.
    #[test]
    fn the_check_refuses_a_small_order_forgery_and_takes_a_real_signature() {
        let message = b"any statement";
        let (public_key, signature) = forgery();
        let lax_key = VerifyingKey::from_bytes(&public_key).expect("the identity point decodes");
        assert!(
            lax_key
                .verify(message, &Signature::from_bytes(&signature))
                .is_ok()
        );
        assert!(matches!(
            verify_ed25519(&public_key, message, &signature),
            Err(SignatureRefusal::Signature(_))
        ));

        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let signed = signing_key.sign(message).to_bytes();
        let minted_key = signing_key.verifying_key().to_bytes();
        assert!(verify_ed25519(&minted_key, message, &signed).is_ok());
        assert!(matches!(
            verify_ed25519(&minted_key, b"another statement", &signed),
            Err(SignatureRefusal::Signature(_))
        ));
    }
}
