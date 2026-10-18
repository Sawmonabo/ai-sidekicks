//! The transcript reads served here: `transcript.read`, one bounded window of a session's
//! transcript rows; `transcript.body.read`, a row's large body or whole output, part by part; and
//! `transcript.search`, one session's find over every row it holds, newest first. Each reads only
//! the session the request names, up to the request's own limit.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::jsonrpc::issue::{Issue, IssuePathSegment};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::transcript::content::{
    StoredBodyText, TranscriptBodyReadRequest, TranscriptBodyReadResponse, stored_body_content_of,
};
use sidekicks_contracts::transcript::methods::{
    TranscriptBodyRead, TranscriptRead, TranscriptSearch,
};
use sidekicks_contracts::transcript::operations::{TranscriptReadRequest, TranscriptReadResponse};
use sidekicks_contracts::transcript::search::TranscriptSearchRequest;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::events::session::read::DamagedFromSequenceReader;
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use crate::session::search::index::live::{LiveIndex, LiveIndexSearchError};
use crate::session::search::transcript::TranscriptSearchError;
use crate::transcript::body::read_stored_event_row;
use crate::transcript::window::{TranscriptReadError, read_transcript_window};

/// What `transcript.read` and `transcript.body.read` read the session's log through.
pub(crate) struct TranscriptLogReads {
    /// The daemon's read connections.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// Where a damaged session's reads stop.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

/// Registers `transcript.read` and `transcript.body.read` over `log_reads`, and
/// `transcript.search` over `search_index`.
/// Each refuses a session the daemon does not hold `session.notFound`; a cursor naming no position
/// is refused `session.event.cursorUnresolvable`, an `aroundCursor` or a `rowId` at which the
/// session holds no row `transcript.row.notFound`, and a body `offset` inside a character or past
/// the body's end `request.paramsInvalid` on that path. Fails the start when a method is already
/// registered.
pub(crate) fn register_transcript_reads(
    registry: &mut MethodRegistryBuilder,
    log_reads: TranscriptLogReads,
    search_index: Arc<LiveIndex>,
) -> Result<(), RegistrationError> {
    let log_reads = Arc::new(log_reads);
    let windows = Arc::clone(&log_reads);
    registry.register::<TranscriptRead, _>(
        move |request: TranscriptReadRequest, _context: HandlerContext| {
            let log_reads = Arc::clone(&windows);
            async move { read_window(&log_reads, request).await }.boxed()
        },
    )?;
    let bodies = Arc::clone(&log_reads);
    registry.register::<TranscriptBodyRead, _>(
        move |request: TranscriptBodyReadRequest, _context: HandlerContext| {
            let log_reads = Arc::clone(&bodies);
            async move { read_body(&log_reads, request).await }.boxed()
        },
    )?;
    registry.register::<TranscriptSearch, _>(
        move |request: TranscriptSearchRequest, _context: HandlerContext| {
            let read_damaged_from_sequence = Arc::clone(&log_reads.read_damaged_from_sequence);
            let search_index = Arc::clone(&search_index);
            async move {
                let damaged_from_sequence = read_damaged_from_sequence(&request.session_id);
                Ok(search_index
                    .search_transcript(request, damaged_from_sequence)
                    .await?)
            }
            .boxed()
        },
    )
}

async fn read_window(
    log_reads: &TranscriptLogReads,
    request: TranscriptReadRequest,
) -> Result<TranscriptReadResponse, HandlerError> {
    let read_damaged_from_sequence = Arc::clone(&log_reads.read_damaged_from_sequence);
    let window = log_reads
        .reads
        .read(ReadLength::Long, move |connection| {
            let read_damaged_from_sequence: &DamagedFromSequenceReader =
                &*read_damaged_from_sequence;
            Ok::<_, DatabaseReadError>(read_transcript_window(
                connection,
                &read_damaged_from_sequence,
                &request,
            ))
        })
        .await
        .map_err(internal)??;
    Ok(window)
}

async fn read_body(
    log_reads: &TranscriptLogReads,
    request: TranscriptBodyReadRequest,
) -> Result<TranscriptBodyReadResponse, HandlerError> {
    let read_damaged_from_sequence = Arc::clone(&log_reads.read_damaged_from_sequence);
    let session_id = request.session_id;
    let row_id = request.row_id.clone();
    let stored_row = log_reads
        .reads
        .read(ReadLength::Short, move |connection| {
            let read_damaged_from_sequence: &DamagedFromSequenceReader =
                &*read_damaged_from_sequence;
            Ok::<_, DatabaseReadError>(read_stored_event_row(
                connection,
                &read_damaged_from_sequence,
                &session_id,
                row_id.as_str(),
            ))
        })
        .await
        .map_err(internal)??;
    let Some(stored_row) = stored_row else {
        return Err(DomainError::new(
            "This session holds no row with that id.",
            RefusalCode::TranscriptRowNotFound,
        )
        .with_detail(json!({ "rowId": request.row_id }))
        .into());
    };
    let stored_body = stored_row
        .content_payload
        .map(|body| StoredBodyText::new(body).ok_or(StoredBodyOverCap))
        .transpose()
        .map_err(internal)?;
    // An offset past what `usize` holds lies past every body's end, so it is refused as one.
    let offset = request
        .offset
        .map_or(Ok(0), |offset| usize::try_from(offset.get()))
        .unwrap_or(usize::MAX);
    stored_body_content_of(
        Some(&stored_row.envelope.payload),
        stored_body.as_ref(),
        offset,
    )
    .map_err(|_refused| offset_refused().into())
}

/// The refusal of a body `offset` inside a character or past the body's end, on the request's
/// `offset` path, as a params refusal names its fault.
fn offset_refused() -> DomainError {
    let issue = Issue {
        path: vec![IssuePathSegment::Member("offset".to_owned())],
        message: "is inside a character or past the body's end".to_owned(),
        params: None,
    };
    DomainError::new(
        "The offset is no place in the body to read from.",
        RefusalCode::RequestParamsInvalid,
    )
    .with_detail(json!({ "issues": [issue] }))
}

/// A stored body longer than the cap every append cuts a body to, which only a write outside the
/// append path can leave.
#[derive(Debug, thiserror::Error)]
#[error("a stored body is longer than the cap every append holds it to")]
struct StoredBodyOverCap;

fn internal(fault: impl Error + Send + Sync + 'static) -> HandlerError {
    HandlerError::Internal(Box::new(fault))
}

impl From<TranscriptReadError> for HandlerError {
    /// A session the daemon does not hold or a row it does not hold answers by its code, a cursor
    /// it cannot read `session.event.cursorUnresolvable`; a failed read is a fault in the daemon.
    fn from(error: TranscriptReadError) -> Self {
        match error {
            TranscriptReadError::Refused(refusal) => Self::Refused(refusal),
            TranscriptReadError::CursorUnresolvable(unresolvable) => unresolvable.into(),
            fault @ (TranscriptReadError::Log(_)
            | TranscriptReadError::Database(_)
            | TranscriptReadError::Projection(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

impl From<LiveIndexSearchError<TranscriptSearchError>> for HandlerError {
    /// A session the daemon does not hold answers `session.notFound`, a cursor it cannot read
    /// `session.event.cursorUnresolvable`; an index that cannot answer or a failed read is a
    /// fault in the daemon.
    fn from(error: LiveIndexSearchError<TranscriptSearchError>) -> Self {
        match error {
            LiveIndexSearchError::Search(TranscriptSearchError::Refused(refusal)) => {
                Self::Refused(refusal)
            }
            LiveIndexSearchError::Search(TranscriptSearchError::CursorUnresolvable(
                unresolvable,
            )) => unresolvable.into(),
            LiveIndexSearchError::Search(
                fault @ (TranscriptSearchError::Database(_)
                | TranscriptSearchError::Index(_)
                | TranscriptSearchError::HitPosition(_)
                | TranscriptSearchError::HitRowId(_)),
            ) => Self::Internal(Box::new(fault)),
            fault @ (LiveIndexSearchError::Closed
            | LiveIndexSearchError::Failed(_)
            | LiveIndexSearchError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sidekicks_contracts::event::envelope::HydratedContentUnavailableReason;
    use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::transcript::content::{
        TranscriptBodyReadRequest, TranscriptBodyReadResponse,
    };
    use sidekicks_contracts::wire::text::FreeFormText;

    use super::{TranscriptLogReads, read_body};
    use crate::database::connection::read_pool::DatabaseReadPool;
    use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
    use crate::events::log_service::tests::open_log;
    use crate::events::log_service::{EVENT_LOG_STATEMENT_CAPACITY, EventLogAppendOptions};
    use crate::ipc::registry::HandlerError;

    #[tokio::test]
    async fn a_row_the_session_lacks_is_refused_where_a_row_with_no_body_reads_absent() {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await.service;
        let session_id = test_session_id();
        let pinned = serde_json::from_value(json!({
            "type": "session.pinned",
            "payload": { "sessionId": session_id, "at": "2026-10-18T09:00:00.000Z" },
        }))
        .expect("the test writes a session.pinned event");
        let receipt = log
            .append(
                test_envelope(session_id, &pinned),
                EventLogAppendOptions::default(),
            )
            .await
            .expect("the append commits");
        let log_reads = TranscriptLogReads {
            reads: Arc::new(DatabaseReadPool::new(
                database.path(),
                EVENT_LOG_STATEMENT_CAPACITY,
            )),
            read_damaged_from_sequence: Arc::new(|_session_id: &SessionId| None),
        };
        let body_of = |row_id: FreeFormText<EVENT_FIELD_MAX_LEN>| TranscriptBodyReadRequest {
            session_id,
            row_id,
            offset: None,
        };

        let held = read_body(&log_reads, body_of(receipt.id))
            .await
            .expect("a row the session holds reads");
        assert_eq!(
            held,
            TranscriptBodyReadResponse::Unavailable {
                reason: HydratedContentUnavailableReason::Absent,
            }
        );

        let missing_id = FreeFormText::new("no-such-row".to_owned()).expect("a row id");
        let refused = read_body(&log_reads, body_of(missing_id))
            .await
            .expect_err("a row the session does not hold is refused");
        let HandlerError::Refused(refusal) = refused else {
            panic!("the missing row is a refusal, not a fault");
        };
        assert_eq!(refusal.code, RefusalCode::TranscriptRowNotFound);
        assert_eq!(
            refusal.detail.map(serde_json::Value::Object),
            Some(json!({ "rowId": "no-such-row" }))
        );
    }
}
