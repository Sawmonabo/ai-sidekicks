//! The folders other sessions' runs are live in, each with its session and the run, an agent's
//! named by its agent or a workflow's, read in one pass for a worktree creation that would stash a
//! checkout's uncommitted work from under them; and what one running run is, which a repository
//! re-attach's conflict names. A run in the run engine's `runs` table is an agent's; any other
//! with a live context is a workflow run.

use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use rusqlite::{Connection, Row, named_params};
use sidekicks_contracts::repo::mount::WorkspaceState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::worktree::lifecycle::RunningHolder;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_workspace::git::worktree::creation::{
    LiveRunFolder, LiveRunFolderReadError, LiveRunFolderReader,
};
use sidekicks_workspace::repo::mount::reattach::{RunningHolderLookup, RunningHolderLookupError};
use sidekicks_workspace::row_guards::CHECKOUT_ROOT_METADATA_PATH;

use crate::run::agent::{RUN_AGENT_STATEMENT_CAPACITY, RunAgentReadError, RunAgentReader};

// A run whose execution context is unreleased, at its checkout, and a run still queued or starting,
// at the checkout its session's own workspace works in now, each of a session other than the
// caller's and each with whether it is an agent's run.
static OTHER_SESSIONS_LIVE_RUN_FOLDERS_SQL: LazyLock<String> = LazyLock::new(|| {
    let queued = <&'static str>::from(RunState::Queued);
    let starting = <&'static str>::from(RunState::Starting);
    let archived = <&'static str>::from(WorkspaceState::Archived);
    format!(
        "SELECT session_id, run_id, is_agent_run, folder FROM (
    SELECT run.session_id AS session_id, run.run_id AS run_id,
           EXISTS (SELECT 1 FROM runs WHERE runs.run_id = run.run_id) AS is_agent_run,
           run.checkout_root AS folder
      FROM run_execution_contexts AS run
     WHERE run.released_at IS NULL
    UNION ALL
    SELECT runs.session_id AS session_id, runs.run_id AS run_id, 1 AS is_agent_run,
           COALESCE(json_extract(standing.metadata, '{CHECKOUT_ROOT_METADATA_PATH}'),
                    standing.fs_root) AS folder
      FROM runs
      JOIN workspaces AS standing ON standing.session_id = runs.session_id
     WHERE runs.state IN ('{queued}', '{starting}')
       AND standing.state <> '{archived}'
       AND standing.workflow_run_id IS NULL
       AND standing.fs_root IS NOT NULL
  )
  WHERE session_id <> @session_id"
    )
});

// The run's id read back beside whether it is an agent's run, so one row reader parses both.
const IS_AGENT_RUN_SQL: &str =
    "SELECT @run_id, EXISTS (SELECT 1 FROM runs WHERE runs.run_id = @run_id)";

// Why the read failed, kept whole as the port's cause.
#[derive(Debug, thiserror::Error)]
enum LiveRunFoldersError {
    #[error("the live runs did not reach the database")]
    Pool(#[from] DatabaseReadError),
    #[error("the live runs could not be read")]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Agent(#[from] RunAgentReadError),
}

/// The statements the live runs' folders prepare on a read connection: the other sessions' live
/// runs, whether one run is an agent's, and the run agent reader's.
pub const SESSION_LIVE_RUN_FOLDERS_STATEMENT_CAPACITY: usize = 2 + RUN_AGENT_STATEMENT_CAPACITY;

/// Reads the live runs' folders, and what one running run is, from the daemon's database, each
/// agent run's agent from its session's log on the same connection.
pub struct SessionLiveRunFolders {
    reads: Arc<DatabaseReadPool>,
}

impl SessionLiveRunFolders {
    /// A reader over the daemon's read pool.
    pub fn new(reads: Arc<DatabaseReadPool>) -> Self {
        Self { reads }
    }
}

impl LiveRunFolderReader for SessionLiveRunFolders {
    fn read_other_sessions_live_runs<'a>(
        &'a self,
        session_id: &'a SessionId,
    ) -> BoxFuture<'a, Result<Vec<LiveRunFolder>, LiveRunFolderReadError>> {
        let session_id = *session_id;
        Box::pin(async move {
            self.reads
                .read(ReadLength::Short, move |connection| {
                    read_live_run_folders(connection, &session_id)
                })
                .await
                .map_err(|failure: LiveRunFoldersError| LiveRunFolderReadError(Box::new(failure)))
        })
    }
}

impl RunningHolderLookup for SessionLiveRunFolders {
    fn read_running_holder<'a>(
        &'a self,
        session_id: &'a SessionId,
        run_id: &'a str,
    ) -> BoxFuture<'a, Result<RunningHolder, RunningHolderLookupError>> {
        let (session_id, run_id) = (*session_id, run_id.to_owned());
        Box::pin(async move {
            self.reads
                .read(ReadLength::Short, move |connection| {
                    let run = connection
                        .prepare_cached(IS_AGENT_RUN_SQL)?
                        .query_row(named_params! { "@run_id": run_id }, |row| {
                            live_run(row, 0, 1)
                        })?;
                    holder_of(&RunAgentReader::new(connection), &session_id, run)
                })
                .await
                .map_err(|failure: LiveRunFoldersError| RunningHolderLookupError(Box::new(failure)))
        })
    }
}

/// A live run by its id: an agent's run, whose agent its session's log names, or a workflow run.
#[derive(Clone, Copy)]
enum LiveRun {
    Agent(RunId),
    WorkflowRun(WorkflowRunId),
}

// The run whose id is at `id_index` and whether it is an agent's at `is_agent_run_index`.
fn live_run(
    row: &Row<'_>,
    id_index: usize,
    is_agent_run_index: usize,
) -> rusqlite::Result<LiveRun> {
    Ok(if row.get(is_agent_run_index)? {
        LiveRun::Agent(text_column(row, id_index, |text| RunId::new(&text))?)
    } else {
        LiveRun::WorkflowRun(text_column(row, id_index, |text| {
            WorkflowRunId::new(&text)
        })?)
    })
}

fn holder_of(
    agents: &RunAgentReader<'_>,
    session_id: &SessionId,
    run: LiveRun,
) -> Result<RunningHolder, LiveRunFoldersError> {
    Ok(match run {
        LiveRun::Agent(run_id) => RunningHolder::Agent {
            agent_id: agents.read_agent(session_id, &run_id)?,
        },
        LiveRun::WorkflowRun(run_id) => RunningHolder::WorkflowRun { run_id },
    })
}

fn read_live_run_folders(
    connection: &Connection,
    session_id: &SessionId,
) -> Result<Vec<LiveRunFolder>, LiveRunFoldersError> {
    let runs = connection
        .prepare_cached(OTHER_SESSIONS_LIVE_RUN_FOLDERS_SQL.as_str())?
        .query_map(
            named_params! { "@session_id": session_id.text().as_str() },
            |row| {
                Ok((
                    text_column(row, 0, |text| SessionId::new(&text))?,
                    live_run(row, 1, 2)?,
                    PathBuf::from(row.get::<_, String>(3)?),
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let agents = RunAgentReader::new(connection);
    runs.into_iter()
        .map(|(run_session_id, run, folder)| {
            Ok(LiveRunFolder {
                session_id: run_session_id,
                holder: holder_of(&agents, &run_session_id, run)?,
                folder,
            })
        })
        .collect()
}
