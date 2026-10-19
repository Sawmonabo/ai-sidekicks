//! The local socket on Windows: the connection to the daemon's named pipe, the listener and the
//! socket path's check.

pub(crate) mod connection;
pub(crate) mod listener;
pub(crate) mod path;
