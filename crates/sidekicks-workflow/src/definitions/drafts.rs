//! The builder's unsaved drafts, one per saved workflow and one for a new workflow, so a draft
//! survives a reload of the window. Saving a version clears its workflow's draft in the same write.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::builder::{
    NewWorkflowDraft, SavedWorkflowDraft, WorkflowDraft, WorkflowDraftReadResponse,
    WorkflowDraftUpdateRequest, WorkflowDraftUpdateResponse,
};
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowDraftDocument,
};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{safe_int_column, text_column};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

use crate::definitions::library::live_definition_statement;
use crate::not_found::WorkflowNotFound;

/// The statements the store's reads run: the held draft.
pub const WORKFLOW_DRAFT_STORE_STATEMENT_CAPACITY: usize = 1;

// The key of the new workflow's draft, which names no definition.
const NEW_WORKFLOW_DRAFT_KEY: &str = "";

const SELECT_DRAFT_SQL: &str = "SELECT based_on_version_number, document_json, updated_at
  FROM workflow_drafts WHERE definition_id = @definition_id";

const UPSERT_DRAFT_SQL: &str = "INSERT INTO workflow_drafts
    (definition_id, based_on_version_number, document_json, updated_at)
  VALUES (@definition_id, @based_on_version_number, @document_json, @updated_at)
  ON CONFLICT (definition_id) DO UPDATE SET
    based_on_version_number = excluded.based_on_version_number,
    document_json = excluded.document_json,
    updated_at = excluded.updated_at";

const DELETE_DRAFT_SQL: &str = "DELETE FROM workflow_drafts WHERE definition_id = @definition_id";

/// Why a draft was not read or stored; a refused store keeps nothing.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowDraftError {
    /// The saved workflow the draft names is not in the library (`workflow.definition.notFound`).
    #[error(transparent)]
    NotFound(#[from] WorkflowNotFound),
    /// The writer did not keep the draft.
    #[error("the workflow draft's write was not kept")]
    Write(#[from] WriteError),
    /// SQLite refused the read, or a stored value did not read as its type.
    #[error("a read of a workflow draft failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<WorkflowDraftError> for HandlerError {
    /// A draft of a workflow not in the library answers its not-found refusal; any other failure
    /// is a fault in the daemon.
    fn from(error: WorkflowDraftError) -> Self {
        match error {
            WorkflowDraftError::NotFound(not_found) => Self::Refused(not_found.into()),
            fault @ (WorkflowDraftError::Write(_)
            | WorkflowDraftError::Database(_)
            | WorkflowDraftError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// The statement that clears a saved workflow's draft, or with no id the new workflow's, for a save
/// or a delete to run inside its own write.
pub(crate) fn clear_workflow_draft_statement(
    definition_id: Option<WorkflowDefinitionId>,
) -> WriteStatement {
    let definition_text = definition_id.map(|id| id.text());
    WriteStatement {
        sql: Cow::Borrowed(DELETE_DRAFT_SQL),
        bindings: StatementBindings::Named(vec![text_binding(
            "@definition_id",
            draft_key(definition_text.as_ref()),
        )]),
        expected_row_count: None,
    }
}

// The key a draft is held under: its saved workflow's id, or the new workflow's key with none.
fn draft_key(definition_text: Option<&UuidText>) -> &str {
    definition_text.map_or(NEW_WORKFLOW_DRAFT_KEY, UuidText::as_str)
}

/// Holds the builder's drafts in `workflow_drafts`, reading through the daemon's read pool and
/// writing through its writer. Each update replaces the draft it names whole, so the last write
/// wins and a retried update needs no key.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow.draft.read and workflow.draft.update handlers"
    )
)]
pub(crate) struct WorkflowDraftStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow.draft.read and workflow.draft.update handlers"
    )
)]
impl WorkflowDraftStore {
    /// The store reading through `pool` and writing through `writer`.
    pub(crate) fn new(pool: Arc<DatabaseReadPool>, writer: Arc<DatabaseWriter>) -> Self {
        Self { pool, writer }
    }

