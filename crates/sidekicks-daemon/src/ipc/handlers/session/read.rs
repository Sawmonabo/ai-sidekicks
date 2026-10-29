//! `session.read`: one session's record with its unsent draft, its staged files and its inbox
//! addresses laid in, its transcript cursors, its runs not yet ended and its standing events. The
//! record, cursors, runs and standing events come from the session's row, run rows and log in one
//! snapshot; the draft from the store `session.draft.update` writes.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::session::methods::{
    SessionRead, SessionReadRequest, SessionReadResponse, SessionRecord,
};
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_session::addresses::SessionInboxAddresses;
use sidekicks_session::draft_store::SessionDraftStore;
use sidekicks_session::service::{SessionLogRead, SessionReadRecord, SessionService};
use sidekicks_session::staged_attachments::StagedAttachments;

// What `session.read` composes its answer from.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the staged attachments store registers the session read"
    )
)]
struct SessionReadSources {
    sessions: Arc<SessionService>,
    drafts: Arc<SessionDraftStore>,
    attachments: Arc<dyn StagedAttachments>,
    addresses: Arc<SessionInboxAddresses>,
}

/// Registers `session.read`, refusing a session the daemon does not hold `session.notFound`.
/// Fails the start when the method is already registered.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the staged attachments store registers the session read"
    )
)]
pub(crate) fn register_session_read(
    registry: &mut MethodRegistryBuilder,
    sessions: Arc<SessionService>,
    drafts: Arc<SessionDraftStore>,
    attachments: Arc<dyn StagedAttachments>,
    addresses: Arc<SessionInboxAddresses>,
) -> Result<(), RegistrationError> {
    let sources = Arc::new(SessionReadSources {
        sessions,
        drafts,
        attachments,
        addresses,
    });
    registry.register::<SessionRead, _>(
        move |request: SessionReadRequest, _context: HandlerContext| {
            let sources = Arc::clone(&sources);
            async move { read_session(&sources, request).await }.boxed()
        },
    )
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the staged attachments store registers the session read"
    )
)]
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
    let attachments = sources.attachments.read(&session_id).await?;
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
        permission_level,
        session_mode,
        tags,
    } = session;
    let addresses = sources.addresses.addresses_of(&session_id, place.as_ref());
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
            permission_level,
            session_mode,
            addresses,
            tags,
        },
        transcript_cursors,
        live_runs,
        standing_events,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use serde_json::{Value, json};
    use sidekicks_contracts::method::Method as _;
    use sidekicks_contracts::place::{Place, WindowsPlace};
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::draft::{SessionAttachmentSummary, SessionDraftUpdate};
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::session::methods::SessionRead;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::registry::{Dispatch as _, MethodRegistry, MethodRegistryBuilder, Reply};
    use sidekicks_platforms::PathRules;
    use sidekicks_provider::driver::test_registry::session_inbox_addresser;
    use sidekicks_session::addresses::SessionInboxAddresses;
    use sidekicks_session::draft_store::{
        SESSION_DRAFT_STORE_STATEMENT_CAPACITY, SessionDraftStore,
    };
    use sidekicks_session::service::{SESSION_SERVICE_STATEMENT_CAPACITY, SessionService};
    use sidekicks_session::staged_attachments::{StagedAttachments, StagedAttachmentsError};
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::events::log_service::test_fixture::open_log;

    use super::register_session_read;
    use crate::daemon::schema::schema_parts;
    use crate::ipc::handlers::session::draft_update::register_session_draft_update;

    /// A session with no files staged.
    struct NoStagedAttachments;

    impl StagedAttachments for NoStagedAttachments {
        fn read(
            &self,
            _session_id: &SessionId,
        ) -> BoxFuture<'_, Result<Vec<SessionAttachmentSummary>, StagedAttachmentsError>> {
            async { Ok(Vec::new()) }.boxed()
        }
    }

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
        let database = TestDatabase::new(schema_parts());
        let writer = open_log(&database, None).await.writer;
        let session_id = test_session_id();
        insert_session_row(
            &database.reader(),
            session_id.text().as_str(),
            None,
            Some("{\"distro\":\"Ubuntu\"}"),
        );
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
            Arc::new(SessionService::new(
                reads,
                Arc::new(|_session_id: &SessionId| None),
                Arc::new(|_: &ProviderId| None),
            )),
            drafts,
            Arc::new(NoStagedAttachments),
            // The session's own distribution is one the start did not list.
            Arc::new(
                SessionInboxAddresses::new(
                    PathRules::Windows,
                    vec![Some(Place::Windows(WindowsPlace::Value))],
                    true,
                    session_inbox_addresser(),
                )
                .expect("the places fit the computer"),
            ),
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
            assert_eq!(
                read["session"]["addresses"][0]["place"],
                json!({ "distro": "Ubuntu" })
            );
            let address = read["session"]["addresses"][0]["address"]
                .as_str()
                .expect("an address is text");
            assert!(address.starts_with("/tmp/cc-socks/"), "{address}");
        }
    }
}
