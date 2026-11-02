//! The OAuth pieces the daemon's sign-ins share: the `DPoP` proof, the signed send to an
//! authorization server, a confidential client's authentication, the pushed authorization request,
//! the one-time redirect receiver the browser returns to and what counts as loopback.

pub(crate) mod client_authentication;
pub mod dpop_proof;
pub(crate) mod loopback;
pub mod pushed_authorization;
pub mod redirect_receiver;
