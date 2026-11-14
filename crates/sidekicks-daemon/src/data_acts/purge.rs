//! The whole-session purge, for `Delete old data` and `Delete session` on a damaged session or one
//! whose create never finished: the one path that removes a committed row of the append-only log.
//! Nothing in the background calls it. Each session goes on its own, under its transition lock, so
//! a refused one stops no other.
//!
//! - The session is marked `purgeRequested` first, from the states its caller purges, with no
//!   event, which locks its row against every other change. The mark is refused while a plan the
//!   session made is being handed to a fresh session whose seed has no queue item yet, so the
//!   seed's transcript and manifest are always written from a live planning session. A damaged
//!   session with no row is deleted without a mark, since nothing runs in it.
//! - Then the files only this session names go: its shells end and stay refused until the rows
//!   are gone, its tool-server connections start closing and no new one opens, every provider
//!   leg of the session ends, so no provider runs a turn on what is deleted, then the provider's
//!   copy of each conversation, a chat's managed workspace folder, the session's own storage
//!   folder with its runs' capture folders, held while they go so a sweep pass, a pack or a fold
//!   of one waits and then finds it gone, the copies a restore made of the clones it kept on
//!   other volumes, its own folders on other volumes whose volume is mounted (each with its user
//!   folder once that is empty; a folder whose volume is absent is owed instead, in the rows'
//!   write), and the project rules the session wrote into its project's files. A failure there
//!   leaves the mark and every row, so purging the session again finishes it.
//! - Then one write, under the session's append lock, deletes every row naming the session, its
//!   plans and the hand-off that made it among them, and appends its `session.event.compacted`
//!   receipt on the daemon's sentinel session, led by two guards: the session is still marked
//!   (or still has no row), and no event of it lies past the receipt's range. An append the lock
//!   let go before its commit can land after the range is read; the range is then read again
//!   once, since the hold keeps any new append out. The writer's connection runs with
//!   `secure_delete` on, so a freed page is overwritten.
//! - After the commit the recovery state forgets the session's damage, the stop intent drops its
//!   name, the session reads let go of its block cuts, the runs' postures forget its level moves,
//!   the project's other sessions are handed their rules again, the live list loses the session,
//!   the project list counts it no more, and each stored payload no surviving manifest names is
//!   unlinked. Once every session is done the sessions they were linked to are scored again, and
//!   the write-ahead log is truncated, tried again until it succeeds, even when nothing was
//!   deleted.

pub(crate) mod rows;
#[cfg(test)]
pub(crate) mod tests;

