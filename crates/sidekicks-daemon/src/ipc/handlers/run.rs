//! Run methods served on the socket: a person's controls on a run, the run queue's sends and
//! changes with its stream, the stream of every run's state in a session, the live intake of the
//! provider's safety holds it carries, and a person's controls on a session's helpers: one
//! helper's interrupt and its pause or continue, and the stop of every agent the session
//! dispatched, which sweeps its tree.

pub(crate) mod child;
pub(crate) mod control;
pub(crate) mod queue;
pub(crate) mod safety_holds;
pub(crate) mod state;
