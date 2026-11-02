//! The workflow engine: the ports through which it reaches the services above this crate, which
//! the program implements and hands it, and the tick that walks, admits, dispatches and commits a
//! run's steps.

pub mod ports;
pub(crate) mod tick;
