//! An undo as one order run in one place, whichever control asks for it: the session held, a
//! pause or resume of the lead already under way waited out, what started after the point stopped
//! and its held calls settled, the lead's turn ended, the files' after-captures taken, the
//! conversation cut with the caller's companions, the files put back, and the hold let go on every
//! exit, each outcome read into what the undo reports.

use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::{
    SessionRestoreFailure, SessionRestoreFailures, SessionRestoreFileOutcome,
    SessionRestoreOutcome, SessionRestoreResend, SessionRestoreScope, SessionRestoreStops,
    SessionRestoreTarget, SessionRestoredScope,
};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_session::checkpoints::resends::{stage_resend_statement, unstage_resend_statement};
use sidekicks_session::interventions::service::{InterventionError, InterventionService};
use sidekicks_session::queue_store::{CurrentLeadRun, QueueItemReader};
use sidekicks_session::run::engine::undo::RollbackCompanions;
use sidekicks_store::database::connection::read_pool::ReadLength;
use tokio::time::timeout;

use super::{ConversationCut, ConversationCutError, UndoHold};
use crate::error::QueueError;
use crate::provider_session::errors::ProviderSessionError;
use crate::service::RunQueue;
use crate::undo::{UndoStopError, UndoStops};

/// How long an undo waits out a pause or a resume of the session's lead already under way.
pub const UNDO_PAUSE_WAIT_BOUND: Duration = Duration::from_secs(60);

/// The files leg of an undo, which the caller that puts files back supplies for the one undo.
pub trait UndoFiles: Send + Sync {
    /// Takes the after-captures the put-back keeps, once everything after the point has stopped
    /// and the lead's turn has ended. Fails with the reason the files stay as they are.
    fn capture_after(&self) -> BoxFuture<'_, Result<(), SessionRestoreFailure>>;

    /// Puts the files back to the undo's point.
    fn put_back(&self) -> BoxFuture<'_, FilesPutBack>;
}

/// What the put-back of an undo's files did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FilesPutBack {
    /// Every file went back, or was skipped with its reason.
    Restored(SessionRestoreFileOutcome),
    /// Some files went back and the rest failed, with the daemon's reason for those.
    Partial {
        /// What went back.
        outcome: SessionRestoreFileOutcome,
        /// Why the rest did not.
        failure: SessionRestoreFailure,
    },
    /// No file went back.
    Failed(SessionRestoreFailure),
}

/// One undo, as every caller asks for it.
pub struct UndoRequest<'files> {
    /// The session undone.
    pub session_id: SessionId,
    /// The point it goes back to: before one of the person's messages, or a snapshot.
    pub target: SessionRestoreTarget,
    /// What it puts back.
    pub scope: SessionRestoreScope,
    /// The undo's key, unique within the session.
    pub undo_key: ClientUuid,
    /// The device a resend is sent from.
    pub device_id: DeviceId,
    /// The commands and agents the person agreed the undo stops; `None` for a caller that asks
    /// no one and stops whatever runs after the point.
    pub consented_stops: Option<SessionRestoreStops>,
    /// Committed in the conversation cut's write, as recovery's resolution is; dropped when the
    /// conversation is not in scope.
    pub companions: RollbackCompanions,
    /// The edited message an edit and resend sends once the conversation is cut.
    pub resend: Option<SessionRestoreResend>,
    /// The files leg; present whenever the scope holds the files.
    pub files: Option<&'files dyn UndoFiles>,
}

