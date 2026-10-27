//! Interventions: what a person changes in a running turn, and the daemon's own interrupt at a
//! limit, stored and applied.

pub mod interrupt_queue;
mod limit_stop;
pub mod service;
pub mod store;
pub mod unresolved;
