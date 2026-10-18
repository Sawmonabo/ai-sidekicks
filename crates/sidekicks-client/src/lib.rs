//! The typed daemon client: the command line's, and the desktop's through its Node-API addon in a
//! helper process.

pub mod daemon_connection;
pub mod error;
pub mod terminal_write;
pub mod transport;
pub mod untyped_call;
