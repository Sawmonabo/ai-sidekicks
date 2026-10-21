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
    /// Marked to go ahead of what the provider holds: handed now where the run takes it, else
    /// first in the queue and handed first at the run's next hand.
    Sent {
        /// The id the message's mark records, which the answer carries.
        intervention_id: InterventionId,
    },
    /// The run moved past the version the person decided against; nothing was handed.
    Expired,
    /// The message has left the queue, or its provider did not give it back; nothing was handed.
    Refused(DomainError),
}

/// The run queue as an interrupt uses it.
pub(crate) trait InterruptQueue: Send + Sync {
    /// Hands `send.item_id` to its run ahead of what the provider holds, with every waiting row
    /// taken back first and handed again after it, the request's key recorded on the message; a
    /// run that takes no message now keeps it first in the queue, marked, for its next hand. No
    /// interrupt is made. A message a `Send now` marked before, under any key, keeps that mark and
    /// answers its id, handed again first only when its provider no longer holds it. Fails as the
    /// queue's read, write or hand fails, every row taken back handed again first.
    fn send_now(&self, send: SendNow)
    -> BoxFuture<'_, Result<SendNowOutcome, InterruptQueueError>>;

    /// Whether `deliver_first` names a message waiting for `run_id` that is not already first
    /// among the ones the provider does not hold, so applying the choice changes their order.
    /// Fails as the queue's read fails.
    fn reorders_waiting(
        &self,
        run_id: RunId,
        deliver_first: Option<QueueItemId>,
    ) -> BoxFuture<'_, Result<bool, InterruptQueueError>>;

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
    /// applies `choice` to the messages of a run that ended first and hands the rest again. Takes
    /// the session's queue itself, so it is never called under it. A second release of one
    /// interrupt changes nothing. Fails as the read, the choice's writes or the hand fail, the
    /// choice then recorded on the interrupt's row for the queue's next hold of the session, or
    /// its next start, to settle again.
    fn release_interrupt(
        &self,
        run_id: RunId,
        intervention_id: InterventionId,
        choice: InterruptChoice,
    ) -> BoxFuture<'_, Result<(), InterruptQueueError>>;

    /// [`InterruptQueue::release_interrupt`] for a run's end, which may be written under the
    /// session's queue: answers once the run is read, and the release runs once the queue is free.
    /// A release that fails then is recorded as [`InterruptQueue::release_interrupt`]'s is. Fails
    /// when the run cannot be read.
    fn release_interrupt_at_run_end(
        &self,
        run_id: RunId,
        intervention_id: InterventionId,
        choice: InterruptChoice,
    ) -> BoxFuture<'_, Result<(), InterruptQueueError>>;
}
