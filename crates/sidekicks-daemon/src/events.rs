//! Events: the session event log and its one append path, the purge that deletes whole sessions
//! from it, its canonical bytes, the content each event carries, and the credentials the daemon's
//! control-plane calls carry.

pub(crate) mod canonicalizer;
pub(crate) mod content;
pub(crate) mod daemon_credential_provider;
pub(crate) mod log_service;
pub(crate) mod session;
