//! A session's runs: their ids, reads, `runs` rows, state transitions and their writes, refusals,
//! the gates a start passes, the run engine and the seam its limit stops go through, which
//! execution each provider delivery belongs to, the daemon's own turns, pause and resume, the
//! provider's choices, and how a restart settles a live run.

pub(crate) mod agent;
pub(crate) mod binding_cursors;
pub(crate) mod daemon_turn;
pub(crate) mod engine;
pub(crate) mod epochs;
pub(crate) mod ids;
pub(crate) mod inbound;
pub(crate) mod limit_interrupter;
pub(crate) mod pause;
pub(crate) mod projection;
pub(crate) mod provider_choice;
pub(crate) mod read;
pub(crate) mod refusals;
pub(crate) mod restart;
pub(crate) mod setup_gates;
pub(crate) mod start_request;
pub(crate) mod state_change;
pub(crate) mod stored_state_change;
pub(crate) mod superseded;
pub(crate) mod transitions;
