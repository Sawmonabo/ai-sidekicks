//! The writes to the one workflow library: create (a duplicate among them), save a new version,
//! soft delete, and the settings kept beside a version (layout, pinned data, tags, permission
//! level, background browser), which mint none. Each change is one write, so a refused write leaves
//! nothing behind.

mod settings;
#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::collections::HashMap;
use std::iter;
use std::sync::Arc;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::name_fold::fold_name;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::True;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowContentHash, WorkflowDefinitionId, WorkflowDocument, WorkflowDocumentSchemaVersion,
    WorkflowNode, WorkflowVersionId, pick_workflow_document_hashed_body,
};
use sidekicks_contracts::workflow::definition::item::WorkflowPinnedItem;
use sidekicks_contracts::workflow::definition::methods::{
    WorkflowCreateOrigin, WorkflowDefinitionCreateRequest, WorkflowDefinitionCreateResponse,
    WorkflowDefinitionDeleteResponse, WorkflowDefinitionUpdateRequest,
    WorkflowDefinitionUpdateResponse,
};
use sidekicks_contracts::workflow::definition::refusals::{
    WorkflowDefinitionFinding, WorkflowNodeHandles, check_workflow_graph,
};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{
    StatementBindings, StatementResult, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::safe_int_column;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::canonicalizer::CanonicalizationRefusal;

use crate::definitions::content_hash::{WorkflowDocumentHash, hash_workflow_body};
use crate::definitions::drafts::clear_workflow_draft_statement;
use crate::definitions::errors::DefinitionRefusal;
use crate::definitions::kept_values::clear_kept_values_statement;
use crate::definitions::library::{WorkflowLibrary, name_holder_statement};
use crate::not_found::{WorkflowNotFound, WorkflowVersionAddress};

/// The statements the store's reads run on a read connection beyond the library's: the latest
/// version a refused save is told about.
pub const WORKFLOW_DEFINITION_STORE_STATEMENT_CAPACITY: usize = 1;

// A permission level is left to the column's default, so a new workflow starts at `yolo`.
const INSERT_DEFINITION_SQL: &str = "INSERT INTO workflow_definitions (
    id, name, name_folded, content_hash, schema_version, definition_body, layout_json,
    pin_data_json, tags, created_at, created_by, updated_at
  ) VALUES (
    @id, @name, @name_folded, @content_hash, @schema_version, @definition_body, @layout_json,
    @pin_data_json, @tags, @created_at, @created_by, @created_at
  )";

// A Duplicate whose document holds the copied version's content, its hash under the source's name
// matching that version's, keeps that version's package locks; any other first version starts
// with none, for the package lock writer to fill.
const INSERT_FIRST_VERSION_SQL: &str = "INSERT INTO workflow_versions (
    id, definition_id, version_number, content_hash, schema_version, definition_body, layout_json,
    created_at, created_by, saved_by_agent_id, code_locks_json
  ) VALUES (
    @id, @definition_id, 1, @content_hash, @schema_version, @definition_body, @layout_json,
    @created_at, @created_by, @saved_by_agent_id,
    COALESCE((SELECT code_locks_json FROM workflow_versions
              WHERE id = @copied_version_id AND content_hash = @sent_content_hash), '{}')
  )";

// Matches only while the expected version is still the latest, so the staleness check and the
// save are one write and no second save can slip a version in between. A layout, tags or pinned
// data the document leaves out keeps what the definition holds; pinned data with no node clears it.
const UPDATE_CURRENT_BODY_SQL: &str = "UPDATE workflow_definitions SET
    name = @name, name_folded = @name_folded, content_hash = @content_hash,
    schema_version = @schema_version, definition_body = @definition_body,
    layout_json = COALESCE(@layout_json, layout_json), tags = COALESCE(@tags, tags),
    pin_data_json = CASE WHEN @carries_pin_data THEN @pin_data_json ELSE pin_data_json END,
    updated_at = @updated_at
  WHERE id = @id AND deleted_at IS NULL
    AND (SELECT MAX(version_number) FROM workflow_versions WHERE definition_id = @id)
      = @expected_version_number";

