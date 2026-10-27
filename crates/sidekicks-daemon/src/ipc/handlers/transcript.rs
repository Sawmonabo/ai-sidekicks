//! The transcript reads served here: `transcript.read`, one bounded window of a session's
//! transcript rows; `transcript.reasoning.read`, a run's reasoning kept whole;
//! `transcript.childRun.expand`, one child run's own rows; `transcript.patch.list`, the patches a
//! tool call's row left out; `transcript.body.read`, a row's large body or whole output, part by
//! part; and `transcript.search`, one session's find over every row it holds, newest first. Each
//! reads only the session or run the request names, up to the request's own limit.

use std::sync::Arc;

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::transcript::content::TranscriptPatchListRequest;
use sidekicks_contracts::transcript::content::{
    TranscriptBodyReadRequest, TranscriptBodyReadResponse,
};
use sidekicks_contracts::transcript::methods::{
    TranscriptBodyRead, TranscriptChildRunExpand, TranscriptPatchList, TranscriptRead,
    TranscriptReasoningRead, TranscriptSearch,
};
use sidekicks_contracts::transcript::operations::{
    TranscriptChildRunExpandRequest, TranscriptReadRequest, TranscriptReasoningReadRequest,
};
use sidekicks_contracts::transcript::search::TranscriptSearchRequest;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;

use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_session::search::index::live::LiveIndex;
use sidekicks_session::service::SessionService;

/// Registers `transcript.read`, `transcript.reasoning.read`, `transcript.childRun.expand`,
/// `transcript.patch.list` and `transcript.body.read` over `sessions` and `transcript.search` over
/// `search_index`, each refusing by the codes its method lists. Fails the start when a method
/// is already registered.
pub(crate) fn register_transcript_reads(
    registry: &mut MethodRegistryBuilder,
    sessions: Arc<SessionService>,
    search_index: Arc<LiveIndex>,
) -> Result<(), RegistrationError> {
    let windows = Arc::clone(&sessions);
    registry.register::<TranscriptRead, _>(
        move |request: TranscriptReadRequest, _context: HandlerContext| {
            let sessions = Arc::clone(&windows);
            async move { Ok(sessions.read_transcript_window(request).await?) }.boxed()
        },
    )?;
    let reasoning = Arc::clone(&sessions);
    registry.register::<TranscriptReasoningRead, _>(
        move |request: TranscriptReasoningReadRequest, _context: HandlerContext| {
            let sessions = Arc::clone(&reasoning);
            async move { Ok(sessions.read_reasoning(request).await?) }.boxed()
        },
    )?;
    let expansions = Arc::clone(&sessions);
    registry.register::<TranscriptChildRunExpand, _>(
        move |request: TranscriptChildRunExpandRequest, _context: HandlerContext| {
            let sessions = Arc::clone(&expansions);
            async move {
                Ok(sessions
                    .expand_child_run(request, WireInstant::now())
                    .await?)
            }
            .boxed()
        },
    )?;
    let patches = Arc::clone(&sessions);
    registry.register::<TranscriptPatchList, _>(
        move |request: TranscriptPatchListRequest, _context: HandlerContext| {
            let sessions = Arc::clone(&patches);
            async move { Ok(sessions.list_patches(request).await?) }.boxed()
        },
    )?;
    let bodies = Arc::clone(&sessions);
    registry.register::<TranscriptBodyRead, _>(
        move |request: TranscriptBodyReadRequest, _context: HandlerContext| {
            let sessions = Arc::clone(&bodies);
            async move { read_body(&sessions, request).await }.boxed()
        },
    )?;
    registry.register::<TranscriptSearch, _>(
        move |request: TranscriptSearchRequest, _context: HandlerContext| {
            let sessions = Arc::clone(&sessions);
            let search_index = Arc::clone(&search_index);
            async move {
                let damaged_from_sequence = sessions.damaged_from_sequence(&request.session_id);
                Ok(search_index
                    .search_transcript(request, damaged_from_sequence)
                    .await?)
            }
            .boxed()
        },
    )
}

// The part of a row's body from the request's offset. A row the session does not hold is refused
// `transcript.row.notFound`, so it never reads like a row with no body.
async fn read_body(
    sessions: &SessionService,
    request: TranscriptBodyReadRequest,
) -> Result<TranscriptBodyReadResponse, HandlerError> {
    let part = sessions
        .read_row_body(
            request.session_id,
            request.row_id.as_str().to_owned(),
            request.offset.map_or(0, SafeInt::get),
        )
        .await?;
    part.ok_or_else(|| {
        DomainError::new(
            "This session holds no row with that id.",
            RefusalCode::TranscriptRowNotFound,
        )
        .with_detail(json!({ "rowId": request.row_id }))
        .into()
    })
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

    use super::read_body;
    use crate::remote::shared_ports::schema::schema_parts;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_session::service::{SESSION_SERVICE_STATEMENT_CAPACITY, SessionService};
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, test_envelope, test_session_id,
    };
    use sidekicks_store::events::log_service::EventLogAppendOptions;
    use sidekicks_store::events::log_service::tests::open_log;

    #[tokio::test]
    async fn a_row_the_session_lacks_is_refused_where_a_row_with_no_body_reads_absent() {
        let database = TestDatabase::new(schema_parts());
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
        let sessions = SessionService::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                SESSION_SERVICE_STATEMENT_CAPACITY,
            )),
            Arc::new(|_session_id: &SessionId| None),
        );
        let body_of = |row_id: FreeFormText<EVENT_FIELD_MAX_LEN>| TranscriptBodyReadRequest {
            session_id,
            row_id,
            offset: None,
        };

        let held = read_body(&sessions, body_of(receipt.id))
            .await
            .expect("a row the session holds reads");
        assert_eq!(
            held,
            TranscriptBodyReadResponse::Unavailable {
                reason: HydratedContentUnavailableReason::Absent,
            }
        );

        let missing_id = FreeFormText::new("no-such-row".to_owned()).expect("a row id");
        let refused = read_body(&sessions, body_of(missing_id))
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
