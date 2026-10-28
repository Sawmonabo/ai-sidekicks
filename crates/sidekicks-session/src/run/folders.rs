//! The folders other sessions' runs are live in, each with its session and the agent the run is
//! for, read in one pass for a worktree creation that would stash a checkout's uncommitted work
//! from under them.

use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use rusqlite::{Connection, named_params};
use sidekicks_contracts::repo::mount::WorkspaceState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_workspace::git::worktree::creation::{
    LiveRunFolder, LiveRunFolderReadError, LiveRunFolderReader,
};
use sidekicks_workspace::row_guards::CHECKOUT_ROOT_METADATA_PATH;

use crate::run::agent::{RunAgentReadError, RunAgentReader};

// A run whose execution context is unreleased, at its checkout, and a run still queued or starting,
// at the checkout its session's workspace works in now, each of a session other than the caller's.
static OTHER_SESSIONS_LIVE_RUN_FOLDERS_SQL: LazyLock<String> = LazyLock::new(|| {
    let queued = <&'static str>::from(RunState::Queued);
    let starting = <&'static str>::from(RunState::Starting);
    let archived = <&'static str>::from(WorkspaceState::Archived);
    format!(
        "SELECT session_id, run_id, folder FROM (
    SELECT run.session_id AS session_id, run.run_id AS run_id, run.checkout_root AS folder
      FROM run_execution_contexts AS run
     WHERE run.released_at IS NULL
    UNION ALL
    SELECT runs.session_id AS session_id, runs.run_id AS run_id,
           COALESCE(json_extract(standing.metadata, '{CHECKOUT_ROOT_METADATA_PATH}'),
                    standing.fs_root) AS folder
      FROM runs
      JOIN workspaces AS standing ON standing.session_id = runs.session_id
     WHERE runs.state IN ('{queued}', '{starting}')
       AND standing.state <> '{archived}'
       AND standing.fs_root IS NOT NULL
  )
  WHERE session_id <> @session_id"
    )
});

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

/// Reads the live runs' folders from the daemon's database, each run's agent from its session's
/// log on the same connection.
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
                    text_column(row, 1, |text| RunId::new(&text))?,
                    PathBuf::from(row.get::<_, String>(2)?),
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let agents = RunAgentReader::new(connection);
    runs.into_iter()
        .map(|(run_session_id, run_id, folder)| {
            Ok(LiveRunFolder {
                session_id: run_session_id,
                agent_id: agents.read_agent(&run_session_id, &run_id)?,
                folder,
            })
        })
        .collect()
}
