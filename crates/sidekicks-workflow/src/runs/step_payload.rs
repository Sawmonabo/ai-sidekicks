//! One step's input, output or log by the payload reference its row stores: written here as
//! inline items within the cap, else as one artifact; read here and paged by item when inline, and
//! answered as its reference when kept as an artifact, which the artifact read follows. A step's
//! outputs are joined into one payload in output order and split back by their item counts.

use std::borrow::Cow;

use rusqlite::{Connection, named_params};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::step::methods::{
    WorkflowStepPayloadKind, WorkflowStepReadCursor, WorkflowStepReadRequest,
    WorkflowStepReadResponse,
};
use sidekicks_contracts::workflow::run::step::record::{
    WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP, WorkflowPayloadRef, WorkflowStepKey,
};
use sidekicks_store::database::stored_column::text_column;

use crate::engine::ports::{PortError, StepPayloadArtifacts};
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

/// Why a step payload could not be written.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StepPayloadWriteError {
    /// The items do not write as JSON.
    #[error("the step's payload does not write as JSON")]
    Json(#[source] serde_json::Error),
    /// The payload store did not keep the items as an artifact.
    #[error("the step's payload could not be stored")]
    Artifact(#[source] PortError),
}

/// `items`, a payload of `step` in `session_id`, as the reference its row stores: inline at or
/// under [`WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP`] JSON bytes, else stored through `payloads` as
/// one artifact. Fails as [`StepPayloadWriteError`] says, with nothing stored.
pub(crate) async fn write_step_payload(
    payloads: &dyn StepPayloadArtifacts,
    session_id: SessionId,
    step: &WorkflowStepKey,
    items: &[WorkflowItem],
) -> Result<WorkflowPayloadRef, StepPayloadWriteError> {
    prepare_step_payload(items)?
        .write(payloads, session_id, step)
        .await
}

/// `items` made ready to keep, inline at or under [`WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP`] JSON
/// bytes, else as the bytes of one artifact under an id minted before anything is written, so a
/// caller can record the id first. Fails with [`StepPayloadWriteError::Json`].
pub(crate) fn prepare_step_payload(
    items: &[WorkflowItem],
) -> Result<PreparedStepPayload, StepPayloadWriteError> {
    let measured_bytes = json_utf8_byte_length(&items).map_err(StepPayloadWriteError::Json)?;
    if measured_bytes <= WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP {
        return Ok(PreparedStepPayload {
            reference: WorkflowPayloadRef::Inline {
                items: items.to_vec(),
            },
            bytes: None,
        });
    }
    prepare_artifact_payload(mint_payload_artifact_id(), items)
}

/// `items`, a payload over [`WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP`] JSON bytes, made ready to keep
/// as the bytes of one artifact under `artifact_id`, an id the caller minted and may have recorded.
/// Fails with [`StepPayloadWriteError::Json`].
pub(crate) fn prepare_artifact_payload(
    artifact_id: ArtifactId,
    items: &[WorkflowItem],
) -> Result<PreparedStepPayload, StepPayloadWriteError> {
    let bytes = serde_json::to_vec(items).map_err(StepPayloadWriteError::Json)?;
    let size_bytes = SafeInt::new(SafeInt::from_usize(bytes.len()).get())
        .expect("a payload above the inline cap holds bytes");
    Ok(PreparedStepPayload {
        reference: WorkflowPayloadRef::Artifact {
            artifact_id,
            size_bytes,
            item_count: SafeInt::from_usize(items.len()),
        },
        bytes: Some(bytes),
    })
}

/// A fresh id for a payload kept as an artifact, minted before the artifact's write.
pub(crate) fn mint_payload_artifact_id() -> ArtifactId {
    ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID is an artifact id")
}

/// A step payload ready to keep: the reference its row will store and, where that names an
/// artifact, the artifact's bytes, not yet written.
pub(crate) struct PreparedStepPayload {
    reference: WorkflowPayloadRef,
    bytes: Option<Vec<u8>>,
}

impl PreparedStepPayload {
    /// The artifact the payload is kept as, `None` for one carried inline.
    pub(crate) fn artifact_id(&self) -> Option<ArtifactId> {
        match &self.reference {
            WorkflowPayloadRef::Artifact { artifact_id, .. } => Some(*artifact_id),
            WorkflowPayloadRef::Inline { .. } => None,
        }
    }

    /// The reference, once the artifact it names, if any, is written through `payloads` as a
    /// payload of `step` in `session_id`. Fails with [`StepPayloadWriteError::Artifact`].
    pub(crate) async fn write(
        self,
        payloads: &dyn StepPayloadArtifacts,
        session_id: SessionId,
        step: &WorkflowStepKey,
    ) -> Result<WorkflowPayloadRef, StepPayloadWriteError> {
        if let (
            Some(bytes),
            WorkflowPayloadRef::Artifact {
                artifact_id,
                item_count,
                ..
            },
        ) = (self.bytes, &self.reference)
        {
            payloads
                .write(session_id, step, *artifact_id, bytes, item_count.get())
                .await
                .map_err(StepPayloadWriteError::Artifact)?;
        }
        Ok(self.reference)
    }
}

/// Every output list's items in output order, as one payload stores them.
pub(crate) fn join_step_outputs(outputs: &[Vec<WorkflowItem>]) -> Cow<'_, [WorkflowItem]> {
    match outputs {
        [only] => Cow::Borrowed(only.as_slice()),
        many => Cow::Owned(many.concat()),
    }
}

