//! The messages Claude Code sends the session's in-process tool servers as `mcp_message`
//! requests: each is handed to its server on a task of its own and answered in band once the
//! server replies, so a failed or unknown server fails only that message; a withdrawn call is
//! cancelled and never answered. The servers' own messages go back as outbound `mcp_message`
//! requests.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use tokio::task::AbortHandle;

use crate::provider::driver::claude::hooks::callbacks::answer_claude_request;
use crate::provider::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::provider::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::provider::driver::claude::session::transport::inbound::{
    ClaudeMcpMessage, ClaudeMcpMessageAnswer,
};
use crate::provider::port::in_process_tool_servers::{
    InProcessToolServerError, InProcessToolServerOutbound, InProcessToolServers,
    compose_in_band_reply,
};

/// One process's in-process tool-server calls still running, by the request id each answers.
#[derive(Clone, Default)]
pub(crate) struct ClaudeToolServerCalls {
    running: Arc<Mutex<HashMap<String, AbortHandle>>>,
}

/// Who one call is for, and the channel its answer goes back on.
pub(crate) struct ClaudeToolServerCallContext {
    /// The session whose servers take the call.
    pub(crate) session_id: SessionId,
    /// The account the process runs on, named if the answer cannot be written.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The process the call came from.
    pub(crate) channel: Arc<dyn ClaudeProcessChannel>,
    /// The servers, once the tool-server front registered them; without them every server is
    /// unknown, as `initialize` named none.
    pub(crate) servers: Option<Arc<dyn InProcessToolServers>>,
}

impl ClaudeToolServerCalls {
    /// Hands `message`, the `mcp_message` request `request_id`, to its server on a task of its
    /// own, and answers it in band with the server's reply once it comes.
    pub(crate) fn start(
        &self,
        context: ClaudeToolServerCallContext,
        request_id: String,
        message: ClaudeMcpMessage,
    ) {
        let calls = self.clone();
        let answered_id = request_id.clone();
        // The entry is written under the same lock the task's removal takes, so a call that ends
        // at once never leaves its handle behind.
        let mut running = self.lock();
        let task = tokio::spawn(async move {
            let reply = call_server(&context, message).await;
            let answer = ClaudeMcpMessageAnswer {
                mcp_response: reply,
            };
            calls.lock().remove(&answered_id);
            answer_claude_request(
                &*context.channel,
                &context.session_id,
                context.provider_account_id.as_ref(),
                answered_id,
                &answer,
            )
            .await;
        });
        running.insert(request_id, task.abort_handle());
    }

    /// Cancels the running call `request_id`, which Claude Code withdrew, and writes no answer
    /// for it; answers whether one was running.
    pub(crate) fn cancel(&self, request_id: &str) -> bool {
        self.lock()
            .remove(request_id)
            .inspect(AbortHandle::abort)
            .is_some()
    }

    /// Cancels every running call, as the process exited.
    pub(crate) fn cancel_all(&self) {
        for (_, call) in self.lock().drain() {
            call.abort();
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, AbortHandle>> {
        self.running
            .lock()
            .expect("the calls' lock is never held across a panic")
    }
}

// The reply to one message, in band whatever became of it.
async fn call_server(
    context: &ClaudeToolServerCallContext,
    message: ClaudeMcpMessage,
) -> Box<RawValue> {
    // A message that names no server, or carries none, is answered as one to a server the
    // session lacks, echoing the message's id where it has one.
    let unnamed = || InProcessToolServerError::ServerNotFound {
        server_name: String::new(),
    };
    let Some(sent) = message.message else {
        return compose_in_band_reply(None, Err(unnamed()));
    };
    let Some(server_name) = message.server_name else {
        return compose_in_band_reply(Some(&sent), Err(unnamed()));
    };
    let handled = match &context.servers {
        Some(servers) => {
            let outbound = Arc::new(ClaudeToolServerOutbound {
                channel: Arc::clone(&context.channel),
            });
            servers
                .handle(context.session_id, server_name, sent.clone(), outbound)
                .await
        }
        None => Err(InProcessToolServerError::ServerNotFound { server_name }),
    };
    compose_in_band_reply(Some(&sent), handled)
}

// A server's own messages, sent to Claude Code as outbound `mcp_message` requests.
struct ClaudeToolServerOutbound {
    #[expect(
        dead_code,
        reason = "the tool-server front sends each server's own messages through it"
    )]
    channel: Arc<dyn ClaudeProcessChannel>,
}

impl InProcessToolServerOutbound for ClaudeToolServerOutbound {
    fn send(
        &self,
        server_name: String,
        message: Box<RawValue>,
    ) -> BoxFuture<'_, Result<(), InProcessToolServerError>> {
        self.channel
            .send_control_request(ClaudeControlRequest::McpMessage {
                server_name,
                message,
            })
            .map(|sent| {
                sent.map(drop)
                    .map_err(|error| InProcessToolServerError::Failed(Box::new(error)))
            })
            .boxed()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use futures::FutureExt;
    use futures::future::BoxFuture;
    use serde_json::value::RawValue;
    use sidekicks_contracts::session::id::SessionId;

    use super::{ClaudeToolServerCallContext, ClaudeToolServerCalls};
    use crate::provider::driver::claude::session::transport::channel::MockClaudeProcessChannel;
    use crate::provider::driver::claude::session::transport::inbound::ClaudeMcpMessage;
    use crate::provider::driver::claude::session::transport::user_message::ClaudeWriteAttempt;
    use crate::provider::port::in_process_tool_servers::{
        InProcessToolServerError, InProcessToolServerOutbound, InProcessToolServers,
    };

    type Answers = Arc<Mutex<Vec<(String, String)>>>;

