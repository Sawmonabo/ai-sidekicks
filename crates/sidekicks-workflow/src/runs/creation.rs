//! Creating a run's row: the statements the engine's run start writes in one unit of work with the
//! run's started event, whose instant is the run's start, so a run, its place in its chain and its
//! execution context are stored together or not at all.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::daemon::config::WorkflowChainAskAfterRuns;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowVersionId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowRunStatus;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_contracts::workflow::run::trigger::{
    WorkflowRunChainPlace, WorkflowRunMode, WorkflowRunTrigger, WorkflowStartedBy,
};
use sidekicks_contracts::worktree::lifecycle::{BranchContextId, WorktreeId};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};

use crate::runs::step_rows::insert_pending_step;

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
    /// The workflow's provider as the run started; `None` when the workflow names none.
    pub(crate) provider: Option<ProviderId>,
    /// When the request, fire or call that started it did so, in the stored form.
    pub(crate) started_at: WireInstant,
    /// The input its trigger step starts on.
    pub(crate) trigger_input: WorkflowPayloadRef,
}

/// The key of the step the run's trigger runs as: its first attempt, the run's first execution.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run engine's start, which writes the trigger step's row with the run's"
    )
)]
pub(crate) fn trigger_step_key(
    workflow_run_id: WorkflowRunId,
    trigger: &WorkflowRunTrigger,
) -> WorkflowStepKey {
    WorkflowStepKey {
        workflow_run_id,
        node_id: trigger.node_id.clone(),
        attempt: SafeInt::new(1).expect("one is a first attempt"),
        execution_index: SafeInt::ZERO,
    }
}

static INSERT_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    let new_run = <&'static str>::from(WorkflowRunStatus::New);
    format!(
        "INSERT INTO workflow_runs (
    id, workflow_version_id, session_id, provider, status, mode, trigger_json, started_by,
    chain_root_run_id, chain_from_error, chain_run_count, chain_kept_going, kept, started_at
  ) VALUES (
    @id, @workflow_version_id, @session_id, @provider, '{new_run}', @mode, @trigger_json,
    @started_by, @chain_root_run_id, @chain_from_error, @chain_run_count, @chain_kept_going, 0,
    @started_at
  )"
    )
});

/// Where a joining run's write checks that its chain's first run is a stored first run: a refusal
/// at this statement is a root that is gone or is not a first run.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run engine's start, which reads why its write was refused"
    )
)]
pub(crate) const CHAIN_ROOT_CHECK_STATEMENT_INDEX: usize = 1;

/// Where a joining run's write counts it on its chain's first run: a refusal at this statement is
/// a chain at its ask-after limit, which holds the run.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run engine's start, which reads why its write was refused"
    )
)]
pub(crate) const CHAIN_COUNT_STATEMENT_INDEX: usize = 2;

// Only a chain's first run counts, so a root that is gone or is not a first run returns no row.
const CHAIN_ROOT_CHECK_SQL: &str = "SELECT 1 FROM workflow_runs
  WHERE id = @chain_root_run_id AND chain_run_count IS NOT NULL";

// Counts the run unless the chain has reached its limit and the person has not answered Keep
// going; a `NULL` limit never asks.
const COUNT_CHAIN_RUN_SQL: &str = "UPDATE workflow_runs SET chain_run_count = chain_run_count + 1
  WHERE id = @chain_root_run_id AND chain_run_count IS NOT NULL
    AND (@ask_after IS NULL OR chain_kept_going = 1 OR chain_run_count < @ask_after)";

const INSERT_EXECUTION_CONTEXT_SQL: &str = "INSERT INTO run_execution_contexts (
    run_id, session_id, workspace_id, execution_mode, execution_root, checkout_root,
    git_common_dir, worktree_id, branch_context_id, created_at
  ) VALUES (
    @run_id, @session_id, @workspace_id, @execution_mode, @execution_root, @checkout_root,
    @git_common_dir, @worktree_id, @branch_context_id, @started_at
  )";

