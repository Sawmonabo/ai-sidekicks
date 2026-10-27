//! Reads of the one workflow library: a definition with its document at a version, the list of
//! every workflow not deleted with its paging cursor, and whether a name is held, compared by its
//! case fold. The statements a write runs inside itself to check a name and a workflow are built
//! here too.

use std::borrow::Cow;

use rusqlite::{Connection, Row, named_params};
use sidekicks_contracts::name_fold::fold_name;
use sidekicks_contracts::tag::TagList;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowContentHash, WorkflowDefinitionId, WorkflowNodeKindId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::methods::{
    WorkflowDefinitionLastRun, WorkflowDefinitionListCursor, WorkflowDefinitionListRequest,
    WorkflowDefinitionReadRequest, WorkflowDefinitionReadResponse,
    WorkflowDefinitionReadWithWebhookToken, WorkflowDefinitionReadWithoutWebhookToken,
    WorkflowWebhookLastFire,
};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;

use crate::definitions::stored_document::{
    StoredDocumentError, StoredWorkflowDocumentColumns, read_stored_workflow_document,
};
use crate::not_found::{WorkflowNotFound, WorkflowVersionAddress};
use crate::runs::invalid_cursor::{UnresolvableCursorReason, WorkflowCursorUnresolvable};
use crate::runs::record::column;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};

/// The statements a [`WorkflowLibrary`] prepares on a read connection: the name holder, the
/// definition read, the definition list and the list cursor's check.
pub(crate) const WORKFLOW_LIBRARY_STATEMENT_CAPACITY: usize = 4;

// A definition never has the empty id, so binding it excludes no workflow.
const NO_DEFINITION_EXCLUDED: &str = "";

const NAME_HOLDER_SQL: &str = "SELECT id FROM workflow_definitions
  WHERE name_folded = @name_folded AND deleted_at IS NULL AND id <> @except_definition_id
  LIMIT 1";

const LIVE_DEFINITION_SQL: &str =
    "SELECT 1 FROM workflow_definitions WHERE id = @definition_id AND deleted_at IS NULL";

// One row for any workflow ever created, deleted or not: a deleted workflow keeps its row, so the
// cursor naming the last of a page still finds it.
const CREATED_DEFINITION_SQL: &str = "SELECT 1 FROM workflow_definitions WHERE id = @definition_id";

// One statement, so the definition, its version and its token are read from one snapshot. The
// layout a read serves is the definition's own at the latest version and the snapshot otherwise.
const READ_DEFINITION_SQL: &str = "SELECT definition.name,
    definition.layout_json AS definition_layout_json, definition.pin_data_json, definition.tags,
    definition.permission_level, definition.background_browser,
    definition.webhook_last_fire_at, definition.webhook_last_fire_outcome,
    definition.created_at, definition.deleted_at,
    version.id AS version_id, version.version_number, version.content_hash,
    version.schema_version, version.definition_body, version.layout_json AS version_layout_json,
    version.version_number = (
      SELECT MAX(version_number) FROM workflow_versions WHERE definition_id = definition.id
    ) AS is_latest,
    token.created_at AS webhook_token_created_at, token.last_used_at AS webhook_token_last_used_at
  FROM workflow_definitions definition
  JOIN workflow_versions version ON version.definition_id = definition.id
  LEFT JOIN workflow_webhook_tokens token ON token.definition_id = definition.id
  WHERE definition.id = @definition_id
    AND version.version_number = COALESCE(@version_number, (
      SELECT MAX(version_number) FROM workflow_versions WHERE definition_id = definition.id
    ))";

// The last run is the one started last. A negative limit reads every row.
const LIST_DEFINITIONS_SQL: &str = "SELECT definition.id, definition.name,
    definition.content_hash, definition.tags, definition.created_at,
    json_extract(definition.definition_body, '$.trigger.kind') AS trigger_kind,
    latest.id AS latest_version_id, latest.version_number AS latest_version_number,
    definition.updated_at,
    (SELECT COUNT(*) FROM workflow_runs run
      JOIN workflow_versions run_version ON run_version.id = run.workflow_version_id
      WHERE run_version.definition_id = definition.id) AS run_count,
    last_run.id AS last_run_id, last_run.status AS last_run_status,
    last_run.started_at AS last_run_started_at
  FROM workflow_definitions definition
  JOIN workflow_versions latest ON latest.id = (
    SELECT id FROM workflow_versions WHERE definition_id = definition.id
    ORDER BY version_number DESC LIMIT 1
  )
  LEFT JOIN workflow_runs last_run ON last_run.id = (
    SELECT run.id FROM workflow_runs run
      JOIN workflow_versions run_version ON run_version.id = run.workflow_version_id
      WHERE run_version.definition_id = definition.id
      ORDER BY run.started_at DESC, run.id DESC LIMIT 1
  )
  WHERE definition.deleted_at IS NULL AND (@cursor IS NULL OR definition.id > @cursor)
  ORDER BY definition.id
  LIMIT @row_limit";

