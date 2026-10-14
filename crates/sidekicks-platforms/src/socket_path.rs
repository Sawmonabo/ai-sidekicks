//! Why a path cannot name a local socket; each platform's module measures the path against its
//! socket address before any bind.

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
