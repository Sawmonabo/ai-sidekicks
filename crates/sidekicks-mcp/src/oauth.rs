//! The OAuth pieces the daemon's sign-ins share: the `DPoP` proof, the signed send to an
//! authorization server and the pushed authorization request.

pub mod dpop_proof;
pub mod pushed_authorization;
