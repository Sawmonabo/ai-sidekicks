//! `workflow.cursorUnresolvable`: the refusal of a paging cursor `workflow.run.list`,
//! `workflow.step.read` or `workflow.definition.list` cannot page from, a client's mistake that
//! answers as an invalid argument; nothing is read.

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_ipc::domain_error::DomainError;

/// Why a cursor leads to no page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UnresolvableCursorReason {
    /// The daemon did not write it.
    NotWritten,
    /// It points past the end of what the list pages.
    PastEnd,
    /// It is a well-formed workflow id no stored definition holds.
    NoDefinition,
}

/// A request's cursor the reading store cannot page from; nothing was read. Answers
/// `workflow.cursorUnresolvable` with the cursor as its detail.
#[derive(Debug, thiserror::Error)]
#[error("{}", reason_words(*.reason))]
pub(crate) struct WorkflowCursorUnresolvable {
    cursor: String,
    reason: UnresolvableCursorReason,
}

impl WorkflowCursorUnresolvable {
    /// The refusal of `cursor`, the text the request carried, for `reason`.
    pub(crate) fn new(cursor: &str, reason: UnresolvableCursorReason) -> Self {
        Self {
            cursor: cursor.to_owned(),
            reason,
        }
    }
}

fn reason_words(reason: UnresolvableCursorReason) -> &'static str {
    match reason {
        UnresolvableCursorReason::NotWritten => {
            "The cursor is not one the daemon wrote; nothing was read."
        }
        UnresolvableCursorReason::PastEnd => {
            "The cursor points past the end of the list; nothing was read."
        }
        UnresolvableCursorReason::NoDefinition => {
            "The cursor names no workflow the daemon holds; nothing was read."
        }
    }
}

impl From<WorkflowCursorUnresolvable> for DomainError {
    fn from(unresolvable: WorkflowCursorUnresolvable) -> Self {
        DomainError::new(
            unresolvable.to_string(),
            RefusalCode::WorkflowCursorUnresolvable,
        )
        .with_detail(json!({ "cursor": unresolvable.cursor }))
    }
}
