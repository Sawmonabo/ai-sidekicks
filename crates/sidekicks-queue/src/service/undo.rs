//! The run queue as an undo uses it: the hold on a session's lead while the undo stops its work,
//! cuts its conversation and puts its files back; the cut, asked of the provider outside every lock
//! and recorded as one rollback write of every run it reaches with the caller's companions, then
//! fenced on the session's live binding, a fork the provider cut onto recorded as that binding's
//! relaunch once the fence opened its cursor; and the release, which sends the edited message ahead
//! of every send held meanwhile and opens the lead's next turn with it. The order an undo runs
//! these in, with its stops and the lead's interrupt between, is `order`'s.

pub mod order;
pub(crate) mod reach;

use std::sync::{Arc, Weak};

use sidekicks_contracts::event::envelope::SourcePosition;
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
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::rewind::{
    RewindConversationParams, RewindConversationResult, RewindTargetPresence,
};
use sidekicks_provider::left_conversations::{
    LeftConversation, compose_fork_left_conversation_insert,
};
use sidekicks_provider::runtime_binding::store::{
    RuntimeBinding, RuntimeBindingRelaunch, read_binding,
};
use sidekicks_session::checkpoints::restore_cuts::record_cut_statement;
use sidekicks_session::checkpoints::store::kept::{CheckpointReadError, read_checkpoint};
use sidekicks_session::queue_store::{QueueItemRecord, placement_statements};
use sidekicks_session::run::engine::undo::{
    RollbackCheckError, RollbackCompanionCheck, RollbackCompanions, RunCut, RunRollback,
    check_rollback,
};
use sidekicks_session::run::epochs::{ConfirmedCut, EpochCursorError};
use sidekicks_session::run::read::read_run_through;
use sidekicks_session::run::superseded::StoredRollbackMismatchError;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, ReadLength};
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;

use self::reach::{ReachRead, UndoReach};
use super::RunQueue;
use crate::delivery::{UndoHoldId, reordered_of};
use crate::error::QueueError;
use crate::provider_session::errors::ProviderSessionError;

/// One undo's hold on a session's lead, from [`RunQueue::hold_for_undo`]: the cut borrows it and
/// [`RunQueue::release_undo_hold`] consumes it, so a hold is let go once. A hold dropped
/// unreleased, its undo canceled or failed, is let go on a task of the queue's own, as a release
/// with no edit; dropped off the runtime, it is let go in place, without the session's lock, and
/// opens and resumes nothing.
#[must_use = "a session held for an undo is handed nothing until the hold is released"]
#[derive(Debug)]
pub struct UndoHold {
    session_id: SessionId,
    undo_key: ClientUuid,
    // Its own among the session's holds, so a retry under the same key holds apart from it.
    hold_id: UndoHoldId,
    // The queue the drop lets the hold go through; empty once a release took the hold.
    queue: Weak<RunQueue>,
}

impl UndoHold {
    // Takes the hold for a release, so its drop lets nothing go.
    fn take(mut self) -> (SessionId, ClientUuid, UndoHoldId) {
        self.queue = Weak::new();
        (self.session_id, self.undo_key.clone(), self.hold_id)
    }
}

impl Drop for UndoHold {
    fn drop(&mut self) {
        let Some(queue) = self.queue.upgrade() else {
            return;
        };
        let (session_id, undo_key, hold_id) =
            (self.session_id, self.undo_key.clone(), self.hold_id);
        if tokio::runtime::Handle::try_current().is_err() {
            // Off the runtime nothing can open the lead's next turn or resume a run, so the hold
            // alone goes: the runs whose resume it held back are dropped, each paused run's pause
            // standing for the person's next press.
            let _owed_resumes = queue.delivery.release_undo_hold(session_id, hold_id);
            return;
        }
        let releases = queue.releases.clone();
        releases.spawn(async move {
            if let Err(error) = queue
                .let_go_undo_hold(session_id, undo_key, hold_id, None)
                .await
            {
                tracing::error!(
                    session_id = %session_id,
                    error = &error as &(dyn std::error::Error + 'static),
                    "opening the lead's next turn after a dropped undo hold failed; the session's \
                     next send opens it"
                );
            }
        });
    }
}

/// What a conversation cut did.
#[derive(Debug)]
pub enum ConversationCut {
    /// The provider cut the conversation; every run it reached is rolled back and the cut fenced,
    /// and a fork it cut onto is recorded as the session's binding.
    Applied {
        /// The rollbacks written, the reach's run first, then each later run oldest first.
        rollbacks: Vec<RunRollback>,
        /// Where the cut went back to and the person's messages it took back, for the draft and a
        /// resend.
        reach: UndoReach,
    },
    /// The provider took a fallback instead; nothing was written.
    Degraded {
        /// The fallback it took.
        fallback_action: Option<String>,
    },
}

/// Whether an undo's cut asks the provider, or records a cut the provider already made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderCut {
    /// The provider's conversation still holds the point, so the provider is asked to cut it.
    ToMake,
    /// The provider's conversation already ends before the point, as its own record read: only
    /// the rollback and the key's record are written.
    AlreadyMade,
}

