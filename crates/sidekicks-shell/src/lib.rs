//! The terminal service: one session's shells, their table and records, how each starts, their
//! list, refusals, pastes, the screen copy's answers and output stream, the shell's own marks, the
//! sizes and writes on their way to the terminal, the control lease, output flow, the input a shell
//! is looked up by, and the orphans a crash leaves. It sits over std, ipc, workspace and provider
//! and is taken by the program.

pub mod console;
pub mod control_lease;
pub(crate) mod flow_control;
pub mod input_lookup;
pub(crate) mod integration;
pub(crate) mod list;
pub mod mode;
pub mod orphan;
pub(crate) mod output;
pub mod paste;
pub(crate) mod record;
pub mod refusals;
pub(crate) mod resize;
pub(crate) mod start;
pub mod table;
#[cfg(any(test, feature = "test-support"))]
pub mod test_table;
pub mod write;
