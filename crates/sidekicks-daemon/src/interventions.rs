//! Interventions: what a person changes in a running turn, and the daemon's own interrupt at a
//! limit, stored and applied.

pub(crate) mod interrupt_queue;
mod limit_stop;
pub(crate) mod service;
pub(crate) mod store;
