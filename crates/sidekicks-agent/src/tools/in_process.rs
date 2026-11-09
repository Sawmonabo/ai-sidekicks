//! The daemon's tool servers as a provider reaches them in process, over its own control channel:
//! one rmcp server per connection, fed the messages the channel carries and answering through it.
//! Each request is stamped with the route and secret of the spawn that opened the connection, so
//! the server admits it against that spawn's entry exactly as it admits a request on the listener,
//! and a replaced spawn's connection is refused.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::channel::{mpsc, oneshot};
use futures::future::{BoxFuture, ready};
use futures::{FutureExt as _, SinkExt as _, StreamExt as _};
use http::header::AUTHORIZATION;
use http::request::Parts;
use rmcp::ServiceExt as _;
use rmcp::model::{
    ClientJsonRpcMessage, GetExtensions as _, JsonRpcMessage, RequestId, ServerJsonRpcMessage,
};
use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_provider::bearer_token::BearerToken;
use sidekicks_provider::port::in_process_tool_servers::{
    InProcessToolServerError, InProcessToolServerOutbound, InProcessToolServers,
    SpawnInProcessToolServers,
};
use sidekicks_provider::port::tool_server_route::{ToolServerSecretError, ToolServerSpawn};
use sidekicks_provider::tool_server_name::DAEMON_TOOL_SERVER_NAME;
use sidekicks_std::mutex_lock::lock;
use tokio_util::task::AbortOnDropHandle;

use crate::tools::entries::{ToolServerEntries, ToolServerEntryGuard};
use crate::tools::server::{AgentToolServer, ToolServerPath};

/// Messages a connection holds in each direction before a sender waits, so a connection's queues
/// stay small.
const CONNECTION_BUFFER: usize = 8;

/// The requests a connection's server has yet to answer, by request id.
type PendingCalls = Mutex<HashMap<RequestId, oneshot::Sender<Box<RawValue>>>>;

/// The daemon's server as a provider reaches it in process, each spawn's connection admitted by
/// that spawn's own entry.
pub struct InProcessAgentToolServers {
    /// Every live spawn's entry.
    entries: Arc<ToolServerEntries>,
    /// The server each connection is served by.
    server: AgentToolServer,
}

impl InProcessAgentToolServers {
    /// The in-process servers over `server`, adding each spawn's entry to `entries`.
    pub fn new(entries: Arc<ToolServerEntries>, server: AgentToolServer) -> Self {
        Self { entries, server }
    }
}

impl InProcessToolServers for InProcessAgentToolServers {
    fn open(
        &self,
        spawn: ToolServerSpawn,
    ) -> Result<Arc<dyn SpawnInProcessToolServers>, ToolServerSecretError> {
        let token = BearerToken::mint().map_err(ToolServerSecretError)?;
        let path = ToolServerPath {
            session_id: spawn.session_id,
            conversation: spawn.conversation,
            server_name: DAEMON_TOOL_SERVER_NAME.to_owned(),
        };
        let (route, ()) = http::Request::builder()
            .uri(path.to_string())
            .header(AUTHORIZATION, token.header_value().as_str())
            .body(())
            .expect("a tool server's path and a hex secret make a request")
            .into_parts();
        let entry = self
            .entries
            .insert(path, spawn.provider, token, spawn.dispatcher);
        Ok(Arc::new(SpawnToolServers {
            server: self.server.clone(),
            route,
            connection: Mutex::new(None),
            _entry: entry,
        }))
    }
}

/// One spawn's connection to the daemon's server, and the entry that admits it.
struct SpawnToolServers {
    /// The server a new connection is served by.
    server: AgentToolServer,
    /// The route and secret stamped on each request, as the listener would hand them over.
    route: Parts,
    /// The connection, opened at the spawn's first message.
    connection: Mutex<Option<Connection>>,
    /// Keeps the spawn's entry in the table while the spawn holds its servers.
    _entry: ToolServerEntryGuard,
}

