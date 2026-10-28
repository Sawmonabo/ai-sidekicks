//! What a session's purge reads and writes in the database: the mark, the reads of what its files
//! and its receipt need, and the one write that deletes every row naming the session.

use std::borrow::Cow;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::LazyLock;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_artifact::payload_store::{ContentHash, NotAContentHash};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::worktree::lifecycle::WorktreeState;
use sidekicks_session::groups::store::remove_empty_groups_of_session_project_statement;
use sidekicks_session::run::ids::SESSION_RUN_IDS_SQL;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_workflow::runs::deletion::workflow_run_deletion_statements;
use sidekicks_workspace::folder::canonical_path::canonical_folder_path;
use sidekicks_workspace::git::turn_snapshot::retention::RunContextKey;
use sidekicks_workspace::repo::mount::service::managed_mount_deletion_statements;

/// The statements the purge's reads prepare, counted into the read pool's statement capacity.
pub(crate) const SESSION_PURGE_STATEMENT_CAPACITY: usize = 9;

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
    /// since a damaged session takes no close.
    DamagedHistory,
}

impl PurgeCaller {
    fn markable_states(self) -> &'static [SessionState] {
        match self {
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
}

/// A run whose snapshot refs the purge prunes: its key and the git folder its context recorded.
pub(super) struct PurgedRunContext {
    /// The run's context key, an agent run's or a workflow run's.
    pub(super) run_key: RunContextKey,
    /// The repository's common git folder.
    pub(super) git_common_dir: PathBuf,
}

/// What the purge reads before it deletes a file: where the session ran, its runs' git folders,
/// its workflow runs, and the payloads its manifests name.
pub(super) struct PurgeTargets {
    /// Where the session runs; `None` on macOS and Linux.
    pub(super) place: Option<Place>,
    /// Every run context of the session, its workflow runs' among them.
    pub(super) run_contexts: Vec<PurgedRunContext>,
    /// The session's workflow runs.
    pub(super) workflow_run_ids: Vec<WorkflowRunId>,
    /// The payloads the session's manifests name.
    pub(super) payload_hashes: Vec<ContentHash>,
}

/// A stored value of the purge's reads that does not read as its type.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PurgeStoredValueError {
    /// A stored payload key is no content hash.
    #[error(transparent)]
    ContentHash(#[from] NotAContentHash),
    /// A stored place is not a place's JSON.
    #[error("the session's stored place is not a place")]
    Place(#[from] serde_json::Error),
}

static MARK_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE sessions SET state = '{}', updated_at = @now WHERE id = @sessionId AND state IN",
        <&'static str>::from(SessionState::PurgeRequested)
    )
});

const SESSION_PLACE_SQL: &str = "SELECT place FROM sessions WHERE id = @sessionId";

// Every run context of the session: its agent runs', those on its workspaces, and its workflow
// runs', each told by whether a workflow run carries its key.
const RUN_CONTEXTS_SQL: &str = "
  SELECT ctx.run_id, ctx.git_common_dir,
         EXISTS (SELECT 1 FROM workflow_runs WHERE id = ctx.run_id)
    FROM run_execution_contexts AS ctx
   WHERE ctx.session_id = @sessionId
      OR ctx.workspace_id IN (SELECT id FROM workspaces WHERE session_id = @sessionId)
      OR ctx.run_id IN (SELECT id FROM workflow_runs WHERE session_id = @sessionId)";

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
// after the gate answers found through it, and an artifact after the reference to its payload.
const DELETES_THROUGH_SESSION_ROW: [&str; 20] = [
    "DELETE FROM session_snapshots WHERE session_id = @sessionId",
    "DELETE FROM recovery_checkpoints WHERE session_id = @sessionId",
    "DELETE FROM session_events WHERE session_id = @sessionId",
    "DELETE FROM session_drafts WHERE session_id = @sessionId",
    "DELETE FROM session_review_notes WHERE session_id = @sessionId",
    "DELETE FROM workflow_gate_resolutions WHERE approval_request_id IN
       (SELECT id FROM approval_requests WHERE session_id = @sessionId)",
    "DELETE FROM approval_resolutions WHERE request_id IN
       (SELECT id FROM approval_requests WHERE session_id = @sessionId)",
    "DELETE FROM approval_requests WHERE session_id = @sessionId",
    "DELETE FROM approval_correction_uses WHERE session_id = @sessionId",
    "DELETE FROM reviewer_denials WHERE session_id = @sessionId",
    "DELETE FROM artifact_payload_refs WHERE manifest_id IN
       (SELECT id FROM artifact_manifests WHERE session_id = @sessionId)",
    "DELETE FROM artifact_manifests WHERE session_id = @sessionId",
    "DELETE FROM runs WHERE session_id = @sessionId",
    "DELETE FROM projection_cursors WHERE session_id = @sessionId",
    "DELETE FROM session_console_state WHERE session_id = @sessionId",
    "DELETE FROM left_conversations WHERE session_id = @sessionId",
    "DELETE FROM session_links WHERE source_session_id = @sessionId
       OR target_session_id = @sessionId",
    "DELETE FROM session_tags WHERE session_id = @sessionId",
    "DELETE FROM session_related WHERE session_id = @sessionId
       OR related_session_id = @sessionId",
    "DELETE FROM sessions WHERE id = @sessionId",
];

