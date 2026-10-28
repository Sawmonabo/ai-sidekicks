//! Events: the session event log and its one append path, the projections it feeds, its canonical
//! bytes and the content each event carries.

pub mod canonicalizer;
pub mod content;
pub mod log_service;
pub mod projection;
pub mod session;
#[cfg(any(test, feature = "test-support"))]
pub mod test_log;
