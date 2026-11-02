//! The fixed words of a `DPoP` exchange (RFC 9449), which the daemon's signer, the daemon's
//! credential check and the control plane's proof check share: the two header names, the
//! `Authorization` scheme, and the proof's type and algorithm.

/// The request header carrying a `DPoP` proof, in the lowercase form a header map keys by; header
/// names are case-insensitive.
pub const DPOP_PROOF_HEADER_NAME: &str = "dpop";

/// The response header carrying the nonce a server wants the next proof bound to, lowercase.
pub const DPOP_NONCE_HEADER_NAME: &str = "dpop-nonce";

/// The `Authorization` scheme of a DPoP-bound token; `Bearer` is another, refused where a proof is
/// required.
pub const DPOP_AUTHORIZATION_SCHEME: &str = "DPoP";

/// The `typ` a proof's header carries.
pub const DPOP_PROOF_TYPE: &str = "dpop+jwt";

/// The one signing algorithm a proof uses: ECDSA on P-256 with SHA-256.
pub const DPOP_PROOF_ALGORITHM: &str = "ES256";
