//! The values a `Keep for later runs` step keeps for its workflow, one per name, which later runs
//! read as `$vars`. They belong to the workflow, not to a version, and sit in `workflow_node_state`
//! under the empty node id. A value above the inline cap is kept as the reference to a one-item
//! payload artifact, whose id its row's `artifact_id` names and which the read resolves back to
//! the value.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, named_params};
use serde_json::Value;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::kept_values::WorkflowKeptValueClearResponse;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{
    StatementBindings, StatementResult, WriteStatement, json_list_binding, text_binding,
};
use sidekicks_store::database::stored_column::{
    optional_text_column, returned_parsed, text_column,
};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

use crate::definitions::library::created_definition_statement;
use crate::engine::ports::{PortError, StepPayloadArtifacts};
use crate::not_found::WorkflowNotFound;

/// The statements the store's reads run: a workflow's kept values.
pub const WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY: usize = 1;

const SELECT_KEPT_VALUES_SQL: &str = "SELECT key, value_json, artifact_id, kept_by_run_id,
    updated_at
  FROM workflow_node_state WHERE definition_id = @definition_id AND node_id = '' ORDER BY key";

// A kept value replaces the one its name held, whichever run kept that. A deleted workflow keeps
// nothing and refuses nothing, so a late step of its run still commits its turn; the WHERE also
// keeps SQLite from reading the conflict clause as a join's.
const UPSERT_KEPT_VALUE_SQL: &str = "INSERT INTO workflow_node_state
    (definition_id, node_id, key, value_json, artifact_id, kept_by_run_id, updated_at)
  SELECT @definition_id, '', @key, @value_json, @artifact_id, @kept_by_run_id, @updated_at
  WHERE EXISTS (
    SELECT 1 FROM workflow_definitions WHERE id = @definition_id AND deleted_at IS NULL
  )
  ON CONFLICT (definition_id, node_id, key) DO UPDATE SET
    value_json = excluded.value_json,
    artifact_id = excluded.artifact_id,
    kept_by_run_id = excluded.kept_by_run_id,
    updated_at = excluded.updated_at";

const DELETE_KEPT_VALUES_SQL: &str =
    "DELETE FROM workflow_node_state WHERE definition_id = @definition_id AND node_id = ''";

// The artifact of each kept name `@keys` lists, or of every name when it is NULL, that is kept in
// one; a write that drops those values reads it first, inside itself.
const DROPPED_KEPT_ARTIFACTS_SQL: &str = "SELECT artifact_id FROM workflow_node_state
  WHERE definition_id = @definition_id AND node_id = '' AND artifact_id IS NOT NULL
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

/// Why kept values were not read or cleared; a refused write keeps nothing, and a clear whose
/// artifacts were left behind stands.
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
    /// The clear committed, but an artifact a cleared value named could not be deleted.
    #[error("the kept values were cleared, but artifacts they named were left behind")]
    ArtifactsLeftBehind {
        /// The committed clear's answer.
        cleared: WorkflowKeptValueClearResponse,
        /// Each artifact left behind, beside why.
        #[source]
        left_behind: KeptArtifactsLeftBehind,
    },
}

/// The artifacts of values a committed write dropped that could not be deleted, each beside its
/// error; the write stands.
#[derive(Debug, thiserror::Error)]
#[error("{} artifacts of dropped kept values could not be deleted", .0.len())]
pub(crate) struct KeptArtifactsLeftBehind(pub(crate) Vec<(ArtifactId, PortError)>);

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
            | WorkflowKeptValueError::PayloadItem(_)
            | WorkflowKeptValueError::ArtifactsLeftBehind { .. }) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

/// The statements of a write that drops kept values: the read of the artifacts the dropped values
/// name, first, then the statements that drop them.
#[derive(Debug)]
pub(crate) struct KeptValueWrite {
    /// The statements, in write order.
    pub(crate) statements: Vec<WriteStatement>,
    /// Where among `statements` the results name the artifacts no row names once the write commits.
    pub(crate) reads: KeptArtifactReads,
}

/// Where a write's statement results name the kept-value artifacts no row names once it commits:
/// each read of the artifacts its dropped values name, and each keep of a value in a new artifact,
/// whose row a deleted workflow does not take. Indices count among the write's statements.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct KeptArtifactReads {
    dropped_reads: Vec<usize>,
    kept_artifacts: Vec<(usize, ArtifactId)>,
}

