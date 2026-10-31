//! Creating a run's row: the statements the engine's run start writes in one unit of work with the
//! run's started event, whose instant is the run's start, so a run, its place in its chain and its
//! execution context are stored together or not at all.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::LazyLock;

use rusqlite::types::Value;
use serde::Serialize;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::document::{WorkflowNodeId, WorkflowVersionId};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowRunStatus;
use sidekicks_contracts::workflow::run::trigger::{
    WorkflowRunMode, WorkflowStartedBy, WorkflowTriggerKind,
};
use sidekicks_contracts::worktree::lifecycle::{BranchContextId, WorktreeId};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};

/// Which trigger node started a run, stored as the run's trigger record.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run engine's start, which writes them with the run's started event"
    )
)]
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowRunTrigger {
    /// The trigger node's kind.
    pub(crate) kind: WorkflowTriggerKind,
    /// The trigger node.
    pub(crate) node_id: WorkflowNodeId,
}

/// A run's place in its chain: it starts a chain of its own, or it joins the chain whose first run
/// is `chain_root_run_id`, through an error trigger when `is_from_error`.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run engine's start, which writes them with the run's started event"
    )
)]
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum WorkflowRunChainPlace {
    /// The run is its chain's first run.
    Starts,
    /// The run joins another run's chain.
    Joins {
        /// The chain's first run.
        chain_root_run_id: WorkflowRunId,
        /// Whether an error trigger started it.
        is_from_error: bool,
    },
}

/// The execution context of a run that works in a project's repository: the checkout the engine
/// prepared for it and that repository's git common folder.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run engine's start, which writes them with the run's started event"
    )
)]
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WorkflowRunExecutionContext {
    /// The workspace the run works in.
    pub(crate) workspace_id: WorkspaceId,
    /// How that workspace uses its mount.
    pub(crate) execution_mode: ExecutionMode,
    /// Where the run works.
    pub(crate) execution_root: PathBuf,
    /// The top level of the working tree the run works in, so a snapshot captures the whole tree.
    pub(crate) checkout_root: PathBuf,
    /// `git rev-parse --git-common-dir`, absolute, read when the context was prepared.
    pub(crate) git_common_dir: PathBuf,
    /// The worktree of a provisioned worktree's run; `None` for a bound root's.
    pub(crate) worktree_id: Option<WorktreeId>,
    /// The workspace's branch context.
    pub(crate) branch_context_id: BranchContextId,
}

/// Everything a new run's row is written from; the run reads `new` until the engine admits it.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run engine's start, which writes them with the run's started event"
    )
)]
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WorkflowRunCreation {
    /// The run.
    pub(crate) workflow_run_id: WorkflowRunId,
    /// The version the run pins for its whole life.
    pub(crate) workflow_version_id: WorkflowVersionId,
    /// The session the run belongs to.
    pub(crate) session_id: SessionId,
    /// How it was started.
    pub(crate) mode: WorkflowRunMode,
    /// The trigger node that started it.
    pub(crate) trigger: WorkflowRunTrigger,
    /// Who or what started it.
    pub(crate) started_by: WorkflowStartedBy,
    /// Its place in its chain.
    pub(crate) chain: WorkflowRunChainPlace,
    /// Present only for a run that works in a project's repository.
    pub(crate) execution_context: Option<WorkflowRunExecutionContext>,
    /// When the request, fire or call that started it did so, in the stored form.
    pub(crate) started_at: WireInstant,
}

static INSERT_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    let new_run = <&'static str>::from(WorkflowRunStatus::New);
    format!(
        "INSERT INTO workflow_runs (
    id, workflow_version_id, session_id, status, mode, trigger_json, started_by,
    chain_root_run_id, chain_from_error, chain_run_count, chain_kept_going, kept, started_at
  ) VALUES (
    @id, @workflow_version_id, @session_id, '{new_run}', @mode, @trigger_json, @started_by,
    @chain_root_run_id, @chain_from_error, @chain_run_count, @chain_kept_going, 0, @started_at
  )"
    )
});

