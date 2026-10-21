//! One session's shells: their table and records, how each starts, their list, refusals, pastes,
//! the screen copy's answers and output stream, the shell's own marks, and the sizes and writes on
//! their way to the terminal.

pub(crate) mod integration;
pub(crate) mod list;
pub(crate) mod mode;
pub(crate) mod output;
pub(crate) mod paste;
pub(crate) mod record;
pub(crate) mod refusals;
pub(crate) mod resize;
pub(crate) mod start;
pub(crate) mod table;
#[cfg(test)]
pub(crate) mod test_table;
pub(crate) mod write;
