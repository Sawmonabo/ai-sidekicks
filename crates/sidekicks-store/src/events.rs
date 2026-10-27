//! Events: the session event log and its one append path, the projections it feeds, its canonical
//! bytes, the content each event carries, and the credentials the daemon's control-plane calls
//! carry.

pub mod canonicalizer;
pub mod content;
pub(crate) mod daemon_credential_provider;
pub mod log_service;
pub mod projection;
pub mod session;
#[cfg(any(test, feature = "test-support"))]
pub mod test_log;
