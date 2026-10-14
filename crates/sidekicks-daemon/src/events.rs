//! Events: the session event log, its canonical bytes, the content each event carries, and the
//! credentials the daemon's control-plane calls carry.

pub(crate) mod canonicalizer;
pub(crate) mod content;
pub(crate) mod daemon_credential_provider;
pub(crate) mod session;
