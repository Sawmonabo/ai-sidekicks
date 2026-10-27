//! Events: the session event log and its one append path, the projections it feeds, its canonical
//! bytes, the content each event carries, and the credentials the daemon's control-plane calls
//! carry.

pub(crate) mod canonicalizer;
pub(crate) mod content;
pub(crate) mod daemon_credential_provider;
pub(crate) mod log_service;
pub(crate) mod projection;
pub(crate) mod session;
#[cfg(test)]
pub(crate) mod test_log;
