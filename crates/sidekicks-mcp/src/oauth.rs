//! The OAuth pieces the daemon's sign-ins share: the `DPoP` proof, the signed send to an
//! authorization server, the pushed authorization request and the one-time redirect receiver the
//! browser returns to.

pub mod dpop_proof;
pub mod pushed_authorization;
pub mod redirect_receiver;
