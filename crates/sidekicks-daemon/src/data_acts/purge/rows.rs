//! What a session's purge reads and writes in the database: the mark and its hand-off guard, the
//! reads of what its files and its receipt need, and the one write that deletes every row naming
//! the session.

use std::borrow::Cow;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::LazyLock;

use rusqlite::types::Value;
use rusqlite::{Connection, named_params};
use sidekicks_artifact::payload_store::{ContentHash, NotAContentHash};
use sidekicks_contracts::run::queue::PlanMessageKind;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::worktree::lifecycle::WorktreeState;
use sidekicks_session::checkpoints::store::shadows::{
    VolumeFolder, insert_owed_folder_statement, volume_folders,
};
use sidekicks_session::directory::lookups::never_activated_sql;
use sidekicks_session::groups::store::remove_empty_groups_of_session_project_statement;
use sidekicks_session::messaging::exchanges::DELETE_SESSION_EXCHANGES_SQL;
use sidekicks_session::messaging::paused_queue::DELETE_SESSION_PAUSED_MESSAGES_SQL;
use sidekicks_session::messaging::reminders::DELETE_SESSION_REMINDERS_SQL;
use sidekicks_session::messaging::waits::DELETE_SESSION_WAITS_SQL;
use sidekicks_session::questions::projection::QuestionsProjection;
use sidekicks_session::queue_store::plan_message::plan_message_item_sql;
use sidekicks_session::run::ids::SESSION_RUN_IDS_SQL;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, json_list_binding, text_binding,
};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::events::projection::SessionProjection as _;
use sidekicks_workflow::runs::deletion::workflow_run_deletion_statements;
use sidekicks_workspace::folder::canonical_path::canonical_folder_path;
use sidekicks_workspace::repo::mount::service::managed_mount_deletion_statements;

/// The statements the purge's reads prepare, counted into the read pool's statement capacity.
pub(crate) const SESSION_PURGE_STATEMENT_CAPACITY: usize = 8;

/// The position of the guard that no hand-off of a plan the session made waits on its seed, in the
/// mark's write.
pub(super) const HAND_OFF_GUARD_INDEX: usize = 0;

/// The position of the mark itself, in the mark's write.
pub(super) const MARK_INDEX: usize = 1;

/// The position of the guard that the session is still marked for purging, in the delete's write.
pub(super) const MARKED_GUARD_INDEX: usize = 0;

/// The position of the guard that no event of the session lies past the receipt's range.
pub(super) const UPPER_BOUND_GUARD_INDEX: usize = 1;

/// The states a purge marks a session from, by the deletion that asks for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PurgeCaller {
    /// `Delete old data`: an archived or closed session, or one a failed purge left marked.
    Retention,
    /// `Delete session` on a session whose history is damaged: any state but `provisioning`,
    /// which only [`PurgeCaller::UnfinishedCreate`] takes.
    DamagedHistory,
    /// `Delete session` on a session whose create never finished: `provisioning`, `archived`,
    /// `closed`, or one a failed purge left marked, never activated, so a finish that activated it
    /// meanwhile refuses the mark.
    UnfinishedCreate,
}

impl PurgeCaller {
    fn markable_states(self) -> &'static [SessionState] {
        match self {
            Self::UnfinishedCreate => &[
                SessionState::Provisioning,
                SessionState::Archived,
                SessionState::Closed,
                SessionState::PurgeRequested,
            ],
            Self::Retention => &[
                SessionState::Archived,
                SessionState::Closed,
                SessionState::PurgeRequested,
            ],
            Self::DamagedHistory => &[
                SessionState::Active,
                SessionState::Archived,
                SessionState::Closed,
                SessionState::PurgeRequested,
            ],
        }
    }

    // What the mark holds to beside the session's state.
    fn mark_condition(self) -> Option<String> {
        match self {
            Self::UnfinishedCreate => Some(never_activated_sql("@sessionId")),
            Self::Retention | Self::DamagedHistory => None,
        }
    }
}

/// What the purge reads before it deletes a file: the session's workflow runs, the payloads its
/// manifests name and its own folders on other volumes.
pub(super) struct PurgeTargets {
    /// The session's workflow runs.
    pub(super) workflow_run_ids: Vec<WorkflowRunId>,
    /// The payloads the session's manifests name.
    pub(super) payload_hashes: Vec<ContentHash>,
    /// The session's own folders on other volumes, read before their rows go so each is removed
    /// or owed.
    pub(super) volume_folders: Vec<VolumeFolder>,
}

