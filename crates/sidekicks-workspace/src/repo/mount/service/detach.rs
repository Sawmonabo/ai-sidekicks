//! A mount's detach: the running check, the archive of its workspaces and the flip in one write,
//! then each archived workspace's `workspace.archived`.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::repo::mount::{
    LifecycleActor, RepoMountId, RepoMountState, WorkspaceId, WorkspaceState,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::settle_all::settle_all;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::database::writer::WriteError;
use sidekicks_store::events::session::appender::SessionEventLinkage;

use super::{RepoMountService, RepoMountServiceError};
use crate::event_emitter::EmitWorkspaceEventInput;
use crate::repo::errors::RepoRefusal;
use crate::schema::MountOrigin;

// The detach write's statements, by position: the running check refuses when it finds a run, and
// the flip refuses when another detach or a re-attach moved the mount first.
const RUNNING_SESSION_STATEMENT: usize = 0;
const ARCHIVABLE_DEPENDENTS_STATEMENT: usize = 1;
const DETACH_MOUNT_STATEMENT: usize = 3;

// True while an agent runs anywhere in the project `@repo_mount_id` serves: a run whose execution
// root is unreleased, in a workspace on any of the project's mounts. A predicate over the
// `run_context` alias of `run_execution_contexts`.
const RUN_IN_PROJECT_PREDICATE: &str = "run_context.released_at IS NULL
   AND run_context.workspace_id IN (
     SELECT project_workspace.id
       FROM workspaces AS project_workspace
       JOIN repo_mounts AS project_mount ON project_mount.id = project_workspace.repo_mount_id
      WHERE project_mount.id = @repo_mount_id
         OR project_mount.project_id = (
              SELECT project_id FROM repo_mounts WHERE id = @repo_mount_id))";

// The oldest unreleased run's session is the one a refusal names; `run_id` breaks ties between
// runs started in the same tick.
static SELECT_RUNNING_SESSION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run_context.session_id
     FROM run_execution_contexts AS run_context
    WHERE {RUN_IN_PROJECT_PREDICATE}
    ORDER BY run_context.created_at ASC, run_context.run_id ASC
    LIMIT 1"
    )
});

// The dependents the archive moves, in event order; read in the same write, so the list and the
// archive agree.
static SELECT_ARCHIVABLE_DEPENDENTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, session_id
     FROM workspaces
    WHERE repo_mount_id = @repo_mount_id AND state <> '{}'
    ORDER BY created_at ASC, id ASC",
        <&'static str>::from(WorkspaceState::Archived)
    )
});

static ARCHIVE_DEPENDENTS_SQL: LazyLock<String> = LazyLock::new(|| {
    let archived = <&'static str>::from(WorkspaceState::Archived);
    format!(
        "UPDATE workspaces
      SET state = '{archived}', updated_at = @now
    WHERE repo_mount_id = @repo_mount_id AND state <> '{archived}'"
    )
});

// Compare-and-swap: `attached` in the predicate is the legal predecessor and the mutual exclusion
// between concurrent detaches and re-attaches.
static DETACH_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE repo_mounts
      SET state = '{}', updated_at = @now
    WHERE id = @repo_mount_id AND state = '{}'",
        <&'static str>::from(RepoMountState::Detached),
        <&'static str>::from(RepoMountState::Attached),
    )
});

/// What a detach did to the mount and its workspaces; the `repoMount.detach` reply adds the
/// forgotten project and the archived sessions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepoMountDetachOutcome {
    /// The mount.
    pub(crate) repo_mount_id: RepoMountId,
    /// Its state after the call.
    pub(crate) state: RepoMountState,
    /// The workspaces this call archived, in event order.
    pub(crate) archived_workspace_ids: Vec<WorkspaceId>,
}

// How one try of a detach's write ended.
enum DetachTry {
    // The detach's answer.
    Answered(RepoMountDetachOutcome),
    // The running check refused, and the run it found ended before its session was read.
    RunEnded(WriteError),
}

