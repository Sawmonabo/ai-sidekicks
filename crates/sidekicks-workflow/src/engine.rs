//! The workflow engine: the ports through which it reaches the services above this crate, which
//! the program implements and hands it, the tick that walks, admits, dispatches and commits a
//! run's steps, the waits of steps waiting on a person, and a chain's question and its Keep going.

pub(crate) mod chain;
pub mod ports;
pub(crate) mod tick;
pub(crate) mod waits;
