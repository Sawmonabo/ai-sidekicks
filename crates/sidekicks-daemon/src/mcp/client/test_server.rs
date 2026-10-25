//! An in-process tool server for the client's tests: hand-written JSON lines over a pipe, so it can
//! answer in the 2025-11-25 shapes rmcp's own server no longer writes, each request it receives
//! kept with the instant it arrived.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::mcp::client::McpClient;
use crate::mcp::client::connection::McpServerConnection;
use crate::mcp::client::raw_copy::{RawLineTee, RawReplyCopy};
use crate::provider::port::registration::PortRegistration;

/// What the server answers a request: its `result` or `error` member, by method and params.
pub(super) type Responder = Box<dyn FnMut(&str, &Value) -> Value + Send>;

/// The server's side: each message it received, and a sender of lines it writes unasked.
pub(super) struct TestServer {
    pub(super) received: Arc<Mutex<Vec<(Instant, Value)>>>,
    pub(super) unasked: mpsc::UnboundedSender<Value>,
    pub(super) session_id: SessionId,
}

impl TestServer {
    /// The methods of the requests received, in order, each with its instant.
    pub(super) fn requests(&self, method: &str) -> Vec<(Instant, Value)> {
        self.received
            .lock()
            .expect("the test's record is never poisoned")
            .iter()
            .filter(|(_, message)| message["method"] == method)
            .cloned()
            .collect()
    }
}

/// A 2025-11-25 server's `initialize` result, declaring tasks on `tools/call`.
pub(super) fn v1_initialize_result() -> Value {
    json!({
        "protocolVersion": "2025-11-25",
        "capabilities": {
            "tools": {},
            "prompts": { "listChanged": true },
            "tasks": { "requests": { "tools": { "call": {} } } },
        },
        "serverInfo": { "name": "tracker", "version": "1.0.0" },
    })
}

/// Opens a connection of `client` to a server answering through `responder`, which is asked for
/// every request but `server/discover`, refused as a 2025-11-25 server refuses it.
pub(super) async fn open_test_server(
    client: &McpClient,
    mut responder: Responder,
) -> (McpServerConnection, TestServer) {
    let (client_end, server_end) = tokio::io::duplex(1 << 16);
    let (client_read, client_write) = tokio::io::split(client_end);
    let (server_read, mut server_write) = tokio::io::split(server_end);
    let received = Arc::new(Mutex::new(Vec::new()));
    let (unasked, mut unasked_lines) = mpsc::unbounded_channel::<Value>();
    let kept = Arc::clone(&received);
    tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        loop {
            let reply = tokio::select! {
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else { return };
                    let message: Value = serde_json::from_str(&line).expect("the client writes JSON");
                    kept.lock().expect("never poisoned").push((Instant::now(), message.clone()));
                    let Some(id) = message.get("id").filter(|_| message.get("method").is_some())
                    else {
                        continue;
                    };
                    let method = message["method"].as_str().unwrap_or_default();
                    let mut reply = if method == "server/discover" {
                        json!({ "error": { "code": -32601, "message": "Method not found" } })
                    } else {
                        responder(method, &message["params"])
                    };
                    reply["jsonrpc"] = json!("2.0");
                    reply["id"] = id.clone();
                    reply
                }
                Some(line) = unasked_lines.recv() => line,
            };
            let mut text = reply.to_string();
            text.push('\n');
            if server_write.write_all(text.as_bytes()).await.is_err() {
                return;
            }
        }
    });
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    let scope = client.connection_scope(
        session_id,
        FreeFormText::new("tracker".to_owned()).expect("a short server name"),
    );
    let raw = RawReplyCopy::default();
    let transport = rmcp::transport::async_rw::AsyncRwTransport::new_client(
        RawLineTee::new(client_read, raw.clone()),
        client_write,
    );
    let connection = McpServerConnection::open(transport, raw, scope, None)
        .await
        .expect("the test server completes its start");
    (
        connection,
        TestServer {
            received,
            unasked,
            session_id,
        },
    )
}

/// A client whose questions card intake is never registered.
pub(super) fn test_client() -> McpClient {
    McpClient::new(Arc::new(PortRegistration::new("questions")))
}