/// Why an undo moved nothing it reports: the session's hold is let go before this answers.
#[derive(Debug, thiserror::Error)]
pub enum UndoError {
    /// The point names no checkpoint of the session, or a message cursor naming no place, or its
    /// message was not sent through the queue.
    #[error("the undo's point could not be read")]
    Point(#[source] Box<ConversationCutError>),
    /// A later undo cut the conversation back past the point (`session.checkpoint.superseded`).
    #[error("the undo's point lies in history a later undo cut away")]
    Superseded,
    /// The session's lead run could not be read.
    #[error("the session's lead run could not be read")]
    Lead(#[source] Box<QueueError>),
    /// A pause or resume of the lead under way did not end within [`UNDO_PAUSE_WAIT_BOUND`].
    #[error("the pause of run {run_id} did not settle in time for the undo")]
    PauseNotSettled {
        /// The lead run.
        run_id: RunId,
    },
    /// The session's process could not be opened, or the cut turns' held calls not settled.
    #[error(transparent)]
    Session(Box<ProviderSessionError>),
    /// What started after the point was not all stopped.
    #[error(transparent)]
    Stops(Box<UndoStopError>),
    /// The undo's interrupt did not end the lead's turn.
    #[error("the undo's interrupt did not end the lead's turn")]
    Interrupt(#[source] Box<InterventionError>),
    /// The edited message could not be kept before the cut.
    #[error("the undo's edited message could not be kept")]
    Stage(#[source] Box<QueueError>),
}

/// Runs every undo in its one order, over the run queue, the interventions and the undo's stops.
pub struct UndoService {
    queue: Arc<RunQueue>,
    interventions: Arc<InterventionService>,
    stops: UndoStops,
}

impl UndoService {
    /// The service over `queue`, interrupting the lead through `interventions` and stopping what
    /// started after the point through `stops`.
    pub fn new(
        queue: Arc<RunQueue>,
        interventions: Arc<InterventionService>,
        stops: UndoStops,
    ) -> Self {
        Self {
            queue,
            interventions,
            stops,
        }
    }

    /// Undoes as `request` asks, in order: holds the session; waits out a pause or resume of a
    /// pausing lead, at most [`UNDO_PAUSE_WAIT_BOUND`], a paused lead resting as it is; with the
    /// conversation in scope, opens the session's process where none is; stops every command and
    /// agent started after the point and waits for their ends, answering
    /// [`SessionRestoreOutcome::StopsChanged`] with nothing moved when more runs than the person
    /// agreed to stop; settles the cut turns' open held calls `stopped`; ends a starting, running
    /// or waiting lead's turn by the undo's own interrupt, its waiting messages kept waiting; takes
    /// the files' after-captures; keeps the edited message for a restart, then cuts the
    /// conversation with the companions; puts the files back; and lets go the hold, sending the
    /// resend once the cut applied. Each part that did not go back is named in the report, a
    /// failed resend as [`SessionRestoreOutcome::ResendUnapplied`]. Fails as [`UndoError`] says,
    /// the hold let go first.
    pub async fn undo(&self, request: UndoRequest<'_>) -> Result<SessionRestoreOutcome, UndoError> {
        run_undo(self, request).await
    }
}

// Where an undo goes back to, as its steps read it.
struct UndoPoint {
    // The sequence of the event the undo goes back to; what started after it is stopped.
    after_sequence: i64,
    // What a resend of the edited message sends, built over what the undo takes back.
    resend: Option<SessionRestoreResend>,
}

// The steps an undo runs, in the order `run_undo` gives them.
trait UndoSteps: Sync {
    // The session's hold for the undo.
    type Hold: Send + Sync;

    fn hold(&self, session_id: SessionId, undo_key: ClientUuid) -> BoxFuture<'_, Self::Hold>;

    fn read_point(
        &self,
        session_id: SessionId,
        target: SessionRestoreTarget,
        scope: SessionRestoreScope,
        edited: Option<SessionRestoreResend>,
    ) -> BoxFuture<'_, Result<UndoPoint, ConversationCutError>>;

    fn read_lead(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<CurrentLeadRun>, QueueError>>;

    fn wait_out_pause(&self, run_id: RunId) -> BoxFuture<'_, ()>;

    fn is_live(&self, session_id: SessionId) -> bool;

    fn make_live(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ProviderSessionError>>;

    fn stop(
        &self,
        session_id: SessionId,
        after_sequence: i64,
        consented: Option<SessionRestoreStops>,
    ) -> BoxFuture<'_, Result<(), UndoStopError>>;

    fn settle_held_calls(
        &self,
        session_id: SessionId,
        after_sequence: i64,
    ) -> BoxFuture<'_, Result<(), ProviderSessionError>>;

    fn interrupt(
        &self,
        run_id: RunId,
        undo_key: ClientUuid,
    ) -> BoxFuture<'_, Result<(), InterventionError>>;

    fn stage_resend(
        &self,
        session_id: SessionId,
        undo_key: ClientUuid,
        resend: SessionRestoreResend,
    ) -> BoxFuture<'_, Result<(), QueueError>>;

    fn cut<'a>(
        &'a self,
        hold: &'a Self::Hold,
        target: SessionRestoreTarget,
        companions: RollbackCompanions,
    ) -> BoxFuture<'a, Result<ConversationCut, ConversationCutError>>;

    fn release(
        &self,
        hold: Self::Hold,
        resend: Option<SessionRestoreResend>,
        device_id: DeviceId,
    ) -> BoxFuture<'_, Result<(), QueueError>>;

    fn unstage_resend(
        &self,
        session_id: SessionId,
        undo_key: ClientUuid,
    ) -> BoxFuture<'_, Result<(), QueueError>>;
}

impl UndoSteps for UndoService {
    type Hold = UndoHold;

    fn hold(&self, session_id: SessionId, undo_key: ClientUuid) -> BoxFuture<'_, UndoHold> {
        self.queue.hold_for_undo(session_id, undo_key).boxed()
    }

    fn read_point(
        &self,
        session_id: SessionId,
        target: SessionRestoreTarget,
        scope: SessionRestoreScope,
        edited: Option<SessionRestoreResend>,
    ) -> BoxFuture<'_, Result<UndoPoint, ConversationCutError>> {
        async move {
            let reach = self
                .queue
                .read_undo_reach(session_id, &target, scope)
                .await?;
            Ok(UndoPoint {
                after_sequence: i64::from(reach.checkpoint.message_sequence),
                resend: edited.map(|edited| reach.resend_with(edited)),
            })
        }
        .boxed()
    }

    fn read_lead(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<CurrentLeadRun>, QueueError>> {
        self.queue
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(
                    QueueItemReader::new(reader).read_current_lead_run(&session_id)?,
                )
            })
            .boxed()
    }

    fn wait_out_pause(&self, run_id: RunId) -> BoxFuture<'_, ()> {
        self.queue.pauses.wait_out_calls(run_id).boxed()
    }

    fn is_live(&self, session_id: SessionId) -> bool {
        self.queue.provider_sessions.is_opened(session_id)
    }

    fn make_live(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ProviderSessionError>> {
        self.queue
            .provider_sessions
            .open(session_id, run_id)
            .boxed()
    }

    fn stop(
        &self,
        session_id: SessionId,
        after_sequence: i64,
        consented: Option<SessionRestoreStops>,
    ) -> BoxFuture<'_, Result<(), UndoStopError>> {
        async move {
            self.stops
                .stop_started_after(session_id, after_sequence, consented.as_ref())
                .await?;
            Ok(())
        }
        .boxed()
    }

    fn settle_held_calls(
        &self,
        session_id: SessionId,
        after_sequence: i64,
    ) -> BoxFuture<'_, Result<(), ProviderSessionError>> {
        self.queue
            .provider_sessions
            .settle_cut_held_tool_calls(session_id, after_sequence)
            .boxed()
    }

