//! Reads of a workflow's saved versions, which never change: one version, every version of the
//! workflow a version belongs to, and the structural difference between two versions.

use std::sync::LazyLock;

use rusqlite::{Connection, Row, named_params};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowContentHash, WorkflowDefinitionId, WorkflowDocumentHashedBody, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::versions::{
    WorkflowVersionDiffCrossWorkflowDetails, WorkflowVersionDiffReadRequest,
    WorkflowVersionDiffReadResponse, WorkflowVersionListEntry, WorkflowVersionListRequest,
    WorkflowVersionListResponse, WorkflowVersionReadRequest, WorkflowVersionReadResponse,
    WorkflowVersionSavedBy,
};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};

use crate::definitions::stored_document::{
    StoredDocumentError, StoredWorkflowDocumentColumns, parse_stored_workflow_body,
    read_stored_workflow_document,
};
use crate::definitions::versions::difference::{count_workflow_changes, diff_workflow_bodies};
use crate::not_found::{WorkflowNotFound, WorkflowVersionAddress};

/// The statements a `WorkflowVersions` prepares on a read connection: a version by number, a
/// version by id, and a version's whole workflow.
pub const WORKFLOW_VERSIONS_STATEMENT_CAPACITY: usize = 3;

// The columns of one version, in the order `version_from_row` reads them.
const VERSION_COLUMNS: &str = "id, definition_id, version_number, content_hash, schema_version,
    definition_body, layout_json, created_at, saved_by_agent_id";

static SELECT_BY_NUMBER_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {VERSION_COLUMNS} FROM workflow_versions
  WHERE definition_id = @definition_id AND version_number = @version_number"
    )
});

static SELECT_BY_ID_SQL: LazyLock<String> = LazyLock::new(|| {
    format!("SELECT {VERSION_COLUMNS} FROM workflow_versions WHERE id = @workflow_version_id")
});

static SELECT_WORKFLOW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {VERSION_COLUMNS} FROM workflow_versions
  WHERE definition_id = (
    SELECT definition_id FROM workflow_versions WHERE id = @workflow_version_id
  )
  ORDER BY version_number"
    )
});

