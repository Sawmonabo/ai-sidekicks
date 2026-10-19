//! The local socket on Windows: the connection to the daemon's named pipe, the listener, the
//! socket path's check, and the connection to an `AF_UNIX` socket a provider's service listens on.

pub(crate) mod connection;
pub(crate) mod listener;
pub(crate) mod path;
pub(crate) mod unix_domain;