// Writes nothing for a document identical to the expected version, which stays the latest. A
// Restore repeats the older version it names, so the new version keeps that version's package
// locks, provided it holds that version's bytes; any other save starts with none, for the package
// lock writer to fill.
const INSERT_NEXT_VERSION_SQL: &str = "INSERT INTO workflow_versions (
    id, definition_id, version_number, parent_version_id, parent_content_hash, content_hash,
    schema_version, definition_body, layout_json, created_at, created_by, saved_by_agent_id,
    code_locks_json
  )
  SELECT @id, definition_id, version_number + 1, id, content_hash, @content_hash,
    @schema_version, @definition_body, @layout_json, @created_at, @created_by, @saved_by_agent_id,
    COALESCE((SELECT restored.code_locks_json FROM workflow_versions AS restored
              WHERE restored.definition_id = @definition_id
                AND restored.version_number = @restored_version_number
                AND restored.content_hash = @content_hash), '{}')
  FROM workflow_versions
  WHERE definition_id = @definition_id AND version_number = @expected_version_number
    AND content_hash <> @content_hash";

// The latest version once a save has run: the one it wrote, or the expected one it left latest.
const SAVED_VERSION_SQL: &str = "SELECT id, version_number, created_at FROM workflow_versions
  WHERE definition_id = @definition_id ORDER BY version_number DESC LIMIT 1";

// Returns a row for a version of a workflow in the library, the one a Duplicate may copy.
const COPIED_VERSION_SQL: &str = "SELECT 1 FROM workflow_versions AS version
  JOIN workflow_definitions AS definition ON definition.id = version.definition_id
  WHERE version.id = @copied_version_id AND definition.deleted_at IS NULL";

const LATEST_VERSION_SQL: &str = "SELECT deleted_at,
    (SELECT MAX(version_number) FROM workflow_versions WHERE definition_id = @definition_id)
      AS latest_version_number
  FROM workflow_definitions WHERE id = @definition_id";

const SOFT_DELETE_SQL: &str = "UPDATE workflow_definitions SET deleted_at = @at, updated_at = @at
  WHERE id = @definition_id AND deleted_at IS NULL";

// A deleted workflow arms nothing; a trigger with no schedule armed has no next fire.
const DISARM_TRIGGERS_SQL: &str = "UPDATE workflow_triggers SET enabled = 0, next_fire_at = NULL
  WHERE definition_id = @definition_id";

const COUNT_PINNED_RUNS_SQL: &str = "SELECT COUNT(*) FROM workflow_runs
  WHERE workflow_version_id IN (
    SELECT id FROM workflow_versions WHERE definition_id = @definition_id
  )";

// The position of the name check among a create's and a save's statements, of the copied
// version's check among a Duplicate's, and of the read of the saved version among a save's.
const NAME_CHECK_INDEX: usize = 0;
const COPIED_VERSION_INDEX: usize = 1;
const SAVED_VERSION_INDEX: usize = 3;
// How many free copy names a Duplicate reads, each followed by one write, so a name taken between
// a read and its write is read past once before the Duplicate is refused.
const DUPLICATE_NAME_READS: usize = 2;
// The position of the pinned runs' count among a delete's statements.
const PINNED_RUN_COUNT_INDEX: usize = 4;

/// What a save is checked against: each node's category and handles from the kinds table, or
/// `None` for a kind the table does not list.
pub(crate) type WorkflowNodeHandlesResolver =
    dyn Fn(&WorkflowNode) -> Option<WorkflowNodeHandles> + Send + Sync;

/// Who saved a version: the device the save came from, and the agent that saved it, if one did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkflowSaveAuthor {
    /// The device the save came from.
    pub(crate) device_id: DeviceId,
    /// The agent that saved it; `None` when the person did.
    pub(crate) agent_id: Option<AgentId>,
}