impl KeptArtifactReads {
    /// Adds `reads`, whose indices count from a statement placed at `offset` in this write.
    pub(crate) fn extend_at(&mut self, offset: usize, reads: KeptArtifactReads) {
        self.dropped_reads
            .extend(reads.dropped_reads.into_iter().map(|read| offset + read));
        self.kept_artifacts.extend(
            reads
                .kept_artifacts
                .into_iter()
                .map(|(keep, artifact_id)| (offset + keep, artifact_id)),
        );
    }

    /// The artifacts the committed write's `results` leave no row naming: each one a dropped
    /// value named, and each one a value was written to whose row was not kept.
    pub(crate) fn unnamed_artifact_ids(&self, results: &[StatementResult]) -> Vec<ArtifactId> {
        let unkept = self
            .kept_artifacts
            .iter()
            .filter(|(keep, _)| results[*keep].row_count == 0)
            .map(|(_, artifact_id)| *artifact_id);
        self.dropped_reads
            .iter()
            .flat_map(|&read| dropped_artifact_ids(&results[read]))
            .chain(unkept)
            .collect()
    }
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
        reads: KeptArtifactReads {
            dropped_reads: vec![0],
            kept_artifacts: Vec::new(),
        },
    }
}

/// The read, run inside a write before it drops kept values, of the artifact of each value the
/// workflow `definition_id` keeps under one of `keys`, or under any name for `None`, kept in one.
fn dropped_kept_artifacts_statement(
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

// The artifact each row of a committed `dropped_kept_artifacts_statement` names.
fn dropped_artifact_ids(result: &StatementResult) -> Vec<ArtifactId> {
    result
        .rows
        .iter()
        .map(|row| {
            returned_parsed(row, 0, ArtifactId::new)
                .expect("the read answers each dropped value's artifact id, stored whole")
        })
        .collect()
}

/// Deletes through `payloads` each of `ids`, artifacts no record names any longer, such as those of
/// values a committed write dropped, and answers each one that could not be deleted beside its
/// error, for the caller to record or report; the write that unnamed them stands either way.
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
/// reference beside the artifact it names. `None` for no value. A deleted workflow keeps none of
/// them, and none refuses the write it rides.
pub(crate) fn kept_value_statements<'value>(
    definition_id: WorkflowDefinitionId,
    run_id: WorkflowRunId,
    values: impl IntoIterator<Item = (&'value str, &'value Value, Option<ArtifactId>)>,
    kept_at: &WireInstant,
) -> Option<KeptValueWrite> {
    let values: Vec<(&str, &Value, Option<ArtifactId>)> = values.into_iter().collect();
    if values.is_empty() {
        return None;
    }
    let names: Vec<&str> = values.iter().map(|(name, _, _)| *name).collect();
    // Each keep follows the read, so the one at `place` is statement `place + 1`.
    let kept_artifacts = values
        .iter()
        .zip(1..)
        .filter_map(|((_, _, artifact_id), keep)| {
            artifact_id.map(|artifact_id| (keep, artifact_id))
        })
        .collect();
    let definition_text = definition_id.text();
    let run_text = run_id.text();
    let mut statements = vec![dropped_kept_artifacts_statement(
        definition_id,
        Some(&names),
    )];
    statements.extend(
        values
            .into_iter()
            .map(|(name, value, artifact_id)| WriteStatement {
                sql: Cow::Borrowed(UPSERT_KEPT_VALUE_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@definition_id", definition_text.as_str()),
                    text_binding("@key", name),
                    (
                        Cow::Borrowed("@value_json"),
                        SqlValue::Text(value.to_string()),
                    ),
                    (
                        Cow::Borrowed("@artifact_id"),
                        artifact_id.map_or(SqlValue::Null, |artifact_id| {
                            SqlValue::Text(artifact_id.to_string())
                        }),
                    ),
                    text_binding("@kept_by_run_id", run_text.as_str()),
                    text_binding("@updated_at", kept_at.as_str()),
                ]),
                expected_row_count: None,
            }),
    );
    Some(KeptValueWrite {
        statements,
        reads: KeptArtifactReads {
            dropped_reads: vec![0],
            kept_artifacts,
        },
    })
}

