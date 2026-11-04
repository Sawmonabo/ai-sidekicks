//! The workflow step's tool call: a step calls a tool server's tool over its session's standing
//! connection through the daemon's one dispatch, and its end is written inline.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_workflow::engine::ports::PortError;
use sidekicks_workflow::engine::ports::tool_call::{StepToolCall, StepToolCallEnd, StepToolCaller};
use tokio::sync::watch;

use crate::client::McpClient;
use crate::client::dispatch::{McpCallCompletionError, McpToolDispatch, McpToolDispatchError};
use crate::client::tasks::{McpTaskContact, McpTaskDispatchIdentity, McpToolCall, McpToolCallEnd};

/// Calls the tools workflow steps call: each over its session's standing connection to the
/// server, through the daemon's one dispatch, its end written before it returns.
pub struct McpStepToolCaller {
    client: Arc<McpClient>,
    dispatch: Arc<McpToolDispatch>,
}

impl McpStepToolCaller {
    /// A caller reaching the servers through `client` and recording each call through `dispatch`.
    pub fn new(client: Arc<McpClient>, dispatch: Arc<McpToolDispatch>) -> Self {
        Self { client, dispatch }
    }

    /// Dispatches `call` and writes its end; a cancel before the call was sent ends it canceled,
    /// and the client's stop ends it stopping, writing nothing.
    async fn call(&self, call: StepToolCall) -> Result<StepToolCallEnd, PortError> {
        let StepToolCall {
            session_id,
            run_id,
            server,
            tool,
            arguments,
            command_id,
            cancel,
        } = call;
        let standing = self.client.standing_connection(session_id, &server);
        // No workflow surface shows a task's contact, so the call publishes into its own.
        let contact = watch::Sender::new(McpTaskContact::Reached);
        let tool_call = McpToolCall {
            dispatch: McpTaskDispatchIdentity {
                command_id,
                tool_name: tool.as_str().to_owned(),
            },
            arguments,
            run_id,
        };
        let dispatched = match self
            .dispatch
            .call(&standing, tool_call, &contact, &cancel)
            .await
        {
            Ok(dispatched) => dispatched,
            Err(McpToolDispatchError::Canceled) => return Ok(StepToolCallEnd::Canceled),
            Err(McpToolDispatchError::ClientStopping) => return Ok(StepToolCallEnd::Stopping),
            Err(error) => return Err(error.into()),
        };
        let (end, written) = dispatched.complete().await;
        match written {
            // The dispatch wrote the end itself at the session's close.
            Ok(()) | Err(McpCallCompletionError::Settled) => {}
            Err(McpCallCompletionError::ClientStopping) => return Ok(StepToolCallEnd::Stopping),
            Err(error) => return Err(error.into()),
        }
        Ok(end?.into())
    }
}

impl StepToolCaller for McpStepToolCaller {
    fn call_tool(&self, call: StepToolCall) -> BoxFuture<'_, Result<StepToolCallEnd, PortError>> {
        self.call(call).boxed()
    }
}

/// The step's end of a tool call's end: unknown when the session closed under the call, or the
/// server lost its task or the input it waited on.
impl From<McpToolCallEnd> for StepToolCallEnd {
    fn from(end: McpToolCallEnd) -> Self {
        match end {
            McpToolCallEnd::Answered { result } => Self::Answered { result },
            McpToolCallEnd::Failed { error } => Self::Failed { error },
            McpToolCallEnd::Canceled => Self::Canceled,
            McpToolCallEnd::TaskUnknown { .. }
            | McpToolCallEnd::ConnectionClosed
            | McpToolCallEnd::InputLost => Self::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_workflow::engine::ports::tool_call::{
        StepToolCall, StepToolCallEnd, StepToolCaller as _,
    };
    use tokio_util::sync::CancellationToken;

    use super::McpStepToolCaller;
    use crate::client::dispatch::tests::{Fixture, StoredReceipt, task_server};
    use crate::client::tasks::McpToolCallEnd;
    use crate::client::test_server::{
        Reply, method_not_found, text_result, tracked_end, v1_status_reply,
    };

    // Mutations: leave out the end's write; take the step's result from another arm; or map the
    // client's stop to an error.
    #[tokio::test(start_paused = true)]
    async fn a_steps_call_returns_the_answer_and_completes_its_receipt_and_a_stop_ends_it() {
        let fixture = Fixture::new().await;
        // Held, so the server answers for the whole call.
        let _connected = fixture
            .connect(task_server(|method, _| match method {
                "tasks/get" => v1_status_reply("completed"),
                "tasks/result" => Reply::Answer(json!({ "result": text_result("tracked") })),
                _ => method_not_found(),
            }))
            .await;
        let caller =
            McpStepToolCaller::new(Arc::clone(&fixture.client), Arc::clone(&fixture.dispatch));
        let step_call = |command_id: &str| StepToolCall {
            session_id: fixture.session_id,
            run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
            server: fixture.name.clone(),
            tool: FreeFormText::new("track".to_owned()).expect("a short tool name"),
            arguments: None,
            command_id: command_id.to_owned(),
            cancel: CancellationToken::new(),
        };

        let end = caller
            .call_tool(step_call("command-1"))
            .await
            .expect("the call ends");
        fixture.client.stop().await;
        let stopped = caller
            .call_tool(step_call("command-2"))
            .await
            .expect("a call the stop ends is no failure");

        let McpToolCallEnd::Answered { result } = tracked_end() else {
            panic!("the tracked end is an answer");
        };
        assert_eq!(end, StepToolCallEnd::Answered { result });
        assert_eq!(stopped, StepToolCallEnd::Stopping);
        assert_eq!(
            fixture.receipts(),
            [StoredReceipt {
                status: "completed".to_owned(),
                is_started: true,
                is_completed: true,
                task: ["task-1", "v1", "tracker", "stdio"].map(|column| Some(column.to_owned())),
            }]
        );
    }
}