/// One running rmcp server and the channels it reads and writes.
struct Connection {
    /// The provider's messages, as the server reads them.
    incoming: mpsc::Sender<ClientJsonRpcMessage>,
    /// The requests still waiting on the server's answer.
    pending: Arc<PendingCalls>,
    /// Serves the connection.
    _serving: AbortOnDropHandle<()>,
    /// Hands the server's answers to their requests and its own messages to the provider.
    _routing: AbortOnDropHandle<()>,
}

impl SpawnToolServers {
    // The live connection, opened anew when there is none or its server has ended, its server's
    // own messages sent through `outbound`.
    fn connection(
        &self,
        outbound: Arc<dyn InProcessToolServerOutbound>,
    ) -> (mpsc::Sender<ClientJsonRpcMessage>, Arc<PendingCalls>) {
        let mut connection = lock(&self.connection);
        if let Some(live) = connection
            .as_ref()
            .filter(|live| !live.incoming.is_closed())
        {
            return (live.incoming.clone(), Arc::clone(&live.pending));
        }
        let opened = open_connection(self.server.clone(), outbound);
        let handles = (opened.incoming.clone(), Arc::clone(&opened.pending));
        *connection = Some(opened);
        handles
    }
}

impl SpawnInProcessToolServers for SpawnToolServers {
    fn server_names(&self) -> Vec<String> {
        vec![DAEMON_TOOL_SERVER_NAME.to_owned()]
    }

    fn handle(
        &self,
        server_name: String,
        message: Box<RawValue>,
        outbound: Arc<dyn InProcessToolServerOutbound>,
    ) -> BoxFuture<'static, Result<Option<Box<RawValue>>, InProcessToolServerError>> {
        if server_name != DAEMON_TOOL_SERVER_NAME {
            return ready(Err(InProcessToolServerError::ServerNotFound {
                server_name,
            }))
            .boxed();
        }
        let read = match serde_json::from_str::<ClientJsonRpcMessage>(message.get()) {
            Ok(read) => read,
            Err(error) => {
                return ready(Err(InProcessToolServerError::Failed(Box::new(error)))).boxed();
            }
        };
        let (mut incoming, pending) = self.connection(outbound);
        match read {
            JsonRpcMessage::Request(mut request) => {
                request.request.extensions_mut().insert(self.route.clone());
                let (answer, answered) = oneshot::channel();
                lock(&pending).insert(request.id.clone(), answer);
                let call = OpenCall {
                    id: request.id.clone(),
                    pending,
                    incoming: incoming.clone(),
                    is_settled: false,
                };
                async move {
                    incoming
                        .send(JsonRpcMessage::Request(request))
                        .await
                        .map_err(connection_closed)?;
                    let reply = answered.await.map_err(|unanswered| {
                        InProcessToolServerError::Failed(Box::new(unanswered))
                    })?;
                    call.settle();
                    Ok(Some(reply))
                }
                .boxed()
            }
            other @ (JsonRpcMessage::Response(_)
            | JsonRpcMessage::Notification(_)
            | JsonRpcMessage::Error(_)) => async move {
                incoming.send(other).await.map_err(connection_closed)?;
                Ok(None)
            }
            .boxed(),
        }
    }
}

/// A request handed to the server and not yet answered: dropped before its answer, it tells the
/// server the call was canceled, which drops the call's work.
struct OpenCall {
    /// The request.
    id: RequestId,
    /// Where its answer is awaited.
    pending: Arc<PendingCalls>,
    /// Where the cancellation goes.
    incoming: mpsc::Sender<ClientJsonRpcMessage>,
    /// Whether its answer came.
    is_settled: bool,
}

impl OpenCall {
    // The answer came, so nothing is canceled.
    fn settle(mut self) {
        self.is_settled = true;
    }
}