/// A detach: the mount, who asked, and the linkage every cascaded `workspace.archived` carries.
#[derive(Clone, Debug)]
pub(crate) struct DetachRepoMount {
    /// The mount to detach.
    pub(crate) repo_mount_id: RepoMountId,
    /// Who acted; `None` when the daemon did.
    pub(crate) actor: Option<LifecycleActor>,
    /// The id tying the archivals to the detach.
    pub(crate) correlation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the repository mount detach handler")
)]
impl RepoMountService {
    /// Detaches a mount and archives its workspaces (nothing changes when it is not `attached`),
    /// running `following_statements` (the project writer's forgetting of the record) in the same
    /// write after the flip. Refuses `repoMount.managed` for a chat's managed mount,
    /// `repoMount.detachConflict` naming the running session while an agent runs anywhere in its
    /// project, and `repoMount.notFound`. A run that ends between the running check and the read
    /// of its session is no conflict, so the detach is tried once more, and a second such race
    /// fails with the write's refusal. Fails with
    /// [`RepoMountServiceError::DetachNotificationIncomplete`] when it committed but an event
    /// append failed, and [`RepoMountServiceError::DetachArchivalsUnread`] when it committed but
    /// an archived workspace did not read.
    pub(crate) async fn detach(
        &self,
        request: DetachRepoMount,
        following_statements: Vec<WriteStatement>,
    ) -> Result<RepoMountDetachOutcome, RepoMountServiceError> {
        match self
            .try_detach(&request, following_statements.clone())
            .await?
        {
            DetachTry::Answered(outcome) => Ok(outcome),
            DetachTry::RunEnded(_refused) => {
                match self.try_detach(&request, following_statements).await? {
                    DetachTry::Answered(outcome) => Ok(outcome),
                    DetachTry::RunEnded(refused) => Err(refused.into()),
                }
            }
        }
    }

    // One try of the detach; a running check whose run ended before its session was read is
    // handed back for the caller to try again.
    async fn try_detach(
        &self,
        request: &DetachRepoMount,
        following_statements: Vec<WriteStatement>,
    ) -> Result<DetachTry, RepoMountServiceError> {
        let repo_mount_id = request.repo_mount_id;
        let row = self.read_row(repo_mount_id).await?;
        // A chat's managed workspace goes only with its chat's purge; the origin never changes, so
        // the row read decides it.
        if row.origin != MountOrigin::Attached {
            return Err(RepoRefusal::MountManaged { repo_mount_id }.into());
        }
        if row.state != RepoMountState::Attached {
            return Ok(DetachTry::Answered(unchanged_outcome(
                repo_mount_id,
                row.state,
            )));
        }
        #[cfg(test)]
        self.detach_pause.pass().await;

        // Each statement binds only the names it holds, since the writer refuses any other.
        let mount = text_binding("@repo_mount_id", repo_mount_id.text().as_str());
        let now = text_binding("@now", WireInstant::now().as_str());
        let statement = |sql: &'static str, bindings, expected_row_count| WriteStatement {
            sql: Cow::Borrowed(sql),
            bindings: StatementBindings::Named(bindings),
            expected_row_count,
        };
        let mut statements = vec![
            statement(
                SELECT_RUNNING_SESSION_SQL.as_str(),
                vec![mount.clone()],
                Some(0),
            ),
            statement(
                SELECT_ARCHIVABLE_DEPENDENTS_SQL.as_str(),
                vec![mount.clone()],
                None,
            ),
            statement(
                ARCHIVE_DEPENDENTS_SQL.as_str(),
                vec![mount.clone(), now.clone()],
                None,
            ),
            statement(DETACH_MOUNT_SQL.as_str(), vec![mount, now], Some(1)),
        ];
        statements.extend(following_statements);
        let results = match self.writer.write(statements).await {
            Ok(results) => results,
            Err(error) => return self.outcome_of_refused_detach(repo_mount_id, error).await,
        };
        let archived = archived_workspaces(&results[ARCHIVABLE_DEPENDENTS_STATEMENT].rows)
            .map_err(|source| RepoMountServiceError::DetachArchivalsUnread {
                repo_mount_id,
                source,
            })?;