    fn interrupt(
        &self,
        run_id: RunId,
        undo_key: ClientUuid,
    ) -> BoxFuture<'_, Result<(), InterventionError>> {
        self.interventions
            .interrupt_for_undo(run_id, undo_key)
            .boxed()
    }

    fn stage_resend(
        &self,
        session_id: SessionId,
        undo_key: ClientUuid,
        resend: SessionRestoreResend,
    ) -> BoxFuture<'_, Result<(), QueueError>> {
        async move {
            self.queue
                .writer
                .write(vec![stage_resend_statement(session_id, &undo_key, &resend)])
                .await?;
            Ok(())
        }
        .boxed()
    }

    fn cut<'a>(
        &'a self,
        hold: &'a UndoHold,
        target: SessionRestoreTarget,
        companions: RollbackCompanions,
    ) -> BoxFuture<'a, Result<ConversationCut, ConversationCutError>> {
        async move { self.queue.cut_conversation(hold, &target, companions).await }.boxed()
    }

    fn release(
        &self,
        hold: UndoHold,
        resend: Option<SessionRestoreResend>,
        device_id: DeviceId,
    ) -> BoxFuture<'_, Result<(), QueueError>> {
        self.queue
            .release_undo_hold(hold, resend, device_id)
            .boxed()
    }

    fn unstage_resend(
        &self,
        session_id: SessionId,
        undo_key: ClientUuid,
    ) -> BoxFuture<'_, Result<(), QueueError>> {
        async move {
            self.queue
                .writer
                .write(vec![unstage_resend_statement(session_id, &undo_key)])
                .await?;
            Ok(())
        }
        .boxed()
    }
}