    // A server that answers each message with `reply`, keeping what it was handed; with no reply
    // it never answers, and records when its call is dropped.
    struct Server {
        reply: Option<&'static str>,
        handed: Arc<Mutex<Vec<(String, String)>>>,
        dropped: Arc<Mutex<bool>>,
    }

    struct DropMark(Arc<Mutex<bool>>);

    impl Drop for DropMark {
        fn drop(&mut self) {
            *self
                .0
                .lock()
                .expect("the test's lock is never held across a panic") = true;
        }
    }

    impl InProcessToolServers for Server {
        fn server_names(&self, _session_id: &SessionId) -> Vec<String> {
            vec!["sidekicks".to_owned()]
        }

        fn handle(
            &self,
            _session_id: SessionId,
            server_name: String,
            message: Box<RawValue>,
            _outbound: Arc<dyn InProcessToolServerOutbound>,
        ) -> BoxFuture<'static, Result<Option<Box<RawValue>>, InProcessToolServerError>> {
            if server_name != "sidekicks" {
                return async move { Err(InProcessToolServerError::ServerNotFound { server_name }) }
                    .boxed();
            }
            self.handed
                .lock()
                .expect("the test's lock is never held across a panic")
                .push((server_name, message.get().to_owned()));
            let reply = self.reply;
            let mark = DropMark(Arc::clone(&self.dropped));
            async move {
                let _mark = mark;
                match reply {
                    Some(reply) => Ok(Some(
                        RawValue::from_string(reply.to_owned()).expect("the reply is JSON"),
                    )),
                    None => std::future::pending().await,
                }
            }
            .boxed()
        }
    }

    fn server(reply: Option<&'static str>) -> Arc<Server> {
        Arc::new(Server {
            reply,
            handed: Arc::default(),
            dropped: Arc::default(),
        })
    }

    fn context(
        answers: &Answers,
        servers: Option<Arc<dyn InProcessToolServers>>,
    ) -> ClaudeToolServerCallContext {
        let mut channel = MockClaudeProcessChannel::new();
        let sink = Arc::clone(answers);
        channel
            .expect_answer_inbound_request()
            .returning(move |request_id, answer| {
                sink.lock()
                    .expect("the test's lock is never held across a panic")
                    .push((request_id, answer.get().to_owned()));
                async { ClaudeWriteAttempt::Written }.boxed()
            });
        ClaudeToolServerCallContext {
            session_id: SessionId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5d")
                .expect("a valid session id"),
            provider_account_id: None,
            channel: Arc::new(channel),
            servers,
        }
    }

    fn message(server_name: &str, message: &str) -> ClaudeMcpMessage {
        serde_json::from_str(&format!(
            r#"{{"server_name":"{server_name}","message":{message}}}"#
        ))
        .expect("the request's members read")
    }

    async fn settle_tasks() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    // Killed by answering an unknown server with a control error, which ends Claude Code's MCP
    // client, rather than a success holding the JSON-RPC error with the message's id.
    #[tokio::test]
    async fn a_message_to_an_unknown_server_is_answered_in_band_with_its_id() {
        let answers = Answers::default();
        let calls = ClaudeToolServerCalls::default();
        calls.start(
            context(&answers, Some(server(None))),
            "7".to_owned(),
            message(
                "elsewhere",
                r#"{"jsonrpc":"2.0","id":5,"method":"tools/list"}"#,
            ),
        );
        settle_tasks().await;
        assert_eq!(
            *answers.lock().expect("the test's lock is never held across a panic"),
            vec![(
                "7".to_owned(),
                r#"{"mcp_response":{"jsonrpc":"2.0","id":5,"error":{"code":-32601,"message":"Server 'elsewhere' not found"}}}"#
                    .to_owned()
            )]
        );
    }

    // Killed by a dropped call, and by answering under another member than `mcp_response`.
    #[tokio::test]
    async fn a_message_reaches_its_server_and_the_reply_goes_back_under_mcp_response() {
        let answers = Answers::default();
        let server = server(Some(r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#));
        let calls = ClaudeToolServerCalls::default();
        calls.start(
            context(
                &answers,
                Some(Arc::clone(&server) as Arc<dyn InProcessToolServers>),
            ),
            "3".to_owned(),
            message(
                "sidekicks",
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
            ),
        );
        settle_tasks().await;
        assert_eq!(
            *server
                .handed
                .lock()
                .expect("the test's lock is never held across a panic"),
            vec![(
                "sidekicks".to_owned(),
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.to_owned()
            )]
        );
        assert_eq!(
            *answers
                .lock()
                .expect("the test's lock is never held across a panic"),
            vec![(
                "3".to_owned(),
                r#"{"mcp_response":{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}}"#.to_owned()
            )]
        );
    }

    // Killed by answering a withdrawn call when its server replies late, and by leaving the
    // server's call running after the withdrawal.
    #[tokio::test(start_paused = true)]
    async fn a_withdrawn_call_is_cancelled_and_never_answered() {
        let answers = Answers::default();
        let server = server(None);
        let calls = ClaudeToolServerCalls::default();
        calls.start(
            context(
                &answers,
                Some(Arc::clone(&server) as Arc<dyn InProcessToolServers>),
            ),
            "4".to_owned(),
            message(
                "sidekicks",
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/call"}"#,
            ),
        );
        settle_tasks().await;
        assert!(calls.cancel("4"), "the call was running");
        tokio::time::sleep(Duration::from_secs(60)).await;
        settle_tasks().await;
        assert!(
            *server
                .dropped
                .lock()
                .expect("the test's lock is never held across a panic")
        );
        assert!(
            answers
                .lock()
                .expect("the test's lock is never held across a panic")
                .is_empty()
        );
        assert!(!calls.cancel("4"), "a cancelled call is gone");
    }
}