// No hand-off names the session as its planning session while the fresh session's seed has no
// queue item, so the planning session stands until the seed's transcript and manifest are written.
static HAND_OFF_GUARD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 WHERE NOT EXISTS (
     SELECT 1 FROM session_hand_offs AS hand_off
      WHERE hand_off.planning_session_id = @sessionId
        AND NOT EXISTS (
          SELECT 1 FROM queue_items AS item
           WHERE item.session_id = hand_off.session_id AND {}))",
        plan_message_item_sql(
            "item",
            "hand_off.plan_id",
            &format!("'{}'", <&'static str>::from(PlanMessageKind::Seed)),
        )
    )
});

static MARK_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE sessions SET state = '{}', updated_at = @now WHERE id = @sessionId AND state IN",
        <&'static str>::from(SessionState::PurgeRequested)
    )
});

const WORKFLOW_RUN_IDS_SQL: &str = "SELECT id FROM workflow_runs WHERE session_id = @sessionId";

const PAYLOAD_HASHES_SQL: &str = "
  SELECT DISTINCT refs.storage_path
    FROM artifact_payload_refs AS refs
    JOIN artifact_manifests AS manifest ON manifest.id = refs.manifest_id
   WHERE manifest.session_id = @sessionId";

const EVENT_RANGE_SQL: &str = "
  SELECT MIN(sequence), MAX(sequence) FROM session_events WHERE session_id = @sessionId";

const LINKED_SESSIONS_SQL: &str = "
  SELECT target_session_id FROM session_links WHERE source_session_id = @sessionId
  UNION
  SELECT source_session_id FROM session_links WHERE target_session_id = @sessionId";

// The session's worktrees that may go once their folders are checked: retired and cleaned off
// disk, or failed at creation, while no branch context or run names them.
static GONE_WORKTREE_PREDICATE: LazyLock<String> = LazyLock::new(|| {
    format!(
        "created_by_session_id = @sessionId
       AND ((state = '{retired}' AND cleaned_at IS NOT NULL) OR state = '{failed}')
       AND NOT EXISTS (SELECT 1 FROM branch_contexts WHERE worktree_id = worktrees.id)
       AND NOT EXISTS (SELECT 1 FROM run_execution_contexts WHERE worktree_id = worktrees.id)",
        retired = <&'static str>::from(WorktreeState::Retired),
        failed = <&'static str>::from(WorktreeState::Failed),
    )
});

static GONE_WORKTREE_CANDIDATES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, state, fs_root FROM worktrees WHERE {}",
        *GONE_WORKTREE_PREDICATE
    )
});

const PENDING_WORKING_FOLDERS_SQL: &str =
    "SELECT pending_working_folder FROM sessions WHERE pending_working_folder IS NOT NULL";

static MARKED_GUARD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM sessions WHERE id = @sessionId AND state = '{}'",
        <&'static str>::from(SessionState::PurgeRequested)
    )
});

const UPPER_BOUND_GUARD_SQL: &str = "
  SELECT 1 FROM session_events WHERE session_id = @sessionId AND sequence > @lastSequence LIMIT 1";

// The rows keyed by one of the session's runs, each up to the run id it is matched on; the run
// ids are found through the session's runs and its log, so these go before both.
const RUN_KEYED_DELETES: [&str; 4] = [
    "DELETE FROM interventions WHERE target_run_id",
    "DELETE FROM send_now_requests WHERE target_run_id",
    "DELETE FROM runtime_bindings WHERE run_id",
    "DELETE FROM command_receipts WHERE run_id",
];