impl Drop for OpenCall {
    fn drop(&mut self) {
        // An answer already taken off the table needs no cancellation.
        if self.is_settled || lock(&self.pending).remove(&self.id).is_none() {
            return;
        }
        let notice = match cancellation_of(&self.id) {
            Ok(notice) => notice,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a dropped call's cancellation could not be composed"
                );
                return;
            }
        };
        if let Err(error) = self.incoming.try_send(notice) {
            tracing::debug!(
                error = &error.into_send_error() as &(dyn Error + 'static),
                "a dropped call's cancellation did not reach its server"
            );
        }
    }
}

// Starts one rmcp server on a pair of channels, with the task that routes what it writes.
fn open_connection(
    server: AgentToolServer,
    outbound: Arc<dyn InProcessToolServerOutbound>,
) -> Connection {
    let (incoming, from_provider) = mpsc::channel::<ClientJsonRpcMessage>(CONNECTION_BUFFER);
    let (to_provider, outgoing) = mpsc::channel::<ServerJsonRpcMessage>(CONNECTION_BUFFER);
    let pending = Arc::new(PendingCalls::default());
    let serving = tokio::spawn(async move {
        match server.serve((to_provider, from_provider)).await {
            Ok(running) => {
                if let Err(error) = running.waiting().await {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "an in-process tool server's connection ended abnormally"
                    );
                }
            }
            Err(error) => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "an in-process tool server's handshake failed"
            ),
        }
    });
    let routing = tokio::spawn(route_outgoing(outgoing, Arc::clone(&pending), outbound));
    Connection {
        incoming,
        pending,
        _serving: AbortOnDropHandle::new(serving),
        _routing: AbortOnDropHandle::new(routing),
    }
}

// Hands each answer the server writes to the request it answers and every other message to the
// provider; once the server ends, every request still waiting fails.
async fn route_outgoing(
    mut outgoing: mpsc::Receiver<ServerJsonRpcMessage>,
    pending: Arc<PendingCalls>,
    outbound: Arc<dyn InProcessToolServerOutbound>,
) {
    while let Some(message) = outgoing.next().await {
        let answered = match &message {
            JsonRpcMessage::Response(response) => Some(Some(response.id.clone())),
            JsonRpcMessage::Error(error) => Some(error.id.clone()),
            JsonRpcMessage::Request(_) | JsonRpcMessage::Notification(_) => None,
        };
        let written = serde_json::value::to_raw_value(&message);
        match (answered, written) {
            (Some(id), written) => {
                let waiting = id.and_then(|id| lock(&pending).remove(&id));
                match (waiting, written) {
                    (Some(waiting), Ok(reply)) => {
                        if waiting.send(reply).is_err() {
                            tracing::debug!("an answer came for a call its caller dropped");
                        }
                    }
                    // Dropping the waiting end fails the call.
                    (Some(_), Err(error)) => tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "an in-process tool server's answer could not be written"
                    ),
                    (None, _) => {
                        tracing::debug!("an answer came for no call the connection holds");
                    }
                }
            }
            (None, Ok(sent)) => {
                if let Err(error) = outbound
                    .send(DAEMON_TOOL_SERVER_NAME.to_owned(), sent)
                    .await
                {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "an in-process tool server's message did not reach the provider"
                    );
                }
            }
            (None, Err(error)) => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "an in-process tool server's message could not be written"
            ),
        }
    }
    lock(&pending).clear();
}

// The notice that cancels the request `id`.
fn cancellation_of(id: &RequestId) -> Result<ClientJsonRpcMessage, serde_json::Error> {
    serde_json::from_value(json!({
        "jsonrpc": "2.0",
        "method": "notifications/cancelled",
        "params": {"requestId": id},
    }))
}

