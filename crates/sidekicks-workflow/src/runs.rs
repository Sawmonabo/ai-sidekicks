//! Workflow runs as their rows store them: a run with its steps, the runs list, one step's payload,
//! the runs that need someone, a new run's and a cancel's statements, a step's row moves, a gate
//! answer's row and event, deleting runs and their Keep mark, the rebuild of the run and step rows
//! from the log, the refusals of a cursor, and the check a step's action passes before it runs.

pub mod attention;
pub(crate) mod cancellation;
pub(crate) mod creation;
pub mod deletion;
pub(crate) mod gate_resolution;
pub(crate) mod invalid_cursor;
pub mod projection;
pub mod record;
pub(crate) mod spent_account;
pub mod step_action;
pub mod step_payload;
pub(crate) mod step_rows;
pub mod store;
