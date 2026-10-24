//! What a local socket's connect, bind and path check share on every system: what a failed connect
//! says, what a bind does with a socket file already at its path, and why a path cannot name a
//! socket.

pub(crate) mod connection;
pub(crate) mod listener;
pub(crate) mod path;
