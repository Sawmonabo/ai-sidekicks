//! The run queue as an undo uses it: the hold on a session's lead while the undo stops its work,
//! cuts its conversation and puts its files back; the cut, asked of the provider outside every lock
//! and recorded as one rollback write of every run it reaches with the caller's companions, then
//! fenced on the session's live binding; and the release, which sends the edited message ahead of
//! every send held meanwhile and opens the lead's next turn with it.

use std::sync::{Arc, LazyLock};

use rusqlite::named_params;
use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{AgentQueueItemCreateRequest, QueueItemId, QueueItemState};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::event_cursor::SessionEventCursorUnresolvable;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::{SessionRestoreResend, SessionRestoreTarget};
use sidekicks_contracts::transcript::turn_attribution::RUN_START_POSITION;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::rewind::{RewindConversationParams, RewindConversationResult};
use sidekicks_provider::runtime_binding::store::read_binding;
use sidekicks_session::checkpoints::store::{CheckpointReadError, read_checkpoint};
use sidekicks_session::driver_resolution::read_run_driver;
use sidekicks_session::queue_store::placement_statements;
use sidekicks_session::run::engine::undo::{RunCut, RunRollback};
use sidekicks_session::run::epochs::{ConfirmedCut, EpochCursorError};
use sidekicks_session::run::read::{RunStateReader, read_run_through};
use sidekicks_session::run::state_change::RunStateChangeCompanions;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, ReadLength};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;
use sidekicks_store::events::session::read::SessionEventReads;

use super::RunQueue;
use crate::delivery::reordered_of;
use crate::error::QueueError;

// The session's lead runs made after `@run_id` that have left `queued`, oldest first: a run id is
// a UUIDv7, so the ids' order is the order the runs were made.
static LATER_LEAD_RUNS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run_id FROM runs
  WHERE session_id = @session_id
    AND parent_run_id IS NULL
    AND state <> '{}'
    AND run_id > @run_id
  ORDER BY run_id",
        <&'static str>::from(RunState::Queued)
    )
});

/// One undo's hold on a session's lead, from [`RunQueue::hold_for_undo`]: the cut borrows it and
/// [`RunQueue::release_undo_hold`] consumes it, so a hold is let go once.
#[must_use = "a session held for an undo is handed nothing until the hold is released"]
#[derive(Debug)]
pub struct UndoHold {
    session_id: SessionId,
    undo_key: ClientUuid,
}

/// What a conversation cut did.
#[derive(Debug)]
pub enum ConversationCut {
    /// The provider cut the conversation; every run it reached is rolled back and the cut fenced.
    Applied {
        /// The rollbacks written, the target's run first, then each later run oldest first.
        rollbacks: Vec<RunRollback>,
        /// The text of the message the cut removed, for the composer, where the provider gave it.
        cut_message_text: Option<String>,
    },
    /// The provider took a fallback instead; nothing was written.
    Degraded {
        /// The fallback it took.
        fallback_action: Option<String>,
    },
}

/// Why a conversation cut was not made or not recorded. Every refusal is answered before the
/// provider is asked, writing nothing and dropping the companions.
#[derive(Debug, thiserror::Error)]
pub enum ConversationCutError {
    /// The target names no checkpoint of the session, or a message cursor naming no place in its
    /// log.
    #[error("the undo's point names no checkpoint of the session")]
    NoCheckpoint {
        /// The cursor's refusal, for a message cursor that names no place.
        #[source]
        source: Option<SessionEventCursorUnresolvable>,
    },
    /// The person's message at the checkpoint does not read as one sent through the queue, so the
    /// provider knows no id for it.
    #[error("the message the undo goes back to was not sent through the queue")]
    MessageNotQueued,
    /// A run the cut reaches holds a turn with no end; the turn must end before the cut.
    #[error("run {run_id} holds a turn with no end, so the conversation is not cut")]
    TurnOpen {
        /// The run.
        run_id: RunId,
    },
    /// The session runs on no binding whose run the cut reaches, so the cut has nothing to fence.
    #[error("the session has no live provider binding the cut reaches")]
    NoLiveBinding,
    /// The cut's rollbacks are written but its fence on the session's binding was refused: the
    /// binding's cursor moved on meanwhile.
    #[error("the conversation cut was recorded but not fenced")]
    Fence(#[source] EpochCursorError),
    /// A read, the provider's cut or the rollback write failed; a write refused writes nothing.
    #[error(transparent)]
    Queue(#[from] QueueError),
}

impl From<DatabaseReadError> for ConversationCutError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Queue(error.into())
    }
}

