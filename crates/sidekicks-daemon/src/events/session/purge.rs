//! The whole-session purge, for `Delete old data` and a damaged session's `Delete session`: the
//! one path that removes a committed row of the append-only log. Nothing in the background calls
//! it. Each session goes on its own, under its transition lock, so a refused one stops no other.
//!
//! - The session is marked `purgeRequested` first, from the states its caller purges, with no
//!   event, which locks its row against every other change.
//! - Then the files only this session names go: its shells end and stay refused until the rows
//!   are gone, then the provider's copy of each conversation, a chat's managed workspace folder,
//!   each run's snapshot refs, and the project rules the session wrote into its project's files.
//!   A failure there leaves the mark and every row, so purging the session again finishes it.
//! - Then one write, under the session's append lock, deletes every row naming the session and
//!   appends its `session.event.compacted` receipt on the daemon's sentinel session, led by two
//!   guards: the session is still marked, and no event of it lies past the receipt's range. An
//!   append the lock let go before its commit can land after the range is read; the range is
//!   then read again once, since the hold keeps any new append out. The writer's connection runs
//!   with `secure_delete` on, so a freed page is overwritten.
//! - After the commit the recovery state forgets the session's damage, the session reads let go of
//!   its block cuts, the project's other sessions are handed their rules again, the live list
//!   loses the session, and each stored payload no surviving manifest names is unlinked. Once
//!   every session is done the sessions they were linked to are scored again, and the
//!   write-ahead log is truncated, tried again until it succeeds, even when nothing was deleted.

pub(crate) mod checkpoint;
pub(crate) mod rows;
#[cfg(test)]
pub(crate) mod tests;

use std::collections::HashSet;
use std::error::Error;
use std::io;
use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::event::declared_variants::{
    SessionEventCompactedPayload, SessionEventCompactedRemovedSession,
};
use sidekicks_contracts::event::envelope::{DAEMON_SCOPE_SENTINEL_SESSION_ID, EventOccurredAt};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;