// The session's own deletes after its run-keyed ones, up to its row, in foreign-key order: a
// snapshot and a recovery checkpoint name the event they reflect, an ask goes after its answer and
// after the gate answers found through it, a plan before the artifact that keeps its text, and an
// artifact after the reference to its payload. The orphaned answers of a card or a question go
// beside the asks they answer, the person's words with them. A checkpoint's versions go first, then
// a window's links to the shadows it stood on, then the windows, then the checkpoints, then the
// shadows, which a version or a link names. The agent tree goes in one statement, each node with
// the children that name it. The attention rows go after the machine's attention count is raised,
// so its readers drop the session's entries, and an entry's delivery before the entry it is found
// through. The messaging rows go at either end of a pair, a message held from the session or a wait
// on it among them. A fork of the session stays whole and names no parent once its parent is gone.
const DELETES_THROUGH_SESSION_ROW: [&str; 44] = [
    "DELETE FROM session_snapshots WHERE session_id = @sessionId",
    "DELETE FROM recovery_checkpoints WHERE session_id = @sessionId",
    "DELETE FROM session_events WHERE session_id = @sessionId",
    "DELETE FROM session_drafts WHERE session_id = @sessionId",
    "DELETE FROM session_kept_schedules WHERE session_id = @sessionId",
    "DELETE FROM session_review_notes WHERE session_id = @sessionId",
    "DELETE FROM workflow_gate_resolutions WHERE approval_request_id IN
       (SELECT id FROM approval_requests WHERE session_id = @sessionId)",
    "DELETE FROM approval_resolutions WHERE request_id IN
       (SELECT id FROM approval_requests WHERE session_id = @sessionId)",
    "DELETE FROM approval_requests WHERE session_id = @sessionId",
    "DELETE FROM approval_correction_uses WHERE session_id = @sessionId",
    "DELETE FROM approval_orphaned_answers WHERE session_id = @sessionId",
    "DELETE FROM question_orphaned_answers WHERE session_id = @sessionId",
    "DELETE FROM reviewer_denials WHERE session_id = @sessionId",
    "DELETE FROM plans WHERE session_id = @sessionId",
    "DELETE FROM artifact_payload_refs WHERE manifest_id IN
       (SELECT id FROM artifact_manifests WHERE session_id = @sessionId)",
    "DELETE FROM artifact_manifests WHERE session_id = @sessionId",
    "DELETE FROM session_restores WHERE session_id = @sessionId",
    "DELETE FROM checkpoint_versions WHERE checkpoint_id IN
       (SELECT checkpoint_id FROM session_checkpoints WHERE session_id = @sessionId)",
    "DELETE FROM checkpoint_window_shadows WHERE shadow_id IN
       (SELECT shadow_id FROM checkpoint_shadows WHERE session_id = @sessionId)",
    "DELETE FROM checkpoint_commands WHERE checkpoint_id IN
       (SELECT checkpoint_id FROM session_checkpoints WHERE session_id = @sessionId)",
    "DELETE FROM session_checkpoints WHERE session_id = @sessionId",
    "DELETE FROM checkpoint_shadows WHERE session_id = @sessionId",
    "DELETE FROM checkpoint_volume_folders WHERE session_id = @sessionId",
    "DELETE FROM agent_tree_nodes WHERE session_id = @sessionId",
    "DELETE FROM agents WHERE session_id = @sessionId",
    "DELETE FROM session_budgets WHERE session_id = @sessionId",
    "DELETE FROM runs WHERE session_id = @sessionId",
    "DELETE FROM projection_cursors WHERE session_id = @sessionId",
    "DELETE FROM session_console_state WHERE session_id = @sessionId",
    "DELETE FROM left_conversations WHERE session_id = @sessionId",
    "DELETE FROM session_links WHERE source_session_id = @sessionId
       OR target_session_id = @sessionId",
    "DELETE FROM session_tags WHERE session_id = @sessionId",
    "DELETE FROM session_related WHERE session_id = @sessionId
       OR related_session_id = @sessionId",
    "UPDATE attention_versions SET version = version + 1
       WHERE scope_key = '' AND EXISTS
         (SELECT 1 FROM attention_entries WHERE session_id = @sessionId)",
    "DELETE FROM attention_deliveries WHERE entry_id IN
       (SELECT id FROM attention_entries WHERE session_id = @sessionId)",
    "DELETE FROM attention_entries WHERE session_id = @sessionId",
    "DELETE FROM attention_seen WHERE session_id = @sessionId",
    "DELETE FROM attention_versions WHERE scope_key = @sessionId",
    DELETE_SESSION_EXCHANGES_SQL,
    DELETE_SESSION_PAUSED_MESSAGES_SQL,
    DELETE_SESSION_WAITS_SQL,
    DELETE_SESSION_REMINDERS_SQL,
    "UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = @sessionId",
    "DELETE FROM sessions WHERE id = @sessionId",
];

// The deletes after the group the session leaves empty, which is found through the session's
// workspaces: every row naming a workspace goes before the workspace. A hand-off row goes with its
// fresh session; one naming the session as its planning session is the fresh session's and stays.
const DELETES_BEFORE_WORKTREES: [&str; 7] = [
    "DELETE FROM session_create_requests WHERE session_id = @sessionId",
    "DELETE FROM session_hand_offs WHERE session_id = @sessionId",
    "DELETE FROM session_convert_requests WHERE session_id = @sessionId",
    "DELETE FROM session_convert_files WHERE session_id = @sessionId",
    "DELETE FROM queue_items WHERE session_id = @sessionId",
    "DELETE FROM run_execution_contexts WHERE session_id = @sessionId
       OR workspace_id IN (SELECT id FROM workspaces WHERE session_id = @sessionId)",
    "DELETE FROM branch_contexts WHERE workspace_id IN
       (SELECT id FROM workspaces WHERE session_id = @sessionId)",
];

