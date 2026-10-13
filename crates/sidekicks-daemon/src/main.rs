//! The `sidekicks-daemon` program: the daemon itself, or the helper mode its arguments or its file
//! name select.

// Set here, not in the workspace table: rustc builds every library's unit tests as a program,
// where this lint reports each `pub` item the tests leave unused.
#![warn(dead_code_pub_in_binary)]

fn main() {}