// Only a chain's first run counts, so a root that is gone or is not a first run matches no row.
const COUNT_CHAIN_RUN_SQL: &str = "UPDATE workflow_runs SET chain_run_count = chain_run_count + 1
  WHERE id = @chain_root_run_id AND chain_run_count IS NOT NULL";

const INSERT_EXECUTION_CONTEXT_SQL: &str = "INSERT INTO run_execution_contexts (
    run_id, session_id, workspace_id, execution_mode, execution_root, checkout_root,
    git_common_dir, worktree_id, branch_context_id, created_at
  ) VALUES (
    @run_id, @session_id, @workspace_id, @execution_mode, @execution_root, @checkout_root,
    @git_common_dir, @worktree_id, @branch_context_id, @started_at
  )";

/// The statements that store a new run: its row, pinned to its version and its session; for a run
/// that joins a chain, one more on the chain's count on the first run's row, which refuses the
/// write when that row is not a stored first run; and its execution context's row where it has
/// one. A first run's own row counts itself.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run engine's start, which writes them with the run's started event"
    )
)]
pub(crate) fn workflow_run_creation_statements(
    creation: &WorkflowRunCreation,
) -> Vec<WriteStatement> {
    let run_id = creation.workflow_run_id.text();
    let session_id = creation.session_id.text();
    let started_at = creation.started_at.as_str();
    let trigger_json = serde_json::to_string(&creation.trigger)
        .expect("a trigger writes as JSON, holding only text");
    let started_by = serde_json::to_string(&creation.started_by)
        .expect("a run's starter writes as JSON, holding only text and ids");
    let (chain_root_run_id, is_from_error) = match &creation.chain {
        WorkflowRunChainPlace::Starts => (run_id, false),
        WorkflowRunChainPlace::Joins {
            chain_root_run_id,
            is_from_error,
        } => (chain_root_run_id.text(), *is_from_error),
    };
    // A first run's own row holds the chain's count and its answer; a joining run's holds neither.
    let first_run_value = |value: i64| match creation.chain {
        WorkflowRunChainPlace::Starts => Value::Integer(value),
        WorkflowRunChainPlace::Joins { .. } => Value::Null,
    };
    let mut statements = vec![WriteStatement {
        sql: Cow::Borrowed(INSERT_RUN_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", run_id.as_str()),
            text_binding(
                "@workflow_version_id",
                creation.workflow_version_id.text().as_str(),
            ),
            text_binding("@session_id", session_id.as_str()),
            text_binding("@mode", <&'static str>::from(creation.mode)),
            text_binding("@trigger_json", &trigger_json),
            text_binding("@started_by", &started_by),
            text_binding("@chain_root_run_id", chain_root_run_id.as_str()),
            (
                Cow::Borrowed("@chain_from_error"),
                Value::Integer(i64::from(is_from_error)),
            ),
            (Cow::Borrowed("@chain_run_count"), first_run_value(1)),
            (Cow::Borrowed("@chain_kept_going"), first_run_value(0)),
            text_binding("@started_at", started_at),
        ]),
        expected_row_count: None,
    }];
    if let WorkflowRunChainPlace::Joins { .. } = creation.chain {
        statements.push(WriteStatement {
            sql: Cow::Borrowed(COUNT_CHAIN_RUN_SQL),
            bindings: StatementBindings::Named(vec![text_binding(
                "@chain_root_run_id",
                chain_root_run_id.as_str(),
            )]),
            expected_row_count: Some(1),
        });
    }
    if let Some(context) = &creation.execution_context {
        statements.push(WriteStatement {
            sql: Cow::Borrowed(INSERT_EXECUTION_CONTEXT_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@run_id", run_id.as_str()),
                text_binding("@session_id", session_id.as_str()),
                text_binding("@workspace_id", context.workspace_id.text().as_str()),
                text_binding(
                    "@execution_mode",
                    <&'static str>::from(context.execution_mode),
                ),
                text_binding("@execution_root", &context.execution_root.to_string_lossy()),
                text_binding("@checkout_root", &context.checkout_root.to_string_lossy()),
                text_binding("@git_common_dir", &context.git_common_dir.to_string_lossy()),
                nullable_text_binding(
                    "@worktree_id",
                    context
                        .worktree_id
                        .map(|worktree_id| worktree_id.text())
                        .as_ref()
                        .map(UuidText::as_str),
                ),
                text_binding(
                    "@branch_context_id",
                    context.branch_context_id.text().as_str(),
                ),
                text_binding("@started_at", started_at),
            ]),
            expected_row_count: None,
        });
    }
    statements
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, OptionalExtension};
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::workflow::definition::document::{WorkflowNodeId, WorkflowVersionId};
    use sidekicks_contracts::workflow::run::id::WorkflowRunId;
    use sidekicks_contracts::workflow::run::trigger::{
        WorkflowRunMode, WorkflowStartedBy, WorkflowTriggerKind,
    };
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};

    use super::{
        WorkflowRunChainPlace, WorkflowRunCreation, WorkflowRunTrigger,
        workflow_run_creation_statements,
    };
    use crate::schema::schema_parts;
    use crate::test_rows::{TEST_SESSION_ID, insert_workflow_version};

    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e60";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e61";
    const ROOT_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e62";
    const JOINING_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e63";
    const REFUSED_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e64";

    fn creation(run_id: &str, chain: WorkflowRunChainPlace) -> WorkflowRunCreation {
        WorkflowRunCreation {
            workflow_run_id: WorkflowRunId::new(run_id).expect("the test's run id"),
            workflow_version_id: WorkflowVersionId::new(VERSION_ID).expect("the test's version"),
            session_id: SessionId::new(TEST_SESSION_ID).expect("the test's session"),
            mode: WorkflowRunMode::Trigger,
            trigger: WorkflowRunTrigger {
                kind: WorkflowTriggerKind::Error,
                node_id: WorkflowNodeId::new("start".to_owned()).expect("a node id"),
            },
            started_by: WorkflowStartedBy::Schedule {},
            chain,
            execution_context: None,
            started_at: WireInstant::try_from("2026-10-02T00:00:00.000Z".to_owned())
                .expect("an instant"),
        }
    }

    fn joining(run_id: &str, root_run_id: &str) -> WorkflowRunCreation {
        creation(
            run_id,
            WorkflowRunChainPlace::Joins {
                chain_root_run_id: WorkflowRunId::new(root_run_id).expect("the root's id"),
                is_from_error: true,
            },
        )
    }

    // A run's chain columns as its row holds them, `None` when the run is not stored.
    fn chain_columns(
        connection: &Connection,
        run_id: &str,
    ) -> Option<(String, i64, Option<i64>, Option<i64>)> {
        connection
            .query_row(
                "SELECT chain_root_run_id, chain_from_error, chain_run_count, chain_kept_going \
                 FROM workflow_runs WHERE id = ?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .expect("the test reads the run")
    }

    /// Mutation: drop the count statement's expected 1, so a run whose root is not a stored first
    /// run is kept with its chain counted nowhere.
    #[tokio::test]
    async fn a_joining_run_counts_on_its_first_run_and_one_whose_root_holds_no_count_is_refused() {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens the test database");
        let rows = database.reader();
        insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Chain");

        writer
            .write(workflow_run_creation_statements(&creation(
                ROOT_RUN_ID,
                WorkflowRunChainPlace::Starts,
            )))
            .await
            .expect("a chain's first run is stored");
        writer
            .write(workflow_run_creation_statements(&joining(
                JOINING_RUN_ID,
                ROOT_RUN_ID,
            )))
            .await
            .expect("a run joining a stored first run is stored");
        let refused = writer
            .write(workflow_run_creation_statements(&joining(
                REFUSED_RUN_ID,
                JOINING_RUN_ID,
            )))
            .await;

        assert!(matches!(
            refused,
            Err(WriteError::Refused {
                statement_index: 1,
                row_count: 0
            })
        ));
        assert_eq!(chain_columns(&rows, REFUSED_RUN_ID), None);
        assert_eq!(
            chain_columns(&rows, ROOT_RUN_ID),
            Some((ROOT_RUN_ID.to_owned(), 0, Some(2), Some(0)))
        );
        assert_eq!(
            chain_columns(&rows, JOINING_RUN_ID),
            Some((ROOT_RUN_ID.to_owned(), 1, None, None))
        );
    }
}
