//! The values a `Keep for later runs` step keeps for its workflow, one per name, which later runs
//! read as `$vars`. They belong to the workflow, not to a version, and sit in `workflow_node_state`
//! under the empty node id. A value above the inline cap is kept as the reference to a one-item
//! payload artifact, which the read resolves back to the value.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, named_params};
use serde::Deserialize as _;
use serde_json::Value;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::kept_values::WorkflowKeptValueClearResponse;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::WorkflowPayloadRef;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{
    StatementBindings, StatementResult, WriteStatement, json_list_binding, text_binding,
};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

use crate::definitions::library::created_definition_statement;
use crate::engine::ports::{PortError, StepPayloadArtifacts};
use crate::not_found::WorkflowNotFound;

/// The statements the store's reads run: a workflow's kept values.
pub const WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY: usize = 1;

const SELECT_KEPT_VALUES_SQL: &str = "SELECT key, value_json, kept_by_run_id, updated_at
  FROM workflow_node_state WHERE definition_id = @definition_id AND node_id = '' ORDER BY key";

// A kept value replaces the one its name held, whichever run kept that. A deleted workflow keeps
// nothing and refuses nothing, so a late step of its run still commits its turn; the WHERE also
// keeps SQLite from reading the conflict clause as a join's.
const UPSERT_KEPT_VALUE_SQL: &str = "INSERT INTO workflow_node_state
    (definition_id, node_id, key, value_json, kept_by_run_id, updated_at)
  SELECT @definition_id, '', @key, @value_json, @kept_by_run_id, @updated_at
  WHERE EXISTS (
    SELECT 1 FROM workflow_definitions WHERE id = @definition_id AND deleted_at IS NULL
  )
  ON CONFLICT (definition_id, node_id, key) DO UPDATE SET
    value_json = excluded.value_json,
    kept_by_run_id = excluded.kept_by_run_id,
    updated_at = excluded.updated_at";

const DELETE_KEPT_VALUES_SQL: &str =
    "DELETE FROM workflow_node_state WHERE definition_id = @definition_id AND node_id = ''";

// The stored value of each kept name `@keys` lists, or of every name when it is NULL, that holds
// an artifact's reference; a write that drops those values reads it first, inside itself.
const DROPPED_KEPT_ARTIFACTS_SQL: &str = "SELECT value_json FROM workflow_node_state
  WHERE definition_id = @definition_id AND node_id = ''
    AND json_extract(value_json, '$.kind') = 'artifact'
    AND (@keys IS NULL OR key IN (SELECT value FROM json_each(@keys)))";

/// One value a workflow keeps: its name, the value, the run that kept it and when.
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

