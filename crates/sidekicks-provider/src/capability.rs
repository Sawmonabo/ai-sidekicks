//! A provider's capabilities read live: the zero-turn probe of which flags its build carries, and
//! the refresh that reads every driver again on each trigger.

pub(crate) mod probe;
pub mod refresh;