/// The statements that store a new run: its row, pinned to its version and its session; for a run
/// that joins a chain, a check at [`CHAIN_ROOT_CHECK_STATEMENT_INDEX`] that refuses the write when
/// the chain's first run is not a stored first run, then its count on that row at
/// [`CHAIN_COUNT_STATEMENT_INDEX`], which refuses it once the chain has started `chain_ask_after`
/// runs and the person has not answered Keep going, `None` never; its execution context's row
/// where it has one; and, last, its trigger step's `pending` row on its trigger input, at the run's
/// start. A first run's own row counts itself.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run engine's start, which writes them with the run's started event"
    )
)]
pub(crate) fn workflow_run_creation_statements(
    creation: &WorkflowRunCreation,
    chain_ask_after: Option<WorkflowChainAskAfterRuns>,
) -> Vec<WriteStatement> {
    let run_id = creation.workflow_run_id.text();
    let session_id = creation.session_id.text();
    let started_at = creation.started_at.as_str();
    let trigger_json = serde_json::to_string(&creation.trigger)
        .expect("a trigger writes as JSON, holding only text");
    let started_by = serde_json::to_string(&creation.started_by)
        .expect("a run's starter writes as JSON, holding only text and ids");
    let (chain_root_run_id, is_from_error) = match &creation.chain {
        WorkflowRunChainPlace::Starts {} => (run_id, false),
        WorkflowRunChainPlace::Joins {
            chain_root_run_id,
            is_from_error,
        } => (chain_root_run_id.text(), *is_from_error),
    };
    // A first run's own row holds the chain's count and its answer; a joining run's holds neither.
    let first_run_value = |value: i64| match creation.chain {
        WorkflowRunChainPlace::Starts {} => Value::Integer(value),
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
            nullable_text_binding(
                "@provider",
                creation.provider.as_ref().map(ProviderId::as_str),
            ),
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
            sql: Cow::Borrowed(CHAIN_ROOT_CHECK_SQL),
            bindings: StatementBindings::Named(vec![text_binding(
                "@chain_root_run_id",
                chain_root_run_id.as_str(),
            )]),
            expected_row_count: Some(1),
        });
        statements.push(WriteStatement {
            sql: Cow::Borrowed(COUNT_CHAIN_RUN_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@chain_root_run_id", chain_root_run_id.as_str()),
                (
                    Cow::Borrowed("@ask_after"),
                    chain_ask_after
                        .map_or(Value::Null, |runs| Value::Integer(i64::from(runs.get()))),
                ),
            ]),
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
    statements.push(insert_pending_step(
        &trigger_step_key(creation.workflow_run_id, &creation.trigger),
        &[],
        &creation.trigger_input,
        &creation.started_at,
    ));
    statements
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use rusqlite::{Connection, OptionalExtension, params};
    use sidekicks_contracts::daemon::config::WorkflowChainAskAfterRuns;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::workflow::definition::document::{WorkflowNodeId, WorkflowVersionId};
    use sidekicks_contracts::workflow::run::id::WorkflowRunId;
    use sidekicks_contracts::workflow::run::step::record::WorkflowPayloadRef;
    use sidekicks_contracts::workflow::run::trigger::{
        WorkflowRunChainPlace, WorkflowRunMode, WorkflowRunTrigger, WorkflowStartedBy,
        WorkflowTriggerKind,
    };
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};

    use super::{
        CHAIN_COUNT_STATEMENT_INDEX, CHAIN_ROOT_CHECK_STATEMENT_INDEX, WorkflowRunCreation,
        workflow_run_creation_statements,
    };
    use crate::schema::schema_parts;
    use crate::test_rows::{TEST_SESSION_ID, insert_workflow_version};

    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e60";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e61";
    const ROOT_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e62";
    const JOINING_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e63";
    const NEW_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e64";
    const STARTED_AT: &str = "2026-10-02T00:00:00.000Z";

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
            provider: None,
            started_at: WireInstant::try_from(STARTED_AT.to_owned()).expect("an instant"),
            trigger_input: WorkflowPayloadRef::Inline { items: Vec::new() },
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

    // The status and start of a run's trigger step, `None` when the run has no trigger step.
    fn trigger_step(connection: &Connection, run_id: &str) -> Option<(String, String)> {
        connection
            .query_row(
                "SELECT status, started_at FROM workflow_steps WHERE workflow_run_id = ?1 \
                 AND node_id = 'start' AND attempt = 1 AND execution_index = 0",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .expect("the test reads the trigger step")
    }

    /// Where a joining run's chain stands before it is written.
    #[derive(Clone, Copy, Debug)]
    enum ChainRoot {
        /// A stored first run, its count and its Keep going answer set by the test.
        First { run_count: i64, is_kept_going: bool },
        /// A run that joined the first run's chain, so it counts nothing.
        Joining,
        /// No stored run.
        Missing,
    }

    /// What the joining run's write does: counts it on the first run, which then reads the count,
    /// or is refused at the statement, keeping nothing.
    #[derive(Clone, Copy, Debug)]
    enum Joined {
        Counted(i64),
        Refused(usize),
    }

    /// Every stored run's trigger step is `pending` at the run's start. Mutations: `<=` for `<` in
    /// the count's limit; the Keep going answer ignored; a `NULL` limit read as a limit; the
    /// count's or the root check's expected 1 dropped; the root check dropped, so a missing root
    /// reads as a chain at its limit; the trigger step's row written before the chain's statements,
    /// moving their indices, or at another instant than the run's start.
    #[rstest]
    #[case::under_the_limit(
        ChainRoot::First { run_count: 24, is_kept_going: false },
        WorkflowChainAskAfterRuns::new(25),
        Joined::Counted(25)
    )]
    #[case::at_the_limit(
        ChainRoot::First { run_count: 25, is_kept_going: false },
        WorkflowChainAskAfterRuns::new(25),
        Joined::Refused(CHAIN_COUNT_STATEMENT_INDEX)
    )]
    #[case::kept_going(
        ChainRoot::First { run_count: 25, is_kept_going: true },
        WorkflowChainAskAfterRuns::new(25),
        Joined::Counted(26)
    )]
    #[case::never_ask(
        ChainRoot::First { run_count: 2_000, is_kept_going: false },
        None,
        Joined::Counted(2_001)
    )]
    #[case::missing_root(
        ChainRoot::Missing,
        WorkflowChainAskAfterRuns::new(25),
        Joined::Refused(CHAIN_ROOT_CHECK_STATEMENT_INDEX)
    )]
    #[case::root_not_a_first_run(
        ChainRoot::Joining,
        None,
        Joined::Refused(CHAIN_ROOT_CHECK_STATEMENT_INDEX)
    )]
    #[tokio::test]
    async fn a_joining_run_counts_under_its_chains_limit_and_a_missing_root_is_refused(
        #[case] root: ChainRoot,
        #[case] chain_ask_after: Option<WorkflowChainAskAfterRuns>,
        #[case] joined: Joined,
    ) {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens the test database");
        let rows = database.reader();
        insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Chain");
        if !matches!(root, ChainRoot::Missing) {
            writer
                .write(workflow_run_creation_statements(
                    &creation(ROOT_RUN_ID, WorkflowRunChainPlace::Starts {}),
                    None,
                ))
                .await
                .expect("a chain's first run is stored");
            // A first run's own row counts itself and has no answer yet.
            assert_eq!(
                chain_columns(&rows, ROOT_RUN_ID),
                Some((ROOT_RUN_ID.to_owned(), 0, Some(1), Some(0)))
            );
            assert_eq!(
                trigger_step(&rows, ROOT_RUN_ID),
                Some(("pending".to_owned(), STARTED_AT.to_owned()))
            );
        }
        let joined_root = match root {
            ChainRoot::First {
                run_count,
                is_kept_going,
            } => {
                rows.execute(
                    "UPDATE workflow_runs SET chain_run_count = ?1, chain_kept_going = ?2 \
                     WHERE id = ?3",
                    params![run_count, i64::from(is_kept_going), ROOT_RUN_ID],
                )
                .expect("the test sets the chain's count");
                ROOT_RUN_ID
            }
            ChainRoot::Joining => {
                writer
                    .write(workflow_run_creation_statements(
                        &joining(JOINING_RUN_ID, ROOT_RUN_ID),
                        None,
                    ))
                    .await
                    .expect("a run joining a stored first run is stored");
                assert_eq!(
                    chain_columns(&rows, JOINING_RUN_ID),
                    Some((ROOT_RUN_ID.to_owned(), 1, None, None))
                );
                JOINING_RUN_ID
            }
            ChainRoot::Missing => ROOT_RUN_ID,
        };
        let root_before = chain_columns(&rows, ROOT_RUN_ID);

        let written = writer
            .write(workflow_run_creation_statements(
                &joining(NEW_RUN_ID, joined_root),
                chain_ask_after,
            ))
            .await;

        match joined {
            Joined::Counted(run_count) => {
                written.expect("the joining run is stored");
                assert_eq!(
                    chain_columns(&rows, NEW_RUN_ID),
                    Some((ROOT_RUN_ID.to_owned(), 1, None, None))
                );
                assert_eq!(
                    chain_columns(&rows, ROOT_RUN_ID).map(|columns| columns.2),
                    Some(Some(run_count))
                );
                assert_eq!(
                    trigger_step(&rows, NEW_RUN_ID),
                    Some(("pending".to_owned(), STARTED_AT.to_owned()))
                );
            }
            Joined::Refused(statement_index) => {
                assert!(matches!(
                    written,
                    Err(WriteError::Refused {
                        statement_index: refused_at,
                        row_count: 0
                    }) if refused_at == statement_index
                ));
                assert_eq!(chain_columns(&rows, NEW_RUN_ID), None);
                assert_eq!(trigger_step(&rows, NEW_RUN_ID), None);
                assert_eq!(chain_columns(&rows, ROOT_RUN_ID), root_before);
            }
        }
    }
}
