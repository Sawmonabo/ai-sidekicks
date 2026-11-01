//! The platforms crate's one integration binary.

#[cfg(unix)]
mod fork_count;
#[cfg(unix)]
mod no_fork;
#[cfg(unix)]
mod secret_pipe;
