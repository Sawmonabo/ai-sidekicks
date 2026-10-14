//! A session's runs: their ids, reads, state transitions, refusals and the gates a start passes.

pub(crate) mod agent;
pub(crate) mod ids;
pub(crate) mod read;
pub(crate) mod refusals;
pub(crate) mod setup_gates;
pub(crate) mod start_request;
pub(crate) mod stored_state_change;
pub(crate) mod superseded;
pub(crate) mod transitions;
