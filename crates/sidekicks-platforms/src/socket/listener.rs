//! What a local socket listener's bind does with a socket file already at its path.

/// What a bind does with a socket file already at its path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExistingSocket {
    /// Fails with `AddrInUse`, whether a listener serves the file or a stopped one left it.
    Refuse,
    /// Deletes the file first, even under a live listener; only for a path no other listener can
    /// hold.
    Replace,
}