// What the cut reaches, read before the provider is asked.
struct CutReach {
    // The id the provider knows the person's message by.
    target_message_id: QueueItemId,
    // The target's run, cut at the turn before the target's.
    cut: RunCut,
    // The session's later lead runs, each cut whole.
    later_cuts: Vec<RunCut>,
    // The binding the session runs on now and the point its run is cut at.
    binding_id: RuntimeBindingId,
    binding_point: SourcePosition,
}

impl RunQueue {
    /// Holds the lead of `session_id` for the undo `undo_key`: from now nothing of the session is
    /// handed, started or continued until the hold's release, and a hand already inside its driver
    /// call is waited out. A send meanwhile is recorded and waits.
    pub async fn hold_for_undo(&self, session_id: SessionId, undo_key: ClientUuid) -> UndoHold {
        let hold = self.session_lock.hold_session(session_id).await;
        self.delivery.hold_for_undo(&hold, undo_key.clone()).await;
        UndoHold {
            session_id,
            undo_key,
        }
    }

    /// Cuts the held session's conversation before the person's message `target` names, as the
    /// provider of the target's run does it, outside every lock. Once the provider applied it, one
    /// write records an `agent.run.rolledBack` of the target's run at the turn before the target's
    /// and of each later lead run at its start, with `companions` committing in it, and the cut is
    /// fenced on the session's live binding; the hold stays. Refuses as [`ConversationCutError`]
    /// says before the provider is asked; a provider's fallback or failure writes nothing.
    pub async fn cut_conversation(
        &self,
        hold: &UndoHold,
        target: &SessionRestoreTarget,
        companions: RunStateChangeCompanions,
    ) -> Result<ConversationCut, ConversationCutError> {
        let session_id = hold.session_id;
        let binding_id = self
            .provider_sessions
            .binding_cursors()
            .current_binding(&session_id)
            .ok_or(ConversationCutError::NoLiveBinding)?;
        let reach = self.read_cut_reach(session_id, target, binding_id).await?;
        let driver =
            read_run_driver::<QueueError>(&self.pool, &self.providers, reach.cut.run_id).await?;
        let rewound = driver
            .rewind_conversation(RewindConversationParams {
                session_id,
                binding_id: reach.binding_id.clone(),
                target_message_id: reach.target_message_id.to_string(),
            })
            .await
            .map_err(QueueError::from)?;
        let (fork_binding_id, cut_message_text) = match rewound {
            RewindConversationResult::Applied {
                binding_id,
                cut_message_text,
            } => (binding_id, cut_message_text),
            RewindConversationResult::Degraded { fallback_action } => {
                return Ok(ConversationCut::Degraded { fallback_action });
            }
        };
        let _queue_hold = self.session_lock.hold_session(session_id).await;
        let append_hold = SESSION_APPEND_LOCK.acquire(session_id).await;
        let rollbacks = self
            .engine
            .roll_back(reach.cut, reach.later_cuts, companions, &append_hold)
            .await
            .map_err(QueueError::from)?;
        // The fork's binding row is the fork restart's, recorded after this fence opens its cursor.
        let confirmed = match fork_binding_id {
            None => ConfirmedCut::InPlace {
                binding_id: reach.binding_id,
                point: reach.binding_point,
            },
            Some(new_binding_id) => ConfirmedCut::ForkRestart {
                binding_id: reach.binding_id,
                point: reach.binding_point,
                new_binding_id,
            },
        };
        self.provider_sessions
            .binding_cursors()
            .fence_cut(confirmed)
            .map_err(ConversationCutError::Fence)?;
        Ok(ConversationCut::Applied {
            rollbacks,
            cut_message_text,
        })
    }

