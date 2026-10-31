//! The shell commands an agent runs: the sealed channel a command's wrapper and its askpass reach
//! the daemon through, those two program modes, the running set each session keeps, and the checks
//! that read whether a command waits for input.

pub mod askpass;
pub mod channel;
pub mod running_set;
pub mod waiting_checks;
pub mod wrapper;
