//! Reading one step's input, output or log by the payload reference its row stores: an inline
//! payload is read here and paged by item; a payload kept as an artifact is answered as its
//! reference, which the artifact read follows.

use rusqlite::{Connection, named_params};
use sidekicks_contracts::workflow::run::step::methods::{
    WorkflowStepPayloadKind, WorkflowStepReadCursor, WorkflowStepReadRequest,
    WorkflowStepReadResponse,
};
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_store::database::stored_column::text_column;

use crate::not_found::WorkflowNotFound;
use crate::runs::invalid_cursor::{UnresolvableCursorReason, WorkflowCursorUnresolvable};

/// The statements a `WorkflowStepPayloadReader` prepares on a read connection: one per payload a
/// step stores.
pub const WORKFLOW_STEP_PAYLOAD_STATEMENT_CAPACITY: usize = 3;

// The read of one payload column of the step the full key names, so only that payload is read.
macro_rules! read_payload_sql {
    ($payload_column:literal) => {
        concat!(
            "SELECT ",
            $payload_column,
            " FROM workflow_steps
  WHERE workflow_run_id = @workflow_run_id AND node_id = @node_id AND attempt = @attempt
    AND execution_index = @execution_index"
        )
    };
}

const READ_INPUT_SQL: &str = read_payload_sql!("input_ref");
const READ_OUTPUT_SQL: &str = read_payload_sql!("output_ref");
const READ_LOG_SQL: &str = read_payload_sql!("log_ref");

/// Why a step payload read failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowStepPayloadError {
    /// The run holds no step at the request's key (`workflow.step.notFound`).
    #[error(transparent)]
    NotFound(#[from] WorkflowNotFound),
    /// The cursor is not one this reader wrote, or points past the payload's end
    /// (`workflow.cursorUnresolvable`).
    #[error(transparent)]
    CursorUnresolvable(#[from] WorkflowCursorUnresolvable),
    /// SQLite failed the read, or the stored reference did not read as its type.
    #[error("reading the workflow step's payload failed")]
    Database(#[from] rusqlite::Error),
}

/// Reads one step's stored payloads for its step panel, on one of the daemon's read connections.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.step.read handler")
)]
pub(crate) struct WorkflowStepPayloadReader<'connection> {
    /// A read-only connection.
    reader: &'connection Connection,
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.step.read handler")
)]
impl<'connection> WorkflowStepPayloadReader<'connection> {
    /// A reader over `reader`, one of the daemon's read-only connections.
    pub(crate) fn new(reader: &'connection Connection) -> Self {
        Self { reader }
    }

    /// The request's payload of the step it names. An inline payload is paged from the cursor's
    /// item, `limit` items at a time or the rest when no limit is given, with a cursor while items
    /// remain; an artifact payload is its reference, whole. Fails with
    /// [`WorkflowStepPayloadError::NotFound`] for a step that is not stored,
    /// [`WorkflowStepPayloadError::CursorUnresolvable`] for a cursor this reader did not write or
    /// one past the payload's end, and [`WorkflowStepPayloadError::Database`] when SQLite fails or
    /// the stored reference does not read.
    pub(crate) fn read(
        &self,
        request: &WorkflowStepReadRequest,
    ) -> Result<WorkflowStepReadResponse, WorkflowStepPayloadError> {
        let sql = match request.which {
            WorkflowStepPayloadKind::Input => READ_INPUT_SQL,
            WorkflowStepPayloadKind::Output => READ_OUTPUT_SQL,
            WorkflowStepPayloadKind::Log => READ_LOG_SQL,
        };
        let run_text = request.workflow_run_id.text();
        let mut statement = self.reader.prepare_cached(sql)?;
        let mut rows = statement.query(named_params! {
            "@workflow_run_id": run_text.as_str(),
            "@node_id": request.node_id.as_str(),
            "@attempt": i64::from(request.attempt),
            "@execution_index": i64::from(request.execution_index),
        })?;
        let Some(row) = rows.next()? else {
            return Err(WorkflowNotFound::Step(WorkflowStepKey {
                workflow_run_id: request.workflow_run_id,
                node_id: request.node_id.clone(),
                attempt: request.attempt,
                execution_index: request.execution_index,
            })
            .into());
        };
        // The row stores the reference the engine wrote from a typed value.
        let payload: WorkflowPayloadRef = text_column(row, 0, |text| serde_json::from_str(&text))?;
        let (payload, next_cursor) = match payload {
            artifact @ WorkflowPayloadRef::Artifact { .. } => (artifact, None),
            WorkflowPayloadRef::Inline { mut items } => {
                let item_count = items.len();
                let start = match request.cursor.as_ref() {
                    None => 0,
                    Some(cursor) => {
                        let start = decode_step_payload_cursor(cursor)?;
                        // A cursor at the end reads the empty last page.
                        if start > item_count {
                            return Err(WorkflowCursorUnresolvable::new(
                                cursor.as_str(),
                                UnresolvableCursorReason::PastEnd,
                            )
                            .into());
                        }
                        start
                    }
                };
                let end = request.limit.map_or(item_count, |limit| {
                    let limit = usize::try_from(limit.get())
                        .expect("a safe integer limit fits the platform's sizes");
                    start.saturating_add(limit).min(item_count)
                });
                items.truncate(end);
                let page = items.split_off(start);
                (
                    WorkflowPayloadRef::Inline { items: page },
                    (end < item_count).then(|| encode_step_payload_cursor(end)),
                )
            }
        };
        Ok(WorkflowStepReadResponse {
            node_id: request.node_id.clone(),
            execution_index: request.execution_index,
            which: request.which,
            payload,
            next_cursor,
        })
    }
}