use crate::approvals::rules::{ApprovalRuleError, ApprovalRules};
use crate::artifacts::payload_store::PayloadStore;
use crate::daemon::scheduler::budget::ProcessorMeter;
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::writer::{DatabaseWriter, WriteError};
use crate::events::log_service::{EventAppendError, EventLogAppendOptions, EventLogService};
use crate::events::session::append_lock::SESSION_APPEND_LOCK;
use crate::events::session::appender::{
    SessionEventDraft, SessionEventDraftError, UnsequencedEventEnvelope,
};
use crate::events::session::purge::checkpoint::WriteAheadLogTruncation;
use crate::events::session::purge::rows::{
    MARKED_GUARD_INDEX, PurgeCaller, PurgeReadError, UPPER_BOUND_GUARD_INDEX, gone_worktree_ids,
    mark_statement, read_gone_worktree_candidates, read_purge_targets, read_range_and_links,
    read_session_state, session_deletion_statements,
};
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::git::turn_snapshot::diagnostics::TurnSnapshotRetentionSkipReason;
use crate::git::turn_snapshot::service::{
    TurnSnapshotPruneFailure, TurnSnapshotPruneOutcome, TurnSnapshotService,
};
use crate::ipc::registry::HandlerError;
use crate::keyed_lock::KeyedLock;
use crate::pty::shell::table::ShellTable;
use crate::recovery::damaged_history::DamagedSessionPurge;
use crate::recovery::status::RecoveryStatusTracker;
use crate::session::conversation_purge::{ConversationPurge, ConversationPurgeError};
use crate::session::directory::list_feed::SessionListFeed;
use crate::session::related::ranking::SessionRelatedRanking;
use crate::session::service::SessionService;
use crate::workspace::managed::service::{ManagedWorkspaceError, ManagedWorkspaceService};
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// Why one session's purge stopped. A session refused before its rows' write keeps its mark and
/// every row, though files already deleted stay gone, and purging it again finishes it.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionPurgeError {
    /// The session is in no state its caller purges from; `None` when it has no row.
    #[error("the session cannot be purged from its state")]
    NotMarkable {
        /// The state it is in.
        state: Option<SessionState>,
    },
    /// The mark was taken off before the rows were deleted.
    #[error("the session's purge mark was taken off before its rows were deleted")]
    MarkLost,
    /// Events of the session committed past its range after the range was read again: a fault,
    /// since the session's append lock keeps every new append out.
    #[error("the session's events moved past their range while its append lock was held")]
    RangeMoved,
    /// A read of the session's rows failed, or a stored value did not read as its type.
    #[error(transparent)]
    Read(#[from] PurgeReadError),
    /// The read pool is closed, a connection did not open, or the read did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The folders of the session's worktrees could not be read.
    #[error("the folders of the session's worktrees could not be read")]
    WorktreeFolders(#[source] io::Error),
    /// A shell of the session would not end.
    #[error("the session's shells could not all be ended")]
    Shells(#[source] HandlerError),
    /// The provider's copy of a conversation could not be deleted.
    #[error(transparent)]
    Conversations(#[from] ConversationPurgeError),
    /// A chat's managed workspace folder could not be removed.
    #[error(transparent)]
    ManagedFolder(#[from] ManagedWorkspaceError),
    /// A run's snapshot refs could not be deleted.
    #[error("a run's snapshot refs could not be deleted")]
    SnapshotRefs {
        /// Why the prune stopped.
        reason: TurnSnapshotRetentionSkipReason,
        /// The failure behind it.
        #[source]
        cause: Option<TurnSnapshotPruneFailure>,
    },
    /// The project rules the session made could not be taken out of the providers' files.
    #[error(transparent)]
    ProjectRules(#[from] ApprovalRuleError),
    /// The mark or the rows' write was not kept.
    #[error("the purge's write was not kept")]
    Write(#[source] WriteError),
    /// The rows' write, with its receipt, was not kept.
    #[error("the purge's write was not kept")]
    Append(#[source] EventAppendError),
    /// The receipt broke its type's checks.
    #[error(transparent)]
    Receipt(#[from] SessionEventDraftError),
}

/// What the purge did to one session.
#[derive(Debug)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the retention handler and `session.recovery.delete` read what the purge did"
    )
)]
pub(crate) enum SessionPurgeOutcome {
    /// Every row naming the session is gone; `hand_out_failure` is why the project's other sessions
    /// were not handed their rules again, when they were not.
    Removed {
        /// The failure of the rules' hand-out after the rows went.
        hand_out_failure: Option<ApprovalRuleError>,
    },
    /// The session was refused, and why.
    Refused(SessionPurgeError),
}

/// What one purge did: each session's outcome, in the order asked, and whether the write-ahead
/// log's truncation still runs.
#[derive(Debug)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the retention handler and `session.recovery.delete` read what the purge did"
    )
)]
pub(crate) struct SessionPurgeReport {
    /// Each session asked for, with its outcome.
    pub(crate) outcomes: Vec<(SessionId, SessionPurgeOutcome)>,
    /// Whether the truncation runs; false only once the daemon's stop ended it.
    pub(crate) is_truncation_running: bool,
}

/// What the purge deletes through.
pub(crate) struct SessionPurgeDeps {
    /// The writer every delete and the mark go through; its connection has `secure_delete` on.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The read pool every read goes through.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The log the receipt is appended to.
    pub(crate) event_log: Arc<EventLogService>,
    /// This machine, named in each receipt.
    pub(crate) machine_id: MachineId,
    /// The lock every session-wide transition holds for its whole run.
    pub(crate) transition_lock: Arc<KeyedLock<SessionId>>,
    /// Ends a session's shells.
    pub(crate) shells: Arc<ShellTable>,
    /// Deletes the provider's copy of each conversation.
    pub(crate) conversations: Arc<ConversationPurge>,
    /// Removes a chat's managed workspace folder.
    pub(crate) managed_workspaces: Arc<ManagedWorkspaceService>,
    /// Deletes a run's snapshot refs.
    pub(crate) snapshots: Arc<TurnSnapshotService>,
    /// Takes a session's project rules out of the providers' files and hands the rest out again.
    pub(crate) project_rules: Arc<ApprovalRules>,
    /// The live sessions list, told of each session marked and removed.
    pub(crate) list_feed: Arc<SessionListFeed>,
    /// Scores again the related lists of the sessions a purged one was linked to.
    pub(crate) ranking: Arc<SessionRelatedRanking>,
    /// The stored payloads a purged session's manifests named.
    pub(crate) payloads: Arc<PayloadStore>,
    /// The write-ahead log's truncation.
    pub(crate) truncation: Arc<WriteAheadLogTruncation>,
    /// The recovery state, which forgets a purged session's damage.
    pub(crate) recovery: Arc<RecoveryStatusTracker>,
    /// The session reads, which let go of the block cuts they kept for a purged session.
    pub(crate) sessions: Arc<SessionService>,
}

/// Deletes whole sessions.
pub(crate) struct SessionPurge {
    deps: SessionPurgeDeps,
    /// Holds a session's purge before it takes the session's append lock.
    #[cfg(test)]
    pub(crate) rows_lock_pause: crate::pause_point::PausePoint,
    /// Holds a session's purge after it read the session's range, before each write of its rows.
    #[cfg(test)]
    pub(crate) rows_write_pause: crate::pause_point::PausePoint,
}

impl SessionPurge {
    /// The purge over `deps`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's start builds the purge")
    )]
    pub(crate) fn new(deps: SessionPurgeDeps) -> Self {
        Self {
            deps,
            #[cfg(test)]
            rows_lock_pause: crate::pause_point::PausePoint::default(),
            #[cfg(test)]
            rows_write_pause: crate::pause_point::PausePoint::default(),
        }
    }

    /// Purges each of `session_ids` from the states `caller` purges, one at a time, then scores
    /// again the sessions they were linked to and starts the log's truncation. Never fails: each
    /// session's failure is its outcome. The payloads a purge unlinks are charged to `meter`, the
    /// meter of the job or call the purge runs under.
    pub(crate) async fn purge(
        &self,
        session_ids: &[SessionId],
        caller: PurgeCaller,
        meter: &ProcessorMeter,
    ) -> SessionPurgeReport {
        let operation_id =
            FreeFormText::new(mint_uuid_v7().to_string()).expect("a UUID is an operation id");
        let mut outcomes = Vec::with_capacity(session_ids.len());
        let mut formerly_linked = HashSet::new();
        for session_id in session_ids {
            let outcome = match self
                .purge_session(*session_id, caller, &operation_id, meter)
                .await
            {
                Ok(removal) => {
                    formerly_linked.extend(removal.linked_session_ids);
                    SessionPurgeOutcome::Removed {
                        hand_out_failure: removal.hand_out_failure,
                    }
                }
                Err(error) => SessionPurgeOutcome::Refused(error),
            };
            outcomes.push((*session_id, outcome));
        }
        for (session_id, outcome) in &outcomes {
            if matches!(outcome, SessionPurgeOutcome::Removed { .. }) {
                formerly_linked.remove(session_id);
            }
        }
        self.deps.ranking.rescore_around(formerly_linked);
        SessionPurgeReport {
            outcomes,
            is_truncation_running: self.deps.truncation.request(),
        }
    }

    async fn purge_session(
        &self,
        session_id: SessionId,
        caller: PurgeCaller,
        operation_id: &FreeFormText<EVENT_FIELD_MAX_LEN>,
        meter: &ProcessorMeter,
    ) -> Result<SessionRemoval, SessionPurgeError> {
        let deps = &self.deps;
        let _transition = deps.transition_lock.acquire(session_id).await;
        self.mark(session_id, caller).await?;
        deps.list_feed.refresh([session_id]);
        let targets = deps
            .reads
            .read(ReadLength::Long, move |connection| {
                read_purge_targets(connection, session_id).map_err(SessionPurgeError::from)
            })
            .await?;

        // No shell opens in the session until its rows are gone or the purge stops.
        let _shells_closed = deps
            .shells
            .close_session_shells(&session_id)
            .await
            .map_err(SessionPurgeError::Shells)?;
        deps.conversations.delete_conversations(session_id).await?;
        deps.managed_workspaces.delete_folder(session_id).await?;
        for context in &targets.run_contexts {
            let pruned = deps
                .snapshots
                .prune_run_refs(
                    targets.place.as_ref(),
                    context.run_key,
                    &context.git_common_dir,
                )
                .await;
            match pruned {
                // A repository removed took its refs with it.
                TurnSnapshotPruneOutcome::Pruned { .. }
                | TurnSnapshotPruneOutcome::Skipped {
                    reason: TurnSnapshotRetentionSkipReason::GitDirAbsent,
                    ..
                } => {}
                TurnSnapshotPruneOutcome::Skipped { reason, cause } => {
                    return Err(SessionPurgeError::SnapshotRefs { reason, cause });
                }
            }
        }
        let withdrawn = deps
            .project_rules
            .withdraw_project_rules(session_id)
            .await?;

        let linked_session_ids = self
            .delete_rows(session_id, &targets.workflow_run_ids, operation_id)
            .await?;
        deps.recovery.mark_session_healthy(&session_id);
        deps.sessions.forget_session_block_cuts(&session_id);
        deps.list_feed.refresh([session_id]);
        let hand_out_failure = deps
            .project_rules
            .hand_out_after_purge(withdrawn)
            .await
            .err();
        if let Some(failure) = &hand_out_failure {
            tracing::error!(
                error = failure as &(dyn Error + 'static),
                "the project's other sessions were not handed their rules again after a purge"
            );
        }
        deps.payloads
            .reclaim_unreferenced(&deps.reads, targets.payload_hashes, meter)
            .await;
        Ok(SessionRemoval {
            linked_session_ids,
            hand_out_failure,
        })
    }

    // Marks the session, or answers the state that refused the mark.
    async fn mark(
        &self,
        session_id: SessionId,
        caller: PurgeCaller,
    ) -> Result<(), SessionPurgeError> {
        match self
            .deps
            .writer
            .write(vec![mark_statement(session_id, caller)])
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if error.refused_statement_index() == Some(0) => {
                let state = self
                    .deps
                    .reads
                    .read(ReadLength::Short, move |connection| {
                        read_session_state(connection, session_id).map_err(|error| {
                            SessionPurgeError::Read(PurgeReadError::Database(error))
                        })
                    })
                    .await?;
                Err(SessionPurgeError::NotMarkable { state })
            }
            Err(error) => Err(SessionPurgeError::Write(error)),
        }
    }

    // The one write that deletes every row naming the session with its receipt, under the
    // session's append lock; answers the sessions it was linked to.
    async fn delete_rows(
        &self,
        session_id: SessionId,
        workflow_run_ids: &[WorkflowRunId],
        operation_id: &FreeFormText<EVENT_FIELD_MAX_LEN>,
    ) -> Result<Vec<SessionId>, SessionPurgeError> {
        let deps = &self.deps;
        #[cfg(test)]
        self.rows_lock_pause.pass().await;
        let _hold = SESSION_APPEND_LOCK.acquire(session_id).await;
        let (candidates, pending_folders) = deps
            .reads
            .read(ReadLength::Short, move |connection| {
                read_gone_worktree_candidates(connection, session_id)
                    .map_err(|error| SessionPurgeError::Read(PurgeReadError::Database(error)))
            })
            .await?;
        let gone_worktree_ids = gone_worktree_ids(candidates, pending_folders)
            .await
            .map_err(SessionPurgeError::WorktreeFolders)?;
        let mut has_read_again = false;
        loop {
            let (range, linked_session_ids) = deps
                .reads
                .read(ReadLength::Short, move |connection| {
                    read_range_and_links(connection, session_id)
                        .map_err(|error| SessionPurgeError::Read(PurgeReadError::Database(error)))
                })
                .await?;
            let statements = session_deletion_statements(
                session_id,
                range.map(|(_first, last)| last),
                workflow_run_ids,
                &gone_worktree_ids,
            );
            #[cfg(test)]
            self.rows_write_pause.pass().await;
            let refused_at = match range {
                None => match deps.writer.write(statements).await {
                    Ok(_) => return Ok(linked_session_ids),
                    Err(error) => match error.refused_statement_index() {
                        Some(index) => index,
                        None => return Err(SessionPurgeError::Write(error)),
                    },
                },
                Some((first, last)) => {
                    let receipt = self.receipt(session_id, first, last, operation_id)?;
                    let options = EventLogAppendOptions {
                        transactional_prelude: statements,
                        ..EventLogAppendOptions::default()
                    };
                    match deps.event_log.append(receipt, options).await {
                        Ok(_) => return Ok(linked_session_ids),
                        Err(EventAppendError::Write(error))
                            if error.refused_statement_index().is_some() =>
                        {
                            error
                                .refused_statement_index()
                                .expect("the guard's refusal names its statement")
                        }
                        Err(error) => return Err(SessionPurgeError::Append(error)),
                    }
                }
            };
            match refused_at {
                MARKED_GUARD_INDEX => return Err(SessionPurgeError::MarkLost),
                UPPER_BOUND_GUARD_INDEX if !has_read_again => has_read_again = true,
                _ => return Err(SessionPurgeError::RangeMoved),
            }
        }
    }

    // The receipt of the session's rows `first..=last`, on the daemon's sentinel session.
    fn receipt(
        &self,
        session_id: SessionId,
        first: i64,
        last: i64,
        operation_id: &FreeFormText<EVENT_FIELD_MAX_LEN>,
    ) -> Result<UnsequencedEventEnvelope, SessionEventDraftError> {
        let occurred_at = EventOccurredAt::now();
        let removed = SessionEventCompactedRemovedSession {
            session_id,
            from_seq: stored_sequence(first),
            to_seq: stored_sequence(last),
        };
        let event = SessionEvent::SessionEventCompacted(SessionEventCompactedPayload {
            machine_id: self.deps.machine_id.clone(),
            operation_id: operation_id.clone(),
            occurred_at: occurred_at.clone(),
            removed_sessions: BoundedVec::new(vec![removed]).expect("a receipt names its session"),
        });
        let draft = SessionEventDraft::of_session(*DAEMON_SCOPE_SENTINEL_SESSION_ID, &event)?;
        Ok(UnsequencedEventEnvelope::new(
            draft,
            occurred_at,
            None,
            None,
            SESSION_EVENT_VERSION.clone(),
        ))
    }
}

impl DamagedSessionPurge for SessionPurge {
    fn purge_damaged_session(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            let report = self
                .purge(
                    &[session_id],
                    PurgeCaller::DamagedHistory,
                    &ProcessorMeter::default(),
                )
                .await;
            let (_, outcome) = report
                .outcomes
                .into_iter()
                .next()
                .expect("a purge answers one outcome for each session id it was given");
            match outcome {
                SessionPurgeOutcome::Removed { .. } => Ok(()),
                SessionPurgeOutcome::Refused(refusal) => {
                    Err(Box::<dyn Error + Send + Sync>::from(refusal))
                }
            }
        })
    }
}

// A session removed: the sessions it was linked to, and the rules' hand-out failure.
struct SessionRemoval {
    linked_session_ids: Vec<SessionId>,
    hand_out_failure: Option<ApprovalRuleError>,
}

// A stored sequence, which the log only ever writes within the safe integers.
fn stored_sequence(sequence: i64) -> SafeInt<0> {
    u64::try_from(sequence)
        .ok()
        .and_then(SafeInt::new)
        .expect("a stored sequence is a safe integer")
}