/// Why a write to the library was not kept; a refused write leaves nothing behind.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowDefinitionStoreError {
    /// The document breaks a rule or names a held name (`workflow.definition.refused`), or the
    /// save was based on a version no longer the latest (`workflow.version.stale`).
    #[error(transparent)]
    Refused(#[from] DefinitionRefusal),
    /// The workflow is not in the library (`workflow.definition.notFound`), or a Duplicate's
    /// copied version is not (`workflow.version.notFound`).
    #[error(transparent)]
    NotFound(#[from] WorkflowNotFound),
    /// The document's hashed body cannot be canonicalized, such as one nesting past the ceiling.
    #[error("the workflow document cannot be hashed")]
    Canonicalization(#[from] CanonicalizationRefusal),
    /// The writer did not keep the write.
    #[error("the workflow library's write was not kept")]
    Write(#[from] WriteError),
    /// SQLite refused a read, or a stored value did not read as its type.
    #[error("a read of the workflow library failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<WorkflowDefinitionStoreError> for HandlerError {
    /// A refused document, a stale save and a workflow or version not in the library answer their
    /// refusals; any other failure is a fault in the daemon.
    fn from(error: WorkflowDefinitionStoreError) -> Self {
        match error {
            WorkflowDefinitionStoreError::Refused(refusal) => Self::Refused(refusal.into()),
            WorkflowDefinitionStoreError::NotFound(not_found) => Self::Refused(not_found.into()),
            fault @ (WorkflowDefinitionStoreError::Canonicalization(_)
            | WorkflowDefinitionStoreError::Write(_)
            | WorkflowDefinitionStoreError::Database(_)
            | WorkflowDefinitionStoreError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// Writes the workflow library, reading through the daemon's read pool and writing through its
/// writer. A save is checked in the daemon before anything is written: every graph finding and a
/// name another workflow holds, compared by case fold, refuse it whole.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow definition and builder settings handlers and the workflow agent \
                  tools"
    )
)]
pub(crate) struct WorkflowDefinitionStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    resolve_node_handles: Box<WorkflowNodeHandlesResolver>,
}

impl WorkflowDefinitionStore {
    /// The store reading through `pool`, writing through `writer`, and checking each save's graph
    /// against the handles `resolve_node_handles` gives each node.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the workflow definition handlers and the workflow agent tools"
        )
    )]
    pub(crate) fn new(
        pool: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
        resolve_node_handles: Box<WorkflowNodeHandlesResolver>,
    ) -> Self {
        Self {
            pool,
            writer,
            resolve_node_handles,
        }
    }

    /// Creates a workflow and its first version in one write, with no policy check; a create from
    /// the new-workflow draft clears that draft in the same write. A Duplicate is written under
    /// the first free `<name> copy` name after the document's and keeps the copied version's
    /// package locks while the document holds that version's content. Fails with
    /// [`WorkflowDefinitionStoreError::Refused`] for a document with findings or a name another
    /// workflow holds, and with [`WorkflowDefinitionStoreError::NotFound`] for a copied version
    /// not in the library, writing nothing.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the workflow definition handlers and the workflow agent tools"
        )
    )]
    pub(crate) async fn create(
        &self,
        request: &WorkflowDefinitionCreateRequest,
        author: &WorkflowSaveAuthor,
    ) -> Result<WorkflowDefinitionCreateResponse, WorkflowDefinitionStoreError> {
        let document = &request.document;
        let WorkflowCreateOrigin::Duplicate { .. } = request.origin else {
            self.refuse_findings(document, None).await?;
            let hash = hash_workflow_body(&pick_workflow_document_hashed_body(document))?;
            let first_version = FirstVersion {
                name: &document.name,
                hash: &hash,
                sent_content_hash: &hash.content_hash,
            };
            return self
                .insert_workflow(document, &first_version, author, request.origin)
                .await?
                .ok_or_else(|| name_taken().into());
        };
        // The free copy name read stands for the name check before the write.
        refuse_unless_empty(self.graph_findings(document))?;
        let mut hashed_body = pick_workflow_document_hashed_body(document);
        let sent_content_hash = hash_workflow_body(&hashed_body)?.content_hash;
        for _ in 0..DUPLICATE_NAME_READS {
            let source_name = document.name.as_str().to_owned();
            let copy_name = self
                .pool
                .read(ReadLength::Short, move |connection| {
                    Ok::<_, WorkflowDefinitionStoreError>(
                        WorkflowLibrary::new(connection).first_free_duplicate_name(&source_name)?,
                    )
                })
                .await?;
            hashed_body.name =
                NonEmptyText::new(copy_name).expect("a copy's name holds its source's name");
            let first_version = FirstVersion {
                name: &hashed_body.name,
                hash: &hash_workflow_body(&hashed_body)?,
                sent_content_hash: &sent_content_hash,
            };
            if let Some(created) = self
                .insert_workflow(document, &first_version, author, request.origin)
                .await?
            {
                return Ok(created);
            }
        }
        Err(name_taken().into())
    }

    /// Saves the document as the workflow's next version, only while `expectedVersionNumber` is
    /// still its latest, even where it repeats an older version's bytes as Restore does; a document
    /// identical to the latest writes no version and answers with the latest. It stores the
    /// layout, tags and pinned data the document carries on the workflow and clears the workflow's
    /// draft in the same write. Fails with [`WorkflowDefinitionStoreError::Refused`] for findings,
    /// a held name or an expected version that is not the latest, and with
    /// [`WorkflowDefinitionStoreError::NotFound`] for a workflow not in the library; a refused
    /// save writes no row.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the workflow definition handlers and the workflow agent tools"
        )
    )]
    pub(crate) async fn update(
        &self,
        request: &WorkflowDefinitionUpdateRequest,
        author: &WorkflowSaveAuthor,
    ) -> Result<WorkflowDefinitionUpdateResponse, WorkflowDefinitionStoreError> {
        self.refuse_findings(&request.document, Some(request.definition_id))
            .await?;
        self.write_update(request, author).await
    }

    // The save's one write, which checks the name and the expected version again inside it, so a
    // name taken or a version saved since the check refuses it whole.
    async fn write_update(
        &self,
        request: &WorkflowDefinitionUpdateRequest,
        author: &WorkflowSaveAuthor,
    ) -> Result<WorkflowDefinitionUpdateResponse, WorkflowDefinitionStoreError> {
        let definition_id = request.definition_id;
        let document = &request.document;
        let WorkflowDocumentHash {
            canonical_body,
            content_hash,
        } = hash_workflow_body(&pick_workflow_document_hashed_body(document))?;
        let workflow_version_id = mint_workflow_version_id();
        let created_at = WireInstant::now();
        let name_folded = fold_name(document.name.as_str());
        let definition_text = definition_id.text();
        let schema_version = schema_version_text(document);
        let layout_json = document.layout.as_ref().map(json_text);
        let expected_version_number = Value::Integer(i64::from(request.expected_version_number));
        let update_body = WriteStatement {
            sql: Cow::Borrowed(UPDATE_CURRENT_BODY_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@id", definition_text.as_str()),
                text_binding("@name", document.name.as_str()),
                text_binding("@name_folded", &name_folded),
                text_binding("@content_hash", content_hash.0.as_str()),
                text_binding("@schema_version", schema_version),
                text_binding("@definition_body", &canonical_body),
                nullable_text_binding("@layout_json", layout_json.as_deref()),
                nullable_text_binding("@tags", document.tags.as_ref().map(json_text).as_deref()),
                (
                    Cow::Borrowed("@carries_pin_data"),
                    Value::Integer(i64::from(document.pin_data.is_some())),
                ),
                nullable_text_binding(
                    "@pin_data_json",
                    stored_pin_data_json(document.pin_data.as_ref()).as_deref(),
                ),
                text_binding("@updated_at", created_at.as_str()),
                (
                    Cow::Borrowed("@expected_version_number"),
                    expected_version_number.clone(),
                ),
            ]),
            expected_row_count: Some(1),
        };
        let insert_version = WriteStatement {
            sql: Cow::Borrowed(INSERT_NEXT_VERSION_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@id", workflow_version_id.text().as_str()),
                text_binding("@definition_id", definition_text.as_str()),
                text_binding("@content_hash", content_hash.0.as_str()),
                text_binding("@schema_version", schema_version),
                text_binding("@definition_body", &canonical_body),
                nullable_text_binding("@layout_json", layout_json.as_deref()),
                text_binding("@created_at", created_at.as_str()),
                text_binding("@created_by", author.device_id.as_str()),
                saved_by_agent_binding(author),
                (
                    Cow::Borrowed("@expected_version_number"),
                    expected_version_number,
                ),
                (
                    Cow::Borrowed("@restored_version_number"),
                    request
                        .restored_version_number
                        .map_or(Value::Null, |number| Value::Integer(i64::from(number))),
                ),
            ]),
            expected_row_count: None,
        };
        let read_saved_version = WriteStatement {
            sql: Cow::Borrowed(SAVED_VERSION_SQL),
            bindings: StatementBindings::Named(vec![text_binding(
                "@definition_id",
                definition_text.as_str(),
            )]),
            expected_row_count: Some(1),
        };
        let statements = vec![
            name_holder_statement(&name_folded, Some(definition_id)),
            update_body,
            insert_version,
            read_saved_version,
            clear_workflow_draft_statement(Some(definition_id)),
        ];
        let results = match self.writer.write(statements).await {
            Ok(results) => results,
            Err(WriteError::Refused {
                statement_index: NAME_CHECK_INDEX,
                ..
            }) => return Err(name_taken().into()),
            Err(WriteError::Refused { .. }) => {
                return Err(self
                    .refusal_for_missed_version(definition_id, request.expected_version_number)
                    .await);
            }
            Err(error) => return Err(error.into()),
        };
        let saved = saved_version_of(&results);
        Ok(WorkflowDefinitionUpdateResponse {
            definition_id,
            version_number: saved.version_number,
            workflow_version_id: saved.workflow_version_id,
            content_hash,
            created_at: saved.created_at,
        })
    }

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
        let statements = vec![
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
            clear_kept_values_statement(definition_id),
            clear_workflow_draft_statement(Some(definition_id)),
            WriteStatement {
                sql: Cow::Borrowed(COUNT_PINNED_RUNS_SQL),
                bindings: of_definition(),
                expected_row_count: None,
            },
        ];
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

    // Writes a workflow and its first version from `document` under the name and hash
    // `first_version` gives, the copied version checked inside the write for a Duplicate and the
    // new-workflow draft cleared for a create from it. `None` when the write's name check finds
    // the name taken.
    async fn insert_workflow(
        &self,
        document: &WorkflowDocument,
        first_version: &FirstVersion<'_>,
        author: &WorkflowSaveAuthor,
        origin: WorkflowCreateOrigin,
    ) -> Result<Option<WorkflowDefinitionCreateResponse>, WorkflowDefinitionStoreError> {
        let FirstVersion {
            name,
            hash:
                WorkflowDocumentHash {
                    canonical_body,
                    content_hash,
                },
            sent_content_hash,
        } = first_version;
        let definition_id =
            WorkflowDefinitionId::try_from(mint_uuid_v7()).expect("a minted UUID is a workflow id");
        let workflow_version_id = mint_workflow_version_id();
        let created_at = WireInstant::now();
        let name_folded = fold_name(name.as_str());
        let definition_text = definition_id.text();
        let schema_version = schema_version_text(document);
        let layout_json = document.layout.as_ref().map(json_text);
        let tags_json = document
            .tags
            .as_ref()
            .map_or_else(|| "[]".to_owned(), json_text);
        let copied_version_id = match origin {
            WorkflowCreateOrigin::Duplicate { copied_version_id } => Some(copied_version_id),
            WorkflowCreateOrigin::NewWorkflowDraft {} | WorkflowCreateOrigin::FileImport {} => None,
        };
        let copied_version_text = copied_version_id.map(|id| id.text());
        let copied_version_binding = || {
            nullable_text_binding(
                "@copied_version_id",
                copied_version_text.as_ref().map(UuidText::as_str),
            )
        };
        let mut statements = vec![name_holder_statement(&name_folded, None)];
        if copied_version_id.is_some() {
            statements.push(WriteStatement {
                sql: Cow::Borrowed(COPIED_VERSION_SQL),
                bindings: StatementBindings::Named(vec![copied_version_binding()]),
                expected_row_count: Some(1),
            });
        }
        statements.extend([
            WriteStatement {
                sql: Cow::Borrowed(INSERT_DEFINITION_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@id", definition_text.as_str()),
                    text_binding("@name", name.as_str()),
                    text_binding("@name_folded", &name_folded),
                    text_binding("@content_hash", content_hash.0.as_str()),
                    text_binding("@schema_version", schema_version),
                    text_binding("@definition_body", canonical_body),
                    nullable_text_binding("@layout_json", layout_json.as_deref()),
                    nullable_text_binding(
                        "@pin_data_json",
                        stored_pin_data_json(document.pin_data.as_ref()).as_deref(),
                    ),
                    text_binding("@tags", &tags_json),
                    text_binding("@created_at", created_at.as_str()),
                    text_binding("@created_by", author.device_id.as_str()),
                ]),
                expected_row_count: None,
            },
            WriteStatement {
                sql: Cow::Borrowed(INSERT_FIRST_VERSION_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@id", workflow_version_id.text().as_str()),
                    text_binding("@definition_id", definition_text.as_str()),
                    text_binding("@content_hash", content_hash.0.as_str()),
                    text_binding("@schema_version", schema_version),
                    text_binding("@definition_body", canonical_body),
                    nullable_text_binding("@layout_json", layout_json.as_deref()),
                    text_binding("@created_at", created_at.as_str()),
                    text_binding("@created_by", author.device_id.as_str()),
                    saved_by_agent_binding(author),
                    copied_version_binding(),
                    text_binding("@sent_content_hash", sent_content_hash.0.as_str()),
                ]),
                expected_row_count: None,
            },
        ]);
        if matches!(origin, WorkflowCreateOrigin::NewWorkflowDraft {}) {
            statements.push(clear_workflow_draft_statement(None));
        }
        match (self.writer.write(statements).await, copied_version_id) {
            (Ok(_), _) => {}
            (
                Err(WriteError::Refused {
                    statement_index: NAME_CHECK_INDEX,
                    ..
                }),
                _,
            ) => return Ok(None),
            (
                Err(WriteError::Refused {
                    statement_index: COPIED_VERSION_INDEX,
                    ..
                }),
                Some(workflow_version_id),
            ) => {
                return Err(WorkflowNotFound::Version(WorkflowVersionAddress::Id {
                    workflow_version_id,
                })
                .into());
            }
            (Err(error), _) => return Err(error.into()),
        }
        Ok(Some(WorkflowDefinitionCreateResponse {
            definition_id,
            version_number: SafeInt::new(1).expect("one is a version number"),
            content_hash: content_hash.clone(),
            workflow_version_id,
            created_at,
        }))
    }

    // Every graph finding and a held name are refused together, so the author sees them all at
    // once.
    async fn refuse_findings(
        &self,
        document: &WorkflowDocument,
        saved_definition_id: Option<WorkflowDefinitionId>,
    ) -> Result<(), WorkflowDefinitionStoreError> {
        let mut findings = self.graph_findings(document);
        let name = document.name.as_str().to_owned();
        let is_name_held = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WorkflowDefinitionStoreError>(
                    WorkflowLibrary::new(connection).is_name_held(&name, saved_definition_id)?,
                )
            })
            .await?;
        if is_name_held {
            findings.push(name_taken_finding());
        }
        refuse_unless_empty(findings)
    }

    // The graph check over the document's trigger, nodes and edges, each node's handles resolved
    // from its kind.
    fn graph_findings(&self, document: &WorkflowDocument) -> Vec<WorkflowDefinitionFinding> {
        let trigger = WorkflowNode::from(&document.trigger);
        let node_handles: HashMap<_, _> = iter::once(&trigger)
            .chain(&document.nodes)
            .filter_map(|node| {
                (self.resolve_node_handles)(node).map(|handles| (node.id.clone(), handles))
            })
            .collect();
        check_workflow_graph(
            Some(&trigger),
            &document.nodes,
            &document.edges,
            &node_handles,
        )
    }

    // A save whose staleness check matched no row: the workflow is gone, or another save came
    // first.
    async fn refusal_for_missed_version(
        &self,
        definition_id: WorkflowDefinitionId,
        expected_version_number: SafeInt<1>,
    ) -> WorkflowDefinitionStoreError {
        let latest = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WorkflowDefinitionStoreError>(read_latest_version(
                    connection,
                    definition_id,
                )?)
            })
            .await;
        match latest {
            Ok(Some(latest_version_number)) => DefinitionRefusal::VersionStale {
                definition_id,
                expected_version_number,
                latest_version_number,
            }
            .into(),
            Ok(None) => WorkflowNotFound::Definition { definition_id }.into(),
            Err(error) => error,
        }
    }
}