// SQLite reads a negative limit as no limit.
const NO_ROW_LIMIT: i64 = -1;

/// One workflow in the library list, as its rows store it: a catalog row without whether the
/// workflow is enabled, its schedule and its last skipped fire, which the trigger scheduler holds.
/// `updated_at` is the last change to the workflow's row.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow definition handlers")
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkflowLibraryEntry {
    /// The workflow.
    pub(crate) id: WorkflowDefinitionId,
    /// Its name.
    pub(crate) name: NonEmptyText,
    /// The latest version's number.
    pub(crate) latest_version_number: SafeInt<1>,
    /// The latest version's id.
    pub(crate) latest_workflow_version_id: WorkflowVersionId,
    /// The hash of the latest version's hashed body.
    pub(crate) content_hash: WorkflowContentHash,
    /// The kind of the document's one trigger.
    pub(crate) trigger_kind: WorkflowNodeKindId,
    /// The run started last; absent where the workflow never ran.
    pub(crate) last_run: Option<WorkflowDefinitionLastRun>,
    /// Its tags.
    pub(crate) tags: TagList,
    /// How many runs it has.
    pub(crate) run_count: SafeInt<0>,
    /// When it was made.
    pub(crate) created_at: WireInstant,
    /// When its row last changed.
    pub(crate) updated_at: WireInstant,
}

/// One page of the library in id order, each workflow listed once across pages.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow definition handlers")
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkflowLibraryPage {
    /// The page's workflows.
    pub(crate) definitions: Vec<WorkflowLibraryEntry>,
    /// Where the next page starts; absent on the last.
    pub(crate) next_cursor: Option<WorkflowDefinitionListCursor>,
}

/// Why a library read failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowLibraryError {
    /// No workflow, or no version of it, answers to the request (`workflow.definition.notFound`,
    /// `workflow.version.notFound`).
    #[error(transparent)]
    NotFound(#[from] WorkflowNotFound),
    /// The list cursor is not one this library wrote, or names no workflow it holds
    /// (`workflow.cursorUnresolvable`).
    #[error(transparent)]
    CursorUnresolvable(#[from] WorkflowCursorUnresolvable),
    /// The stored document did not read as its contract type.
    #[error("the stored workflow document does not read")]
    StoredDocument(#[from] StoredDocumentError),
    /// SQLite failed the read, or a stored value did not read as its type.
    #[error("reading the workflow library failed")]
    Database(#[from] rusqlite::Error),
}

/// The statement a save runs first, inside its own write, to refuse a name another workflow in the
/// library holds; the write is refused unless it returns no row. `except_definition_id` is the
/// workflow being saved, whose own name is no conflict.
pub(crate) fn name_holder_statement(
    name_folded: &str,
    except_definition_id: Option<WorkflowDefinitionId>,
) -> WriteStatement {
    let except_text = except_definition_id.map(|id| id.text());
    WriteStatement {
        sql: Cow::Borrowed(NAME_HOLDER_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@name_folded", name_folded),
            text_binding(
                "@except_definition_id",
                except_text
                    .as_ref()
                    .map_or(NO_DEFINITION_EXCLUDED, |text| text.as_str()),
            ),
        ]),
        expected_row_count: Some(0),
    }
}

/// The statement a write to a saved workflow runs first, inside that write, so a delete cannot
/// land between the check and the change; the write is refused unless it returns the one row a
/// workflow in the library returns.
pub(crate) fn live_definition_statement(definition_id: WorkflowDefinitionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(LIVE_DEFINITION_SQL),
        bindings: StatementBindings::Named(vec![text_binding(
            "@definition_id",
            definition_id.text().as_str(),
        )]),
        expected_row_count: Some(1),
    }
}

/// The statement a write runs first, inside that write, to refuse a workflow never created; the
/// write is refused unless it returns the one row every workflow ever created returns, deleted or
/// not.
pub(crate) fn created_definition_statement(definition_id: WorkflowDefinitionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(CREATED_DEFINITION_SQL),
        bindings: StatementBindings::Named(vec![text_binding(
            "@definition_id",
            definition_id.text().as_str(),
        )]),
        expected_row_count: Some(1),
    }
}

