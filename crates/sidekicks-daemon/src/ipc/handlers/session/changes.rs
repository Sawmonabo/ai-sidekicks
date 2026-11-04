//! A person's changes to one session: `session.rename`; `session.archive`, `session.reactivate`
//! and `session.close`, its moves between the live list, the archived ones and closed; and
//! `session.pin`, `session.unpin`, `session.mute` and `session.unmute`, the marks the daemon holds
//! for every device. A change that finds the session already as it asks appends nothing. A
//! close, once it is written, starts closing the session's tool-server connections and answers
//! without waiting for them.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{
    SessionArchive, SessionClose, SessionMute, SessionPin, SessionReactivate, SessionRename,
    SessionRenameRequest, SessionTargetRequest, SessionUnmute, SessionUnpin,
};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_mcp::client::McpClient;
use sidekicks_session::changes::{SessionChangeError, SessionChanges};

/// One change to the session a request names, run on its own `SessionChanges` handle.
type SessionTargetChange =
    fn(Arc<SessionChanges>, SessionId) -> BoxFuture<'static, Result<(), SessionChangeError>>;

/// Registers the eight session change verbs, each refusing by the codes its method lists and
/// keeping nothing when refused; a close that succeeds starts `mcp_client`'s close of the
/// session's tool-server connections. Fails the start when a verb is already registered.
pub(crate) fn register_session_changes(
    registry: &mut MethodRegistryBuilder,
    changes: Arc<SessionChanges>,
    mcp_client: Arc<McpClient>,
) -> Result<(), RegistrationError> {
    let renaming = Arc::clone(&changes);
    registry.register::<SessionRename, _>(
        move |request: SessionRenameRequest, _context: HandlerContext| {
            let changes = Arc::clone(&renaming);
            async move { Ok(changes.rename(request).await?) }.boxed()
        },
    )?;
    register_target_change::<SessionArchive>(
        registry,
        Arc::clone(&changes),
        |changes, session_id| async move { changes.archive(session_id).await }.boxed(),
    )?;
    register_target_change::<SessionReactivate>(
        registry,
        Arc::clone(&changes),
        |changes, session_id| async move { changes.reactivate(session_id).await }.boxed(),
    )?;
    let closing = Arc::clone(&changes);
    registry.register::<SessionClose, _>(
        move |request: SessionTargetRequest, _context: HandlerContext| {
            let (changes, mcp_client) = (Arc::clone(&closing), Arc::clone(&mcp_client));
            async move {
                changes.close(request.session_id).await?;
                mcp_client.start_session_close(request.session_id);
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )?;
    register_target_change::<SessionPin>(registry, Arc::clone(&changes), |changes, session_id| {
        async move { changes.pin(session_id).await }.boxed()
    })?;
    register_target_change::<SessionUnpin>(
        registry,
        Arc::clone(&changes),
        |changes, session_id| async move { changes.unpin(session_id).await }.boxed(),
    )?;
    register_target_change::<SessionMute>(
        registry,
        Arc::clone(&changes),
        |changes, session_id| async move { changes.mute(session_id).await }.boxed(),
    )?;
    register_target_change::<SessionUnmute>(registry, changes, |changes, session_id| {
        async move { changes.unmute(session_id).await }.boxed()
    })
}

/// Registers `M`, a verb on one session that answers `{}` once `change` has run on it. Fails the
/// start when `M` is already registered.
fn register_target_change<M>(
    registry: &mut MethodRegistryBuilder,
    changes: Arc<SessionChanges>,
    change: SessionTargetChange,
) -> Result<(), RegistrationError>
where
    M: Method<Params = SessionTargetRequest, Result = EmptyPayload> + 'static,
{
    registry.register::<M, _>(
        move |request: SessionTargetRequest, _context: HandlerContext| {
            let changing = change(Arc::clone(&changes), request.session_id);
            async move {
                changing.await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use sidekicks_contracts::mcp::server::McpServerName;
    use sidekicks_contracts::method::Method as _;
    use sidekicks_contracts::session::methods::SessionClose;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::registry::{Dispatch as _, MethodRegistryBuilder, Reply};
    use sidekicks_mcp::client::McpClient;
    use sidekicks_provider::driver::registry::ProviderRegistry;
    use sidekicks_provider::driver::test_registry::test_driver_services;
    use sidekicks_session::changes::{SESSION_CHANGES_STATEMENT_CAPACITY, SessionChanges};
    use sidekicks_std::port_registration::PortRegistration;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::events::log_service::test_fixture::open_log;

    use super::register_session_changes;
    use crate::daemon::release_version::this_build_release_version;
    use crate::daemon::schema::schema_parts;

    /// Long enough for a close to append and answer, many times over.
    const CLOSE_WAIT: Duration = Duration::from_secs(10);

    // Mutation: await the client's close before the reply; the held work then keeps the close,
    // and so the reply, from coming. Leaving the close out keeps the connection open.
    #[tokio::test]
    async fn the_close_answers_before_the_sessions_tool_server_connections_close() {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let session_id = test_session_id();
        insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
        let changes = Arc::new(SessionChanges::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                SESSION_CHANGES_STATEMENT_CAPACITY,
            )),
            Arc::clone(&log.service),
            Arc::new(ProviderRegistry::register_from(
                &[],
                &test_driver_services(),
            )),
        ));
        let mcp_client = Arc::new(
            McpClient::new(
                Arc::new(PortRegistration::new("questions")),
                this_build_release_version(),
            )
            .expect("the client builds"),
        );
        let mut builder = MethodRegistryBuilder::new();
        register_session_changes(&mut builder, changes, Arc::clone(&mcp_client))
            .expect("the change methods register");
        let registry = builder.freeze();
        let server_name: McpServerName =
            FreeFormText::new("tracker".to_owned()).expect("a short server name");
        let probe = mcp_client.probe_standing_connection(session_id, &server_name);
        let held = probe.hold();

        let reply = tokio::time::timeout(
            CLOSE_WAIT,
            registry.dispatch(
                request(
                    SessionClose::DESCRIPTOR.method,
                    Some(&json!({ "sessionId": session_id })),
                ),
                context(1),
            ),
        )
        .await
        .expect("the close answers while the connection's work is held");
        assert!(matches!(reply, Ok(Reply::Result(_))), "the close succeeds");
        tokio::time::timeout(CLOSE_WAIT, probe.closed())
            .await
            .expect("the session's connection reads closed");

        drop(held);
    }
}
