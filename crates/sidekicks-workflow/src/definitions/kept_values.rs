//! The values a `Keep for later runs` step keeps for its workflow, one per name, which later runs
//! read as `$vars`. They belong to the workflow, not to a version, and sit in `workflow_node_state`
//! under the empty node id.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, named_params};
use serde_json::{Map, Value};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_contracts::workflow::kept_values::WorkflowKeptValueClearResponse;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;

use crate::definitions::library::{created_definition_statement, live_definition_statement};
use crate::not_found::WorkflowNotFound;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

/// The statements the store's reads run: a workflow's kept values.
pub const WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY: usize = 1;

const SELECT_KEPT_VALUES_SQL: &str = "SELECT key, value_json, kept_by_run_id, updated_at
  FROM workflow_node_state WHERE definition_id = @definition_id AND node_id = '' ORDER BY key";

// A kept value replaces the one its name held, whichever run kept that.
const UPSERT_KEPT_VALUE_SQL: &str = "INSERT INTO workflow_node_state
    (definition_id, node_id, key, value_json, kept_by_run_id, updated_at)
  VALUES (@definition_id, '', @key, @value_json, @kept_by_run_id, @updated_at)
  ON CONFLICT (definition_id, node_id, key) DO UPDATE SET
    value_json = excluded.value_json,
    kept_by_run_id = excluded.kept_by_run_id,
    updated_at = excluded.updated_at";

const DELETE_KEPT_VALUES_SQL: &str =
    "DELETE FROM workflow_node_state WHERE definition_id = @definition_id AND node_id = ''";

/// One value a workflow keeps: its name, the value, the run that kept it and when.
#[expect(
    dead_code,
    reason = "the workflow engine reads kept values into a run's $vars"
)]
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WorkflowKeptValue {
    /// The name later runs read it by.
    pub(crate) name: String,
    /// The value.
    pub(crate) value: Value,
    /// The run that kept it.
    pub(crate) kept_by_run_id: WorkflowRunId,
    /// When it was kept.
    pub(crate) kept_at: WireInstant,
}

/// Why kept values were not read, kept or cleared; a refused write keeps nothing.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowKeptValueError {
    /// The workflow is not in the library, or for a clear was never created
    /// (`workflow.definition.notFound`).
    #[error(transparent)]
    NotFound(#[from] WorkflowNotFound),
    /// The writer did not keep the write.
    #[error("the kept values' write was not kept")]
    Write(#[from] WriteError),
    /// SQLite refused the read, or a stored value did not read as its type.
    #[error("a read of a workflow's kept values failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<WorkflowKeptValueError> for HandlerError {
    /// A workflow not in the library answers its not-found refusal; any other failure is a fault in
    /// the daemon.
    fn from(error: WorkflowKeptValueError) -> Self {
        match error {
            WorkflowKeptValueError::NotFound(not_found) => Self::Refused(not_found.into()),
            fault @ (WorkflowKeptValueError::Write(_)
            | WorkflowKeptValueError::Database(_)
            | WorkflowKeptValueError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// The statement that deletes every value a workflow keeps, for a delete to run in its write.
pub(crate) fn clear_kept_values_statement(definition_id: WorkflowDefinitionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(DELETE_KEPT_VALUES_SQL),
        bindings: StatementBindings::Named(vec![text_binding(
            "@definition_id",
            definition_id.text().as_str(),
        )]),
        expected_row_count: None,
    }
}

/// Keeps, reads and clears a workflow's kept values, reading through the daemon's read pool and
/// writing through its writer. It stores the JSON value it is given, which for a value over 64 KiB
/// is the reference to the artifact the caller wrote.
#[expect(
    dead_code,
    reason = "the workflow engine's Keep for later runs step and the workflow.keptValue.clear \
              handler"
)]
pub(crate) struct WorkflowKeptValueStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

#[expect(
    dead_code,
    reason = "the workflow engine's Keep for later runs step and the workflow.keptValue.clear \
              handler"
)]
impl WorkflowKeptValueStore {
    /// The store reading through `pool` and writing through `writer`.
    pub(crate) fn new(pool: Arc<DatabaseReadPool>, writer: Arc<DatabaseWriter>) -> Self {
        Self { pool, writer }
    }

