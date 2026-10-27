//! The helper modes, each the calling program, started again in a helper mode as a child process it
//! waits on: the caller's side, which starts the child armed to end with it, stops it by closing
//! its standard input and keeps its error output's tail, and the mode's side, which ends as soon as
//! that input does.

pub mod child;
pub mod error_output;
pub mod input_watch;
