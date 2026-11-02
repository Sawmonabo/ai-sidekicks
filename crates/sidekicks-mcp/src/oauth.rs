//! The OAuth pieces the daemon's sign-ins share: the `DPoP` proof, the signed send to an
//! authorization server, a confidential client's authentication, the pushed authorization request,
//! the one-time redirect receiver the browser returns to and the readings of an address's host.

pub(crate) mod address;
pub(crate) mod client_authentication;
pub mod dpop_proof;
pub mod pushed_authorization;
pub mod redirect_receiver;
