//! Recovery: the start's checks, the sweep of new accounts' homes a stop left, the settling of
//! runs a stop left live, damaged history, the gate that holds writes to state the daemon cannot
//! yet trust, projection rebuilds, the recovery status and the database file's repair, with the
//! finalize of the runs a resume found. It sits over std, store, ipc, provider, session, approval,
//! queue and artifact and is taken by the program.

pub mod account_homes;
pub mod damaged_history;
pub mod database_file;
pub mod projection_rebuild;
pub mod restart_settle;
pub mod resumed_runs;
pub mod session_write_refusal;
pub mod startup;
pub mod status;
pub mod stop_intent;
#[cfg(test)]
pub(crate) mod test_pass;
pub mod write_gate;
