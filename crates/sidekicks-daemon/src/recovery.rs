//! Recovery: the start's checks, damaged history, the gate that holds writes to state the daemon
//! cannot yet trust, projection rebuilds and the database file's repair.

pub(crate) mod damaged_history;
pub mod database_file;
pub(crate) mod projection_rebuild;
pub(crate) mod restart_settle;
pub(crate) mod session_write_refusal;
pub(crate) mod startup;
pub(crate) mod status;
#[cfg(test)]
pub(crate) mod test_pass;
pub(crate) mod write_gate;
