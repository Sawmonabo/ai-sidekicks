//! An undo as one order run in one place, whichever control asks for it, one undo of a session at a
//! time: the session held, what its key already applied answered as applied, the files of a
//! recorded cut finished and its resend sent, a pause or resume of the lead already under way
//! waited out, the person's consent checked, a fork an earlier cut left unrecorded closed, the
//! provider asked whether its conversation already ends at the point, what started after the point
//! stopped and its held calls settled, the lead's turn ended, the files' after-captures taken, the
//! conversation cut with the caller's companions, the files put back and recorded, and the hold
//! let go on every exit, each outcome read into what the undo reports, a failure once something
//! was stopped among them.

use std::sync::Arc;
use std::time::Duration;

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
use sidekicks_session::checkpoints::restore_cuts::RecordedCut;
use sidekicks_session::checkpoints::store::Checkpoint;
use sidekicks_session::interventions::service::{InterventionError, InterventionService};
use sidekicks_session::queue_store::CurrentLeadRun;
use sidekicks_session::run::engine::undo::RollbackCompanions;
use sidekicks_std::keyed_lock::KeyedLock;
use tokio::time::timeout;

use super::{ConversationCut, ConversationCutError, ProviderCut};
use crate::error::QueueError;
use crate::provider_session::errors::ProviderSessionError;
use crate::service::RunQueue;
use crate::undo::{UndoStopError, UndoStopSet, UndoStops};

/// How long an undo waits out a pause or a resume of the session's lead already under way.
pub const UNDO_PAUSE_WAIT_BOUND: Duration = Duration::from_secs(60);

/// The files leg of an undo, which the caller that puts files back supplies for the one undo, each
/// call handed the checkpoint the files go back to: the reach's, or on a retry the one its key
/// recorded with the cut.
pub trait UndoFiles: Send + Sync {
    /// Takes the after-captures of the commands stopped after `checkpoint`, once everything after
    /// it has stopped and the lead's turn has ended. Each command's window closes once, so a
    /// retry's call never replaces a capture an earlier attempt took. Fails with the reason the
    /// files stay as they are.
    fn capture_after<'a>(
        &'a self,
        checkpoint: &'a Checkpoint,
    ) -> BoxFuture<'a, Result<(), SessionRestoreFailure>>;

    /// Puts the files back to `checkpoint`; a second call finishes what an earlier one left.
    fn put_back<'a>(&'a self, checkpoint: &'a Checkpoint) -> BoxFuture<'a, FilesPutBack>;
}

/// What an undo puts back, with the files leg wherever the files are in it.
#[derive(Clone, Copy)]
pub enum UndoScope<'files> {
    /// The conversation and the files together.
    ConversationAndFiles(&'files dyn UndoFiles),
    /// The conversation alone.
    Conversation,
    /// The files alone.
    Files(&'files dyn UndoFiles),
}

impl<'files> UndoScope<'files> {
    /// The scope as the wire names it.
    pub fn requested(&self) -> SessionRestoreScope {
        match self {
            Self::ConversationAndFiles(_) => SessionRestoreScope::ConversationAndFiles,
            Self::Conversation => SessionRestoreScope::Conversation,
            Self::Files(_) => SessionRestoreScope::Files,
        }
    }

    // The files leg, where the files are in scope.
    fn files(&self) -> Option<&'files dyn UndoFiles> {
        match self {
            Self::ConversationAndFiles(files) | Self::Files(files) => Some(*files),
            Self::Conversation => None,
        }
    }
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
    /// What it puts back, with the files leg where the files are in it.
    pub scope: UndoScope<'files>,
    /// The undo's key, unique within the session.
    pub undo_key: ClientUuid,
    /// The device a resend is sent from.
    pub device_id: DeviceId,
    /// What the person agreed the undo stops; `None` for a caller that asks no one and stops
    /// whatever runs after the point.
    pub consented_stops: Option<SessionRestoreStops>,
    /// Committed in the conversation cut's write, as recovery's resolution is; dropped when the
    /// conversation is not in scope.
    pub companions: RollbackCompanions,
    /// The edited message an edit and resend sends once the conversation is cut.
    pub resend: Option<SessionRestoreResend>,
}