// The candidates the folder checks let go, the predicate tested again inside the write.
static GONE_WORKTREES_DELETE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "DELETE FROM worktrees WHERE id IN (SELECT value FROM json_each(@worktreeIds)) AND {}",
        *GONE_WORKTREE_PREDICATE
    )
});

const WORKSPACES_DELETE_SQL: &str = "DELETE FROM workspaces WHERE session_id = @sessionId";

/// The mark's write: its hand-off guard, refused while a hand-off of a plan the session made has no
/// queue item for its seed, then the mark, which moves the session to `purgeRequested` from one of
/// the states `caller` purges and while the caller's condition holds, one row expected, so a
/// session in any other state, or none, refuses the write.
pub(super) fn mark_statements(session_id: SessionId, caller: PurgeCaller) -> Vec<WriteStatement> {
    let from_states = sql_list_of(
        caller
            .markable_states()
            .iter()
            .map(|state| <&'static str>::from(*state)),
    );
    let condition = caller
        .mark_condition()
        .map_or_else(String::new, |condition| format!(" AND {condition}"));
    vec![
        WriteStatement {
            sql: Cow::Borrowed(HAND_OFF_GUARD_SQL.as_str()),
            bindings: StatementBindings::Named(vec![text_binding(
                "@sessionId",
                session_id.text().as_str(),
            )]),
            expected_row_count: Some(1),
        },
        WriteStatement {
            sql: Cow::Owned(format!("{} ({from_states}){condition}", *MARK_SQL)),
            bindings: StatementBindings::Named(vec![
                text_binding("@sessionId", session_id.text().as_str()),
                text_binding("@now", WireInstant::now().as_str()),
            ]),
            expected_row_count: Some(1),
        },
    ]
}

/// What the purge's files and its receipt need, read once the session is marked. Fails when SQLite
/// refuses a read or a stored value does not read as its type.
pub(super) fn read_purge_targets(
    connection: &Connection,
    session_id: SessionId,
) -> Result<PurgeTargets, PurgeReadError> {
    let session_text = session_id.to_string();
    let session = named_params! { "@sessionId": session_text };
    let workflow_run_ids = connection
        .prepare_cached(WORKFLOW_RUN_IDS_SQL)?
        .query_map(session, |row| {
            text_column(row, 0, |text| WorkflowRunId::new(&text))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let payload_hashes = connection
        .prepare_cached(PAYLOAD_HASHES_SQL)?
        .query_map(session, |row| row.get::<_, String>(0))?
        .map(|stored| Ok(ContentHash::from_stored(stored?)?))
        .collect::<Result<_, PurgeReadError>>()?;
    Ok(PurgeTargets {
        workflow_run_ids,
        payload_hashes,
        volume_folders: volume_folders(connection, session_id)?,
    })
}

/// Why a read of the purge failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PurgeReadError {
    /// SQLite refused the read.
    #[error("a read of the purged session's rows failed")]
    Database(#[from] rusqlite::Error),
    /// A stored payload key is no content hash.
    #[error(transparent)]
    ContentHash(#[from] NotAContentHash),
}

/// A session's event rows' first and last sequence, `None` when it has none, and the sessions it is
/// linked to.
pub(super) type RangeAndLinks = (Option<(i64, i64)>, Vec<SessionId>);

/// The session's event rows' first and last sequence, `None` when it has none, and the sessions
/// it is linked to, whose related lists the purge has scored again.
pub(super) fn read_range_and_links(
    connection: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<RangeAndLinks> {
    let session_text = session_id.to_string();
    let session = named_params! { "@sessionId": session_text };
    let range = connection
        .prepare_cached(EVENT_RANGE_SQL)?
        .query_row(session, |row| {
            Ok(row
                .get::<_, Option<i64>>(0)?
                .zip(row.get::<_, Option<i64>>(1)?))
        })?;
    let linked = connection
        .prepare_cached(LINKED_SESSIONS_SQL)?
        .query_map(session, |row| {
            text_column(row, 0, |text| SessionId::new(&text))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok((range, linked))
}

/// One worktree the session made that its rows may take with them, as the read finds it.
pub(super) struct GoneWorktreeCandidate {
    id: String,
    is_failed: bool,
    fs_root: PathBuf,
}

/// The session's worktrees that may go, before their folders are checked, and every folder a
/// pending working-folder move names.
pub(super) fn read_gone_worktree_candidates(
    connection: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<(Vec<GoneWorktreeCandidate>, Vec<PathBuf>)> {
    let failed = <&'static str>::from(WorktreeState::Failed);
    let candidates = connection
        .prepare_cached(&GONE_WORKTREE_CANDIDATES_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            |row| {
                Ok(GoneWorktreeCandidate {
                    id: row.get(0)?,
                    is_failed: row.get::<_, String>(1)? == failed,
                    fs_root: PathBuf::from(row.get::<_, String>(2)?),
                })
            },
        )?
        .collect::<rusqlite::Result<_>>()?;
    let pending = connection
        .prepare_cached(PENDING_WORKING_FOLDERS_SQL)?
        .query_map([], |row| Ok(PathBuf::from(row.get::<_, String>(0)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok((candidates, pending))
}

/// The candidates whose rows may go: a worktree still on disk is the project's file and keeps its
/// row, which its removal needs, a failed one's attempt included, and so does one a pending move
/// names, the folders compared resolved. Fails when a folder cannot be resolved.
pub(super) async fn gone_worktree_ids(
    candidates: Vec<GoneWorktreeCandidate>,
    pending_folders: Vec<PathBuf>,
) -> std::io::Result<Vec<String>> {
    let mut pending_keys = HashSet::with_capacity(pending_folders.len());
    for folder in &pending_folders {
        pending_keys.insert(canonical_folder_path(folder).await?);
    }
    let mut gone = Vec::new();
    for candidate in candidates {
        if pending_keys.contains(&canonical_folder_path(&candidate.fs_root).await?) {
            continue;
        }
        if candidate.is_failed && tokio::fs::try_exists(&candidate.fs_root).await? {
            continue;
        }
        gone.push(candidate.id);
    }
    Ok(gone)
}

/// The one write that deletes every row naming the session, led by its two guards: the session is
/// still marked, and no event of it lies past `last_sequence` (its receipt's range, `None` for a
/// session with no event). The workflow runs go first with every row hanging off them, then the
/// rows keyed by the session's runs, then its questions and the queued answers paired with them,
/// then the session's own, its plans and its hand-off row among them, then the chat's managed
/// mount, and last one owed row for each of `owed_folders`, the session's folders on volumes that
/// were absent, so each folder stays named by one row or the other.
pub(super) fn session_deletion_statements(
    session_id: SessionId,
    last_sequence: Option<i64>,
    workflow_run_ids: &[WorkflowRunId],
    gone_worktree_ids: &[String],
    owed_folders: &[VolumeFolder],
) -> Vec<WriteStatement> {
    let session_binding = || text_binding("@sessionId", session_id.text().as_str());
    let by_session = |sql: Cow<'static, str>| WriteStatement {
        sql,
        bindings: StatementBindings::Named(vec![session_binding()]),
        expected_row_count: None,
    };
    let mut statements = vec![
        WriteStatement {
            sql: Cow::Borrowed(MARKED_GUARD_SQL.as_str()),
            bindings: StatementBindings::Named(vec![session_binding()]),
            expected_row_count: Some(1),
        },
        WriteStatement {
            sql: Cow::Borrowed(UPPER_BOUND_GUARD_SQL),
            bindings: StatementBindings::Named(vec![
                session_binding(),
                (
                    Cow::Borrowed("@lastSequence"),
                    Value::Integer(last_sequence.unwrap_or(-1)),
                ),
            ]),
            expected_row_count: Some(0),
        },
    ];
    statements.extend(workflow_run_deletion_statements(workflow_run_ids));
    statements.extend(
        RUN_KEYED_DELETES
            .iter()
            .map(|delete| by_session(Cow::Owned(format!("{delete} IN ({SESSION_RUN_IDS_SQL})")))),
    );
    // The questions' rows go as their projection's rebuild clears them.
    statements.extend(QuestionsProjection.clear_statements(&session_id));
    statements.extend(
        DELETES_THROUGH_SESSION_ROW
            .iter()
            .map(|sql| by_session(Cow::Borrowed(*sql))),
    );
    statements.push(remove_empty_groups_of_session_project_statement(
        &session_id,
    ));
    statements.extend(
        DELETES_BEFORE_WORKTREES
            .iter()
            .map(|sql| by_session(Cow::Borrowed(*sql))),
    );
    statements.push(WriteStatement {
        sql: Cow::Borrowed(GONE_WORKTREES_DELETE_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            session_binding(),
            json_list_binding("@worktreeIds", &gone_worktree_ids),
        ]),
        expected_row_count: None,
    });
    statements.push(by_session(Cow::Borrowed(WORKSPACES_DELETE_SQL)));
    statements.extend(managed_mount_deletion_statements(session_id));
    statements.extend(owed_folders.iter().map(insert_owed_folder_statement));
    statements
}
