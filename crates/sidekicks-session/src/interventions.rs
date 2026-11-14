//! Interventions: what a person changes in a running turn, and the daemon's own interrupts, at a
//! limit and for an undo, stored and applied.

pub mod interrupt_queue;
pub(crate) mod limit_stop;
pub mod service;
pub mod store;
pub(crate) mod undo_interrupt;
pub mod unresolved;
