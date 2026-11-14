//! Codex's log export read for price: the tag each launch carries, which launch an export came
//! from, each completed response its records state, the sighting each source's reading of a
//! request carries, the exported response a session prices, where a response on a thread no
//! session streams belongs, the copies' threads, and the drain that takes each response where it
//! belongs; a one-shot exec's export, collected for its caller; and each launch's read of its
//! rollout files while its export is absent.

pub(crate) mod completed_response;
pub(crate) mod copy_threads;
pub(crate) mod drain;
pub(crate) mod exec_export;
pub(crate) mod exported_response;
pub(crate) mod exports;
pub(crate) mod placement;
mod reader;
pub(crate) mod rollouts;
pub(crate) mod sighting;
