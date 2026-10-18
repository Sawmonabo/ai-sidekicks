//! `session.read`: one session's record with its unsent draft, its staged files and its inbox
//! addresses laid in, its transcript cursors, its runs not yet ended and its standing events. The
//! record, cursors, runs and standing events come from the session's row, run rows and log in one
//! snapshot; the draft from the store `session.draft.update` writes.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::session::draft::SessionAttachmentSummary;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{
    SessionAddress, SessionRead, SessionReadRequest, SessionReadResponse, SessionRecord,
};
use sidekicks_contracts::wire::list::UniqueList;

use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use crate::session::draft_store::SessionDraftStore;
use crate::session::service::{
    SessionLogRead, SessionReadRecord, SessionService, SessionServiceError,
};

/// A session's inbox addresses, the session's own place first.
pub(crate) type SessionAddresses = UniqueList<SessionAddress, 1, { usize::MAX }>;

/// Answers a session's inbox addresses, derived from its id alone, so they read the same whether
/// or not a process runs for it.
pub(crate) type SessionAddressLookup = Arc<dyn Fn(&SessionId) -> SessionAddresses + Send + Sync>;

/// Reads the files staged for a session's next message, in the order they were staged; fails as
/// the store's read does.
pub(crate) type StagedAttachmentsReader = Arc<
    dyn Fn(SessionId) -> BoxFuture<'static, Result<Vec<SessionAttachmentSummary>, HandlerError>>
        + Send
        + Sync,
>;

/// What `session.read` composes its answer from.
pub(crate) struct SessionReadSources {
    /// The session's row, cursors, live runs and standing events.
    pub(crate) sessions: Arc<SessionService>,
    /// The unsent draft.
    pub(crate) drafts: Arc<SessionDraftStore>,
    /// The staged files.
    pub(crate) read_attachments: StagedAttachmentsReader,
    /// The inbox addresses.
    pub(crate) addresses_of: SessionAddressLookup,
}

/// Registers `session.read` over `sources`. Refuses a session the daemon does not hold
/// `session.notFound`; a failed read is a fault in the daemon. Fails the start when the method is
/// already registered.
pub(crate) fn register_session_read(
    registry: &mut MethodRegistryBuilder,
    sources: SessionReadSources,
) -> Result<(), RegistrationError> {
    let sources = Arc::new(sources);
    registry.register::<SessionRead, _>(
        move |request: SessionReadRequest, _context: HandlerContext| {
            let sources = Arc::clone(&sources);
            async move { read_session(&sources, request).await }.boxed()
        },
    )
}

async fn read_session(
    sources: &SessionReadSources,
    request: SessionReadRequest,
) -> Result<SessionReadResponse, HandlerError> {
    let session_id = request.session_id;
    let SessionLogRead {
        session,
        transcript_cursors,
        live_runs,
        standing_events,
    } = sources.sessions.read_session(request).await?;
    let draft = sources.drafts.read(session_id).await?;
    let attachments = (sources.read_attachments)(session_id).await?;
    let SessionReadRecord {
        id,
        state,
        shape,
        place,
        name,
        muted,
        pending_working_folder,
        created_at,
        updated_at,
        max_steps_per_turn,
        tags,
    } = session;
    Ok(SessionReadResponse {
        session: SessionRecord {
            id,
            state,
            shape,
            place,
            name,
            muted,
            pending_working_folder,
            created_at,
            updated_at,
            draft,
            attachments,
            max_steps_per_turn,
            addresses: (sources.addresses_of)(&session_id),
            tags,
        },
        transcript_cursors,
        live_runs,
        standing_events,
    })
}