/// Why a stored step payload could not be read back into its items or its outputs.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StepPayloadReadError {
    /// The payload store did not give back the artifact's bytes.
    #[error("the step's stored payload could not be read")]
    Artifact(#[source] PortError),
    /// The artifact's bytes do not read as items.
    #[error("the step's stored payload does not read as items")]
    Json(#[source] serde_json::Error),
    /// The artifact holds another number of items than its reference records.
    #[error("the step's stored payload records {recorded} items but holds {held}")]
    ItemCountMismatch {
        /// The items the reference records.
        recorded: u64,
        /// The items the artifact holds.
        held: usize,
    },
    /// The output item counts do not add up to the items the payload holds.
    #[error("the step's output counts add up to {counted} items but its payload holds {held}")]
    CountsMismatch {
        /// The items the counts add up to.
        counted: usize,
        /// The items the payload holds.
        held: usize,
    },
}

/// The items `payload_ref` holds: an inline payload's own, or an artifact's read through
/// `payloads` as JSON, which must hold the item count its reference records. Fails as
/// [`StepPayloadReadError::Artifact`], [`StepPayloadReadError::Json`] or
/// [`StepPayloadReadError::ItemCountMismatch`] says.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start of a partial run and the restart's loader"
    )
)]
pub(crate) async fn read_step_payload(
    payloads: &dyn StepPayloadArtifacts,
    payload_ref: &WorkflowPayloadRef,
) -> Result<Vec<WorkflowItem>, StepPayloadReadError> {
    match payload_ref {
        WorkflowPayloadRef::Inline { items } => Ok(items.clone()),
        WorkflowPayloadRef::Artifact {
            artifact_id,
            item_count,
            ..
        } => {
            let bytes = payloads
                .read(artifact_id)
                .await
                .map_err(StepPayloadReadError::Artifact)?;
            let items: Vec<WorkflowItem> =
                serde_json::from_slice(&bytes).map_err(StepPayloadReadError::Json)?;
            if SafeInt::from_usize(items.len()) != *item_count {
                return Err(StepPayloadReadError::ItemCountMismatch {
                    recorded: item_count.get(),
                    held: items.len(),
                });
            }
            Ok(items)
        }
    }
}

/// `items`, a payload [`join_step_outputs`] joined, split back into one list per output by
/// `output_item_counts`, the stored count of each output in order. Counts that do not add up to
/// the items are refused as [`StepPayloadReadError::CountsMismatch`].
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start of a partial run and the restart's loader"
    )
)]
pub(crate) fn split_step_outputs(
    items: Vec<WorkflowItem>,
    output_item_counts: &[usize],
) -> Result<Vec<Vec<WorkflowItem>>, StepPayloadReadError> {
    let counted = output_item_counts
        .iter()
        .fold(0, |sum: usize, count| sum.saturating_add(*count));
    let held = items.len();
    if counted != held {
        return Err(StepPayloadReadError::CountsMismatch { counted, held });
    }
    let mut items = items.into_iter();
    Ok(output_item_counts
        .iter()
        .map(|count| items.by_ref().take(*count).collect())
        .collect())
}

