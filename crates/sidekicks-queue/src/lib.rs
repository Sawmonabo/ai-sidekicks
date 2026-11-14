//! The run queue: sending, ordering, admitting, delivering and recording runs per session, the
//! memory gate that holds a start while the processes' peak use leaves no room, and the stops an
//! undo makes before its cut. It sits over std, store, ipc, provider and session and is taken by
//! the program.

pub mod admission;
pub mod changes;
pub mod delivery;
pub mod error;
pub mod memory_gate;
pub mod provider_session;
pub(crate) mod recorder;
pub(crate) mod refusals;
pub(crate) mod run_lifecycle;
pub mod run_token_limit;
pub(crate) mod send;
pub mod service;
pub(crate) mod session_lock;
#[cfg(test)]
pub(crate) mod test_items;
pub mod undo;