impl From<SessionServiceError> for HandlerError {
    /// A session the daemon does not hold answers `session.notFound`; every other failure is a
    /// fault in the daemon.
    fn from(error: SessionServiceError) -> Self {
        match error {
            SessionServiceError::Refused(refusal) => Self::Refused(refusal),
            fault @ (SessionServiceError::Database(_)
            | SessionServiceError::Log(_)
            | SessionServiceError::RunNamesNoAgent { .. }
            | SessionServiceError::Rebuild(_)
            | SessionServiceError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::FutureExt as _;
    use serde_json::{Value, json};
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::method::Method as _;
    use sidekicks_contracts::session::draft::SessionDraftUpdate;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::session::methods::{SessionAddress, SessionRead};
    use sidekicks_contracts::wire::list::UniqueList;

    use super::{SessionReadSources, register_session_read};
    use crate::database::connection::read_pool::DatabaseReadPool;
    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use crate::events::log_service::tests::open_log;
    use crate::ipc::call_fixtures::{context, request};
    use crate::ipc::handlers::session::draft_update::register_session_draft_update;
    use crate::ipc::registry::{Dispatch as _, MethodRegistry, MethodRegistryBuilder, Reply};
    use crate::session::draft_store::{SESSION_DRAFT_STORE_STATEMENT_CAPACITY, SessionDraftStore};
    use crate::session::service::{SESSION_SERVICE_STATEMENT_CAPACITY, SessionService};

    /// The tables a session read and the draft store name, with only the columns they read.
    const SESSION_TABLES_SQL: &str = "
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, shape TEXT NOT NULL, name TEXT, muted_at TEXT,
  pending_working_folder TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, place TEXT);
CREATE TABLE session_tags (session_id TEXT NOT NULL, tag TEXT NOT NULL, tag_folded TEXT NOT NULL);
CREATE TABLE session_console_state (session_id TEXT PRIMARY KEY, max_steps_per_turn INTEGER);
CREATE TABLE runs (
  session_id TEXT NOT NULL, run_id TEXT NOT NULL, parent_run_id TEXT, is_apart INTEGER NOT NULL,
  state TEXT NOT NULL, run_version INTEGER NOT NULL);
CREATE TABLE session_drafts (
  session_id TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at TEXT NOT NULL);";

    /// The answer of one call that succeeds.
    async fn call(registry: &MethodRegistry, method: &str, params: &Value) -> Value {
        let reply = registry
            .dispatch(request(method, Some(params)), context(1))
            .await;
        let Ok(Reply::Result(result)) = reply else {
            panic!("{method} answers a result");
        };
        serde_json::from_slice(&result.json).expect("a result is JSON")
    }

    #[tokio::test]
    async fn a_read_carries_the_place_and_the_draft_last_saved_and_an_empty_one_once_cleared() {
        let database = TestDatabase::new();
        let writer = open_log(&database, None).await.writer;
        let session_id = test_session_id();
        let reader = database.reader();
        reader
            .execute_batch(SESSION_TABLES_SQL)
            .expect("the session tables are made");
        reader
            .execute(
                "INSERT INTO sessions (id, state, shape, created_at, updated_at, place)
                 VALUES (?1, 'active', 'chat', '2026-10-18T09:00:00.000Z',
                         '2026-10-18T09:00:00.000Z', '{\"distro\":\"Ubuntu\"}')",
                [session_id.text().as_str()],
            )
            .expect("the session is written");
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            SESSION_SERVICE_STATEMENT_CAPACITY + SESSION_DRAFT_STORE_STATEMENT_CAPACITY,
        ));
        let drafts = Arc::new(SessionDraftStore::new(Arc::clone(&reads), writer));
        let mut builder = MethodRegistryBuilder::new();
        register_session_draft_update(&mut builder, Arc::clone(&drafts))
            .expect("session.draft.update registers");
        register_session_read(
            &mut builder,
            SessionReadSources {
                sessions: Arc::new(SessionService::new(
                    reads,
                    Arc::new(|_session_id: &SessionId| None),
                )),
                drafts,
                read_attachments: Arc::new(|_session_id| async { Ok(Vec::new()) }.boxed()),
                addresses_of: Arc::new(|_session_id: &SessionId| {
                    let address = SessionAddress {
                        place: None,
                        address: FilesystemPath::new("/run/inbox.sock".to_owned())
                            .expect("an inbox path"),
                    };
                    UniqueList::new(vec![address]).expect("one address")
                }),
            },
        )
        .expect("session.read registers");
        let registry = builder.freeze();
        let read_params = json!({ "sessionId": session_id });

        for draft in ["Half a thought about the", ""] {
            call(
                &registry,
                SessionDraftUpdate::DESCRIPTOR.method,
                &json!({ "sessionId": session_id, "text": draft }),
            )
            .await;
            let read = call(&registry, SessionRead::DESCRIPTOR.method, &read_params).await;
            assert_eq!(read["session"]["draft"], draft);
            assert_eq!(read["session"]["place"], json!({ "distro": "Ubuntu" }));
        }
    }
}
