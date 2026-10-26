//! The shell commands an agent runs: the sealed channel a command's wrapper and its askpass reach
//! the daemon through, those two program modes, the running set each session keeps, and the checks
//! that read whether a command waits for input.

pub(crate) mod askpass;
pub(crate) mod channel;
pub(crate) mod running_set;
pub(crate) mod waiting_checks;
pub(crate) mod wrapper;
