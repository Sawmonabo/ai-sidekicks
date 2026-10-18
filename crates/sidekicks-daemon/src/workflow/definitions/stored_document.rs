//! A workflow document rebuilt from the columns that store it: its schema version and canonical
//! hashed body, and beside them the layout, pinned data and tags that sit outside the hash.

use serde_json::Value;
use sidekicks_contracts::tag::TagList;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDocument, WorkflowDocumentHashedBody, WorkflowDocumentSchemaVersion, WorkflowLayout,
};
use sidekicks_contracts::workflow::definition::item::WorkflowPinnedItem;

/// The stored columns a document is rebuilt from, borrowed from the row; pinned data and tags live
/// on the definition, so a version's row passes `None` for both.
#[derive(Clone, Copy, Debug)]
pub(crate) struct StoredWorkflowDocumentColumns<'columns> {
    /// The document schema version the save wrote.
    pub(crate) schema_version: &'columns str,
    /// The canonical hashed body.
    pub(crate) definition_body: &'columns str,
    /// The canvas layout's JSON, `None` where none was stored.
    pub(crate) layout_json: Option<&'columns str>,
    /// The pinned data's JSON, `None` where none was stored or the row carries none.
    pub(crate) pin_data_json: Option<&'columns str>,
    /// The tag list's JSON, `None` where the row carries none.
    pub(crate) tags_json: Option<&'columns str>,
}

/// Why a stored column did not read as its contract type. The parser's message is dropped, since
/// it can quote the stored text; only its position is kept.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StoredDocumentError {
    /// The schema version column names no version this daemon reads.
    #[error("the stored schema version is not one this daemon reads")]
    SchemaVersion,
    /// The definition body is no hashed body.
    #[error("the stored definition body does not read, at line {line} column {column}")]
    DefinitionBody {
        /// The line the parser stopped on, from 1.
        line: usize,
        /// The column the parser stopped on, from 1.
        column: usize,
    },
    /// The layout is no canvas layout.
    #[error("the stored layout does not read, at line {line} column {column}")]
    Layout {
        /// The line the parser stopped on, from 1.
        line: usize,
        /// The column the parser stopped on, from 1.
        column: usize,
    },
    /// The pinned data is no pinned data.
    #[error("the stored pinned data does not read, at line {line} column {column}")]
    PinData {
        /// The line the parser stopped on, from 1.
        line: usize,
        /// The column the parser stopped on, from 1.
        column: usize,
    },
    /// The tags are no tag list.
    #[error("the stored tags do not read, at line {line} column {column}")]
    Tags {
        /// The line the parser stopped on, from 1.
        line: usize,
        /// The column the parser stopped on, from 1.
        column: usize,
    },
}

/// Parses a stored canonical body, which the store wrote from a checked document; fails with
/// [`StoredDocumentError::DefinitionBody`], which keeps only where the parser stopped.
pub(crate) fn parse_stored_workflow_body(
    definition_body: &str,
) -> Result<WorkflowDocumentHashedBody, StoredDocumentError> {
    serde_json::from_str(definition_body).map_err(|error| StoredDocumentError::DefinitionBody {
        line: error.line(),
        column: error.column(),
    })
}

/// Rebuilds the document a save stored: a member with nothing stored stays out of it, and an empty
/// tag list reads as no tags. Fails when a column does not read as its contract type.
pub(crate) fn read_stored_workflow_document(
    columns: StoredWorkflowDocumentColumns<'_>,
) -> Result<WorkflowDocument, StoredDocumentError> {
    let schema_version: WorkflowDocumentSchemaVersion =
        serde_json::from_value(Value::String(columns.schema_version.to_owned()))
            .map_err(|_names_the_text| StoredDocumentError::SchemaVersion)?;
    let body = parse_stored_workflow_body(columns.definition_body)?;
    let layout = columns
        .layout_json
        .map(serde_json::from_str::<WorkflowLayout>)
        .transpose()
        .map_err(|error| StoredDocumentError::Layout {
            line: error.line(),
            column: error.column(),
        })?;
    let pin_data = columns
        .pin_data_json
        .map(serde_json::from_str::<Record<String, Vec<WorkflowPinnedItem>>>)
        .transpose()
        .map_err(|error| StoredDocumentError::PinData {
            line: error.line(),
            column: error.column(),
        })?;
    let tags = columns
        .tags_json
        .map(serde_json::from_str::<TagList>)
        .transpose()
        .map_err(|error| StoredDocumentError::Tags {
            line: error.line(),
            column: error.column(),
        })?
        .filter(|tags| !tags.0.as_slice().is_empty());
    Ok(WorkflowDocument {
        schema_version,
        name: body.name,
        description: body.description,
        trigger: body.trigger,
        nodes: body.nodes,
        edges: body.edges,
        layout,
        pin_data,
        tags,
    })
}
