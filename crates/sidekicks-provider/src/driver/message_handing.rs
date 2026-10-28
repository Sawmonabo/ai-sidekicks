//! How a provider takes a message sent while its run's turn runs, which each driver declares and
//! the run queue reads to hand, withdraw and keep waiting messages.

/// How a provider takes a message sent while its run's turn runs; each fact drives one path of
/// the run queue on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MessageHanding {
    /// When the queue hands a waiting message to the running turn.
    pub hands_at: HandMoment,
    /// Whether a handed message the provider has not read can be withdrawn ahead of a change.
    pub can_withdraw: bool,
    /// Whether the provider's process keeps a handed message past its run's end, for a turn it
    /// starts with it.
    pub kept_by_process: bool,
    /// Whether the provider reads a message marked priority ahead of what it holds, at its turn's
    /// next step, so a person's `Send now` needs no interrupt.
    pub reads_priority_message: bool,
}

/// When the run queue hands a waiting message to a running turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandMoment {
    /// At once, the provider holding it to its own next step.
    AtOnce,
    /// At the turn's next tool boundary, the daemon holding it until then.
    AtToolBoundary,
}
