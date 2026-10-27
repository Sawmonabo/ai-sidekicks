//! The helper modes the daemon starts its own program in, each a child process the daemon waits
//! on: the daemon's side, which starts the child armed to end with it, stops it by closing its
//! standard input and keeps its error output's tail, and the mode's side, which ends as soon as
//! that input does.

pub mod child;
pub mod error_output;
pub mod input_watch;