fn connection_closed(error: mpsc::SendError) -> InProcessToolServerError {
    InProcessToolServerError::Failed(Box::new(error))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use serde_json::value::RawValue;
    use serde_json::{Value, json};
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::port::in_process_tool_servers::{
        InProcessToolServerError, InProcessToolServerOutbound, InProcessToolServers,
        SpawnInProcessToolServers,
    };
    use sidekicks_provider::port::tool_server_route::{ToolServerConversation, ToolServerSpawn};
    use sidekicks_provider::tool_server_name::DAEMON_TOOL_SERVER_NAME;

    use super::InProcessAgentToolServers;
    use crate::tools::server::tests::{CLAUDE_SESSION, fixture};
    use crate::tools::session::list;

    /// The provider's channel, which takes every message the server sends of its own.
    struct Channel;

    impl InProcessToolServerOutbound for Channel {
        fn send(
            &self,
            _server_name: String,
            _message: Box<RawValue>,
        ) -> BoxFuture<'_, Result<(), InProcessToolServerError>> {
            async { Ok(()) }.boxed()
        }
    }

    /// Sends `message` to `servers`' daemon server and reads its reply, `Null` for none.
    async fn send(servers: &Arc<dyn SpawnInProcessToolServers>, message: &Value) -> Value {
        let raw = RawValue::from_string(message.to_string()).expect("the message is JSON");
        let reply = servers
            .handle(DAEMON_TOOL_SERVER_NAME.to_owned(), raw, Arc::new(Channel))
            .await
            .expect("the server takes the message");
        reply.map_or(Value::Null, |reply| {
            serde_json::from_str(reply.get()).expect("the reply is JSON")
        })
    }

    /// The handshake, then its `initialized` notice; answers the handshake's reply.
    async fn connect(servers: &Arc<dyn SpawnInProcessToolServers>) -> Value {
        let handshake = send(
            servers,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            }),
        )
        .await;
        let initialized = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        assert_eq!(send(servers, &initialized).await, Value::Null);
        handshake
    }

    fn list_tools(id: u64) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": "tools/list"})
    }

    // A Claude Code connection lists and calls the daemon's tools in process, a second handshake
    // on it is served, and once a later spawn of the conversation replaced its entry the earlier
    // spawn's connection is refused while the new one is served. Killed by the in-process path
    // skipping the entry's secret, which serves the replaced spawn's connection.
    #[tokio::test]
    async fn a_connection_lists_and_calls_in_process_and_a_replaced_spawns_is_refused() {
        let mut fixture = fixture();
        drop(fixture.spawns[0].1.take());
        let servers =
            InProcessAgentToolServers::new(Arc::clone(&fixture.entries), (fixture.server)());
        let session_id = SessionId::new(CLAUDE_SESSION).expect("the text is a UUID");
        let spawn = || ToolServerSpawn {
            session_id,
            conversation: ToolServerConversation::of_session(session_id),
            provider: ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id"),
            dispatcher: Arc::clone(fixture.spawns[0].0.dispatcher()),
        };
        let first = servers
            .open(spawn())
            .expect("the system's random source reads");
        assert_eq!(first.server_names(), [DAEMON_TOOL_SERVER_NAME]);

        assert!(connect(&first).await["result"]["serverInfo"].is_object());
        assert!(
            connect(&first).await["result"].is_object(),
            "a second handshake on a live connection is served"
        );
        let listed = send(&first, &list_tools(2)).await;
        let tools = listed["result"]["tools"]
            .as_array()
            .expect("the listing holds tools");
        assert!(
            tools
                .iter()
                .any(|tool| tool["name"] == list::DESCRIPTION.name)
        );
        let called = send(
            &first,
            &json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": list::DESCRIPTION.name, "arguments": {}},
            }),
        )
        .await;
        assert_eq!(called["id"], 3);
        assert_eq!(called["result"]["content"][0]["text"], "two sessions");

        let second = servers
            .open(spawn())
            .expect("the system's random source reads");
        let refused = send(&first, &list_tools(4)).await;
        assert!(refused["error"].is_object(), "{refused}");
        assert!(refused["result"].is_null());
        connect(&second).await;
        assert!(send(&second, &list_tools(5)).await["result"]["tools"].is_array());
    }
}
