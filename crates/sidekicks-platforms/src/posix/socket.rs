//! The local socket on macOS and Linux: the connection to it, its listener, its path's check and
//! the link a service's advertised socket path is.

pub(crate) mod connection;
pub(crate) mod link;
pub(crate) mod listener;
pub(crate) mod path;
