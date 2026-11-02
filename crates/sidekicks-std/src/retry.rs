//! Trying a step again after a failure another moment can clear: the one read retry, the schedule
//! of waits between a step's tries, and the random spread that keeps two waiters from trying at
//! once.

pub mod jitter;
pub mod read;
pub mod waits;