/// Reads and clears a workflow's kept values, reading through the daemon's read pool, writing
/// through its writer and resolving a value kept as an artifact through the payload store.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow.keptValue.clear handler and the engine's run start"
    )
)]
pub(crate) struct WorkflowKeptValueStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    payloads: Arc<dyn StepPayloadArtifacts>,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow.keptValue.clear handler and the engine's run start"
    )
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
    /// A run may replace a value and remove its artifact between the read of the rows and the read
    /// of the artifact, so an artifact that does not read sends the read round once more. Fails
    /// with [`WorkflowKeptValueError::Database`] or [`WorkflowKeptValueError::Pool`] when the read
    /// does, and with [`WorkflowKeptValueError::Payload`] or
    /// [`WorkflowKeptValueError::PayloadItem`] when an artifact does not read.
    pub(crate) async fn read(
        &self,
        definition_id: WorkflowDefinitionId,
    ) -> Result<Vec<WorkflowKeptValue>, WorkflowKeptValueError> {
        match self.read_once(definition_id).await {
            Err(WorkflowKeptValueError::Payload(_)) => self.read_once(definition_id).await,
            read => read,
        }
    }

    // The workflow's kept values as its rows stand now, each kept as an artifact read back.
    async fn read_once(
        &self,
        definition_id: WorkflowDefinitionId,
    ) -> Result<Vec<WorkflowKeptValue>, WorkflowKeptValueError> {
        let rows = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WorkflowKeptValueError>(read_kept_values(connection, definition_id)?)
            })
            .await?;
        let mut kept_values = Vec::with_capacity(rows.len());
        for (mut kept_value, artifact_id) in rows {
            if let Some(artifact_id) = artifact_id {
                let bytes = self
                    .payloads
                    .read(&artifact_id)
                    .await
                    .map_err(WorkflowKeptValueError::Payload)?;
                let [item] = serde_json::from_slice::<[WorkflowItem; 1]>(&bytes)
                    .map_err(WorkflowKeptValueError::PayloadItem)?;
                kept_value.value = item.json.0;
            }
            kept_values.push(kept_value);
        }
        Ok(kept_values)
    }

    /// Deletes every value the workflow keeps and counts them, then deletes the artifacts the
    /// cleared values named. Fails with [`WorkflowKeptValueError::NotFound`] for a workflow never
    /// created, and with [`WorkflowKeptValueError::ArtifactsLeftBehind`], the clear kept, when an
    /// artifact could not be deleted.
    pub(crate) async fn clear(
        &self,
        definition_id: WorkflowDefinitionId,
    ) -> Result<WorkflowKeptValueClearResponse, WorkflowKeptValueError> {
        let clear = clear_kept_values_statements(definition_id);
        // The clear's statements follow the check that the workflow was created: its read, then
        // its delete.
        let mut reads = KeptArtifactReads::default();
        reads.extend_at(1, clear.reads);
        let mut statements = vec![created_definition_statement(definition_id)];
        statements.extend(clear.statements);
        let results = match self.writer.write(statements).await {
            Ok(results) => results,
            Err(WriteError::Refused { .. }) => {
                return Err(WorkflowNotFound::Definition { definition_id }.into());
            }
            Err(error) => return Err(error.into()),
        };
        let cleared = WorkflowKeptValueClearResponse {
            definition_id,
            cleared_count: SafeInt::new(
                u64::try_from(results[2].row_count).expect("a row count fits in 64 bits"),
            )
            .expect("a row count is a safe integer"),
        };
        let left_behind =
            remove_dropped(&*self.payloads, &reads.unnamed_artifact_ids(&results)).await;
        if left_behind.is_empty() {
            Ok(cleared)
        } else {
            Err(WorkflowKeptValueError::ArtifactsLeftBehind {
                cleared,
                left_behind: KeptArtifactsLeftBehind(left_behind),
            })
        }
    }
}