/// What a create's first version is written under: the workflow's name, the hash of the hashed
/// body under that name, and the hash of the document as sent, which a Duplicate's lock carry
/// compares with the copied version's.
struct FirstVersion<'a> {
    name: &'a NonEmptyText,
    hash: &'a WorkflowDocumentHash,
    sent_content_hash: &'a WorkflowContentHash,
}

/// The latest version a save just read back in its own write.
struct SavedVersion {
    workflow_version_id: WorkflowVersionId,
    version_number: SafeInt<1>,
    created_at: WireInstant,
}

// The row the save's own read returned, which the writer refuses the write without. The table
// types the version's id, number and save time, and the store wrote each.
fn saved_version_of(results: &[StatementResult]) -> SavedVersion {
    let row = results
        .get(SAVED_VERSION_INDEX)
        .and_then(|read| read.rows.first())
        .expect("the save's read of its version expects one row");
    let text = |index: usize| match row.get(index) {
        Some(Value::Text(text)) => Some(text.clone()),
        _ => None,
    };
    let version_number = match row.get(1) {
        Some(&Value::Integer(number)) => u64::try_from(number).ok().and_then(SafeInt::new),
        _ => None,
    };
    SavedVersion {
        workflow_version_id: text(0)
            .and_then(|id| WorkflowVersionId::new(&id).ok())
            .expect("a version's id is the UUID the store minted"),
        version_number: version_number.expect("a version's number counts from 1"),
        created_at: text(2)
            .and_then(|created_at| WireInstant::try_from(created_at).ok())
            .expect("a version's save time is the instant the store wrote"),
    }
}

