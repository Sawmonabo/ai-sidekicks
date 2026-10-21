//! What an interrupt asks of the run queue: to hold its hands to the run while a person's interrupt
//! settles, to end the run with what the interrupt makes of the messages waiting for it, and, for
//! `Send now` on a provider that reads a priority message, to hand the message first instead.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{InterventionId, RunLimit};
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::ipc::domain_error::DomainError;
use crate::provider::driver::run_control::InterruptPendingChoice;
use crate::session::run::state_change::RunStateChangeCompanions;

/// A failure of the run queue's part in an interrupt, kept whole.
pub(crate) type InterruptQueueError = Box<dyn Error + Send + Sync>;

/// A person's choice for the messages waiting for the run they interrupt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct InterruptChoice {
    /// What becomes of the waiting messages.
    pub(crate) pending: InterruptPendingChoice,
    /// The waiting message that goes first in the next turn.
    pub(crate) deliver_first: Option<QueueItemId>,
}

/// Whose interrupt ends the run, with what the run queue and the run's end need of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InterruptCause {
    /// A person's, with their choice for the waiting messages.
    Person(InterruptChoice),
    /// The daemon's own at a limit, which leaves the waiting messages waiting.
    Limit {
        /// The limit the run reached.
        limit: RunLimit,
        /// The turn the stop cut, which the run's end ends with the limit's cause.
        cut_turn: Option<SafeInt<1>>,
    },
}

/// An interrupt that applied, as the write that ends its run takes it.
pub(crate) struct InterruptEnd {
    /// The run interrupted.
    pub(crate) run_id: RunId,
    /// The run version the interrupt was accepted at; a run ended since keeps that end.
    pub(crate) accepted_run_version: i64,
    /// Whose interrupt it is.
    pub(crate) cause: InterruptCause,
    /// The waiting messages the provider gave back with the interrupt, which none of it runs; a
    /// handed message not among them stays with the provider.
    pub(crate) cancelled: Vec<QueueItemId>,
    /// The interrupt's row move and its event, which the run's end commits.
    pub(crate) verdict: RunStateChangeCompanions,
}

/// A person's `Send now` of a waiting message, on a run whose provider reads a priority message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SendNow {
    /// The run the message waits for.
    pub(crate) run_id: RunId,
    /// The run version the person decided against.
    pub(crate) expected_run_version: SafeInt<0>,
    /// The message handed first.
    pub(crate) item_id: QueueItemId,
    /// The request's idempotency key, which the message records.
    pub(crate) key: ClientUuid,
    /// The id the answer carries, which the message records with the key.
    pub(crate) intervention_id: InterventionId,
}

/// What a `Send now` came to.
#[derive(Debug)]
pub(crate) enum SendNowOutcome {
    /// Handed ahead of what the provider held.
    Sent,
    /// The run moved past the version the person decided against; nothing was handed.
    Expired,
    /// The message has left the queue, or its provider did not give it back; nothing was handed.
    Refused(DomainError),
    /// The run takes no message now: the interrupt that puts the message first in the next turn
    /// carries the request instead.
    Interrupt,
}

/// The run queue as an interrupt uses it.
pub(crate) trait InterruptQueue: Send + Sync {
    /// Hands `send.item_id` to its run ahead of what the provider holds, with the rows ahead of it
    /// taken back first and handed again after it, the request's key recorded on the message; no
    /// interrupt is made. Fails as the queue's read or write fails.
    fn send_now(&self, send: SendNow)
    -> BoxFuture<'_, Result<SendNowOutcome, InterruptQueueError>>;

    /// Holds the queue's hands to `run_id` for the interrupt `intervention_id`, and the settling
    /// of an end of it seen meanwhile, until that interrupt's
    /// [`InterruptQueue::release_interrupt`]; the run stays held while any interrupt holds it. A
    /// run whose end already moved its waiting messages on has `choice` applied to them. Fails as
    /// the queue's read or write fails.
    fn hold_for_interrupt(
        &self,
        run_id: RunId,
        intervention_id: InterventionId,
        choice: InterruptChoice,
    ) -> BoxFuture<'_, Result<(), InterruptQueueError>>;

    /// Ends the run as `end` says in one write, with the verdict and what the interrupt makes of
    /// the waiting messages: a person's choice applied, a limit's left waiting, the end handed to
    /// the run engine with the limit and the turn it cut. Answers `false` with nothing written
    /// when the run has ended since the accept. Fails as the write fails.
    fn end_run_for_interrupt(
        &self,
        end: InterruptEnd,
    ) -> BoxFuture<'_, Result<bool, InterruptQueueError>>;

    /// Lets go the hold the interrupt `intervention_id` took, and once no interrupt holds the run,
    /// applies `choice` to the messages of a run that ended first and hands the rest again. A
    /// second release of one interrupt changes nothing. Fails as the queue's write fails.
    fn release_interrupt(
        &self,
        run_id: RunId,
        intervention_id: InterventionId,
        choice: InterruptChoice,
    ) -> BoxFuture<'_, Result<(), InterruptQueueError>>;
}
