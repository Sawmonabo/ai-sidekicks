//! Provider-bound text: the words the daemon hands a provider, unchanged, with who composed them.

/// Who composed a piece of provider-bound text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OutboundTextOrigin {
    /// A person typed it.
    HumanText,
    /// The daemon wrote it to tell the agent what happened, as a hand-over brief does.
    SystemNarration,
    /// A driver composed it as a command to the provider.
    DriverCommand,
}

/// Text the daemon sends a provider, as typed, with who composed it.
#[derive(Clone, Debug)]
pub(crate) struct OutboundText {
    /// The text, unchanged.
    pub(crate) text: String,
    /// Who composed it.
    pub(crate) origin: OutboundTextOrigin,
}