// The deletes after the group the session leaves empty, which is found through the session's
// workspaces: every row naming a workspace goes before the workspace.
const DELETES_BEFORE_WORKTREES: [&str; 6] = [
    "DELETE FROM session_create_requests WHERE session_id = @sessionId",
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

/// The mark: the session moves to `purgeRequested` from one of the states `caller` purges, one row
/// expected, so a session in any other state, or none, refuses the write.
pub(super) fn mark_statement(session_id: SessionId, caller: PurgeCaller) -> WriteStatement {
    let from_states = sql_list_of(
        caller
            .markable_states()
            .iter()
            .map(|state| <&'static str>::from(*state)),
    );
    WriteStatement {
        sql: Cow::Owned(format!("{} ({from_states})", *MARK_SQL)),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@now", WireInstant::now().as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// What the purge's files and its receipt need, read once the session is marked. Fails when SQLite
/// refuses a read or a stored value does not read as its type.
pub(super) fn read_purge_targets(
    connection: &Connection,
    session_id: SessionId,
) -> Result<PurgeTargets, PurgeReadError> {
    let session_text = session_id.to_string();
    let session = named_params! { "@sessionId": session_text };
    let place = connection
        .prepare_cached(SESSION_PLACE_SQL)?
        .query_row(session, |row| row.get::<_, Option<String>>(0))
        .optional()?
        .flatten()
        .map(|place| serde_json::from_str::<Place>(&place))
        .transpose()
        .map_err(PurgeStoredValueError::from)?;
    let run_contexts = connection
        .prepare_cached(RUN_CONTEXTS_SQL)?
        .query_map(session, |row| {
            let is_workflow_run: bool = row.get(2)?;
            let run_key = if is_workflow_run {
                RunContextKey::from(text_column(row, 0, |text| WorkflowRunId::new(&text))?)
            } else {
                RunContextKey::from(text_column(row, 0, |text| RunId::new(&text))?)
            };
            Ok(PurgedRunContext {
                run_key,
                git_common_dir: PathBuf::from(row.get::<_, String>(1)?),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let workflow_run_ids = connection
        .prepare_cached(WORKFLOW_RUN_IDS_SQL)?
        .query_map(session, |row| {
            text_column(row, 0, |text| WorkflowRunId::new(&text))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let payload_hashes = connection
        .prepare_cached(PAYLOAD_HASHES_SQL)?
        .query_map(session, |row| row.get::<_, String>(0))?
        .map(|stored| Ok(ContentHash::from_stored(stored?).map_err(PurgeStoredValueError::from)?))
        .collect::<Result<_, PurgeReadError>>()?;
    Ok(PurgeTargets {
        place,
        run_contexts,
        workflow_run_ids,
        payload_hashes,
    })
}

/// Why a read of the purge failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PurgeReadError {
    /// SQLite refused the read.
    #[error("a read of the purged session's rows failed")]
    Database(#[from] rusqlite::Error),
    /// A stored value does not read as its type.
    #[error(transparent)]
    StoredValue(#[from] PurgeStoredValueError),
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
/// rows keyed by the session's runs, then the session's own, the chat's managed mount last.
pub(super) fn session_deletion_statements(
    session_id: SessionId,
    last_sequence: Option<i64>,
    workflow_run_ids: &[WorkflowRunId],
    gone_worktree_ids: &[String],
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
            text_binding(
                "@worktreeIds",
                &serde_json::to_string(gone_worktree_ids).expect("worktree ids write as JSON"),
            ),
        ]),
        expected_row_count: None,
    });
    statements.push(by_session(Cow::Borrowed(WORKSPACES_DELETE_SQL)));
    statements.extend(managed_mount_deletion_statements(session_id));
    statements
}
