//! The passkey relying party: the two ceremonies' routes, the single-use challenges they run on,
//! the passkeys they keep, and the verifier and authenticator list they call out to.

pub(crate) mod authentication;
pub mod authenticator_list;
pub(crate) mod challenge;
pub(crate) mod credential;
pub(crate) mod registration;
pub mod verifier;