        // After the commit, so a crash cannot log archivals for rows that never moved. Every append
        // is tried even after one fails.
        let mut appends = Vec::with_capacity(archived.len());
        for (workspace_id, session_id) in &archived {
            let input = EmitWorkspaceEventInput {
                session_id: *session_id,
                workspace_id: *workspace_id,
                repo_mount_id: Some(repo_mount_id),
                actor: request.actor.clone(),
            };
            let linkage = SessionEventLinkage {
                correlation_id: request.correlation_id.clone(),
                ..SessionEventLinkage::default()
            };
            appends.push(self.events.emit_workspace_archived(input, linkage).await);
        }
        settle_all(appends, "announcing a detach's archived workspaces").map_err(|source| {
            RepoMountServiceError::DetachNotificationIncomplete {
                repo_mount_id,
                source,
            }
        })?;
        Ok(DetachTry::Answered(RepoMountDetachOutcome {
            repo_mount_id,
            state: RepoMountState::Detached,
            archived_workspace_ids: archived
                .into_iter()
                .map(|(workspace_id, _)| workspace_id)
                .collect(),
        }))
    }

    // A refused detach write: a run in the project refuses it naming its session, and a run that
    // ended before its session was read is handed back to try again; a flip another detach or
    // re-attach won changed nothing, so the mount's state now is the answer; anything else is the
    // write's failure.
    async fn outcome_of_refused_detach(
        &self,
        repo_mount_id: RepoMountId,
        error: WriteError,
    ) -> Result<DetachTry, RepoMountServiceError> {
        match error.refused_statement_index() {
            Some(RUNNING_SESSION_STATEMENT) => {
                #[cfg(test)]
                self.running_read_pause.pass().await;
                let running = self
                    .reads
                    .read(ReadLength::Short, move |connection| {
                        read_running_session(connection, repo_mount_id)
                    })
                    .await?;
                return match running {
                    Some(running_session_id) => {
                        Err(RepoRefusal::DetachConflict { running_session_id }.into())
                    }
                    None => Ok(DetachTry::RunEnded(error)),
                };
            }
            Some(DETACH_MOUNT_STATEMENT) => {
                let current = self.read_row(repo_mount_id).await?;
                if current.state != RepoMountState::Attached {
                    return Ok(DetachTry::Answered(unchanged_outcome(
                        repo_mount_id,
                        current.state,
                    )));
                }
            }
            Some(_) | None => {}
        }
        Err(error.into())
    }
}

fn unchanged_outcome(repo_mount_id: RepoMountId, state: RepoMountState) -> RepoMountDetachOutcome {
    RepoMountDetachOutcome {
        repo_mount_id,
        state,
        archived_workspace_ids: Vec::new(),
    }
}

// The archivable dependents the detach's write read: each workspace with its session.
fn archived_workspaces(
    rows: &[Vec<Value>],
) -> Result<Vec<(WorkspaceId, SessionId)>, rusqlite::Error> {
    rows.iter()
        .map(|row| {
            let (workspace_id, session_id) = match row.as_slice() {
                [Value::Text(workspace_id), Value::Text(session_id)] => {
                    Some((workspace_id, session_id))
                }
                _ => None,
            }
            .expect("the dependents read selects two TEXT columns of a STRICT table");
            let workspace_id =
                WorkspaceId::new(workspace_id).map_err(|error| conversion_failure(0, error))?;
            let session_id =
                SessionId::new(session_id).map_err(|error| conversion_failure(1, error))?;
            Ok((workspace_id, session_id))
        })
        .collect()
}

fn conversion_failure(
    index: usize,
    failure: impl std::error::Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(failure))
}

fn read_running_session(
    connection: &Connection,
    repo_mount_id: RepoMountId,
) -> Result<Option<SessionId>, RepoMountServiceError> {
    Ok(connection
        .prepare_cached(&SELECT_RUNNING_SESSION_SQL)?
        .query_row(
            named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
            |row| text_column(row, 0, |text| SessionId::new(&text)),
        )
        .optional()?)
}