/// Reads the one workflow library on one of the daemon's read connections, which sees each write
/// once it has committed.
pub(crate) struct WorkflowLibrary<'connection> {
    /// A read-only connection.
    reader: &'connection Connection,
}

impl<'connection> WorkflowLibrary<'connection> {
    /// A library reading through `reader`, one of the daemon's read-only connections.
    pub(crate) fn new(reader: &'connection Connection) -> Self {
        Self { reader }
    }

    /// Whether a workflow in the library other than `except_definition_id` holds `name`, in any
    /// letter case. Fails only when SQLite fails the read.
    pub(crate) fn is_name_held(
        &self,
        name: &str,
        except_definition_id: Option<WorkflowDefinitionId>,
    ) -> rusqlite::Result<bool> {
        let except_text = except_definition_id.map(|id| id.text());
        let mut statement = self.reader.prepare_cached(NAME_HOLDER_SQL)?;
        statement.exists(named_params! {
            "@name_folded": fold_name(name),
            "@except_definition_id": except_text
                .as_ref()
                .map_or(NO_DEFINITION_EXCLUDED, |text| text.as_str()),
        })
    }

    /// The first of `<name> copy`, `<name> copy 2`, `<name> copy 3` and on that no workflow holds.
    /// Fails only when SQLite fails a read.
    pub(crate) fn first_free_duplicate_name(&self, name: &str) -> rusqlite::Result<String> {
        let first_candidate = format!("{name} copy");
        let mut candidate = first_candidate.clone();
        let mut ordinal: u64 = 2;
        while self.is_name_held(&candidate, None)? {
            candidate = format!("{first_candidate} {ordinal}");
            ordinal += 1;
        }
        Ok(candidate)
    }

    /// One definition at the version the request names, else at its latest, with its document,
    /// permission level, background browser, last webhook fire and webhook token dates; a deleted
    /// workflow still reads. Fails with [`WorkflowLibraryError::NotFound`] when no such workflow
    /// or version exists, [`WorkflowLibraryError::StoredDocument`] when the stored document does
    /// not read, and [`WorkflowLibraryError::Database`] when SQLite fails or a stored value does
    /// not read.
    #[expect(dead_code, reason = "the workflow definition handlers")]
    pub(crate) fn read(
        &self,
        request: &WorkflowDefinitionReadRequest,
    ) -> Result<WorkflowDefinitionReadResponse, WorkflowLibraryError> {
        let definition_id = request.definition_id;
        let definition_text = definition_id.text();
        let mut statement = self.reader.prepare_cached(READ_DEFINITION_SQL)?;
        let mut rows = statement.query(named_params! {
            "@definition_id": definition_text.as_str(),
            "@version_number": request.version.map(i64::from),
        })?;
        let Some(row) = rows.next()? else {
            return Err(match request.version {
                None => WorkflowNotFound::Definition { definition_id },
                Some(version_number) => WorkflowNotFound::Version(WorkflowVersionAddress::Number {
                    definition_id,
                    version_number,
                }),
            }
            .into());
        };
        read_definition_from_row(definition_id, row)
    }