// What the held part of an undo came to: its report, and the resend its release sends.
struct HeldUndo {
    outcome: SessionRestoreOutcome,
    resend: Option<SessionRestoreResend>,
}

// Runs `request` through `steps` as `UndoService::undo` says.
async fn run_undo<Steps: UndoSteps>(
    steps: &Steps,
    request: UndoRequest<'_>,
) -> Result<SessionRestoreOutcome, UndoError> {
    let session_id = request.session_id;
    let undo_key = request.undo_key.clone();
    let device_id = request.device_id.clone();
    let is_resend_kept = request.resend.is_some();
    let hold = steps.hold(session_id, undo_key.clone()).await;
    let held = run_held(steps, &hold, request).await;
    let resend = match &held {
        Ok(held) => held.resend.clone(),
        Err(_) => None,
    };
    let is_resent = resend.is_some();
    let released = steps.release(hold, resend, device_id).await;
    if is_resend_kept && let Err(error) = steps.unstage_resend(session_id, undo_key).await {
        // A kept resend left behind goes back into the draft at the next start.
        tracing::error!(
            session_id = %session_id,
            error = &error as &(dyn std::error::Error + 'static),
            "the undo's kept edited message was not dropped"
        );
    }
    let outcome = held?.outcome;
    match released {
        Ok(()) => Ok(outcome),
        Err(error) if is_resent => Ok(SessionRestoreOutcome::ResendUnapplied {
            reason: reason_of(&error),
        }),
        Err(error) => {
            // The hold is let go whatever the release answers; what failed is the opening of the
            // lead's next turn, which the session's next send opens.
            tracing::error!(
                session_id = %session_id,
                error = &error as &(dyn std::error::Error + 'static),
                "opening the lead's next turn after an undo failed"
            );
            Ok(outcome)
        }
    }
}

// The undo's steps under its `hold`, up to the release.
async fn run_held<Steps: UndoSteps>(
    steps: &Steps,
    hold: &Steps::Hold,
    request: UndoRequest<'_>,
) -> Result<HeldUndo, UndoError> {
    let UndoRequest {
        session_id,
        target,
        scope,
        undo_key,
        device_id: _,
        consented_stops,
        companions,
        resend,
        files,
    } = request;
    let has_conversation = scope != SessionRestoreScope::Files;
    let has_files = scope != SessionRestoreScope::Conversation;
    let point = steps
        .read_point(session_id, target.clone(), scope, resend)
        .await
        .map_err(|error| {
            if matches!(error, ConversationCutError::Superseded) {
                UndoError::Superseded
            } else {
                UndoError::Point(Box::new(error))
            }
        })?;
    let mut lead = steps
        .read_lead(session_id)
        .await
        .map_err(|error| UndoError::Lead(Box::new(error)))?;
    if let Some(pausing) = lead
        .as_ref()
        .filter(|lead| lead.state == RunState::Pausing)
        .map(|lead| lead.run_id)
    {
        if timeout(UNDO_PAUSE_WAIT_BOUND, steps.wait_out_pause(pausing))
            .await
            .is_err()
        {
            return Err(UndoError::PauseNotSettled { run_id: pausing });
        }
        lead = steps
            .read_lead(session_id)
            .await
            .map_err(|error| UndoError::Lead(Box::new(error)))?;
    }
    // The cut and the held calls' settle reach the provider through the session's live process.
    if has_conversation
        && let Some(lead) = &lead
        && !steps.is_live(session_id)
    {
        steps
            .make_live(session_id, lead.run_id)
            .await
            .map_err(|error| UndoError::Session(Box::new(error)))?;
    }
    match steps
        .stop(session_id, point.after_sequence, consented_stops)
        .await
    {
        Ok(()) => {}
        Err(UndoStopError::Grew { stops }) => {
            return Ok(HeldUndo {
                outcome: SessionRestoreOutcome::StopsChanged { stops },
                resend: None,
            });
        }
        Err(error) => return Err(UndoError::Stops(Box::new(error))),
    }
    if steps.is_live(session_id) {
        steps
            .settle_held_calls(session_id, point.after_sequence)
            .await
            .map_err(|error| UndoError::Session(Box::new(error)))?;
    }
    // A paused, queued, interrupted or ended lead has no turn to end.
    if let Some(lead) = lead
        && matches!(
            lead.state,
            RunState::Starting
                | RunState::Running
                | RunState::WaitingForApproval
                | RunState::WaitingForInput
        )
    {
        steps
            .interrupt(lead.run_id, undo_key.clone())
            .await
            .map_err(|error| UndoError::Interrupt(Box::new(error)))?;
    }
    let captured = if has_files {
        let files = files.expect("a scope with the files carries their leg");
        Some((files, files.capture_after().await))
    } else {
        None
    };
    let mut conversation = None;
    let mut resend = None;
    if has_conversation {
        if let Some(kept) = &point.resend {
            steps
                .stage_resend(session_id, undo_key, kept.clone())
                .await
                .map_err(|error| UndoError::Stage(Box::new(error)))?;
        }
        conversation = Some(match steps.cut(hold, target, companions).await {
            Ok(ConversationCut::Applied { .. }) => {
                resend = point.resend;
                Ok(())
            }
            Ok(ConversationCut::Degraded { fallback_action }) => Err(SessionRestoreFailure {
                reason: fallback_action
                    .and_then(NonEmptyText::new)
                    .unwrap_or_else(|| {
                        NonEmptyText::new(
                            "the provider took a fallback instead of cutting the conversation"
                                .to_owned(),
                        )
                        .expect("a fixed reason has words")
                    }),
            }),
            Err(ConversationCutError::Superseded) => return Err(UndoError::Superseded),
            Err(error) => Err(SessionRestoreFailure {
                reason: reason_of(&error),
            }),
        });
    }
    let put_back = match captured {
        Some((files, Ok(()))) => Some(files.put_back().await),
        Some((_, Err(failure))) => Some(FilesPutBack::Failed(failure)),
        None => None,
    };
    Ok(HeldUndo {
        outcome: restore_outcome(scope, conversation, put_back),
        resend,
    })
}

// What an undo of `requested` reports, the conversation's cut and the files' put-back as they
// went, each `None` when not in scope: what went back, the files' figures exactly when they went
// back, and the daemon's reason for each part that failed.
fn restore_outcome(
    requested: SessionRestoreScope,
    conversation: Option<Result<(), SessionRestoreFailure>>,
    files: Option<FilesPutBack>,
) -> SessionRestoreOutcome {
    let (is_conversation_back, conversation_failure) = match conversation {
        Some(Ok(())) => (true, None),
        Some(Err(failure)) => (false, Some(failure)),
        None => (false, None),
    };
    let (files, files_failure) = match files {
        Some(FilesPutBack::Restored(outcome)) => (Some(outcome), None),
        Some(FilesPutBack::Partial { outcome, failure }) => (Some(outcome), Some(failure)),
        Some(FilesPutBack::Failed(failure)) => (None, Some(failure)),
        None => (None, None),
    };
    let restored = match (is_conversation_back, files.is_some()) {
        (true, true) => SessionRestoredScope::ConversationAndFiles,
        (true, false) => SessionRestoredScope::Conversation,
        (false, true) => SessionRestoredScope::Files,
        (false, false) => SessionRestoredScope::Nothing,
    };
    let failures = (conversation_failure.is_some() || files_failure.is_some()).then_some(
        SessionRestoreFailures {
            conversation: conversation_failure,
            files: files_failure,
        },
    );
    SessionRestoreOutcome::RestoreFinished {
        requested,
        restored,
        files,
        failures,
    }
}

// The daemon's reason for a part that did not go back, in the error's own words.
fn reason_of(error: &dyn std::error::Error) -> NonEmptyText {
    NonEmptyText::new(error.to_string()).expect("every error the undo meets says why in words")
}

#[cfg(test)]
mod tests;