// The workflow's latest version number, or `None` for a workflow not in the library.
fn read_latest_version(
    connection: &Connection,
    definition_id: WorkflowDefinitionId,
) -> rusqlite::Result<Option<SafeInt<1>>> {
    let mut statement = connection.prepare_cached(LATEST_VERSION_SQL)?;
    let latest = statement
        .query_row(
            named_params! { "@definition_id": definition_id.text().as_str() },
            |row| {
                let deleted_at: Option<String> = row.get(0)?;
                let latest: Option<i64> = row.get(1)?;
                Ok(match (deleted_at, latest) {
                    (None, Some(_)) => Some(safe_int_column(row, 1)?),
                    (Some(_) | None, _) => None,
                })
            },
        )
        .optional()?;
    Ok(latest.flatten())
}

fn name_taken_finding() -> WorkflowDefinitionFinding {
    WorkflowDefinitionFinding::NameTaken {
        node_ids: Vec::new(),
    }
}

// Refuses the findings whole, so the author sees them all at once.
fn refuse_unless_empty(
    findings: Vec<WorkflowDefinitionFinding>,
) -> Result<(), WorkflowDefinitionStoreError> {
    if findings.is_empty() {
        Ok(())
    } else {
        Err(DefinitionRefusal::Refused { findings }.into())
    }
}

