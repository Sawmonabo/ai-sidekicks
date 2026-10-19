//! How a provider takes a message sent while its run's turn runs, which each driver declares and
//! the run queue reads to hand, withdraw and keep waiting messages.

/// How a provider takes a message sent while its run's turn runs; each fact drives one path of
/// the run queue on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MessageHanding {
    /// When the queue hands a waiting message to the running turn.
    pub(crate) hands_at: HandMoment,
    /// Whether a handed message the provider has not read can be withdrawn ahead of a change.
    pub(crate) can_withdraw: bool,
    /// Whether the provider's process keeps a handed message past its run's end, for a turn it
    /// starts with it.
    pub(crate) kept_by_process: bool,
}

/// When the run queue hands a waiting message to a running turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "each driver's answer to how its provider takes a message"
    )
)]
pub(crate) enum HandMoment {
    /// At once, the provider holding it to its own next step.
    AtOnce,
    /// At the turn's next tool boundary, the daemon holding it until then.
    AtToolBoundary,
}
