//! When a session's own switch of its tool servers reaches the provider, as its driver answers a
//! switch.

/// When a switch of a session's tool servers reaches the provider; the stored set holds the switch
/// in every case.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpSessionSwitch {
    /// The live conversation runs with the switched set now.
    Applied,
    /// The live conversation takes the switched set before its next turn.
    AtNextTurn,
    /// The session has no live conversation; its next start or resume takes the switched set.
    AtNextStart,
}