    /// Every value the workflow keeps, by name. Fails with [`WorkflowKeptValueError::Database`] or
    /// [`WorkflowKeptValueError::Pool`] when the read does.
    pub(crate) async fn read(
        &self,
        definition_id: WorkflowDefinitionId,
    ) -> Result<Vec<WorkflowKeptValue>, WorkflowKeptValueError> {
        self.pool
            .read(ReadLength::Short, move |connection| {
                Ok(read_kept_values(connection, definition_id)?)
            })
            .await
    }

    /// Keeps each named value for the workflow from one run, in one write, each replacing the value
    /// its name held, and answers when they were kept. Fails with
    /// [`WorkflowKeptValueError::NotFound`] for a workflow not in the library, keeping nothing.
    pub(crate) async fn keep(
        &self,
        definition_id: WorkflowDefinitionId,
        run_id: WorkflowRunId,
        values: &Map<String, Value>,
    ) -> Result<WireInstant, WorkflowKeptValueError> {
        let kept_at = WireInstant::now();
        let definition_text = definition_id.text();
        let run_text = run_id.text();
        let mut statements = vec![live_definition_statement(definition_id)];
        statements.extend(values.iter().map(|(name, value)| WriteStatement {
            sql: Cow::Borrowed(UPSERT_KEPT_VALUE_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@definition_id", definition_text.as_str()),
                text_binding("@key", name),
                (
                    Cow::Borrowed("@value_json"),
                    SqlValue::Text(value.to_string()),
                ),
                text_binding("@kept_by_run_id", run_text.as_str()),
                text_binding("@updated_at", kept_at.as_str()),
            ]),
            expected_row_count: None,
        }));
        match self.writer.write(statements).await {
            Ok(_) => Ok(kept_at),
            Err(WriteError::Refused { .. }) => {
                Err(WorkflowNotFound::Definition { definition_id }.into())
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Deletes every value the workflow keeps and counts them. Fails with
    /// [`WorkflowKeptValueError::NotFound`] for a workflow never created.
    pub(crate) async fn clear(
        &self,
        definition_id: WorkflowDefinitionId,
    ) -> Result<WorkflowKeptValueClearResponse, WorkflowKeptValueError> {
        let statements = vec![
            created_definition_statement(definition_id),
            clear_kept_values_statement(definition_id),
        ];
        let results = match self.writer.write(statements).await {
            Ok(results) => results,
            Err(WriteError::Refused { .. }) => {
                return Err(WorkflowNotFound::Definition { definition_id }.into());
            }
            Err(error) => return Err(error.into()),
        };
        // A committed write answers each of its statements, the clear second.
        let cleared = results[1].row_count;
        Ok(WorkflowKeptValueClearResponse {
            definition_id,
            cleared_count: SafeInt::new(
                u64::try_from(cleared).expect("a row count fits in 64 bits"),
            )
            .expect("a row count is a safe integer"),
        })
    }
}

fn read_kept_values(
    connection: &Connection,
    definition_id: WorkflowDefinitionId,
) -> rusqlite::Result<Vec<WorkflowKeptValue>> {
    let mut statement = connection.prepare_cached(SELECT_KEPT_VALUES_SQL)?;
    let rows = statement.query_map(
        named_params! { "@definition_id": definition_id.text().as_str() },
        |row| {
            Ok(WorkflowKeptValue {
                name: row.get(0)?,
                value: text_column(row, 1, |text| serde_json::from_str(&text))?,
                kept_by_run_id: text_column(row, 2, |text| WorkflowRunId::new(&text))?,
                kept_at: text_column(row, 3, WireInstant::try_from)?,
            })
        },
    )?;
    rows.collect()
}
