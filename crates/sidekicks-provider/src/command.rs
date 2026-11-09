//! The shell commands an agent runs: the sealed channel a command's wrapper and its askpass reach
//! the daemon through, those two program modes, the running set each session keeps, the checks
//! that read whether a command waits for input, and the move of a helper to the background, the
//! background act's other target.

pub mod askpass;
pub mod channel;
pub mod helper_background;
pub mod running_set;
pub mod waiting_checks;
pub mod wrapper;