/// Why an undo moved nothing and reports nothing, each a failure before anything was stopped: the
/// session's hold is let go before this answers.
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
    /// Whether the undo's key already cut the conversation could not be read.
    #[error("whether the undo already cut the conversation could not be read")]
    RecordedCut(#[source] Box<QueueError>),
    /// Whether the provider's conversation already ends at the point could not be read.
    #[error("whether the conversation already ends at the undo's point could not be read")]
    ProviderRead(#[source] Box<ConversationCutError>),
    /// The session's process could not be opened.
    #[error(transparent)]
    Session(Box<ProviderSessionError>),
    /// What started after the point could not be read.
    #[error(transparent)]
    Stops(Box<UndoStopError>),
}

/// Why an undo that already stopped something moved nothing more, which it reports as its outcome.
#[derive(Debug, thiserror::Error)]
enum UndoStepFailure {
    /// What started after the point was not all stopped.
    #[error(transparent)]
    Stops(UndoStopError),
    /// The cut turns' held calls were not settled.
    #[error(transparent)]
    HeldCalls(ProviderSessionError),
    /// The undo's interrupt did not end the lead's turn.
    #[error("the undo's interrupt did not end the lead's turn")]
    Interrupt(#[source] InterventionError),
    /// The edited message could not be kept before the cut.
    #[error("the undo's edited message could not be kept")]
    Stage(#[source] QueueError),
    /// A later undo cut the conversation back past the point while this one stopped its work.
    #[error("the undo's point lies in history a later undo cut away")]
    Superseded,
}

/// Runs every undo in its one order, over the run queue, the interventions and the undo's stops.
pub struct UndoService {
    queue: Arc<RunQueue>,
    interventions: Arc<InterventionService>,
    stops: UndoStops,
    // One undo of a session at a time, so a second one reads its point and its key after the first.
    undos: KeyedLock<SessionId>,
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
            undos: KeyedLock::new(),
        }
    }

    /// Undoes as `request` asks, in order, once every earlier undo of the session has ended: holds
    /// the session; answers the conversation applied with nothing cut again where the undo's key
    /// already recorded its cut, sending the resend recorded with it, and the files applied too
    /// where it recorded them put back, else finishes them to the checkpoint the key kept; waits
    /// out a pause or resume of the lead already under way, at most [`UNDO_PAUSE_WAIT_BOUND`], a
    /// paused lead resting as it is; answers [`SessionRestoreOutcome::StopsChanged`] with nothing
    /// moved when more runs after the point than the person agreed to stop, a live lead turn a
    /// restore of the files alone ends among it; with the conversation in scope, closes a fork an
    /// earlier cut left unrecorded and running, opens the session's process where none is and asks
    /// the provider whether its conversation already ends at the point, so a cut it already made
    /// is only recorded; stops every command and agent started after the point and waits for
    /// their ends; settles the cut turns' open held calls `stopped`; ends a starting, running or
    /// waiting lead's turn by the undo's own interrupt, its waiting messages kept waiting; takes
    /// the files' after-captures; keeps the edited message for a restart, then cuts the
    /// conversation with the companions; puts the files back and records them beside the cut; and
    /// lets go the hold, sending the resend once the cut applied, under the undo's key, so a retry
    /// sends it once. Each part that did not go back is named in the report, a step that failed
    /// once a stop ran as nothing restored with its cause, a conversation the key recorded cut
    /// still reading applied, and a resend that was not sent as
    /// [`SessionRestoreOutcome::ResendUnapplied`]. Fails as [`UndoError`] says, the hold let go
    /// first.
    pub async fn undo(&self, request: UndoRequest<'_>) -> Result<SessionRestoreOutcome, UndoError> {
        run_undo(self, &self.undos, request).await
    }
}

// Where an undo goes back to, as its steps read it once.
struct UndoPoint<Reach> {
    // The checkpoint the cut's reach stands at, which the files go back to.
    checkpoint: Checkpoint,
    // What a resend of the edited message sends, built over what the undo takes back.
    resend: Option<SessionRestoreResend>,
    // What the provider's read and the cut take, `None` for the checkpoint a recorded cut kept.
    reach: Option<Reach>,
}

impl<Reach> UndoPoint<Reach> {
    // The sequence of the event the undo goes back to; what started after it is stopped.
    fn after_sequence(&self) -> i64 {
        i64::from(self.checkpoint.message_sequence)
    }
}

// What an undo does to the conversation.
enum ConversationLeg<Reach> {
    // The cut of `reach` is asked of the provider, or recorded as one the provider already made.
    Cut {
        provider_cut: ProviderCut,
        reach: Reach,
    },
    // The undo's key recorded its cut, so the conversation is answered as applied.
    Recorded,
}

// The steps an undo runs, in the order `run_undo` gives them.
trait UndoSteps: Sync {
    // The session's hold for the undo.
    type Hold: Send + Sync;
    // What the point's read gives the provider's read and the cut.
    type Reach: Send + Sync;

    fn hold(&self, session_id: SessionId, undo_key: ClientUuid) -> BoxFuture<'_, Self::Hold>;

    fn read_recorded_cut(
        &self,
        session_id: SessionId,
        undo_key: ClientUuid,
    ) -> BoxFuture<'_, Result<Option<RecordedCut>, QueueError>>;

    fn read_point(
        &self,
        session_id: SessionId,
        target: SessionRestoreTarget,
        scope: SessionRestoreScope,
        edited: Option<SessionRestoreResend>,
    ) -> BoxFuture<'_, Result<UndoPoint<Self::Reach>, ConversationCutError>>;

    fn read_lead(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<CurrentLeadRun>, QueueError>>;

    fn wait_out_pause(&self, run_id: RunId) -> BoxFuture<'_, ()>;

    fn is_live(&self, session_id: SessionId) -> bool;

    fn read_stops(
        &self,
        session_id: SessionId,
        after_sequence: i64,
    ) -> BoxFuture<'_, Result<UndoStopSet, UndoStopError>>;

    fn close_unrecorded_fork(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), ProviderSessionError>>;

    fn make_live(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ProviderSessionError>>;

    fn read_provider_cut<'a>(
        &'a self,
        session_id: SessionId,
        reach: &'a Self::Reach,
    ) -> BoxFuture<'a, Result<ProviderCut, ConversationCutError>>;

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
        reach: &'a Self::Reach,
        companions: RollbackCompanions,
        provider_cut: ProviderCut,
        resend: Option<SessionRestoreResend>,
    ) -> BoxFuture<'a, Result<ConversationCut, ConversationCutError>>;

    fn record_files(
        &self,
        session_id: SessionId,
        undo_key: ClientUuid,
        files: SessionRestoreFileOutcome,
    ) -> BoxFuture<'_, Result<(), QueueError>>;

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

// What the held part of an undo came to: its report, and the resend its release sends.
struct HeldUndo {
    outcome: SessionRestoreOutcome,
    resend: Option<SessionRestoreResend>,
}

// Runs `request` through `steps` as `UndoService::undo` says, once `undos` lets it take its
// session.
async fn run_undo<Steps: UndoSteps>(
    steps: &Steps,
    undos: &KeyedLock<SessionId>,
    request: UndoRequest<'_>,
) -> Result<SessionRestoreOutcome, UndoError> {
    let session_id = request.session_id;
    let _one_undo = undos.acquire(session_id).await;
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
    } = request;
    let requested = scope.requested();
    let has_conversation = requested != SessionRestoreScope::Files;
    // A retry after an outcome the daemon could not read: what its key recorded applied, and the
    // point the cut went back to is the history it cut away, so the files go back to the
    // checkpoint the key kept.
    let recorded = if has_conversation {
        steps
            .read_recorded_cut(session_id, undo_key.clone())
            .await
            .map_err(|error| UndoError::RecordedCut(Box::new(error)))?
    } else {
        None
    };
    // A recorded cut's resend goes under the undo's key, so a retry after it sends it once.
    let mut point = match recorded {
        Some(recorded) => match (scope.files(), recorded.files) {
            (None, _) => {
                return Ok(HeldUndo {
                    outcome: restore_outcome(requested, Some(Ok(())), None),
                    resend: recorded.resend,
                });
            }
            (Some(_), Some(files)) => {
                return Ok(HeldUndo {
                    outcome: restore_outcome(
                        requested,
                        Some(Ok(())),
                        Some(FilesPutBack::Restored(files)),
                    ),
                    resend: recorded.resend,
                });
            }
            (Some(_), None) => UndoPoint {
                checkpoint: recorded.checkpoint,
                resend: recorded.resend,
                reach: None,
            },
        },
        None => steps
            .read_point(session_id, target, requested, resend)
            .await
            .map_err(|error| {
                if matches!(error, ConversationCutError::Superseded) {
                    UndoError::Superseded
                } else {
                    UndoError::Point(Box::new(error))
                }
            })?,
    };
    let after_sequence = point.after_sequence();
    let read_lead = || async move {
        steps
            .read_lead(session_id)
            .await
            .map_err(|error| UndoError::Lead(Box::new(error)))
    };
    // A pause or a resume still in its driver call is waited out before the lead's state is read.
    let mut lead = read_lead().await?;
    if let Some(run_id) = lead.as_ref().map(|lead| lead.run_id) {
        if timeout(UNDO_PAUSE_WAIT_BOUND, steps.wait_out_pause(run_id))
            .await
            .is_err()
        {
            return Err(UndoError::PauseNotSettled { run_id });
        }
        lead = read_lead().await?;
    }
    // A paused, queued, interrupted or ended lead has no turn to end.
    let live_turn = lead
        .as_ref()
        .filter(|lead| {
            matches!(
                lead.state,
                RunState::Starting
                    | RunState::Running
                    | RunState::WaitingForApproval
                    | RunState::WaitingForInput
            )
        })
        .map(|lead| lead.run_id);
    // Checked before anything moves; a restore of the files alone also ends the lead's live turn,
    // which the person agreed to with the rest.
    if let Some(consented) = &consented_stops {
        let set = steps
            .read_stops(session_id, after_sequence)
            .await
            .map_err(|error| UndoError::Stops(Box::new(error)))?;
        let mut stops = set.named_stops();
        stops.lead_run_id = live_turn.filter(|_| !has_conversation);
        if set.has_grown_past(consented)
            || stops
                .lead_run_id
                .is_some_and(|run_id| consented.lead_run_id != Some(run_id))
        {
            return Ok(HeldUndo {
                outcome: SessionRestoreOutcome::StopsChanged { stops },
                resend: None,
            });
        }
    }
    // A fork an earlier cut left running unrecorded goes first, so nothing reaches it and the
    // provider is asked of the conversation the cut was made from.
    if has_conversation {
        steps
            .close_unrecorded_fork(session_id)
            .await
            .map_err(|error| UndoError::Session(Box::new(error)))?;
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
    // The provider is asked before anything stops whether a cut it made already took the point,
    // so one undo never cuts twice; a read that fails moves nothing.
    let conversation = match (has_conversation, point.reach.take()) {
        (false, _) => None,
        (true, None) => Some(ConversationLeg::Recorded),
        (true, Some(reach)) => Some(ConversationLeg::Cut {
            provider_cut: steps
                .read_provider_cut(session_id, &reach)
                .await
                .map_err(|error| UndoError::ProviderRead(Box::new(error)))?,
            reach,
        }),
    };
    let is_cut_recorded = matches!(conversation, Some(ConversationLeg::Recorded));
    match steps
        .stop(session_id, after_sequence, consented_stops)
        .await
    {
        Ok(()) => {}
        Err(UndoStopError::Grew { mut stops }) => {
            stops.lead_run_id = live_turn.filter(|_| !has_conversation);
            return Ok(HeldUndo {
                outcome: SessionRestoreOutcome::StopsChanged { stops },
                resend: None,
            });
        }
        // Each failed before a stop was sent; one after them is marked `AfterStops`.
        Err(
            error @ (UndoStopError::Pool(_)
            | UndoStopError::Database(_)
            | UndoStopError::Log(_)
            | UndoStopError::ToolCalls(_)
            | UndoStopError::Agents(_)
            | UndoStopError::PointNotFound { .. }),
        ) => return Err(UndoError::Stops(Box::new(error))),
        Err(
            error @ (UndoStopError::Sweep(_)
            | UndoStopError::AfterStops(_)
            | UndoStopError::Refused(_)
            | UndoStopError::NotStopped { .. }
            | UndoStopError::StillRunning { .. }),
        ) => {
            return Ok(failed_after_stops(
                scope,
                &UndoStepFailure::Stops(error),
                is_cut_recorded.then_some(RecordedConversation {
                    resend: point.resend,
                }),
            ));
        }
    }
    // From here a failure reports, since something may already have stopped.
    held_after_stops(
        steps,
        hold,
        HeldAfterStops {
            session_id,
            scope,
            undo_key,
            companions,
            point,
            conversation,
            live_turn,
        },
    )
    .await
}

// What the undo's steps after the stops take.
struct HeldAfterStops<'files, Reach> {
    session_id: SessionId,
    scope: UndoScope<'files>,
    undo_key: ClientUuid,
    companions: RollbackCompanions,
    point: UndoPoint<Reach>,
    conversation: Option<ConversationLeg<Reach>>,
    live_turn: Option<RunId>,
}

// The undo's steps once its stops have run: a step that fails is the undo's outcome, nothing
// restored with its cause.
async fn held_after_stops<Steps: UndoSteps>(
    steps: &Steps,
    hold: &Steps::Hold,
    held: HeldAfterStops<'_, Steps::Reach>,
) -> Result<HeldUndo, UndoError> {
    let HeldAfterStops {
        session_id,
        scope,
        undo_key,
        companions,
        point,
        conversation: leg,
        live_turn,
    } = held;
    let requested = scope.requested();
    let after_sequence = point.after_sequence();
    // A conversation the key recorded cut stays applied whatever fails, with its resend sent.
    let recorded_resend = || {
        matches!(leg, Some(ConversationLeg::Recorded)).then(|| RecordedConversation {
            resend: point.resend.clone(),
        })
    };
    if steps.is_live(session_id)
        && let Err(error) = steps.settle_held_calls(session_id, after_sequence).await
    {
        return Ok(failed_after_stops(
            scope,
            &UndoStepFailure::HeldCalls(error),
            recorded_resend(),
        ));
    }
    if let Some(run_id) = live_turn
        && let Err(error) = steps.interrupt(run_id, undo_key.clone()).await
    {
        return Ok(failed_after_stops(
            scope,
            &UndoStepFailure::Interrupt(error),
            recorded_resend(),
        ));
    }
    let captured = match scope.files() {
        Some(files) => Some((files, files.capture_after(&point.checkpoint).await)),
        None => None,
    };
    let mut conversation = None;
    let mut resend = None;
    match leg {
        None => {}
        Some(ConversationLeg::Recorded) => {
            conversation = Some(Ok(()));
            resend = point.resend.clone();
        }
        Some(ConversationLeg::Cut {
            provider_cut,
            reach,
        }) => {
            if let Some(kept) = &point.resend
                && let Err(error) = steps
                    .stage_resend(session_id, undo_key.clone(), kept.clone())
                    .await
            {
                return Ok(failed_after_stops(
                    scope,
                    &UndoStepFailure::Stage(error),
                    None,
                ));
            }
            let cut = steps
                .cut(hold, &reach, companions, provider_cut, point.resend.clone())
                .await;
            conversation = Some(match cut {
                Ok(ConversationCut::Applied { .. }) => {
                    resend = point.resend.clone();
                    Ok(())
                }
                Ok(ConversationCut::Degraded { fallback_action }) => Err(SessionRestoreFailure {
                    reason: fallback_action
                        .and_then(NonEmptyText::new)
                        .unwrap_or_else(|| {
                            NonEmptyText::new(
                                "the provider took a fallback instead of cutting the \
                                         conversation"
                                    .to_owned(),
                            )
                            .expect("a fixed reason has words")
                        }),
                }),
                Err(ConversationCutError::Superseded) => {
                    return Ok(failed_after_stops(
                        scope,
                        &UndoStepFailure::Superseded,
                        None,
                    ));
                }
                Err(error) => Err(SessionRestoreFailure {
                    reason: reason_of(&error),
                }),
            });
        }
    }
    let put_back = match captured {
        Some((files, Ok(()))) => Some(files.put_back(&point.checkpoint).await),
        Some((_, Err(failure))) => Some(FilesPutBack::Failed(failure)),
        None => None,
    };
    // Beside the key's recorded cut, so a retry answers the files applied and puts back nothing.
    if matches!(conversation, Some(Ok(())))
        && let Some(FilesPutBack::Restored(files)) = &put_back
        && let Err(error) = steps
            .record_files(session_id, undo_key, files.clone())
            .await
    {
        // The files went back; a retry under the key only puts them back again.
        tracing::error!(
            session_id = %session_id,
            error = &error as &(dyn std::error::Error + 'static),
            "the undo's files went back, but its key's record of them was not written"
        );
    }
    Ok(HeldUndo {
        outcome: restore_outcome(requested, conversation, put_back),
        resend,
    })
}

// A conversation the undo's key recorded cut, with the resend its record keeps.
struct RecordedConversation {
    resend: Option<SessionRestoreResend>,
}

// The outcome of an undo whose step after its stops failed with `failure`: each part in `scope`
// failing with that cause, but a `recorded` conversation, which reads applied and sends its resend.
fn failed_after_stops(
    scope: UndoScope<'_>,
    failure: &UndoStepFailure,
    recorded: Option<RecordedConversation>,
) -> HeldUndo {
    let failure = SessionRestoreFailure {
        reason: reason_of(failure),
    };
    let requested = scope.requested();
    let conversation = (requested != SessionRestoreScope::Files).then(|| {
        if recorded.is_some() {
            Ok(())
        } else {
            Err(failure.clone())
        }
    });
    let files = scope.files().map(|_| FilesPutBack::Failed(failure));
    HeldUndo {
        outcome: restore_outcome(requested, conversation, files),
        resend: recorded.and_then(|recorded| recorded.resend),
    }
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

mod steps;
#[cfg(test)]
mod tests;