fn name_taken() -> DefinitionRefusal {
    DefinitionRefusal::Refused {
        findings: vec![name_taken_finding()],
    }
}

// The agent that saved a version, `NULL` when the person did.
fn saved_by_agent_binding(author: &WorkflowSaveAuthor) -> (Cow<'static, str>, Value) {
    let agent_text = author.agent_id.map(|agent_id| agent_id.text());
    nullable_text_binding(
        "@saved_by_agent_id",
        agent_text.as_ref().map(UuidText::as_str),
    )
}

fn mint_workflow_version_id() -> WorkflowVersionId {
    WorkflowVersionId::try_from(mint_uuid_v7()).expect("a minted UUID is a version id")
}

// A value the contracts type as JSON, written as its text.
fn json_text(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).expect("a contract value writes as JSON")
}

// The document schema version as the column stores it.
fn schema_version_text(document: &WorkflowDocument) -> &'static str {
    match document.schema_version {
        WorkflowDocumentSchemaVersion::Value => "2",
    }
}

// Pinned data with no node is stored as nothing pinned, as unpinning the last node leaves it.
fn stored_pin_data_json(
    pin_data: Option<&Record<String, Vec<WorkflowPinnedItem>>>,
) -> Option<String> {
    pin_data
        .filter(|pin_data| !pin_data.as_map().is_empty())
        .map(json_text)
}