    /// Lets go the undo's `hold`. With `resend`, the edited message is first sent from `device_id`
    /// as any send is, under the undo's key, so a repeated undo sends it once, and placed ahead of
    /// every lead message waiting for its run. Once the session's last undo lets go, the lead's
    /// next turn is opened once, as a send would open it, for the run its first waiting message
    /// waits for: the resend, then the sends held meanwhile in the order they were recorded. The
    /// hold is let go and the turn opened whatever the resend answered; fails afterwards with the
    /// first failure, the resend's first.
    pub async fn release_undo_hold(
        &self,
        hold: UndoHold,
        resend: Option<SessionRestoreResend>,
        device_id: DeviceId,
    ) -> Result<(), QueueError> {
        let UndoHold {
            session_id,
            undo_key,
        } = hold;
        let mut first_failure = None;
        if let Some(resend) = resend {
            let request = AgentQueueItemCreateRequest {
                session_id,
                to: None,
                workspace_id: None,
                client_idempotency_key: undo_key.clone(),
                content: resend.content,
                attachments: resend.attachments,
                skills: None,
                replaces_queue_item_id: None,
                answers_question_id: None,
                output_speed_for_turn: None,
            };
            if let Err(error) = self.create(request, device_id).await {
                first_failure = Some(error);
            }
        }
        let resumes = {
            let queue_hold = self.session_lock.hold_session(session_id).await;
            if first_failure.is_none()
                && let Err(error) = self.place_resend_first(session_id, &undo_key).await
            {
                first_failure = Some(error);
            }
            if self.delivery.release_undo_hold(session_id, &undo_key) {
                match self.open_after_undo(&queue_hold).await {
                    Ok(resumes) => resumes,
                    Err(error) => {
                        first_failure.get_or_insert(error);
                        None
                    }
                }
            } else {
                None
            }
        };
        if let Some((run_id, run_version)) = resumes {
            self.resume_for_send(run_id, run_version).await;
        }
        first_failure.map_or(Ok(()), Err)
    }

    // Reads what the cut of the session's conversation before `target` reaches, `binding_id`
    // being the binding the session runs on now; a refusal of the reads answers as the cut's.
    async fn read_cut_reach(
        &self,
        session_id: SessionId,
        target: &SessionRestoreTarget,
        binding_id: RuntimeBindingId,
    ) -> Result<CutReach, ConversationCutError> {
        let target = target.clone();
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        self.pool
            .read(ReadLength::Short, move |reader| {
                let checkpoint = match read_checkpoint(reader, session_id, &target) {
                    Ok(Some(stored)) => stored.checkpoint,
                    Ok(None) => return Err(ConversationCutError::NoCheckpoint { source: None }),
                    Err(CheckpointReadError::CursorUnresolvable(source)) => {
                        return Err(ConversationCutError::NoCheckpoint {
                            source: Some(source),
                        });
                    }
                    Err(CheckpointReadError::Database(error)) => {
                        return Err(QueueError::from(error).into());
                    }
                };
                let sent = SessionEventReads::new(reader, |session: &SessionId| {
                    read_damaged_from_sequence(session)
                })
                .read_at_sequences(&session_id, &[i64::from(checkpoint.message_sequence)])
                .map_err(QueueError::from)?;
                let target_message_id = match sent
                    .first()
                    .map(SessionEvent::from_envelope)
                    .transpose()
                    .map_err(QueueError::from)?
                {
                    Some(SessionEvent::UserMessageSent(payload)) => payload.queue_item_id,
                    _ => None,
                }
                .ok_or(ConversationCutError::MessageNotQueued)?;
                // The kept turns of the target's run are those before the target's own.
                let point = SafeInt::new(checkpoint.turn.position.0.get().saturating_sub(1))
                    .map(SourcePosition)
                    .expect("a position less one stays a safe integer");
                let cut = RunCut {
                    run_id: checkpoint.run_id,
                    target_position: point,
                };
                let later_cuts: Vec<RunCut> = reader
                    .prepare_cached(&LATER_LEAD_RUNS_SQL)
                    .and_then(|mut statement| {
                        statement
                            .query_map(
                                named_params! {
                                    "@session_id": session_id.text().as_str(),
                                    "@run_id": checkpoint.run_id.text().as_str(),
                                },
                                |row| text_column(row, 0, |text| RunId::new(&text)),
                            )?
                            .collect::<rusqlite::Result<Vec<RunId>>>()
                    })
                    .map_err(QueueError::from)?
                    .into_iter()
                    // A later run is cut before its first turn, so every turn of it goes.
                    .map(|run_id| RunCut {
                        run_id,
                        target_position: RUN_START_POSITION.position,
                    })
                    .collect();
                let reached = |run_id: &RunId| {
                    *run_id == cut.run_id || later_cuts.iter().any(|later| later.run_id == *run_id)
                };
                let runs = RunStateReader::new(reader);
                let live_open = runs
                    .list_live_run_resumes(&session_id)
                    .map_err(QueueError::from)?
                    .into_iter()
                    .find(|run| reached(&run.run_id) && !run.open_turns.is_empty())
                    .map(|run| run.run_id);
                let ended_open = runs
                    .list_ended_runs_with_open_turns(Some(&session_id))
                    .map_err(QueueError::from)?
                    .into_iter()
                    .find(|run| reached(&run.run_id))
                    .map(|run| run.run_id);
                if let Some(run_id) = live_open.or(ended_open) {
                    return Err(ConversationCutError::TurnOpen { run_id });
                }
                let binding_run_id = read_binding(reader, &binding_id)
                    .map_err(QueueError::from)?
                    .map(|binding| binding.run_id);
                let binding_point = std::iter::once(&cut)
                    .chain(&later_cuts)
                    .find(|reached| Some(reached.run_id) == binding_run_id)
                    .map(|reached| reached.target_position)
                    .ok_or(ConversationCutError::NoLiveBinding)?;
                Ok(CutReach {
                    target_message_id,
                    cut,
                    later_cuts,
                    binding_id,
                    binding_point,
                })
            })
            .await
    }