    /// One page of every workflow not deleted, in id order, after the workflow the request's cursor
    /// names; with no limit the page holds every workflow after it. Fails with
    /// [`WorkflowLibraryError::CursorUnresolvable`] for a cursor that is not a workflow id in the
    /// form this library writes, or one no workflow row holds, and with
    /// [`WorkflowLibraryError::Database`] when SQLite fails or a stored value does not read.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the workflow definition handlers")
    )]
    pub(crate) fn list(
        &self,
        request: &WorkflowDefinitionListRequest,
    ) -> Result<WorkflowLibraryPage, WorkflowLibraryError> {
        let after = request
            .cursor
            .as_ref()
            .map(|cursor| self.resolve_list_cursor(cursor))
            .transpose()?;
        let after_text = after.map(|id| id.text());
        let page_size = request.limit.map(|limit| {
            usize::try_from(limit.get()).expect("a safe integer limit fits the platform's sizes")
        });
        // One row past the page says whether another page follows.
        let row_limit = request
            .limit
            .map_or(NO_ROW_LIMIT, |limit| i64::from(limit).saturating_add(1));
        let mut statement = self.reader.prepare_cached(LIST_DEFINITIONS_SQL)?;
        let mut rows = statement.query(named_params! {
            "@cursor": after_text.as_ref().map(UuidText::as_str),
            "@row_limit": row_limit,
        })?;
        let mut definitions = Vec::new();
        let mut has_more = false;
        while let Some(row) = rows.next()? {
            if page_size.is_some_and(|page_size| definitions.len() == page_size) {
                has_more = true;
                break;
            }
            definitions.push(library_entry_from_row(row)?);
        }
        let next_cursor = if has_more {
            definitions
                .last()
                .map(|last: &WorkflowLibraryEntry| encode_list_cursor(last.id))
        } else {
            None
        };
        Ok(WorkflowLibraryPage {
            definitions,
            next_cursor,
        })
    }

    // The workflow a list cursor names. The cursor must be an id in the lowercase form the
    // library writes, since ids compare as text, and a workflow row must hold it.
    fn resolve_list_cursor(
        &self,
        cursor: &WorkflowDefinitionListCursor,
    ) -> Result<WorkflowDefinitionId, WorkflowLibraryError> {
        let refuse = |reason| WorkflowCursorUnresolvable::new(cursor.as_str(), reason);
        let definition_id = WorkflowDefinitionId::new(cursor.as_str())
            .map_err(|_not_an_id| refuse(UnresolvableCursorReason::NotWritten))?;
        if encode_list_cursor(definition_id).as_str() != cursor.as_str() {
            return Err(refuse(UnresolvableCursorReason::NotWritten).into());
        }
        let mut statement = self.reader.prepare_cached(CREATED_DEFINITION_SQL)?;
        if statement.exists(named_params! { "@definition_id": cursor.as_str() })? {
            Ok(definition_id)
        } else {
            Err(refuse(UnresolvableCursorReason::NoDefinition).into())
        }
    }
}

// The cursor naming the workflow a page ended on, which a later page starts after.
fn encode_list_cursor(definition_id: WorkflowDefinitionId) -> WorkflowDefinitionListCursor {
    WorkflowDefinitionListCursor::new(definition_id.text().as_str().to_owned())
        .expect("a workflow id's 36 characters lie inside the cursor's bound")
}

fn read_definition_from_row(
    definition_id: WorkflowDefinitionId,
    row: &Row<'_>,
) -> Result<WorkflowDefinitionReadResponse, WorkflowLibraryError> {
    let is_latest: bool = row.get(column(row, "is_latest")?)?;
    let layout_alias = if is_latest {
        "definition_layout_json"
    } else {
        "version_layout_json"
    };
    let layout_json: Option<String> = row.get(column(row, layout_alias)?)?;
    let pin_data_json: Option<String> = row.get(column(row, "pin_data_json")?)?;
    let tags_json: String = row.get(column(row, "tags")?)?;
    let schema_version: String = row.get(column(row, "schema_version")?)?;
    let definition_body: String = row.get(column(row, "definition_body")?)?;
    let document = read_stored_workflow_document(StoredWorkflowDocumentColumns {
        schema_version: &schema_version,
        definition_body: &definition_body,
        layout_json: layout_json.as_deref(),
        pin_data_json: pin_data_json.as_deref(),
        tags_json: Some(&tags_json),
    })?;
    // The table keeps the two last-fire columns both set or both null.
    let webhook_last_fire = match optional_text_column(
        row,
        column(row, "webhook_last_fire_at")?,
        WireInstant::try_from,
    )? {
        None => None,
        Some(at) => Some(WorkflowWebhookLastFire {
            at,
            outcome: text_column(row, column(row, "webhook_last_fire_outcome")?, closed_word)?,
        }),
    };
    let read = WorkflowDefinitionReadWithoutWebhookToken {
        id: definition_id,
        name: text_column(row, column(row, "name")?, closed_word)?,
        version_number: safe_int_column(row, column(row, "version_number")?)?,
        workflow_version_id: text_column(row, column(row, "version_id")?, |text| {
            WorkflowVersionId::new(&text)
        })?,
        content_hash: text_column(row, column(row, "content_hash")?, closed_word)?,
        document,
        permission_level: text_column(row, column(row, "permission_level")?, closed_word)?,
        background_browser: text_column(row, column(row, "background_browser")?, closed_word)?,
        created_at: text_column(row, column(row, "created_at")?, WireInstant::try_from)?,
        webhook_last_fire,
        deleted_at: optional_text_column(row, column(row, "deleted_at")?, WireInstant::try_from)?,
        webhook_token_created_at: None,
        webhook_token_last_used_at: None,
    };
    let webhook_token_created_at = optional_text_column(
        row,
        column(row, "webhook_token_created_at")?,
        WireInstant::try_from,
    )?;
    Ok(match webhook_token_created_at {
        None => WorkflowDefinitionReadResponse::WithoutWebhookToken(read),
        Some(webhook_token_created_at) => {
            let webhook_token_last_used_at = optional_text_column(
                row,
                column(row, "webhook_token_last_used_at")?,
                WireInstant::try_from,
            )?;
            WorkflowDefinitionReadResponse::WithWebhookToken(
                WorkflowDefinitionReadWithWebhookToken {
                    id: read.id,
                    name: read.name,
                    version_number: read.version_number,
                    workflow_version_id: read.workflow_version_id,
                    content_hash: read.content_hash,
                    document: read.document,
                    permission_level: read.permission_level,
                    background_browser: read.background_browser,
                    created_at: read.created_at,
                    webhook_last_fire: read.webhook_last_fire,
                    deleted_at: read.deleted_at,
                    webhook_token_created_at,
                    webhook_token_last_used_at,
                },
            )
        }
    })
}