use std::collections::HashSet;
use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_approval::rules::{ApprovalRuleError, ApprovalRules};
use sidekicks_artifact::payload_store::PayloadStore;
use sidekicks_contracts::event::declared_variants::{
    SessionEventCompactedPayload, SessionEventCompactedRemovedSession,
};
use sidekicks_contracts::event::envelope::{DAEMON_SCOPE_SENTINEL_SESSION_ID, EventOccurredAt};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_mcp::client::McpClient;
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_recovery::damaged_history::{
    SessionDeletePurge, SessionDeletePurgeError, SessionDeletion,
};
use sidekicks_recovery::status::RecoveryStatusTracker;
use sidekicks_recovery::stop_intent::StopIntentFile;
use sidekicks_session::changes::{SessionChangeError, SessionChanges};
use sidekicks_session::checkpoints::store::shadows::VolumeFolder;
use sidekicks_session::checkpoints::volume_folders::{
    VolumeFolderRemoval, remove_volume_folder, restored_clones_folder,
};
use sidekicks_session::conversations::purge::{ConversationPurge, ConversationPurgeError};
use sidekicks_session::directory::list_feed::SessionListFeed;
use sidekicks_session::questions::service::QuestionsService;
use sidekicks_session::readings::context::ContextReadings;
use sidekicks_session::readings::tool_call_status::ToolCallStatuses;
use sidekicks_session::readings::turn::TurnReadings;
use sidekicks_session::related::ranking::SessionRelatedRanking;
use sidekicks_session::service::SessionService;
use sidekicks_shell::table::ShellTable;
use sidekicks_std::file::remove_tree_awaited;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::scheduler::budget::run_blocking;
use sidekicks_store::data_folder::session_storage_folder;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::schema::session_directory::read_session_state;
use sidekicks_store::database::wal_truncation::WriteAheadLogTruncation;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::log_service::{
    EventAppendError, EventLogAppendOptions, EventLogService,
};
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;
use sidekicks_store::events::session::appender::{
    SessionEventDraft, SessionEventDraftError, UnsequencedEventEnvelope,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_workspace::git::turn_snapshot::repack::CapturePacking;
use sidekicks_workspace::managed::service::{ManagedWorkspaceError, ManagedWorkspaceService};
use sidekicks_workspace::project::list_feed::ProjectListFeed;

use crate::data_acts::purge::rows::{
    HAND_OFF_GUARD_INDEX, MARK_INDEX, MARKED_GUARD_INDEX, PurgeCaller, PurgeReadError, PurgedRow,
    UPPER_BOUND_GUARD_INDEX, gone_worktree_ids, mark_statements, read_gone_worktree_candidates,
    read_purge_targets, read_range_and_links, session_deletion_statements,
};
use crate::hand_over::remove_session_storage_folder;

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
    /// The session's plan is still being handed to a fresh session whose first message is not
    /// queued.
    #[error("the session's plan is still being handed to a fresh session")]
    HandOffUnfinished,
    /// The mark was taken off before the rows were deleted, or a session deleted with no row came
    /// to have one.
    #[error("the session's row changed before its rows were deleted")]
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
    /// A provider leg of the session could not be ended.
    #[error("the session's provider legs could not all be ended")]
    Legs(#[source] SessionChangeError),
    /// The provider's copy of a conversation could not be deleted.
    #[error(transparent)]
    Conversations(#[from] ConversationPurgeError),
    /// A chat's managed workspace folder could not be removed.
    #[error(transparent)]
    ManagedFolder(#[from] ManagedWorkspaceError),
    /// The session's own storage folder could not be removed.
    #[error("the session's storage folder could not be removed")]
    StorageFolder(#[source] io::Error),
    /// The session's capture folders could not be listed to hold them.
    #[error("the session's capture folders could not be listed to hold them")]
    CaptureFolders(#[source] io::Error),
    /// A session's folder on another volume, or the restored copies of its clones, could not be
    /// removed, or its volume read.
    #[error("a session's folder on another volume could not be removed")]
    VolumeFolder(#[source] io::Error),
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
pub(crate) enum SessionPurgeOutcome {
    /// Every row naming the session is gone.
    Removed,
    /// The session was refused, and why.
    Refused(SessionPurgeError),
}

/// What one purge did: each session's outcome, in the order asked.
#[derive(Debug)]
pub(crate) struct SessionPurgeReport {
    /// Each session asked for, with its outcome.
    pub(crate) outcomes: Vec<(SessionId, SessionPurgeOutcome)>,
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
    /// Ends every provider leg of a session before its conversations are deleted.
    pub(crate) changes: Arc<SessionChanges>,
    /// Ends a session's shells.
    pub(crate) shells: Arc<ShellTable>,
    /// Closes a session's tool-server connections and opens no new one for it.
    pub(crate) mcp_client: Arc<McpClient>,
    /// Deletes the provider's copy of each conversation.
    pub(crate) conversations: Arc<ConversationPurge>,
    /// Removes a chat's managed workspace folder.
    pub(crate) managed_workspaces: Arc<ManagedWorkspaceService>,
    /// The service's data folder, which holds each session's own storage folder.
    pub(crate) data_folder: PathBuf,
    /// The capture folders' packing, which holds a purged session's capture folders while they go
    /// and then forgets what it kept of them.
    pub(crate) packing: Arc<CapturePacking>,
    /// Takes a session's project rules out of the providers' files and hands the rest out again.
    pub(crate) project_rules: Arc<ApprovalRules>,
    /// The live sessions list, told of each session marked and removed.
    pub(crate) list_feed: Arc<SessionListFeed>,
    /// The project list, told of each session marked and removed, whose project it holds from
    /// its last read once the session's rows are gone.
    pub(crate) project_list_feed: Arc<ProjectListFeed>,
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
    /// The latest context readings, which forget a purged session they kept as closed.
    pub(crate) context_readings: Arc<ContextReadings>,
    /// The latest turn readings, which forget a purged session they kept as closed.
    pub(crate) turn_readings: Arc<TurnReadings>,
    /// The tool calls' status lines, which forget a purged session they kept as closed.
    pub(crate) tool_call_statuses: Arc<ToolCallStatuses>,
    /// The runs' postures, which forget the level moves they kept for a purged session.
    pub(crate) execution_postures: Arc<ExecutionPostureService>,
    /// The questions, which forget the secret answers they kept in memory for a purged session.
    pub(crate) questions: Arc<QuestionsService>,
    /// The intent the person's Stop left, which drops a purged session's name.
    pub(crate) stop_intent: Arc<StopIntentFile>,
}

/// Deletes whole sessions.
pub(crate) struct SessionPurge {
    deps: SessionPurgeDeps,
    /// Holds a session's purge before it takes the session's append lock.
    #[cfg(test)]
    pub(crate) rows_lock_pause: sidekicks_std::pause_point::PausePoint,
    /// Holds a session's purge after it read the session's range, before each write of its rows.
    #[cfg(test)]
    pub(crate) rows_write_pause: sidekicks_std::pause_point::PausePoint,
}

impl SessionPurge {
    /// The purge over `deps`.
    pub(crate) fn new(deps: SessionPurgeDeps) -> Self {
        Self {
            deps,
            #[cfg(test)]
            rows_lock_pause: sidekicks_std::pause_point::PausePoint::default(),
            #[cfg(test)]
            rows_write_pause: sidekicks_std::pause_point::PausePoint::default(),
        }
    }

    /// Purges each of `session_ids` from the states `caller` purges, one at a time, then scores
    /// again the sessions they were linked to and starts the log's truncation. Never fails: each
    /// session's failure is its outcome. The payloads a purge unlinks are measured on the meter of
    /// the metered run whose task calls, if any.
    pub(crate) async fn purge(
        &self,
        session_ids: &[SessionId],
        caller: PurgeCaller,
    ) -> SessionPurgeReport {
        let operation_id =
            FreeFormText::new(mint_uuid_v7().to_string()).expect("a UUID is an operation id");
        let mut outcomes = Vec::with_capacity(session_ids.len());
        let mut formerly_linked = HashSet::new();
        for session_id in session_ids {
            let outcome = match self.purge_session(*session_id, caller, &operation_id).await {
                Ok(linked_session_ids) => {
                    formerly_linked.extend(linked_session_ids);
                    SessionPurgeOutcome::Removed
                }
                Err(error) => SessionPurgeOutcome::Refused(error),
            };
            outcomes.push((*session_id, outcome));
        }
        for (session_id, outcome) in &outcomes {
            if matches!(outcome, SessionPurgeOutcome::Removed) {
                formerly_linked.remove(session_id);
            }
        }
        self.deps.ranking.rescore_around(formerly_linked);
        self.deps.truncation.request();
        SessionPurgeReport { outcomes }
    }

    async fn purge_session(
        &self,
        session_id: SessionId,
        caller: PurgeCaller,
        operation_id: &FreeFormText<EVENT_FIELD_MAX_LEN>,
    ) -> Result<Vec<SessionId>, SessionPurgeError> {
        let deps = &self.deps;
        let _transition = deps.transition_lock.acquire(session_id).await;
        let row = self.mark(session_id, caller).await?;
        deps.list_feed.refresh([session_id]);
        deps.project_list_feed.refresh_sessions(&[session_id]);
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
        deps.mcp_client.start_session_close(session_id);
        // The transition lock held here keeps any opening out while the legs end.
        deps.changes
            .end_session_legs(session_id)
            .await
            .map_err(SessionPurgeError::Legs)?;
        deps.conversations.delete_conversations(session_id).await?;
        deps.managed_workspaces.delete_folder(session_id).await?;
        let storage_folder = session_storage_folder(&deps.data_folder, &session_id);
        // Held through the removal, so a pass, a pack or a fold queued on a capture folder finds
        // it gone once the hold drops.
        let capture_hold = deps
            .packing
            .hold_owner_folders(&storage_folder)
            .await
            .map_err(SessionPurgeError::CaptureFolders)?;
        remove_session_storage_folder(&deps.data_folder, session_id)
            .await
            .map_err(SessionPurgeError::StorageFolder)?;
        deps.packing.forget_owner(&storage_folder);
        drop(capture_hold);
        remove_tree_awaited(&restored_clones_folder(&deps.data_folder, &session_id))
            .await
            .map_err(SessionPurgeError::VolumeFolder)?;
        let owed_folders = remove_volume_folders(targets.volume_folders)
            .await
            .map_err(SessionPurgeError::VolumeFolder)?;
        let withdrawn = deps
            .project_rules
            .withdraw_project_rules(session_id)
            .await?;

        let linked_session_ids = self
            .delete_rows(
                session_id,
                row,
                &targets.workflow_run_ids,
                &owed_folders,
                operation_id,
            )
            .await?;
        deps.recovery.mark_session_deleted(&session_id);
        // A name left behind only makes a later start read it and settle nothing.
        if let Err(error) = deps.stop_intent.drop_named(&session_id).await {
            tracing::error!(
                %session_id,
                error = &error as &(dyn Error + 'static),
                "a purged session's name was not dropped from the stop intent"
            );
        }
        deps.sessions.forget_session_block_cuts(&session_id);
        deps.context_readings.forget_purged_session(session_id);
        deps.turn_readings.forget_purged_session(session_id);
        deps.tool_call_statuses.forget_purged_session(session_id);
        deps.execution_postures.forget_session(&session_id);
        deps.questions.forget_purged_session(session_id);
        deps.list_feed.refresh([session_id]);
        deps.project_list_feed.refresh_sessions(&[session_id]);
        if let Err(failure) = deps.project_rules.hand_out_after_purge(withdrawn).await {
            tracing::error!(
                %session_id,
                error = &failure as &(dyn Error + 'static),
                "the project's other sessions were not handed their rules again after a purge"
            );
        }
        deps.payloads
            .reclaim_unreferenced(&deps.reads, targets.payload_hashes)
            .await;
        Ok(linked_session_ids)
    }

    // Marks the session, or answers the unfinished hand-off or the state that refused the mark. A
    // damaged session with no row is deleted without one: nothing runs in a session with no row.
    async fn mark(
        &self,
        session_id: SessionId,
        caller: PurgeCaller,
    ) -> Result<PurgedRow, SessionPurgeError> {
        match self
            .deps
            .writer
            .write(mark_statements(session_id, caller))
            .await
        {
            Ok(_) => Ok(PurgedRow::Marked),
            Err(error) if error.refused_statement_index() == Some(HAND_OFF_GUARD_INDEX) => {
                Err(SessionPurgeError::HandOffUnfinished)
            }
            Err(error) if error.refused_statement_index() == Some(MARK_INDEX) => {
                let state = self
                    .deps
                    .reads
                    .read(ReadLength::Short, move |connection| {
                        read_session_state(connection, &session_id).map_err(|error| {
                            SessionPurgeError::Read(PurgeReadError::Database(error))
                        })
                    })
                    .await?;
                match state {
                    None if caller == PurgeCaller::DamagedHistory => Ok(PurgedRow::Absent),
                    state => Err(SessionPurgeError::NotMarkable { state }),
                }
            }
            Err(error) => Err(SessionPurgeError::Write(error)),
        }
    }

    // The one write that deletes every row naming the session with its receipt and owes each of
    // `owed_folders`, under the session's append lock, while its row is still as `row` says;
    // answers the sessions it was linked to.
    async fn delete_rows(
        &self,
        session_id: SessionId,
        row: PurgedRow,
        workflow_run_ids: &[WorkflowRunId],
        owed_folders: &[VolumeFolder],
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
                row,
                range.map(|(_first, last)| last),
                workflow_run_ids,
                &gone_worktree_ids,
                owed_folders,
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

impl SessionDeletePurge for SessionPurge {
    fn purge_deleted_session(
        &self,
        session_id: SessionId,
        deletion: SessionDeletion,
    ) -> BoxFuture<'_, Result<(), SessionDeletePurgeError>> {
        let caller = match deletion {
            SessionDeletion::DamagedHistory => PurgeCaller::DamagedHistory,
            SessionDeletion::UnfinishedCreate => PurgeCaller::UnfinishedCreate,
        };
        Box::pin(async move {
            let report = self.purge(&[session_id], caller).await;
            let (_, outcome) = report
                .outcomes
                .into_iter()
                .next()
                .expect("a purge answers one outcome for each session id it was given");
            match outcome {
                SessionPurgeOutcome::Removed => Ok(()),
                SessionPurgeOutcome::Refused(SessionPurgeError::NotMarkable { .. }) => {
                    Err(SessionDeletePurgeError::NotDeletable)
                }
                SessionPurgeOutcome::Refused(refusal) => {
                    Err(SessionDeletePurgeError::Failed(Box::new(refusal)))
                }
            }
        })
    }
}

// A stored sequence, which the log only ever writes within the safe integers.
fn stored_sequence(sequence: i64) -> SafeInt<0> {
    u64::try_from(sequence)
        .ok()
        .and_then(SafeInt::new)
        .expect("a stored sequence is a safe integer")
}

// Removes each of `folders` whose volume is mounted, in one task charged to `meter`, and answers
// those whose volume is absent; fails at the first folder whose removal or volume read fails.
async fn remove_volume_folders(folders: Vec<VolumeFolder>) -> io::Result<Vec<VolumeFolder>> {
    run_blocking(move || -> io::Result<Vec<VolumeFolder>> {
        let mut absent = Vec::new();
        for folder in folders {
            match remove_volume_folder(&folder)? {
                VolumeFolderRemoval::Removed => {}
                VolumeFolderRemoval::VolumeAbsent => absent.push(folder),
            }
        }
        Ok(absent)
    })
    .await
    .map_err(io::Error::other)?
}
