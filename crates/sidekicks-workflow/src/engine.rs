//! The workflow engine: the ports through which it reaches the services above this crate, which
//! the program implements and hands it, the tick that walks, admits, dispatches and commits a
//! run's steps, and the waits of steps waiting on a person.

pub mod ports;
pub(crate) mod tick;
pub(crate) mod waits;
