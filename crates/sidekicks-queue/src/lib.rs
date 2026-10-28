//! The run queue: sending, ordering, admitting, delivering and recording runs per session, and the
//! memory gate that holds a start while the processes' peak use leaves no room. It sits over std,
//! store, ipc, provider and session and is taken by the program.

pub mod admission;
pub mod changes;
pub mod delivery;
pub mod error;
pub mod memory_gate;
pub mod provider_session;
pub(crate) mod recorder;
pub(crate) mod refusals;
pub(crate) mod run_lifecycle;
pub(crate) mod send;
pub mod service;
pub(crate) mod session_lock;