    // Puts the message sent under `undo_key` first among the unhanded lead messages waiting for
    // its run, in one write; one no longer waiting, a repeated undo's, stays where it is. Called
    // under the session's queue lock.
    async fn place_resend_first(
        &self,
        session_id: SessionId,
        undo_key: &ClientUuid,
    ) -> Result<(), QueueError> {
        let Some(resent) = self.read_saved(session_id, undo_key).await? else {
            return Ok(());
        };
        let Some(run_id) = resent.target_run_id else {
            return Ok(());
        };
        let waiting: Vec<_> = self
            .read_waiting(run_id)
            .await?
            .into_iter()
            .filter(|item| item.child_handle.is_none() && !self.delivery.is_handed(&item.id))
            .collect();
        let Some(ordered) = reordered_of(&waiting, Some(resent.id)) else {
            return Ok(());
        };
        self.writer
            .write(placement_statements(&ordered, &WireInstant::now()))
            .await?;
        self.recorder.raise_committed(&ordered, true);
        Ok(())
    }

    // Opens the lead's next turn as a send would, for the run the first lead message waiting in
    // the session waits for: handed into a live run, a continue of an interrupted one, a start of
    // a queued one; a paused or pausing one is answered with its version, to resume once the
    // session's lock is let go. Called under `hold`.
    async fn open_after_undo(
        &self,
        hold: &KeyHold<'_, SessionId>,
    ) -> Result<Option<(RunId, i64)>, QueueError> {
        let session_id = *hold.key();
        let first = self
            .read_queue(session_id, None, Some(QueueItemState::Queued))
            .await?
            .into_iter()
            .next();
        let Some((item, run_id)) =
            first.and_then(|item| item.target_run_id.map(|run_id| (item, run_id)))
        else {
            return Ok(None);
        };
        let Some(run) = read_run_through::<QueueError>(&self.pool, run_id).await? else {
            return Ok(None);
        };
        match run.state {
            RunState::Queued => self.admission.start(session_id, run_id),
            RunState::Interrupted => {
                self.lifecycle
                    .continue_interrupted_run(hold, run_id, true)
                    .await?;
            }
            RunState::Starting
            | RunState::Running
            | RunState::WaitingForApproval
            | RunState::WaitingForInput => {
                self.delivery.accept_send(hold, &item, run_id).await?;
            }
            RunState::Pausing | RunState::Paused => {
                self.delivery.accept_send(hold, &item, run_id).await?;
                return Ok(Some((run_id, run.version)));
            }
            // A message waiting for an ended run moves on with that run's end.
            RunState::Completed | RunState::Stopped | RunState::Failed => {}
        }
        Ok(None)
    }
}
