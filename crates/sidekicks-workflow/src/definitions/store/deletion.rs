//! A workflow's soft delete: the workflow marked deleted, its triggers disarmed and its kept
//! values and draft deleted in one write, its versions kept for the runs pinned to them.

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
use crate::definitions::kept_values::clear_kept_values_statements;
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

// The position of the pinned runs' count among a delete's statements.
const PINNED_RUN_COUNT_INDEX: usize = 5;

impl WorkflowDefinitionStore {
    /// Marks the workflow deleted, disarms its triggers, and deletes its kept values and its draft,
    /// in one write; its versions stay, so the runs pinned to them still read, and the reply counts
    /// those runs. Fails with [`WorkflowDefinitionStoreError::NotFound`] for a workflow not in the
    /// library.
    #[expect(
        dead_code,
        reason = "the workflow definition handlers and the workflow agent tools"
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
        statements.extend(clear_kept_values_statements(definition_id).statements);
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
        Ok(WorkflowDefinitionDeleteResponse {
            definition_id,
            deleted: True::default(),
            retained_run_count,
        })
    }
}
