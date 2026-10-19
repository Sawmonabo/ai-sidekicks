//! Why a path cannot name a local socket, and what already stands at one; each platform's module
//! measures the path against its socket address and reads what is there before any bind.

use std::io;

/// Why a path cannot name a local socket.
#[derive(Debug, thiserror::Error)]
pub enum SocketPathRefused {
    /// The path's bytes pass the longest path a socket address holds.
    #[error("the socket path is {observed} bytes, past the {limit} a socket address holds")]
    TooLong {
        /// The longest path, in bytes, a socket address holds.
        limit: usize,
        /// The path's length in bytes.
        observed: usize,
    },
    /// The path is no socket address for another reason: it holds a NUL, or on Windows it is not
    /// UTF-8.
    #[error("the path is no socket address")]
    Invalid(#[source] io::Error),
}

/// What stands at a socket's path before a bind, read without following a link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SocketPathEntry {
    /// Nothing: the path is free.
    Absent,
    /// A socket, which a listener may still serve; a connect tells.
    Socket,
    /// A file, a folder, a link or anything else that is no socket.
    Other,
}
