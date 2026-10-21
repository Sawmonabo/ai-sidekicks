//! The daemon's tool servers as a provider reaches them in process, over its own control channel
//! rather than an address: each JSON-RPC message a provider sends one of a session's servers, the
//! reply that server writes, and the server's own messages back. The tool-server front registers
//! the port once it runs; until then a session names no in-process server.

use std::error::Error;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
use sidekicks_contracts::session::id::SessionId;

/// A session's in-process tool servers, registered through a `PortRegistration`.
pub(crate) trait InProcessToolServers: Send + Sync {
    /// The names of `session_id`'s servers, the daemon's own among them.
    fn server_names(&self, session_id: &SessionId) -> Vec<String>;

    /// Hands `message`, one JSON-RPC message the provider sent `server_name`, to that server and
    /// answers its reply, or `None` for a notification. A server takes a second `initialize` on a
    /// live connection, which a provider sends to retry its handshake, and a
    /// `notifications/cancelled` like any message; dropping the future cancels the call. Fails
    /// with `ServerNotFound` when the session has no such server, `Failed` when the server did.
    fn handle(
        &self,
        session_id: SessionId,
        server_name: String,
        message: Box<RawValue>,
        outbound: Arc<dyn InProcessToolServerOutbound>,
    ) -> BoxFuture<'static, Result<Option<Box<RawValue>>, InProcessToolServerError>>;
}

/// The route a server's own messages take to the provider: a progress notification, or a request
/// of its own.
pub(crate) trait InProcessToolServerOutbound: Send + Sync {
    /// Sends `message`, one JSON-RPC message from `server_name`, and settles once the provider
    /// took it. Fails when the provider's channel did.
    #[expect(
        dead_code,
        reason = "the tool-server front sends each server's own messages through it"
    )]
    fn send(
        &self,
        server_name: String,
        message: Box<RawValue>,
    ) -> BoxFuture<'_, Result<(), InProcessToolServerError>>;
}

/// Why an in-process server could not answer a message.
#[derive(Debug, thiserror::Error)]
pub(crate) enum InProcessToolServerError {
    /// The session has no server of the name the message named.
    #[error("the session has no tool server named {server_name}")]
    ServerNotFound {
        /// The name, as the provider sent it.
        server_name: String,
    },
    /// The server, or the route to the provider, failed.
    #[error("the tool server failed")]
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the tool-server front and a server's own sends fail with it"
        )
    )]
    Failed(#[source] Box<dyn Error + Send + Sync>),
}

#[derive(Deserialize)]
struct MessageId {
    #[serde(default)]
    id: Option<Box<RawValue>>,
}

#[derive(Serialize)]
struct JsonRpcReply<'reply> {
    jsonrpc: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'reply RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<EmptyResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Serialize)]
struct EmptyResult {}

#[derive(Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

/// The reply a provider reads for one message to an in-process server, always in band so the
/// provider's MCP client fails only that message: the server's reply; `{"result": {}}` for a
/// notification; a `-32601` error echoing the message's `id` (or `null` where it has none) for a
/// server the session lacks, or for a message naming no server or carrying none; and a `-32603`
/// error for a server that failed.
pub(crate) fn compose_in_band_reply(
    message: Option<&RawValue>,
    handled: Result<Option<Box<RawValue>>, InProcessToolServerError>,
) -> Box<RawValue> {
    let error = match handled {
        Ok(Some(reply)) => return reply,
        Ok(None) => {
            return to_raw(&JsonRpcReply {
                jsonrpc: "2.0",
                id: None,
                result: Some(EmptyResult {}),
                error: None,
            });
        }
        Err(InProcessToolServerError::ServerNotFound { server_name }) => JsonRpcError {
            code: JsonRpcErrorCode::MethodNotFound.code(),
            message: format!("Server '{server_name}' not found"),
        },
        Err(InProcessToolServerError::Failed(cause)) => JsonRpcError {
            code: JsonRpcErrorCode::InternalError.code(),
            message: cause.to_string(),
        },
    };
    let id = message
        .and_then(|message| serde_json::from_str::<MessageId>(message.get()).ok())
        .and_then(|read| read.id);
    let null = RawValue::NULL;
    to_raw(&JsonRpcReply {
        jsonrpc: "2.0",
        id: Some(id.as_deref().unwrap_or(null)),
        result: None,
        error: Some(error),
    })
}

fn to_raw(reply: &JsonRpcReply<'_>) -> Box<RawValue> {
    serde_json::value::to_raw_value(reply)
        .expect("a reply of strings, numbers and relayed JSON always serializes")
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::value::RawValue;

    use super::{InProcessToolServerError, compose_in_band_reply};

    // Killed by answering a notification with an error, a failed server with `-32601`, or a
    // message with no id under any id but `null`.
    #[rstest]
    #[case::a_notification(
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        Ok(None),
        r#"{"jsonrpc":"2.0","result":{}}"#
    )]
    #[case::a_failed_server(
        r#"{"jsonrpc":"2.0","id":"call-1","method":"tools/call"}"#,
        Err(InProcessToolServerError::Failed("the server stopped".into())),
        r#"{"jsonrpc":"2.0","id":"call-1","error":{"code":-32603,"message":"the server stopped"}}"#,
    )]
    #[case::an_unknown_server_with_no_id(
        r#"{"jsonrpc":"2.0","method":"tools/list"}"#,
        Err(InProcessToolServerError::ServerNotFound { server_name: "elsewhere".to_owned() }),
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32601,"message":"Server 'elsewhere' not found"}}"#,
    )]
    fn each_unanswered_message_is_answered_in_band(
        #[case] message: &str,
        #[case] handled: Result<Option<Box<RawValue>>, InProcessToolServerError>,
        #[case] reply: &str,
    ) {
        let message = RawValue::from_string(message.to_owned()).expect("the message is JSON");

        assert_eq!(compose_in_band_reply(Some(&message), handled).get(), reply);
    }
}
