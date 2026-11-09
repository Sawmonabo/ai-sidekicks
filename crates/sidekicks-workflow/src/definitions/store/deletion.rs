//! A workflow's soft delete: the workflow marked deleted, its triggers disarmed and its kept
//! values and draft deleted in one write, its versions kept for the runs pinned to them, then the
//! artifacts its kept values named deleted.

use std::borrow::Cow;

use rusqlite::types::Value;
use sidekicks_contracts::wire::True;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_contracts::workflow::definition::methods::WorkflowDefinitionDeleteResponse;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::WriteError;

use super::{WorkflowDefinitionStore, WorkflowDefinitionStoreError};
use crate::definitions::drafts::clear_workflow_draft_statement;
use crate::definitions::kept_values::{
    KeptArtifactReads, KeptArtifactsLeftBehind, clear_kept_values_statements, remove_dropped,
};
use crate::not_found::WorkflowNotFound;

const SOFT_DELETE_SQL: &str = "UPDATE workflow_definitions SET deleted_at = @at, updated_at = @at
  WHERE id = @definition_id AND deleted_at IS NULL";

// A deleted workflow arms nothing; a trigger with no schedule armed has no next fire.
const DISARM_TRIGGERS_SQL: &str = "UPDATE workflow_triggers SET enabled = 0, next_fire_at = NULL
  WHERE definition_id = @definition_id";

const COUNT_PINNED_RUNS_SQL: &str = "SELECT COUNT(*) FROM workflow_runs
  WHERE workflow_version_id IN (
    SELECT id FROM workflow_versions WHERE definition_id = @definition_id
  )";

// Where the kept values' statements start, and the position of the pinned runs' count, among a
// delete's statements.
const KEPT_VALUES_WRITE_INDEX: usize = 2;
const PINNED_RUN_COUNT_INDEX: usize = 5;

impl WorkflowDefinitionStore {
    /// Marks the workflow deleted, disarms its triggers, and deletes its kept values and its draft,
    /// in one write; its versions stay, so the runs pinned to them still read, and the reply counts
    /// those runs. Once the write commits, the artifacts the deleted kept values named are deleted.
    /// Fails with [`WorkflowDefinitionStoreError::NotFound`] for a workflow not in the library,
    /// and with [`WorkflowDefinitionStoreError::KeptArtifactsLeftBehind`], the delete kept, when
    /// an artifact could not be deleted.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the workflow definition handlers and the workflow agent tools"
        )
    )]
    pub(crate) async fn delete(
        &self,
        definition_id: WorkflowDefinitionId,
    ) -> Result<WorkflowDefinitionDeleteResponse, WorkflowDefinitionStoreError> {
        let definition_text = definition_id.text();
        let deleted_at = WireInstant::now();
        let of_definition = || {
            StatementBindings::Named(vec![text_binding(
                "@definition_id",
                definition_text.as_str(),
            )])
        };
        let mut statements = vec![
            WriteStatement {
                sql: Cow::Borrowed(SOFT_DELETE_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@at", deleted_at.as_str()),
                    text_binding("@definition_id", definition_text.as_str()),
                ]),
                expected_row_count: Some(1),
            },
            WriteStatement {
                sql: Cow::Borrowed(DISARM_TRIGGERS_SQL),
                bindings: of_definition(),
                expected_row_count: None,
            },
        ];
        let clear = clear_kept_values_statements(definition_id);
        let mut kept_reads = KeptArtifactReads::default();
        kept_reads.extend_at(KEPT_VALUES_WRITE_INDEX, clear.reads);
        statements.extend(clear.statements);
        statements.extend([
            clear_workflow_draft_statement(Some(definition_id)),
            WriteStatement {
                sql: Cow::Borrowed(COUNT_PINNED_RUNS_SQL),
                bindings: of_definition(),
                expected_row_count: None,
            },
        ]);
        let results = match self.writer.write(statements).await {
            Ok(results) => results,
            Err(WriteError::Refused { .. }) => {
                return Err(WorkflowNotFound::Definition { definition_id }.into());
            }
            Err(error) => return Err(error.into()),
        };
        let retained_run_count = match results
            .get(PINNED_RUN_COUNT_INDEX)
            .and_then(|count| count.rows.first())
            .and_then(|row| row.first())
        {
            Some(&Value::Integer(count)) => u64::try_from(count).ok().and_then(SafeInt::new),
            _ => None,
        }
        .expect("a count of rows is a safe integer");
        let deleted = WorkflowDefinitionDeleteResponse {
            definition_id,
            deleted: True::default(),
            retained_run_count,
        };
        let left_behind =
            remove_dropped(&*self.payloads, &kept_reads.unnamed_artifact_ids(&results)).await;
        if left_behind.is_empty() {
            Ok(deleted)
        } else {
            Err(WorkflowDefinitionStoreError::KeptArtifactsLeftBehind {
                deleted,
                left_behind: KeptArtifactsLeftBehind(left_behind),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use sidekicks_contracts::artifacts::id::ArtifactId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
    use sidekicks_contracts::workflow::run::step::record::WorkflowPayloadRef;
    use sidekicks_store::database::writer::test_file::TestDatabase;

    use crate::definitions::store::tests::{SHELL_LINE_LIMIT, open_stores};
    use crate::schema::schema_parts;
    use crate::test_rows::insert_workflow_version;

    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e90";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e91";
    const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e92";

    /// A deleted workflow's value kept as an artifact has that artifact deleted once the delete
    /// commits. Mutation: the `remove_dropped` call in `delete` dropped, which leaves the artifact
    /// undeleted.
    #[tokio::test]
    async fn a_deleted_workflows_kept_artifact_is_deleted() {
        let database = TestDatabase::new(schema_parts());
        let (store, _drafts, payloads) = open_stores(&database, SHELL_LINE_LIMIT).await;
        let rows = database.reader();
        insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Nightly");
        let artifact_id =
            ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID is an artifact id");
        let reference = WorkflowPayloadRef::Artifact {
            artifact_id,
            size_bytes: SafeInt::new(70_000).expect("a size"),
            item_count: SafeInt::new(1).expect("a count"),
        };
        rows.execute(
            "INSERT INTO workflow_node_state
               (definition_id, node_id, key, value_json, artifact_id, kept_by_run_id, updated_at)
             VALUES (?1, '', 'report', ?2, ?3, ?4, '2026-10-02T00:00:00.000Z')",
            params![
                DEFINITION_ID,
                serde_json::to_string(&reference).expect("a payload ref writes as JSON"),
                artifact_id.to_string(),
                RUN_ID,
            ],
        )
        .expect("the test keeps a value");

        store
            .delete(WorkflowDefinitionId::new(DEFINITION_ID).expect("the test's definition id"))
            .await
            .expect("the delete commits and removes its kept artifact");

        assert_eq!(payloads.deletes(), [artifact_id]);
    }
}