/// Why a version read failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowVersionsError {
    /// No saved version answers to the request (`workflow.version.notFound`).
    #[error(transparent)]
    NotFound(#[from] WorkflowNotFound),
    /// The two versions of a diff belong to different workflows
    /// (`workflow.version.diffCrossWorkflow`); nothing was compared.
    #[error("The two versions belong to different workflows.")]
    DiffCrossWorkflow {
        /// The version compared from.
        from_workflow_version_id: WorkflowVersionId,
        /// The version compared to.
        to_workflow_version_id: WorkflowVersionId,
    },
    /// A stored document did not read as its contract type.
    #[error("the stored workflow version does not read")]
    StoredDocument(#[from] StoredDocumentError),
    /// SQLite failed the read, or a stored value did not read as its type.
    #[error("reading the workflow versions failed")]
    Database(#[from] rusqlite::Error),
}

impl From<WorkflowVersionsError> for HandlerError {
    /// A version not found and a diff of two workflows answer their refusals; any other failure is
    /// a fault in the daemon.
    fn from(error: WorkflowVersionsError) -> Self {
        let message = error.to_string();
        match error {
            WorkflowVersionsError::NotFound(not_found) => Self::Refused(not_found.into()),
            WorkflowVersionsError::DiffCrossWorkflow {
                from_workflow_version_id,
                to_workflow_version_id,
            } => Self::Refused(
                DomainError::new(message, RefusalCode::WorkflowVersionDiffCrossWorkflow)
                    .with_detail(WorkflowVersionDiffCrossWorkflowDetails {
                        from_workflow_version_id,
                        to_workflow_version_id,
                    }),
            ),
            fault @ (WorkflowVersionsError::StoredDocument(_)
            | WorkflowVersionsError::Database(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// One version as its row stores it.
struct VersionRow {
    workflow_version_id: WorkflowVersionId,
    definition_id: WorkflowDefinitionId,
    version_number: SafeInt<1>,
    content_hash: WorkflowContentHash,
    schema_version: String,
    definition_body: String,
    layout_json: Option<String>,
    created_at: WireInstant,
    saved_by_agent_id: Option<AgentId>,
}

/// Reads a workflow's saved versions on one of the daemon's read connections, a deleted workflow's
/// included, since runs pin them.
#[expect(
    dead_code,
    reason = "the workflow.version.read, workflow.version.list and workflow.version.diff.read \
              handlers"
)]
pub(crate) struct WorkflowVersions<'connection> {
    /// A read-only connection.
    reader: &'connection Connection,
}

#[expect(
    dead_code,
    reason = "the workflow.version.read, workflow.version.list and workflow.version.diff.read \
              handlers"
)]
impl<'connection> WorkflowVersions<'connection> {
    /// Versions reading through `reader`, one of the daemon's read-only connections.
    pub(crate) fn new(reader: &'connection Connection) -> Self {
        Self { reader }
    }

    /// One version's document, with the layout it was saved with. Fails with
    /// [`WorkflowVersionsError::NotFound`] when the workflow has no such version.
    pub(crate) fn read(
        &self,
        request: &WorkflowVersionReadRequest,
    ) -> Result<WorkflowVersionReadResponse, WorkflowVersionsError> {
        let definition_id = request.definition_id;
        let mut statement = self.reader.prepare_cached(SELECT_BY_NUMBER_SQL.as_str())?;
        let mut rows = statement.query(named_params! {
            "@definition_id": definition_id.text().as_str(),
            "@version_number": i64::from(request.version_number),
        })?;
        let Some(row) = rows.next()? else {
            return Err(WorkflowNotFound::Version(WorkflowVersionAddress::Number {
                definition_id,
                version_number: request.version_number,
            })
            .into());
        };
        let version = version_from_row(row)?;
        let document = read_stored_workflow_document(StoredWorkflowDocumentColumns {
            schema_version: &version.schema_version,
            definition_body: &version.definition_body,
            layout_json: version.layout_json.as_deref(),
            pin_data_json: None,
            tags_json: None,
        })?;
        Ok(WorkflowVersionReadResponse {
            definition_id,
            version_number: version.version_number,
            workflow_version_id: version.workflow_version_id,
            content_hash: version.content_hash,
            document,
            created_at: version.created_at,
        })
    }

    /// Every version of the workflow the given version belongs to, oldest first, each with who
    /// saved it and what it changed over the one before. Fails with
    /// [`WorkflowVersionsError::NotFound`] for an unknown version.
    pub(crate) fn list(
        &self,
        request: &WorkflowVersionListRequest,
    ) -> Result<WorkflowVersionListResponse, WorkflowVersionsError> {
        let mut statement = self.reader.prepare_cached(SELECT_WORKFLOW_SQL.as_str())?;
        let mut rows = statement.query(named_params! {
            "@workflow_version_id": request.workflow_version_id.text().as_str(),
        })?;
        let mut definition_id = None;
        let mut previous_body: Option<WorkflowDocumentHashedBody> = None;
        let mut versions = Vec::new();
        while let Some(row) = rows.next()? {
            let version = version_from_row(row)?;
            definition_id.get_or_insert(version.definition_id);
            let body = parse_stored_workflow_body(&version.definition_body)?;
            let changes_from_previous = previous_body
                .as_ref()
                .map(|previous| count_workflow_changes(&diff_workflow_bodies(previous, &body)));
            versions.push(WorkflowVersionListEntry {
                workflow_version_id: version.workflow_version_id,
                version_number: version.version_number,
                content_hash: version.content_hash,
                created_at: version.created_at,
                saved_by: match version.saved_by_agent_id {
                    None => WorkflowVersionSavedBy::User { agent_id: None },
                    Some(agent_id) => WorkflowVersionSavedBy::Agent { agent_id },
                },
                changes_from_previous,
            });
            previous_body = Some(body);
        }
        let Some(definition_id) = definition_id else {
            return Err(WorkflowNotFound::Version(WorkflowVersionAddress::Id {
                workflow_version_id: request.workflow_version_id,
            })
            .into());
        };
        Ok(WorkflowVersionListResponse {
            definition_id,
            versions: BoundedVec::new(versions).expect("a workflow found has a version"),
        })
    }

    /// The structural difference from one version to another over the hashed body alone. Fails
    /// with [`WorkflowVersionsError::NotFound`] for an unknown version, and with
    /// [`WorkflowVersionsError::DiffCrossWorkflow`] for two versions of different workflows.
    pub(crate) fn read_diff(
        &self,
        request: &WorkflowVersionDiffReadRequest,
    ) -> Result<WorkflowVersionDiffReadResponse, WorkflowVersionsError> {
        let from = self.read_version(request.from_workflow_version_id)?;
        let to = self.read_version(request.to_workflow_version_id)?;
        if from.definition_id != to.definition_id {
            return Err(WorkflowVersionsError::DiffCrossWorkflow {
                from_workflow_version_id: request.from_workflow_version_id,
                to_workflow_version_id: request.to_workflow_version_id,
            });
        }
        Ok(diff_workflow_bodies(
            &parse_stored_workflow_body(&from.definition_body)?,
            &parse_stored_workflow_body(&to.definition_body)?,
        ))
    }

    fn read_version(
        &self,
        workflow_version_id: WorkflowVersionId,
    ) -> Result<VersionRow, WorkflowVersionsError> {
        let mut statement = self.reader.prepare_cached(SELECT_BY_ID_SQL.as_str())?;
        let mut rows = statement.query(named_params! {
            "@workflow_version_id": workflow_version_id.text().as_str(),
        })?;
        match rows.next()? {
            Some(row) => Ok(version_from_row(row)?),
            None => Err(WorkflowNotFound::Version(WorkflowVersionAddress::Id {
                workflow_version_id,
            })
            .into()),
        }
    }
}

fn version_from_row(row: &Row<'_>) -> rusqlite::Result<VersionRow> {
    Ok(VersionRow {
        workflow_version_id: text_column(row, 0, |text| WorkflowVersionId::new(&text))?,
        definition_id: text_column(row, 1, |text| WorkflowDefinitionId::new(&text))?,
        version_number: safe_int_column(row, 2)?,
        content_hash: text_column(row, 3, closed_word)?,
        schema_version: row.get(4)?,
        definition_body: row.get(5)?,
        layout_json: row.get(6)?,
        created_at: text_column(row, 7, WireInstant::try_from)?,
        saved_by_agent_id: optional_text_column(row, 8, |text| AgentId::new(&text))?,
    })
}
