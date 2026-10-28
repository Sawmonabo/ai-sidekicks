//! The pause and continue of runs as a driver reaches them: the messages waiting for a paused run,
//! as the run queue holds them, and the settle of the messages a continue kept once the provider
//! reports the run running again.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::keyed_lock::KeyHold;

use crate::driver::message_handing::MessageHanding;
use crate::driver::run_control::WaitingMessage;

/// A failure the waiting-message queue reports, kept whole.
pub type ContinuedMessagesError = Box<dyn Error + Send + Sync>;

/// The messages waiting for a paused run that its resume delivers: read once the resume is sure to
/// go, taken once the driver continued the run with them, given back when it did not, and kept
/// when the driver sent them and no answer came. Each call runs under the queue's own lock on the
/// session, which the driver's call itself never holds: the read marks the messages as the
/// resume's, so a change to them meanwhile finds them taken.
pub trait ContinuedMessages: Send + Sync {
    /// Takes the queue's own per-session lock on `session_id`, which every hand and take-back of a
    /// session's waiting messages runs under.
    fn hold_session(&self, session_id: SessionId) -> BoxFuture<'_, KeyHold<'_, SessionId>>;

    /// The messages waiting for `run_id`, in send order, each marked as the resume's to a provider
    /// that takes messages as `handing` says. Called under `hold`.
    fn read(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        handing: MessageHanding,
    ) -> BoxFuture<'_, Result<Vec<WaitingMessage>, ContinuedMessagesError>>;

    /// Marks the messages read for `run_id` as delivered with its resume. Called under `hold`.
    fn admit(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>>;

    /// Gives the messages read for `run_id` back to wait for its next turn. Called under `hold`.
    fn release(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>>;

    /// Keeps the messages read for `run_id`, which a resume sent with no answer back: no later
    /// resume reads them until the provider's own record says whether it took them, so none is
    /// sent twice. Called under `hold`.
    fn keep(&self, hold: &KeyHold<'_, SessionId>, run_id: RunId);

    /// The ids of the messages resumes of `run_id` kept, unsettled. Called under `hold`.
    fn kept(&self, hold: &KeyHold<'_, SessionId>, run_id: RunId) -> Vec<QueueItemId>;

    /// The ids of the messages resumes of `run_id` kept, unsettled, that no live provider process
    /// still holds for a turn of its own, so the provider's record of each is final. Called under
    /// `hold`.
    fn kept_unheld(&self, hold: &KeyHold<'_, SessionId>, run_id: RunId) -> Vec<QueueItemId>;

    /// Settles each of `settled` that resumes of `run_id` kept: one of `taken` delivered with the
    /// run, every other one given back to go once more under its own id. Called under `hold`.
    fn settle_kept(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        settled: &[QueueItemId],
        taken: &[QueueItemId],
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>>;

    /// Ends each of `message_ids` that resumes of `run_id` kept not delivered, the provider's
    /// record of it unreadable, so the person decides whether to send it again. Called under
    /// `hold`.
    fn fail_kept(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        message_ids: &[QueueItemId],
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>>;
}

/// The pause and continue of runs, as a driver reaches them once a continue's answer came.
pub trait RunPauses: Send + Sync {
    /// Settles as taken every message a continue of `run_id` kept, once the provider reports the
    /// run running again, which shows it took the continue they went with. Fails as the queue's
    /// admission of them fails.
    fn settle_kept_as_taken<'pauses>(
        &'pauses self,
        session_id: SessionId,
        run_id: RunId,
        continued: &'pauses dyn ContinuedMessages,
    ) -> BoxFuture<'pauses, Result<(), Box<dyn Error + Send + Sync>>>;
}
