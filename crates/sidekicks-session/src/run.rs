//! A session's runs: their ids, reads, `runs` rows, state transitions and their writes, the count
//! of live runs, each run's live binding and the session's stored leg, the folders other sessions'
//! runs are live in, refusals, the run engine and the seam its limit stops go through, which
//! execution each provider delivery belongs to, the daemon's own turns, pause and resume, the
//! provider's choices, and how a restart settles a live run.

pub mod agent;
pub mod binding_cursors;
pub(crate) mod daemon_turn;
pub mod engine;
pub mod epochs;
pub mod folders;
pub mod ids;
pub mod inbound;
pub(crate) mod limit_interrupter;
pub mod live_bindings;
pub mod live_count;
pub mod pause;
pub mod projection;
pub mod provider_choice;
pub mod read;
pub mod refusals;
pub(crate) mod restart;
pub(crate) mod schema;
pub mod start_request;
pub mod state_change;
pub mod stored_leg;
pub mod stored_state_change;
pub mod superseded;
pub mod transitions;