fn library_entry_from_row(row: &Row<'_>) -> rusqlite::Result<WorkflowLibraryEntry> {
    // A run's status and start are never null, so a run found reads all three.
    let last_run = match optional_text_column(row, column(row, "last_run_id")?, |text| {
        WorkflowRunId::new(&text)
    })? {
        None => None,
        Some(workflow_run_id) => Some(WorkflowDefinitionLastRun {
            workflow_run_id,
            status: text_column(row, column(row, "last_run_status")?, closed_word)?,
            started_at: text_column(
                row,
                column(row, "last_run_started_at")?,
                WireInstant::try_from,
            )?,
        }),
    };
    Ok(WorkflowLibraryEntry {
        id: text_column(row, column(row, "id")?, |text| {
            WorkflowDefinitionId::new(&text)
        })?,
        name: text_column(row, column(row, "name")?, closed_word)?,
        latest_version_number: safe_int_column(row, column(row, "latest_version_number")?)?,
        latest_workflow_version_id: text_column(row, column(row, "latest_version_id")?, |text| {
            WorkflowVersionId::new(&text)
        })?,
        content_hash: text_column(row, column(row, "content_hash")?, closed_word)?,
        trigger_kind: text_column(row, column(row, "trigger_kind")?, closed_word)?,
        last_run,
        tags: text_column(row, column(row, "tags")?, |text| {
            serde_json::from_str(&text)
        })?,
        run_count: safe_int_column(row, column(row, "run_count")?)?,
        created_at: text_column(row, column(row, "created_at")?, WireInstant::try_from)?,
        updated_at: text_column(row, column(row, "updated_at")?, WireInstant::try_from)?,
    })
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::workflow::definition::methods::{
        WorkflowDefinitionListCursor, WorkflowDefinitionListRequest,
    };

    use super::{WorkflowLibrary, WorkflowLibraryError};
    use crate::runs::invalid_cursor::{UnresolvableCursorReason, WorkflowCursorUnresolvable};
    use crate::test_rows::{insert_workflow_version, workflow_tables};

    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e50";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e51";
    // A well-formed id below the stored one, which no workflow row holds.
    const UNKNOWN_DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e40";

    /// Mutation: page past it, reading every workflow after an id no workflow row holds.
    #[test]
    fn a_cursor_naming_no_workflow_is_refused() {
        let connection = workflow_tables();
        insert_workflow_version(&connection, DEFINITION_ID, VERSION_ID, "Nightly");
        let request = WorkflowDefinitionListRequest {
            limit: None,
            cursor: Some(
                WorkflowDefinitionListCursor::new(UNKNOWN_DEFINITION_ID.to_owned())
                    .expect("an id lies inside the cursor's bound"),
            ),
        };
        let refusal = WorkflowLibrary::new(&connection)
            .list(&request)
            .expect_err("a cursor naming no workflow is refused");
        assert!(matches!(
            refusal,
            WorkflowLibraryError::CursorUnresolvable(_)
        ));
        assert_eq!(
            refusal.to_string(),
            WorkflowCursorUnresolvable::new(
                UNKNOWN_DEFINITION_ID,
                UnresolvableCursorReason::NoDefinition
            )
            .to_string()
        );
    }
}
