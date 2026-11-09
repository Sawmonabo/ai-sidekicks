//! The workflow engine: the ports through which it reaches the services above this crate, which the
//! program implements and hands it, a run's start, a person's Cancel and Resume, the tick that
//! walks, admits, dispatches and commits a run's steps, the waits of steps waiting on a person, a
//! chain's question and its Keep going, the deadline clock over its waits, the results a finished
//! run posts, a partial run's plan, and the record of its own decisions.

pub(crate) mod chain;
pub(crate) mod controls;
pub(crate) mod deadlines;
pub(crate) mod event_record;
pub(crate) mod partial_run;
pub mod ports;
pub(crate) mod results;
pub(crate) mod start;
pub(crate) mod tick;
pub mod waits;