/// How many items each output of a stored step holds, in output order, from its stored counts.
pub(crate) fn stored_output_lengths(counts: &[SafeInt<0>]) -> Vec<usize> {
    counts
        .iter()
        .map(|count| usize::try_from(count.get()).expect("a safe integer fits in a usize"))
        .collect()
}

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
    use serde_json::json;
    use sidekicks_contracts::artifacts::id::ArtifactId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::workflow::definition::item::WorkflowItem;
    use sidekicks_contracts::workflow::run::id::WorkflowRunId;
    use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};
    use sidekicks_contracts::workflow::run::step::methods::WorkflowStepReadRequest;
    use sidekicks_contracts::workflow::run::step::record::{
        WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP, WorkflowPayloadRef, WorkflowStepKey,
    };

    use super::{
        StepPayloadReadError, WorkflowStepPayloadError, WorkflowStepPayloadReader,
        decode_step_payload_cursor, encode_step_payload_cursor, join_step_outputs,
        read_step_payload, split_step_outputs, write_step_payload,
    };
    use crate::engine::ports::kept_payloads::KeptPayloads;
    use crate::runs::invalid_cursor::{UnresolvableCursorReason, WorkflowCursorUnresolvable};
    use crate::test_rows::{
        TEST_NODE_ID, TEST_SESSION_ID, TestStep, insert_run, insert_step, insert_workflow_version,
        test_node_id, workflow_tables,
    };

    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e50";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e51";
    const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e52";
    const STARTED_AT: &str = "2026-10-02T00:00:00.000Z";

    /// Items whose `json` values are `values`, in order.
    fn items(values: &[i64]) -> Vec<WorkflowItem> {
        values
            .iter()
            .map(|value| serde_json::from_value(json!({ "json": value })).expect("the item reads"))
            .collect()
    }

    /// Mutation: in `split_step_outputs`, collect every item into the first output in place of
    /// `take(*count)`, so a later output's items are read back as the first output's.
    #[test]
    fn joined_outputs_split_back_by_their_counts() {
        let outputs = vec![items(&[1, 2]), items(&[]), items(&[3])];
        let joined = join_step_outputs(&outputs).into_owned();
        let split = split_step_outputs(joined, &[2, 0, 1]).expect("the counts add up");
        assert_eq!(split, outputs);
    }

    /// A payload over the inline cap is written as an artifact and read back to the same items, and
    /// an artifact holding another count than its reference records, or one the store does not
    /// hold, is refused. Mutations: drop the item-count check (the short reference reads back);
    /// answer an artifact's read refusal as no items (the unknown artifact reads back).
    #[tokio::test]
    async fn an_artifact_payload_reads_back_to_the_items_it_records() {
        let payloads = KeptPayloads::default();
        let step = WorkflowStepKey {
            workflow_run_id: WorkflowRunId::new(RUN_ID).expect("the test's run id"),
            node_id: test_node_id(TEST_NODE_ID),
            attempt: SafeInt::new(1).expect("a first attempt"),
            execution_index: SafeInt::ZERO,
        };
        let large = "x".repeat(WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP);
        let written: Vec<WorkflowItem> = (0..2)
            .map(|_| serde_json::from_value(json!({ "json": large })).expect("the item reads"))
            .collect();
        let session_id = SessionId::new(TEST_SESSION_ID).expect("the test's session id");
        let reference = write_step_payload(&payloads, session_id, &step, &written)
            .await
            .expect("the payload is stored");
        let WorkflowPayloadRef::Artifact {
            artifact_id,
            size_bytes,
            ..
        } = reference
        else {
            panic!("a payload over the cap is stored as an artifact");
        };
        let read = read_step_payload(&payloads, &reference).await;
        assert_eq!(read.expect("the artifact reads back"), written);
        let short = WorkflowPayloadRef::Artifact {
            artifact_id,
            size_bytes,
            item_count: SafeInt::from_usize(1),
        };
        assert!(matches!(
            read_step_payload(&payloads, &short).await,
            Err(StepPayloadReadError::ItemCountMismatch {
                recorded: 1,
                held: 2
            })
        ));
        let unknown = WorkflowPayloadRef::Artifact {
            artifact_id: ArtifactId::try_from(mint_uuid_v7()).expect("a minted artifact id"),
            size_bytes,
            item_count: SafeInt::from_usize(2),
        };
        assert!(matches!(
            read_step_payload(&payloads, &unknown).await,
            Err(StepPayloadReadError::Artifact(_))
        ));
    }

    /// Mutation: drop `split_step_outputs`' `counted != held` check, so a stored count that
    /// disagrees with its payload splits short or drops items instead of being refused.
    #[rstest]
    #[case::counts_past_the_items(&[2, 2], 4)]
    #[case::counts_short_of_the_items(&[1], 1)]
    fn counts_that_do_not_add_up_to_the_items_are_refused(
        #[case] counts: &[usize],
        #[case] counted: usize,
    ) {
        let refusal = split_step_outputs(items(&[1, 2, 3]), counts).expect_err("the counts differ");
        assert!(matches!(
            refusal,
            StepPayloadReadError::CountsMismatch { counted: refused, held: 3 } if refused == counted
        ));
    }

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
