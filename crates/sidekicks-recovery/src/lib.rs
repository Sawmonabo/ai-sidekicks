//! Recovery: the start's checks, the settling of runs a stop left live, damaged history, the gate
//! that holds writes to state the daemon cannot yet trust, projection rebuilds, the recovery status
//! and the database file's repair. It sits over std, store, ipc, provider, session, approval and
//! artifact and is taken by the program.

pub mod damaged_history;
pub mod database_file;
pub mod projection_rebuild;
pub mod restart_settle;
pub mod session_write_refusal;
pub mod startup;
pub mod status;
#[cfg(test)]
pub(crate) mod test_pass;
pub mod write_gate;