// Each value the workflow keeps as its row stores it, beside the artifact it is kept in, if any.
fn read_kept_values(
    connection: &Connection,
    definition_id: WorkflowDefinitionId,
) -> rusqlite::Result<Vec<(WorkflowKeptValue, Option<ArtifactId>)>> {
    let mut statement = connection.prepare_cached(SELECT_KEPT_VALUES_SQL)?;
    let rows = statement.query_map(
        named_params! { "@definition_id": definition_id.text().as_str() },
        |row| {
            let artifact_id = optional_text_column(row, 2, |text| ArtifactId::new(&text))?;
            Ok((
                WorkflowKeptValue {
                    name: row.get(0)?,
                    value: text_column(row, 1, |text| serde_json::from_str(&text))?,
                    kept_by_run_id: text_column(row, 3, |text| WorkflowRunId::new(&text))?,
                    kept_at: text_column(row, 4, WireInstant::try_from)?,
                },
                artifact_id,
            ))
        },
    )?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use serde_json::Value;
    use sidekicks_contracts::artifacts::id::ArtifactId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
    use sidekicks_contracts::workflow::run::id::WorkflowRunId;
    use sidekicks_contracts::workflow::run::step::record::WorkflowPayloadRef;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::{
        WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY, WorkflowKeptValueError,
        WorkflowKeptValueStore, kept_value_statements, remove_dropped,
    };
    use crate::engine::ports::StepPayloadArtifacts;
    use crate::engine::ports::kept_payloads::KeptPayloads;
    use crate::schema::schema_parts;
    use crate::test_rows::insert_workflow_version;

    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e70";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e71";
    const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e72";

    /// A workflow's kept values over a test database, written through its writer, with the
    /// payload store their artifacts are deleted through.
    struct KeptHarness {
        database: TestDatabase,
        writer: Arc<DatabaseWriter>,
        payloads: Arc<KeptPayloads>,
        store: WorkflowKeptValueStore,
    }

    impl KeptHarness {
        async fn new() -> Self {
            let database = TestDatabase::new(schema_parts());
            let writer = Arc::new(
                DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                    .await
                    .expect("the writer opens the test database"),
            );
            insert_workflow_version(&database.reader(), DEFINITION_ID, VERSION_ID, "Nightly");
            let payloads = Arc::new(KeptPayloads::default());
            let store = WorkflowKeptValueStore::new(
                Arc::new(DatabaseReadPool::new(
                    database.path(),
                    WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY,
                )),
                Arc::clone(&writer),
                Arc::clone(&payloads) as Arc<dyn StepPayloadArtifacts>,
            );
            Self {
                database,
                writer,
                payloads,
                store,
            }
        }

        /// Keeps a fresh artifact's reference under each of `names` in one write, as a step's
        /// settlement keeps a value above the inline cap, then deletes the artifacts the write
        /// left unnamed, and answers the artifacts kept, in the order of `names`.
        async fn keep(&self, names: &[&str]) -> Vec<ArtifactId> {
            let kept: Vec<(&str, Value, Option<ArtifactId>)> = names
                .iter()
                .map(|&name| {
                    let artifact_id = ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID");
                    (name, artifact_reference(artifact_id), Some(artifact_id))
                })
                .collect();
            self.write(&kept).await;
            kept.into_iter()
                .filter_map(|(_, _, artifact_id)| artifact_id)
                .collect()
        }

        /// Keeps each of `values` in one write, each beside the artifact it is kept in, if any,
        /// then deletes the artifacts the write left unnamed.
        async fn write(&self, values: &[(&str, Value, Option<ArtifactId>)]) {
            let write = kept_value_statements(
                definition_id(),
                WorkflowRunId::new(RUN_ID).expect("the test's run id"),
                values
                    .iter()
                    .map(|(name, value, artifact_id)| (*name, value, *artifact_id)),
                &WireInstant::now(),
            )
            .expect("a kept value writes");
            let results = self
                .writer
                .write(write.statements)
                .await
                .expect("the kept values commit");
            let left_behind =
                remove_dropped(&*self.payloads, &write.reads.unnamed_artifact_ids(&results)).await;
            assert!(left_behind.is_empty());
        }

        /// The artifact each kept value is kept in, by name.
        fn kept_artifacts(&self) -> Vec<(String, Option<String>)> {
            let rows = self.database.reader();
            let mut statement = rows
                .prepare("SELECT key, artifact_id FROM workflow_node_state ORDER BY key")
                .expect("the test reads the kept values");
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("the test reads the kept values")
                .collect::<Result<_, _>>()
                .expect("each kept value reads")
        }
    }

    fn definition_id() -> WorkflowDefinitionId {
        WorkflowDefinitionId::new(DEFINITION_ID).expect("the test's definition id")
    }

    /// The JSON of a payload reference to the one-item artifact `artifact_id`.
    fn artifact_reference(artifact_id: ArtifactId) -> Value {
        serde_json::to_value(WorkflowPayloadRef::Artifact {
            artifact_id,
            size_bytes: SafeInt::new(70_000).expect("a size"),
            item_count: SafeInt::new(1).expect("a count"),
        })
        .expect("a payload ref writes as JSON")
    }

    /// A value kept inline that has a payload reference's shape is workflow data: replacing it
    /// deletes no artifact, and the read answers it as it was kept. Mutation: tell a kept artifact
    /// by the value's shape (the replace deletes the artifact the data names, and the read tries
    /// to resolve it).
    #[tokio::test]
    async fn an_inline_value_shaped_like_a_reference_names_no_artifact() {
        let harness = KeptHarness::new().await;
        let named = ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID");
        let data = artifact_reference(named);
        harness.write(&[("body", data.clone(), None)]).await;

        let read = harness
            .store
            .read(definition_id())
            .await
            .expect("the values read");
        assert_eq!(
            read.into_iter().map(|kept| kept.value).collect::<Vec<_>>(),
            [data]
        );
        harness.write(&[("body", Value::Null, None)]).await;
        assert_eq!(harness.payloads.deletes(), []);
    }

    /// A value a step of a deleted workflow keeps in an artifact keeps no row, so its artifact is
    /// deleted once the write commits. Mutation: read only the replaced values' artifacts (the new
    /// artifact is left behind).
    #[tokio::test]
    async fn a_deleted_workflows_kept_artifact_is_deleted() {
        let harness = KeptHarness::new().await;
        harness
            .database
            .reader()
            .execute(
                "UPDATE workflow_definitions SET deleted_at = '2026-10-01T00:00:00.000Z'",
                [],
            )
            .expect("the test deletes the workflow");

        let kept = harness.keep(&["report"]).await;

        assert_eq!(harness.kept_artifacts(), []);
        assert_eq!(harness.payloads.deletes(), kept);
    }

    /// A value above the cap kept twice under one name leaves only the second artifact kept, and
    /// the first deleted. Mutations: the read left out of `kept_value_statements`, which deletes
    /// nothing; the read placed after the upsert, which deletes the second artifact.
    #[tokio::test]
    async fn a_replaced_kept_artifact_is_deleted() {
        let harness = KeptHarness::new().await;
        let first = harness.keep(&["report"]).await[0];
        let second = harness.keep(&["report"]).await[0];

        assert_eq!(harness.payloads.deletes(), [first]);
        assert_eq!(
            harness.kept_artifacts(),
            [("report".to_owned(), Some(second.text().as_str().to_owned()))]
        );
    }

    /// A clear of two kept artifacts deletes both once the clear commits; a delete the payload
    /// store refuses leaves the clear kept and answers each artifact left behind. Mutations: the
    /// read left out of `clear_kept_values_statements`, or the `remove_dropped` call in `clear`
    /// dropped, which deletes nothing; a refused delete that undoes the clear or goes unanswered.
    #[rstest]
    #[case::deleted(false)]
    #[case::left_behind(true)]
    #[tokio::test]
    async fn a_clear_deletes_its_kept_artifacts(#[case] is_refusing_deletes: bool) {
        let harness = KeptHarness::new().await;
        let kept = harness.keep(&["log", "report"]).await;
        if is_refusing_deletes {
            harness.payloads.refuse_deletes();
        }

        let cleared = harness.store.clear(definition_id()).await;

        assert_eq!(harness.kept_artifacts(), []);
        let (cleared, removed) = match cleared {
            Ok(cleared) => (cleared, harness.payloads.deletes()),
            Err(WorkflowKeptValueError::ArtifactsLeftBehind {
                cleared,
                left_behind,
            }) if is_refusing_deletes => (
                cleared,
                left_behind.0.into_iter().map(|(id, _)| id).collect(),
            ),
            Err(error) => panic!("the clear answers its artifacts: {error:?}"),
        };
        assert_eq!(cleared.cleared_count.get(), 2);
        assert_eq!(removed.len(), 2);
        assert!(kept.iter().all(|artifact_id| removed.contains(artifact_id)));
    }
}