/// Why kept values were not read or cleared; a refused write keeps nothing.
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
    /// The payload store did not answer the artifact a value above the inline cap is kept in.
    #[error("a kept value's artifact could not be read")]
    Payload(#[source] PortError),
    /// A kept value's artifact does not hold the one item it was written as.
    #[error("a kept value's artifact does not read as its one item")]
    PayloadItem(#[source] serde_json::Error),
}

impl From<WorkflowKeptValueError> for HandlerError {
    /// A workflow not in the library answers its not-found refusal; any other failure is a fault in
    /// the daemon.
    fn from(error: WorkflowKeptValueError) -> Self {
        match error {
            WorkflowKeptValueError::NotFound(not_found) => Self::Refused(not_found.into()),
            fault @ (WorkflowKeptValueError::Write(_)
            | WorkflowKeptValueError::Database(_)
            | WorkflowKeptValueError::Pool(_)
            | WorkflowKeptValueError::Payload(_)
            | WorkflowKeptValueError::PayloadItem(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// The statements of a write that drops kept values: the read of the artifacts the dropped values
/// name, first, then the statements that drop them.
#[derive(Debug)]
pub(crate) struct KeptValueWrite {
    /// The statements, in write order.
    pub(crate) statements: Vec<WriteStatement>,
    /// The index among `statements` of the read whose result [`dropped_artifact_ids`] decodes.
    pub(crate) dropped_read: usize,
}

/// The statements that delete every value a workflow keeps, for a clear or a delete to run in
/// its write.
pub(crate) fn clear_kept_values_statements(definition_id: WorkflowDefinitionId) -> KeptValueWrite {
    KeptValueWrite {
        statements: vec![
            dropped_kept_artifacts_statement(definition_id, None),
            WriteStatement {
                sql: Cow::Borrowed(DELETE_KEPT_VALUES_SQL),
                bindings: StatementBindings::Named(vec![text_binding(
                    "@definition_id",
                    definition_id.text().as_str(),
                )]),
                expected_row_count: None,
            },
        ],
        dropped_read: 0,
    }
}

/// The read, run inside a write before it drops kept values, of the stored reference of each value
/// the workflow `definition_id` keeps under one of `keys`, or under any name for `None`, that names
/// an artifact.
pub(crate) fn dropped_kept_artifacts_statement(
    definition_id: WorkflowDefinitionId,
    keys: Option<&[&str]>,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(DROPPED_KEPT_ARTIFACTS_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@definition_id", definition_id.text().as_str()),
            match keys {
                Some(keys) => json_list_binding("@keys", &keys),
                None => (Cow::Borrowed("@keys"), SqlValue::Null),
            },
        ]),
        expected_row_count: None,
    }
}

/// The artifact each row of a committed [`dropped_kept_artifacts_statement`] names; a value that
/// only looks like a reference is skipped, as a read of the kept values skips it.
pub(crate) fn dropped_artifact_ids(result: &StatementResult) -> Vec<ArtifactId> {
    result
        .rows
        .iter()
        .filter_map(|row| {
            let text = if let Some(SqlValue::Text(text)) = row.first() {
                Some(text)
            } else {
                None
            }
            .expect("the read answers each value's stored text");
            let value = serde_json::from_str(text).expect("a kept value is stored as JSON");
            kept_artifact_id(&value)
        })
        .collect()
}

/// Deletes through `payloads` each of `ids`, the artifacts of values a committed write dropped,
/// and answers each one that could not be deleted beside its error, for the caller to record or
/// report; the committed write stands either way.
pub(crate) async fn remove_dropped(
    payloads: &dyn StepPayloadArtifacts,
    ids: &[ArtifactId],
) -> Vec<(ArtifactId, PortError)> {
    let mut left_behind = Vec::new();
    for artifact_id in ids {
        if let Err(removal) = payloads.delete(artifact_id).await {
            left_behind.push((*artifact_id, removal));
        }
    }
    left_behind
}

/// The write that keeps each of `values`, by name, for the workflow `definition_id` from the run
/// `run_id` at `kept_at`, each replacing the value its name held, after the read of the artifacts
/// the replaced values name; a value above the inline cap is passed as the JSON of its payload
/// reference. `None` for no value. A deleted workflow keeps none of them, and none refuses the
/// write it rides.
pub(crate) fn kept_value_statements<'value>(
    definition_id: WorkflowDefinitionId,
    run_id: WorkflowRunId,
    values: impl IntoIterator<Item = (&'value str, &'value Value)>,
    kept_at: &WireInstant,
) -> Option<KeptValueWrite> {
    let values: Vec<(&str, &Value)> = values.into_iter().collect();
    if values.is_empty() {
        return None;
    }
    let names: Vec<&str> = values.iter().map(|(name, _)| *name).collect();
    let definition_text = definition_id.text();
    let run_text = run_id.text();
    let mut statements = vec![dropped_kept_artifacts_statement(
        definition_id,
        Some(&names),
    )];
    statements.extend(values.into_iter().map(|(name, value)| WriteStatement {
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
    Some(KeptValueWrite {
        statements,
        dropped_read: 0,
    })
}

/// Reads and clears a workflow's kept values, reading through the daemon's read pool, writing
/// through its writer and resolving a value kept as an artifact through the payload store.
#[expect(
    dead_code,
    reason = "the workflow.keptValue.clear handler and the engine's run start"
)]
pub(crate) struct WorkflowKeptValueStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    payloads: Arc<dyn StepPayloadArtifacts>,
}

#[expect(
    dead_code,
    reason = "the workflow.keptValue.clear handler and the engine's run start"
)]
impl WorkflowKeptValueStore {
    /// The store reading through `pool`, writing through `writer` and reading kept artifacts
    /// through `payloads`.
    pub(crate) fn new(
        pool: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
        payloads: Arc<dyn StepPayloadArtifacts>,
    ) -> Self {
        Self {
            pool,
            writer,
            payloads,
        }
    }

    /// Every value the workflow keeps, by name, each kept as an artifact read back to its value.
    /// Fails with [`WorkflowKeptValueError::Database`] or [`WorkflowKeptValueError::Pool`] when
    /// the read does, and with [`WorkflowKeptValueError::Payload`] or
    /// [`WorkflowKeptValueError::PayloadItem`] when an artifact does not read.
    pub(crate) async fn read(
        &self,
        definition_id: WorkflowDefinitionId,
    ) -> Result<Vec<WorkflowKeptValue>, WorkflowKeptValueError> {
        let mut kept_values = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WorkflowKeptValueError>(read_kept_values(connection, definition_id)?)
            })
            .await?;
        for kept_value in &mut kept_values {
            if let Some(artifact_id) = kept_artifact_id(&kept_value.value) {
                let bytes = self
                    .payloads
                    .read(&artifact_id)
                    .await
                    .map_err(WorkflowKeptValueError::Payload)?;
                let [item] = serde_json::from_slice::<[WorkflowItem; 1]>(&bytes)
                    .map_err(WorkflowKeptValueError::PayloadItem)?;
                kept_value.value = item.json.0;
            }
        }
        Ok(kept_values)
    }

    /// Deletes every value the workflow keeps and counts them. Fails with
    /// [`WorkflowKeptValueError::NotFound`] for a workflow never created.
    pub(crate) async fn clear(
        &self,
        definition_id: WorkflowDefinitionId,
    ) -> Result<WorkflowKeptValueClearResponse, WorkflowKeptValueError> {
        let mut statements = vec![created_definition_statement(definition_id)];
        statements.extend(clear_kept_values_statements(definition_id).statements);
        let results = match self.writer.write(statements).await {
            Ok(results) => results,
            Err(WriteError::Refused { .. }) => {
                return Err(WorkflowNotFound::Definition { definition_id }.into());
            }
            Err(error) => return Err(error.into()),
        };
        // A committed write answers each of its statements, the clear third, after the read.
        let cleared = results[2].row_count;
        Ok(WorkflowKeptValueClearResponse {
            definition_id,
            cleared_count: SafeInt::new(
                u64::try_from(cleared).expect("a row count fits in 64 bits"),
            )
            .expect("a row count is a safe integer"),
        })
    }
}

// The artifact a stored value names when it was kept as a payload reference, told apart by the
// reference's shape.
fn kept_artifact_id(value: &Value) -> Option<ArtifactId> {
    if value.get("kind").and_then(Value::as_str) != Some("artifact") {
        return None;
    }
    match WorkflowPayloadRef::deserialize(value) {
        Ok(WorkflowPayloadRef::Artifact { artifact_id, .. }) => Some(artifact_id),
        Ok(WorkflowPayloadRef::Inline { .. }) | Err(_) => None,
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