// The cursor of an inline page: the index of the first item it starts at.
fn encode_step_payload_cursor(item_index: usize) -> WorkflowStepReadCursor {
    WorkflowStepReadCursor::new(item_index.to_string())
        .expect("an item index's decimal digits lie inside the cursor's bound")
}

// The item index a cursor names. Only the text `encode_step_payload_cursor` writes reads back, so
// a sign, a leading zero or an index past the platform's sizes is refused.
fn decode_step_payload_cursor(
    cursor: &WorkflowStepReadCursor,
) -> Result<usize, WorkflowCursorUnresolvable> {
    cursor
        .as_str()
        .parse::<usize>()
        .ok()
        .filter(|item_index| encode_step_payload_cursor(*item_index).as_str() == cursor.as_str())
        .ok_or_else(|| {
            WorkflowCursorUnresolvable::new(cursor.as_str(), UnresolvableCursorReason::NotWritten)
        })
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use rstest::rstest;
    use rusqlite::params;
    use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};
    use sidekicks_contracts::workflow::run::step::methods::WorkflowStepReadRequest;

    use super::{
        WorkflowStepPayloadError, WorkflowStepPayloadReader, decode_step_payload_cursor,
        encode_step_payload_cursor,
    };
    use crate::runs::invalid_cursor::{UnresolvableCursorReason, WorkflowCursorUnresolvable};
    use crate::test_rows::{
        TEST_NODE_ID, TestStep, insert_run, insert_step, insert_workflow_version, workflow_tables,
    };

    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e50";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e51";
    const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e52";
    const STARTED_AT: &str = "2026-10-02T00:00:00.000Z";

    proptest! {
        /// Mutation: write the index in another form than the one the read takes back, so a page's
        /// own cursor is refused.
        #[test]
        fn a_written_cursor_reads_back_to_its_item(item_index in any::<usize>()) {
            let cursor = encode_step_payload_cursor(item_index);
            prop_assert_eq!(
                decode_step_payload_cursor(&cursor).expect("a written cursor reads back"),
                item_index
            );
        }
    }

    /// Mutation: accept `01`, reading a cursor this reader never wrote as the item it counts.
    #[rstest]
    #[case("01", UnresolvableCursorReason::NotWritten)]
    #[case("+1", UnresolvableCursorReason::NotWritten)]
    #[case("3", UnresolvableCursorReason::PastEnd)]
    fn a_cursor_the_reader_cannot_page_from_is_refused(
        #[case] text: &str,
        #[case] reason: UnresolvableCursorReason,
    ) {
        let connection = workflow_tables();
        insert_workflow_version(&connection, DEFINITION_ID, VERSION_ID, "Nightly");
        insert_run(
            &connection,
            RUN_ID,
            VERSION_ID,
            WorkflowRunStatus::Succeeded,
            STARTED_AT,
            Some(STARTED_AT),
        );
        insert_step(
            &connection,
            RUN_ID,
            &TestStep {
                execution_index: 0,
                status: WorkflowStepStatus::Succeeded,
                wait_cause: None,
                wait_account_id: None,
                resume_at: None,
            },
        );
        // Two items, so a cursor of `1` would read a page.
        connection
            .execute(
                "UPDATE workflow_steps SET output_ref = ?1 WHERE workflow_run_id = ?2",
                params![
                    r#"{"kind":"inline","items":[{"json":1},{"json":2}]}"#,
                    RUN_ID
                ],
            )
            .expect("the test stores the step's output");
        let request: WorkflowStepReadRequest = serde_json::from_value(serde_json::json!({
            "workflowRunId": RUN_ID,
            "nodeId": TEST_NODE_ID,
            "attempt": 1,
            "executionIndex": 0,
            "which": "output",
            "cursor": text,
        }))
        .expect("the request reads");
        let refusal = WorkflowStepPayloadReader::new(&connection)
            .read(&request)
            .expect_err("the cursor is refused");
        assert!(matches!(
            refusal,
            WorkflowStepPayloadError::CursorUnresolvable(_)
        ));
        assert_eq!(
            refusal.to_string(),
            WorkflowCursorUnresolvable::new(text, reason).to_string()
        );
    }
}