    /// The draft of the named workflow, or of the new workflow with no id; `draft` is `None` when
    /// none is held. Fails with [`WorkflowDraftError::Database`] or [`WorkflowDraftError::Pool`]
    /// when the read does.
    pub(crate) async fn read(
        &self,
        definition_id: Option<WorkflowDefinitionId>,
    ) -> Result<WorkflowDraftReadResponse, WorkflowDraftError> {
        let draft = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WorkflowDraftError>(read_draft(connection, definition_id)?)
            })
            .await?;
        Ok(WorkflowDraftReadResponse { draft })
    }

    /// Replaces the draft the request names and answers when it was stored, once committed. Fails
    /// with [`WorkflowDraftError::NotFound`] for a saved workflow that is not in the library, and
    /// with [`WorkflowDraftError::Write`] when the write is not kept.
    pub(crate) async fn update(
        &self,
        request: &WorkflowDraftUpdateRequest,
    ) -> Result<WorkflowDraftUpdateResponse, WorkflowDraftError> {
        let updated_at = WireInstant::now();
        let (definition_id, based_on_version_number, document) = match request {
            WorkflowDraftUpdateRequest::Saved(saved) => (
                Some(saved.definition_id),
                saved.based_on_version_number,
                &saved.document,
            ),
            WorkflowDraftUpdateRequest::New(new) => (None, None, &new.document),
        };
        let document_json =
            serde_json::to_string(document).expect("a draft document writes as JSON");
        let definition_text = definition_id.map(|id| id.text());
        let upsert = WriteStatement {
            sql: Cow::Borrowed(UPSERT_DRAFT_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@definition_id", draft_key(definition_text.as_ref())),
                (
                    Cow::Borrowed("@based_on_version_number"),
                    based_on_version_number
                        .map_or(Value::Null, |number| Value::Integer(i64::from(number))),
                ),
                (Cow::Borrowed("@document_json"), Value::Text(document_json)),
                text_binding("@updated_at", updated_at.as_str()),
            ]),
            expected_row_count: None,
        };
        match definition_id {
            None => {
                self.writer.write(vec![upsert]).await?;
            }
            // The library check and the upsert are one write, so a delete cannot land between them.
            Some(definition_id) => {
                match self
                    .writer
                    .write(vec![live_definition_statement(definition_id), upsert])
                    .await
                {
                    Ok(_) => {}
                    Err(WriteError::Refused { .. }) => {
                        return Err(WorkflowNotFound::Definition { definition_id }.into());
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(WorkflowDraftUpdateResponse { updated_at })
    }
}

// The held draft `definition_id` names, or the new workflow's with none.
fn read_draft(
    connection: &Connection,
    definition_id: Option<WorkflowDefinitionId>,
) -> rusqlite::Result<Option<WorkflowDraft>> {
    let definition_text = definition_id.map(|id| id.text());
    let mut statement = connection.prepare_cached(SELECT_DRAFT_SQL)?;
    statement
        .query_row(
            named_params! { "@definition_id": draft_key(definition_text.as_ref()) },
            |row| {
                let document: WorkflowDraftDocument =
                    text_column(row, 1, |text| serde_json::from_str(&text))?;
                let updated_at = text_column(row, 2, WireInstant::try_from)?;
                let Some(definition_id) = definition_id else {
                    return Ok(WorkflowDraft::New(NewWorkflowDraft {
                        definition_id: None,
                        based_on_version_number: None,
                        document,
                        updated_at,
                    }));
                };
                let based_on_version_number = match row.get::<_, Option<i64>>(0)? {
                    None => None,
                    Some(_) => Some(safe_int_column(row, 0)?),
                };
                Ok(WorkflowDraft::Saved(SavedWorkflowDraft {
                    definition_id,
                    based_on_version_number,
                    document,
                    updated_at,
                }))
            },
        )
        .optional()
}
