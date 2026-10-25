//! A call to a 2026-07-28 server, or to any server that offers no 2025-11-25 task for the tool,
//! through rmcp's own types: the server answers a result or a task, and a task is polled with
//! `tasks/get` until its result arrives inline. Each new `inputRequests` entry that is an
//! elicitation is asked on the questions card and answered with `tasks/update`.

use std::collections::{BTreeMap, HashSet};
use std::error::Error;
use std::sync::Mutex;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, GetTaskParams, InputRequest, TaskPayload,
    UpdateTaskParams,
};
use rmcp::{Peer, RoleClient};
use serde_json::{Value, json};
use sidekicks_contracts::question::QuestionAnswer;

use crate::mcp::client::connection::McpServerConnection;
use crate::mcp::client::poll::{PollOutcome, PollStep, follow_task};
use crate::mcp::client::tasks::{
    McpTaskGeneration, McpTaskHandleSink, McpToolCall, McpToolCallEnd, McpToolCallError,
    observe_mcp_task_acceptance,
};
use crate::mcp::elicitation_form::compose_elicitation_content;
use crate::provider::port::question::ToolServerQuestionAnswer;

/// Calls `call`'s tool, following a task to its end. Fails as the call fails, when the server
/// asks for input before accepting the call, or answers another request's result.
pub(super) async fn call_tool(
    connection: &McpServerConnection,
    call: McpToolCall,
    sink: &dyn McpTaskHandleSink,
) -> Result<McpToolCallEnd, McpToolCallError> {
    let mut params = CallToolRequestParams::new(call.dispatch.tool_name.clone());
    params.arguments.clone_from(&call.arguments);
    let response = connection
        .peer()
        .call_tool_once(params)
        .await
        .map_err(McpToolCallError::Service)?;
    let created = match response {
        CallToolResponse::Task(created) => created,
        CallToolResponse::Complete(result) => {
            let Value::Object(result) = serde_json::to_value(result)
                .map_err(|_unwritable| McpToolCallError::UnexpectedResult)?
            else {
                return Err(McpToolCallError::UnexpectedResult);
            };
            return Ok(McpToolCallEnd::Answered { result });
        }
        CallToolResponse::InputRequired(_) => {
            return Err(McpToolCallError::InputRequiredBeforeTask);
        }
        _ => return Err(McpToolCallError::UnexpectedResult),
    };
    let mcp_task_id = created.task.task_id;
    if mcp_task_id.is_empty() {
        return Err(McpToolCallError::AcceptanceWithoutHandle);
    }
    observe_mcp_task_acceptance(
        sink,
        call.dispatch.clone(),
        McpTaskGeneration::V2,
        &mcp_task_id,
    )
    .await;
    let watch = connection
        .scope
        .task_watches
        .watch(&connection.scope, &call, &mcp_task_id);
    let asked = Mutex::new(HashSet::new());
    let outcome = follow_task(&watch.wake, || poll_once(connection, &mcp_task_id, &asked)).await;
    watch.finish().await;
    Ok(match outcome {
        PollOutcome::Ended(end) => end,
        PollOutcome::Halted => McpToolCallEnd::Halted { mcp_task_id },
    })
}

/// One poll: the task's state, asking each input request not asked before.
#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "rmcp marks the task payload non-exhaustive, so its states cannot all be named"
)]
async fn poll_once(
    connection: &McpServerConnection,
    mcp_task_id: &str,
    asked: &Mutex<HashSet<String>>,
) -> Result<PollStep<McpToolCallEnd>, rmcp::service::ServiceError> {
    let reply = connection
        .peer()
        .get_task(GetTaskParams::new(mcp_task_id))
        .await?;
    let suggested_interval_ms = reply.task.task.poll_interval_ms;
    match reply.task.payload {
        TaskPayload::Completed { result } => Ok(PollStep::End(McpToolCallEnd::Answered { result })),
        TaskPayload::Failed { error } => Ok(PollStep::End(McpToolCallEnd::Failed { error })),
        TaskPayload::Cancelled => Ok(PollStep::End(McpToolCallEnd::Canceled {})),
        TaskPayload::InputRequired { input_requests } => {
            for (key, request) in input_requests {
                let is_new = asked
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(key.clone());
                if is_new {
                    ask_input_request(connection, mcp_task_id, key, request).await;
                }
            }
            Ok(PollStep::Wait {
                suggested_interval_ms,
            })
        }
        // `working`, and any state a later rmcp adds to its open set, waits for the next poll.
        _ => Ok(PollStep::Wait {
            suggested_interval_ms,
        }),
    }
}

/// Asks one input request on the questions card: an elicitation's form. A sampling or roots
/// request, which the client never declared it takes, is logged and left outstanding.
async fn ask_input_request(
    connection: &McpServerConnection,
    mcp_task_id: &str,
    key: String,
    request: InputRequest,
) {
    let InputRequest::Elicitation(elicitation) = request else {
        tracing::warn!(
            server = connection.scope.server_name.as_str(),
            "a tool server task asked for input the client does not take"
        );
        return;
    };
    let params = match serde_json::to_value(&elicitation.params) {
        Ok(params) => params,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a tool server task's question could not be read"
            );
            return;
        }
    };
    let answer = std::sync::Arc::new(V2TaskAnswer {
        peer: connection.peer().clone(),
        mcp_task_id: mcp_task_id.to_owned(),
        key,
        params: params.clone(),
    });
    connection
        .scope
        .task_watches
        .ask(&connection.scope, mcp_task_id, &params, answer)
        .await;
}

/// The answer to one input request of a 2026-07-28 task, sent as `tasks/update`.
struct V2TaskAnswer {
    peer: Peer<RoleClient>,
    mcp_task_id: String,
    key: String,
    params: Value,
}

impl ToolServerQuestionAnswer for V2TaskAnswer {
    fn answer(
        &self,
        answers: Vec<QuestionAnswer>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        let content = compose_elicitation_content(&self.params, &answers);
        let response = json!({ "action": "accept", "content": Value::Object(content) });
        let mut params = UpdateTaskParams::new(self.mcp_task_id.clone(), BTreeMap::default());
        params.input_responses.insert(self.key.clone(), response);
        async move {
            self.peer
                .update_task(params)
                .await
                .map_err(|error| Box::new(error) as Box<dyn Error + Send + Sync>)
        }
        .boxed()
    }
}
