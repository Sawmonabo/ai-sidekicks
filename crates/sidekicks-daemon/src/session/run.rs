//! A session's runs: their ids, reads, `runs` rows, state transitions and their writes, refusals,
//! the gates a start passes, the daemon's own turns and how a restart settles a live run.

pub(crate) mod agent;
pub(crate) mod daemon_turn;
pub(crate) mod ids;
pub(crate) mod projection;
pub(crate) mod read;
pub(crate) mod refusals;
pub(crate) mod restart;
pub(crate) mod setup_gates;
pub(crate) mod start_request;
pub(crate) mod state_change;
pub(crate) mod stored_state_change;
pub(crate) mod superseded;
pub(crate) mod transitions;