/// Why a conversation cut was not made or not recorded. Every refusal but [`Unrecorded`],
/// [`Fence`] and [`ForkUnrecorded`] writes nothing and drops the companions, and each is answered
/// before the provider is asked, the companions' check among them, except a [`Queue`] that carries
/// the provider's own failure of the cut.
///
/// [`Unrecorded`]: ConversationCutError::Unrecorded
/// [`Fence`]: ConversationCutError::Fence
/// [`ForkUnrecorded`]: ConversationCutError::ForkUnrecorded
/// [`Queue`]: ConversationCutError::Queue
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
    /// A later undo cut the conversation back past the checkpoint's message, so there is nothing
    /// of it to cut.
    #[error("the undo's point lies in history a later undo cut away")]
    Superseded,
    /// A stored rollback of the checkpoint's run does not match its contract.
    #[error(transparent)]
    Rollback(StoredRollbackMismatchError),
    /// The person's message the cut goes back to, or one it takes back, does not read as one sent
    /// through the queue, so the provider knows no id for it and no queue item holds its words;
    /// or the turn a steer joined holds no checkpoint of its start where the cut lands only at
    /// turns.
    #[error("the message the undo goes back to was not sent through the queue")]
    MessageNotQueued,
    /// A run the cut reaches holds a turn with no end; the turn must end before the cut.
    #[error("run {run_id} holds a turn with no end, so the conversation is not cut")]
    TurnOpen {
        /// The run.
        run_id: RunId,
    },
    /// A companion statement would refuse the rollback's write, as the companions' check read it.
    #[error("companion statement {companion_index} of the rollback would refuse it")]
    CompanionRefused {
        /// The statement's position among the companions.
        companion_index: usize,
    },
    /// The session runs on no binding whose run the cut reaches, so the cut has nothing to fence.
    #[error("the session has no live provider binding the cut reaches")]
    NoLiveBinding,
    /// A cut in place's rollbacks are written but its fence on the session's binding was refused:
    /// the binding's cursor moved on meanwhile.
    #[error("the conversation cut was recorded but not fenced")]
    Fence(#[source] EpochCursorError),
    /// The provider cut the conversation but the store did not record the rollback: its write
    /// failed, or a condition the check read before the cut moved before the write, so the store
    /// holds no rollback of turns the provider no longer has.
    #[error("the provider cut the conversation, but the store recorded no rollback")]
    Unrecorded(#[source] QueueError),
    /// The provider cut onto a fork and the store recorded the rollback, but the daemon could not
    /// take the fork up: its fence or its binding row was refused. The fork's process is closed,
    /// or the error says it could not be.
    #[error("the provider cut the conversation onto a fork the daemon could not take up")]
    ForkUnrecorded(#[source] ProviderSessionError),
    /// A read or the provider's cut failed, writing nothing.
    #[error(transparent)]
    Queue(#[from] QueueError),
}

// The driver of `reach`'s run, which a reach read with the conversation in scope resolves.
fn driver_of(reach: &ReachRead) -> &Arc<dyn ProviderDriver> {
    reach
        .driver
        .as_ref()
        .expect("a reach read with the conversation in scope resolves its driver")
}

impl From<DatabaseReadError> for ConversationCutError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Queue(error.into())
    }
}

// What the cut of a reach writes, read before the provider is asked.
struct CutReach {
    // The reach's run, cut at the position before the reach's.
    cut: RunCut,
    // The session's later lead runs, each cut whole.
    later_cuts: Vec<RunCut>,
    // The binding the session runs on now and the point its run is cut at.
    binding: RuntimeBinding,
    binding_point: SourcePosition,
}

impl RunQueue {
    /// Holds the lead of `session_id` for the undo `undo_key`: from now nothing of the session is
    /// handed, started or continued until the hold's release, and a hand already inside its driver
    /// call is waited out. A send meanwhile is recorded and waits.
    pub async fn hold_for_undo(&self, session_id: SessionId, undo_key: ClientUuid) -> UndoHold {
        let hold = self.session_lock.hold_session(session_id).await;
        // Made before the hold goes in, with no await between, so a hold canceled while it waits
        // out a hand in flight still lets itself go.
        let hold_id = self.delivery.mint_undo_hold_id();
        let undo_hold = UndoHold {
            session_id,
            undo_key,
            hold_id,
            queue: self.this.clone(),
        };
        self.delivery.hold_for_undo(&hold, hold_id).await;
        undo_hold
    }

    /// Whether the provider of `reach`'s run, read with the conversation in scope, still holds on
    /// the session's live binding the person's message the cut before `reach` is asked before,
    /// read from the provider's own record, so a retried undo never cuts twice. Fails with
    /// [`ConversationCutError`]'s `NoLiveBinding` where the session runs on none, and with `Queue`
    /// carrying the provider's failure of the read.
    pub async fn read_provider_cut(
        &self,
        session_id: SessionId,
        reach: &ReachRead,
    ) -> Result<ProviderCut, ConversationCutError> {
        let binding_id = self
            .provider_sessions
            .binding_cursors()
            .current_binding(&session_id)
            .ok_or(ConversationCutError::NoLiveBinding)?;
        let presence = driver_of(reach)
            .read_rewind_target(RewindConversationParams {
                session_id,
                binding_id,
                target_message_id: reach.reach.message_id.to_string(),
            })
            .await
            .map_err(QueueError::from)?;
        Ok(match presence {
            RewindTargetPresence::Held => ProviderCut::ToMake,
            RewindTargetPresence::CutAway => ProviderCut::AlreadyMade,
        })
    }

    /// Cuts the held session's conversation before the person's message `reach`, read with the
    /// conversation in scope, is asked before, as the provider of the reach's run does it, outside
    /// every lock, or, for a cut `provider_cut` says the provider already made, records it with no
    /// cut asked, once the driver brought its own record to it: before that message, or, for one
    /// whose landing names a group the cut takes it with, before the group's first message.
    /// Once the provider applied it, one write records an `agent.run.rolledBack` of that run at the
    /// position before the reach's and of each later lead run at its start, with `companions`
    /// committing in it, and the cut is fenced on the session's live binding; a fork the provider
    /// cut onto is recorded in that write as a conversation the binding left, so the purge reaches
    /// it whatever follows, and then as that binding's relaunch, the conversation it left and the
    /// cut under the undo's key with it, under the same holds; a cut in place is recorded under the
    /// key in the rollback's write, with `resend`, which a retry under the key sends. The hold
    /// stays. A turn opening on the session that meets the write in progress opens once the write
    /// has ended. Refuses as [`ConversationCutError`] says before the provider is asked, a reach a
    /// later cut took meanwhile, an open turn among the runs it reaches and a companion its check
    /// refuses included; a provider's fallback or failure writes nothing, a write the store does
    /// not record once the provider cut answers [`ConversationCutError::Unrecorded`], and a fork
    /// whose rollback, fence or row is refused is closed and answers
    /// [`ConversationCutError::Unrecorded`] or [`ConversationCutError::ForkUnrecorded`], the
    /// session left on the binding it was cut on, unfrozen, and its process forgotten as opened, a
    /// fork whose close failed held until a later close of it succeeds.
    pub async fn cut_conversation(
        &self,
        hold: &UndoHold,
        reach: &ReachRead,
        companions: RollbackCompanions,
        provider_cut: ProviderCut,
        resend: Option<&SessionRestoreResend>,
    ) -> Result<ConversationCut, ConversationCutError> {
        let session_id = hold.session_id;
        let binding_id = self
            .provider_sessions
            .binding_cursors()
            .current_binding(&session_id)
            .ok_or(ConversationCutError::NoLiveBinding)?;
        let cut_reach = self
            .read_cut_reach(session_id, reach, binding_id, &companions.check)
            .await?;
        let driver = Arc::clone(driver_of(reach));
        let rewind = RewindConversationParams {
            session_id,
            binding_id: cut_reach.binding.id.clone(),
            target_message_id: reach.reach.message_id.to_string(),
        };
        // A cut the provider already made was made in place on the binding the session runs on.
        let fork = match provider_cut {
            ProviderCut::AlreadyMade => {
                driver
                    .adopt_conversation_rewind(rewind)
                    .await
                    .map_err(QueueError::from)?;
                None
            }
            ProviderCut::ToMake => {
                let rewound = driver
                    .rewind_conversation(rewind)
                    .await
                    .map_err(QueueError::from)?;
                // The draft's words come from the daemon's own queue items, never the provider's.
                match rewound {
                    RewindConversationResult::Applied { fork, .. } => fork,
                    RewindConversationResult::Degraded { fallback_action } => {
                        return Ok(ConversationCut::Degraded { fallback_action });
                    }
                }
            }
        };
        // Pushed after the caller's statements, so each keeps the index its check names.
        let mut companion_write = companions.write;
        // A retry under the undo's key reads the cut as applied and never cuts again; a cut onto a
        // fork is recorded in the write that takes the fork up, so a fork refused records none.
        let cut_record = record_cut_statement(
            session_id,
            &hold.undo_key,
            &reach.reach.checkpoint.checkpoint_id,
            resend,
        );
        let fork_companions = if fork.is_some() {
            vec![cut_record]
        } else {
            companion_write.statements.push(cut_record);
            Vec::new()
        };
        if let Some(fork) = &fork {
            match compose_fork_left_conversation_insert(
                session_id,
                &cut_reach.binding,
                fork.resume_handle.as_str(),
            ) {
                Ok(statement) => companion_write.statements.push(statement),
                Err(error) => tracing::error!(
                    session_id = %session_id,
                    error = &error as &(dyn std::error::Error + 'static),
                    "the provider forked the session's conversation onto a handle the daemon \
                     cannot record"
                ),
            }
        }
        // A turn opening that meets this mark waits for the write to end, so it cannot refuse the
        // rollback; one already past its check can, and the write then answers `Unrecorded`.
        let undo_write = self.engine.mark_undo_write(session_id);
        let queue_hold = self.session_lock.hold_session(session_id).await;
        let append_hold = SESSION_APPEND_LOCK.acquire(session_id).await;
        let written = self
            .engine
            .roll_back(
                cut_reach.cut,
                cut_reach.later_cuts,
                companion_write,
                &append_hold,
            )
            .await;
        drop(undo_write);
        let rollbacks = match written {
            Ok(rollbacks) => rollbacks,
            Err(error) => {
                let error = QueueError::from(error);
                tracing::error!(
                    session_id = %session_id,
                    error = &error as &(dyn std::error::Error + 'static),
                    "the provider cut the session's conversation, but its rollback was not recorded"
                );
                // The source conversation was never cut, so a retry cuts it once the fork goes.
                if fork.is_some() {
                    drop(append_hold);
                    drop(queue_hold);
                    if let Err(closed) = self
                        .provider_sessions
                        .close_unrecorded_fork(driver, session_id)
                        .await
                    {
                        return Err(ConversationCutError::ForkUnrecorded(
                            ProviderSessionError::UnclosedFork { session_id, closed },
                        ));
                    }
                }
                return Err(ConversationCutError::Unrecorded(error));
            }
        };
        let binding_cursors = self.provider_sessions.binding_cursors();
        let Some(fork) = fork else {
            binding_cursors
                .fence_cut(ConfirmedCut::InPlace {
                    binding_id: cut_reach.binding.id,
                    point: cut_reach.binding_point,
                })
                .map_err(ConversationCutError::Fence)?;
            return Ok(ConversationCut::Applied {
                rollbacks,
                reach: reach.reach.clone(),
            });
        };
        // The fork's row is recorded once this fence opened its cursor, under both holds: a row
        // recorded through a path that opens a cursor would be refused the one the fence opened.
        let source_binding_id = cut_reach.binding.id.clone();
        let fenced = binding_cursors.fence_cut(ConfirmedCut::ForkRestart {
            binding_id: cut_reach.binding.id.clone(),
            point: cut_reach.binding_point,
            new_binding_id: fork.binding_id.clone(),
        });
        let is_fenced = fenced.is_ok();
        let recorded = match fenced {
            Ok(()) => {
                let left_conversations = LeftConversation::of_relaunch(
                    session_id,
                    &cut_reach.binding,
                    fork.resume_handle.as_str(),
                )
                .into_iter()
                .collect();
                binding_cursors
                    .record_relaunch(
                        RuntimeBindingRelaunch {
                            predecessor_id: cut_reach.binding.id,
                            binding_id: fork.binding_id,
                            resume_handle: fork.resume_handle.as_str().to_owned(),
                            spawned_version: fork.spawned_version,
                            left_conversations,
                        },
                        fork_companions,
                    )
                    .await
            }
            Err(refused) => Err(refused.into()),
        };
        if let Err(failure) = recorded {
            // Claude Code's close appends the closed runs' ends under the session's append lock,
            // so both holds go first. Nothing runs under the fork meanwhile: the undo's own hold
            // keeps every hand and start off the session, and the fork has no cursor.
            drop(append_hold);
            drop(queue_hold);
            let unrecorded = ProviderSessionError::from(failure);
            let error = match self
                .provider_sessions
                .close_unrecorded_fork(driver, session_id)
                .await
            {
                Ok(()) => unrecorded,
                Err(closed) => ProviderSessionError::UnrecordedNotClosed {
                    session_id,
                    recorded: Box::new(unrecorded),
                    closed,
                },
            };
            // The session carries on from the binding it was cut on, its log holding the rollback
            // and its conversation the turns rolled back until its next turn; a fence refused set
            // no freeze, and one set earlier stays.
            if is_fenced {
                binding_cursors.lift_fork_fence(&source_binding_id);
            }
            tracing::error!(
                session_id = %session_id,
                error = &error as &(dyn std::error::Error + 'static),
                "the provider cut the session's conversation onto a fork the daemon could not take up"
            );
            return Err(ConversationCutError::ForkUnrecorded(error));
        }
        Ok(ConversationCut::Applied {
            rollbacks,
            reach: reach.reach.clone(),
        })
    }

    /// Lets go the undo's `hold`. With `resend`, the edited message is first sent from `device_id`
    /// as any send is, under the undo's key, so a repeated undo sends it once, and placed ahead of
    /// every lead message waiting for its run. Once the session's last undo lets go, the lead's
    /// next turn is opened once, as a send would open it, for the run its first waiting message
    /// waits for: the resend, then the sends held meanwhile in the order they were recorded. A run
    /// that reads its opening later (a queued or interrupted run's start, a paused one's resume)
    /// has the resend reserved as that opening, so no reorder or `Send now` meanwhile puts another
    /// message ahead of it; a resume that does not go drops the reservation while it still names
    /// this resend. Then each run whose resume the session's undos held back is resumed once, in
    /// the order the resumes came, at its version read then, while it is still pausing or paused;
    /// one the undo moved on is dropped. The hold is let go and the turn opened whatever the
    /// resend answered, on a task of the queue's own, so a caller that goes away meanwhile still
    /// lets it go; fails afterwards with the first failure, the resend's first.
    pub async fn release_undo_hold(
        &self,
        hold: UndoHold,
        resend: Option<SessionRestoreResend>,
        device_id: DeviceId,
    ) -> Result<(), QueueError> {
        let (session_id, undo_key, hold_id) = hold.take();
        let queue = self
            .this
            .upgrade()
            .expect("the queue lives while a call of it runs");
        let released = self.releases.spawn(async move {
            queue
                .let_go_undo_hold(
                    session_id,
                    undo_key,
                    hold_id,
                    resend.map(|resend| (resend, device_id)),
                )
                .await
        });
        match released.await {
            Ok(released) => released,
            // The tracker never aborts its tasks, and the runtime's shutdown drops this call with
            // them, so only a panic ends one early.
            Err(error) => std::panic::resume_unwind(error.into_panic()),
        }
    }

    // Lets go the hold `hold_id` the undo `undo_key` took on `session_id` as `release_undo_hold`
    // says, with `resend` sent from its device first under that key.
    async fn let_go_undo_hold(
        &self,
        session_id: SessionId,
        undo_key: ClientUuid,
        hold_id: UndoHoldId,
        resend: Option<(SessionRestoreResend, DeviceId)>,
    ) -> Result<(), QueueError> {
        let mut first_failure = None;
        if let Some((resend, device_id)) = resend {
            let request = AgentQueueItemCreateRequest {
                session_id,
                to: None,
                workspace_id: None,
                client_idempotency_key: undo_key.clone(),
                content: resend.content,
                attachments: resend.attachments,
                skills: resend.skills,
                replaces_queue_item_id: None,
                answers_question_id: None,
                output_speed_for_turn: resend.output_speed_for_turn,
            };
            if let Err(error) = self.create(request, device_id).await {
                first_failure = Some(error);
            }
        }
        let (opened, owed_resumes) = {
            let queue_hold = self.session_lock.hold_session(session_id).await;
            let mut resent = None;
            if first_failure.is_none() {
                match self.place_resend_first(session_id, &undo_key).await {
                    Ok(placed) => resent = placed,
                    Err(error) => first_failure = Some(error),
                }
            }
            match self.delivery.release_undo_hold(session_id, hold_id) {
                Some(owed_resumes) => match self.open_after_undo(&queue_hold, resent).await {
                    Ok(opened) => (opened, owed_resumes),
                    Err(error) => {
                        first_failure.get_or_insert(error);
                        (None, owed_resumes)
                    }
                },
                None => (None, Vec::new()),
            }
        };
        let opened_run_id = opened.map(|(run_id, _, _)| run_id);
        if let Some((run_id, run_version, reserved_id)) = opened {
            #[cfg(test)]
            self.resume_pause.pass().await;
            if !self.resume_paused_run(run_id, run_version).await
                && let Some(reserved_id) = reserved_id
            {
                self.admission.drop_reservation_naming(run_id, reserved_id);
            }
        }
        // The run the opening resumed is not resumed again.
        for run_id in owed_resumes {
            if Some(run_id) == opened_run_id {
                continue;
            }
            match read_run_through::<QueueError>(&self.pool, run_id).await {
                Ok(Some(run)) if matches!(run.state, RunState::Pausing | RunState::Paused) => {
                    // A resume that did not go was logged, and the run's messages wait.
                    let _resumed = self.resume_paused_run(run_id, run.version).await;
                }
                // The undo interrupted the run or it ended: its waiting messages go as it moves.
                Ok(_) => {}
                Err(error) => {
                    first_failure.get_or_insert(error);
                }
            }
        }
        first_failure.map_or(Ok(()), Err)
    }

    // Reads what the cut of the session's conversation before `reach` writes, `binding_id` being
    // the binding the session runs on now, and checks in the same read that no later cut took the
    // reach meanwhile and every condition the rollback refuses on, the companions' `check` among
    // them; a refusal answers as the cut's.
    async fn read_cut_reach(
        &self,
        session_id: SessionId,
        reach: &ReachRead,
        binding_id: RuntimeBindingId,
        check: &RollbackCompanionCheck,
    ) -> Result<CutReach, ConversationCutError> {
        let checkpoint = reach.reach.checkpoint.clone();
        let later_run_ids = reach.later_run_ids.clone();
        let check = Arc::clone(check);
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        self.pool
            .read(ReadLength::Short, move |reader| {
                let kept = read_checkpoint(
                    reader,
                    &*read_damaged_from_sequence,
                    session_id,
                    &SessionRestoreTarget::Snapshot {
                        snapshot_id: checkpoint.checkpoint_id.clone(),
                    },
                );
                match kept {
                    Ok(Some(_)) => {}
                    Ok(None) => return Err(ConversationCutError::NoCheckpoint { source: None }),
                    Err(CheckpointReadError::Superseded { .. }) => {
                        return Err(ConversationCutError::Superseded);
                    }
                    Err(CheckpointReadError::CursorUnresolvable(source)) => {
                        return Err(ConversationCutError::NoCheckpoint {
                            source: Some(source),
                        });
                    }
                    Err(CheckpointReadError::Database(error)) => {
                        return Err(QueueError::from(error).into());
                    }
                    Err(CheckpointReadError::Rollback(error)) => {
                        return Err(ConversationCutError::Rollback(error));
                    }
                }
                // The kept positions of the reach's run are those before the reach's own.
                let point = checkpoint
                    .turn
                    .position
                    .0
                    .get()
                    .checked_sub(1)
                    .and_then(SafeInt::new)
                    .map(SourcePosition)
                    .expect("a message the person sent sits past its run's start");
                let cut = RunCut {
                    run_id: checkpoint.run_id,
                    target_position: point,
                };
                // A later run is cut before its first position, so every message it took goes.
                let later_cuts: Vec<RunCut> = later_run_ids
                    .into_iter()
                    .map(|run_id| RunCut {
                        run_id,
                        target_position: RUN_START_POSITION.position,
                    })
                    .collect();
                let cuts: Vec<RunCut> = std::iter::once(cut)
                    .chain(later_cuts.iter().copied())
                    .collect();
                check_rollback(reader, &session_id, &cuts, &check).map_err(
                    |error| match error {
                        RollbackCheckError::TurnOpen { run_id } => {
                            ConversationCutError::TurnOpen { run_id }
                        }
                        RollbackCheckError::CompanionRefused { companion_index } => {
                            ConversationCutError::CompanionRefused { companion_index }
                        }
                        RollbackCheckError::Database(error) => QueueError::from(error).into(),
                    },
                )?;
                let binding = read_binding(reader, &binding_id)
                    .map_err(QueueError::from)?
                    .ok_or(ConversationCutError::NoLiveBinding)?;
                // The fence opens the binding's run at the point its rollback writes.
                let binding_point = cuts
                    .iter()
                    .find(|reached| reached.run_id == binding.run_id)
                    .map(|reached| reached.target_position)
                    .ok_or(ConversationCutError::NoLiveBinding)?;
                Ok(CutReach {
                    cut,
                    later_cuts,
                    binding,
                    binding_point,
                })
            })
            .await
    }

    // Puts the message sent under `undo_key` first among the unhanded lead messages waiting for
    // its run, in one write, and answers it; one no longer waiting or handed, a repeated undo's,
    // stays where it is and is answered `None`. Called under the session's queue lock.
    async fn place_resend_first(
        &self,
        session_id: SessionId,
        undo_key: &ClientUuid,
    ) -> Result<Option<QueueItemRecord>, QueueError> {
        let Some(resent) = self.read_saved(session_id, undo_key).await? else {
            return Ok(None);
        };
        let Some(run_id) = resent.target_run_id else {
            return Ok(None);
        };
        let waiting: Vec<_> = self
            .read_waiting(run_id)
            .await?
            .into_iter()
            .filter(|item| item.child_handle.is_none() && !self.delivery.is_handed(&item.id))
            .collect();
        let Some(ordered) = reordered_of(&waiting, Some(resent.id)) else {
            return Ok(None);
        };
        self.writer
            .write(placement_statements(&ordered, &WireInstant::now()))
            .await?;
        self.recorder.raise_committed(&ordered, true);
        Ok(Some(resent))
    }

    // Opens the lead's next turn as a send would, for the run the first lead message waiting in
    // the session waits for: handed into a live run, a continue of an interrupted one, a start of
    // a queued one; a paused or pausing one is answered with its version and the item reserved
    // for it, to resume once the session's lock is let go. `resent`, when that run's, is
    // reserved as the opening of every run but a live one, which hands it first in the queue's
    // order. Called under `hold`.
    async fn open_after_undo(
        &self,
        hold: &KeyHold<'_, SessionId>,
        resent: Option<QueueItemRecord>,
    ) -> Result<Option<(RunId, i64, Option<QueueItemId>)>, QueueError> {
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
        let does_read_opening_later = matches!(
            run.state,
            RunState::Queued | RunState::Interrupted | RunState::Pausing | RunState::Paused
        );
        let reserved_id = resent
            .filter(|resent| does_read_opening_later && resent.target_run_id == Some(run_id))
            .map(|resent| resent.id);
        if let Some(reserved_id) = reserved_id {
            self.admission.reserve_opening(run_id, reserved_id);
        }
        match run.state {
            RunState::Queued => self.admission.start(session_id, run_id),
            RunState::Interrupted => {
                self.lifecycle
                    .continue_interrupted_run(hold, run_id, true)
                    .await?;
                // A run left resting, with no continue under way, would keep the reservation.
                if let Some(reserved_id) = reserved_id
                    && !self.admission.is_starting(run_id)
                {
                    self.admission.drop_reservation_naming(run_id, reserved_id);
                }
            }
            RunState::Starting
            | RunState::Running
            | RunState::WaitingForApproval
            | RunState::WaitingForInput => {
                self.delivery.accept_send(hold, &item, run_id).await?;
            }
            RunState::Pausing | RunState::Paused => {
                self.delivery.accept_send(hold, &item, run_id).await?;
                return Ok(Some((run_id, run.version, reserved_id)));
            }
            // A message waiting for an ended run moves on with that run's end.
            RunState::Completed | RunState::Stopped | RunState::Failed => {}
        }
        Ok(None)
    }
}
