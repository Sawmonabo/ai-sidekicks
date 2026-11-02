//! A task on a 2025-11-25 server: the call goes out task-augmented as the client's own
//! `tools/call`, and `tasks/get` and `tasks/result` are read from the raw copy, which keeps the
//! task's `ttl` and `pollInterval`. On `input_required` the client holds `tasks/result` on the
//! side, whose stream carries the server's `elicitation/create` requests and ends with the result,
//! and keeps polling `tasks/get` meanwhile, so the task's contact is read from answered polls
//! however long the person takes.

use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use serde_json::{Value, json};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::{Notify, watch};
use tokio_util::task::AbortOnDropHandle;

use crate::client::connection::McpServerConnection;
use crate::client::poll::{PollStep, follow_task as poll_until_end};
use crate::client::requests::{McpRequestError, RequestWait, ServerRequests};
use crate::client::tasks::{
    McpTaskContact, McpTaskGeneration, McpTaskHandleSink, McpToolCall, McpToolCallEnd,
    McpToolCallError, extract_mcp_task_id, observe_mcp_task_acceptance,
};

/// A task's `tasks/result` held in a task of its own while the polls go on; dropped, it stops
/// waiting and the server is told the request is canceled.
type HeldResult = AbortOnDropHandle<Result<McpToolCallEnd, McpRequestError>>;

/// One `tasks/get` reply as a 2025-11-25 server sends it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct V1TaskReading {
    /// The task's status.
    pub(super) status: String,
    /// How long the server keeps the task from its creation, in milliseconds; `None` when it
    /// keeps it without limit.
    pub(super) ttl_ms: Option<u64>,
    /// The interval the server suggests between polls, in milliseconds.
    pub(super) poll_interval_ms: Option<u64>,
}

/// Calls `call`'s tool as a task and follows it to its end. Fails as the call fails or when the
/// acceptance names no task.
pub(super) async fn call_task_tool(
    connection: &McpServerConnection,
    call: McpToolCall,
    sink: &dyn McpTaskHandleSink,
    contact: &watch::Sender<McpTaskContact>,
) -> Result<McpToolCallEnd, McpToolCallError> {
    let mut params = json!({ "name": call.dispatch.tool_name, "task": {} });
    if let Some(arguments) = &call.arguments {
        params["arguments"] = Value::Object(arguments.clone());
    }
    let acceptance = connection
        .requests
        .send_raw("tools/call", Some(params), RequestWait::ToolCall)
        .await?;
    let Some(mcp_task_id) = extract_mcp_task_id(&acceptance).map(str::to_owned) else {
        return Err(McpToolCallError::AcceptanceWithoutHandle);
    };
    observe_mcp_task_acceptance(
        sink,
        connection,
        call.dispatch.clone(),
        McpTaskGeneration::V1,
        &mcp_task_id,
    )
    .await;
    Ok(follow_task(connection, &call, &mcp_task_id, contact).await)
}

/// Follows `call`'s task `mcp_task_id` to its end, its questions asked in the call's run.
pub(super) async fn follow_task(
    connection: &McpServerConnection,
    call: &McpToolCall,
    mcp_task_id: &str,
    contact: &watch::Sender<McpTaskContact>,
) -> McpToolCallEnd {
    let watch = connection
        .scope
        .task_watches
        .watch(&connection.scope, call, mcp_task_id);
    let held = Mutex::new(None);
    let end = poll_until_end(&watch.wake, contact, || {
        poll_once(connection, mcp_task_id, &watch.wake, &held)
    })
    .await;
    watch.finish().await;
    end
}

/// One poll: a held result that came back ends the call; else the task's status, which holds the
/// result on `input_required` and reads it at a terminal status.
async fn poll_once(
    connection: &McpServerConnection,
    mcp_task_id: &str,
    wake: &Arc<Notify>,
    held: &Mutex<Option<HeldResult>>,
) -> Result<PollStep<McpToolCallEnd>, McpRequestError> {
    if let Some(end) = take_held_end(connection, held) {
        return Ok(PollStep::End(end));
    }
    let reading = read_task(connection, mcp_task_id).await?;
    tracing::debug!(
        status = reading.status.as_str(),
        ttl_ms = reading.ttl_ms,
        poll_interval_ms = reading.poll_interval_ms,
        "a tool server task was polled"
    );
    match reading.status.as_str() {
        "cancelled" => Ok(PollStep::End(McpToolCallEnd::Canceled)),
        "completed" | "failed" => {
            if let Some(end) = take_held_end(connection, held) {
                return Ok(PollStep::End(end));
            }
            // A hold still waiting is dropped and the result read afresh.
            *lock(held) = None;
            read_result(&connection.requests, mcp_task_id, RequestWait::Ordinary)
                .await
                .map(PollStep::End)
        }
        status => {
            if status == "input_required" {
                lock(held).get_or_insert_with(|| hold_result(connection, mcp_task_id, wake));
            }
            Ok(PollStep::Wait {
                suggested_interval_ms: reading.poll_interval_ms,
            })
        }
    }
}

/// Holds the task's `tasks/result` in a task of its own, within the total bound alone, and wakes
/// the poll once it comes back.
fn hold_result(
    connection: &McpServerConnection,
    mcp_task_id: &str,
    wake: &Arc<Notify>,
) -> HeldResult {
    let requests = connection.requests.clone();
    let mcp_task_id = mcp_task_id.to_owned();
    let wake = Arc::clone(wake);
    AbortOnDropHandle::new(tokio::spawn(async move {
        let read = read_result(&requests, &mcp_task_id, RequestWait::HeldResult).await;
        wake.notify_one();
        read
    }))
}

/// The end the held result came back with, taking the hold; `None` while it waits or when there
/// is none, and when it failed, which is logged, so the next `input_required` holds it again.
fn take_held_end(
    connection: &McpServerConnection,
    held: &Mutex<Option<HeldResult>>,
) -> Option<McpToolCallEnd> {
    let mut held = lock(held);
    let came_back = held.as_mut()?.now_or_never()?;
    *held = None;
    let failed: Box<dyn Error + Send + Sync> = match came_back {
        Ok(Ok(end)) => return Some(end),
        Ok(Err(error)) => Box::new(error),
        Err(error) => Box::new(error),
    };
    tracing::warn!(
        error = &*failed as &(dyn Error + 'static),
        server = connection.scope.server_name.as_str(),
        "a tool server task's held result failed; it is held again at the task's next question"
    );
    None
}

/// The task's `tasks/get` reply, read raw. Fails as the request fails or when the reply names no
/// status.
pub(super) async fn read_task(
    connection: &McpServerConnection,
    mcp_task_id: &str,
) -> Result<V1TaskReading, McpRequestError> {
    let reply = connection
        .requests
        .send_raw(
            "tasks/get",
            Some(json!({ "taskId": mcp_task_id })),
            RequestWait::Ordinary,
        )
        .await?;
    let status =
        reply
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(|| McpRequestError::Malformed {
                method: "tasks/get".to_owned(),
            })?;
    Ok(V1TaskReading {
        status: status.to_owned(),
        ttl_ms: reply.get("ttl").and_then(Value::as_u64),
        poll_interval_ms: reply.get("pollInterval").and_then(Value::as_u64),
    })
}

/// The task's result through `tasks/result`, waiting within `wait`'s bound: the tool's result,
/// or the JSON-RPC error the task failed with.
async fn read_result(
    requests: &ServerRequests,
    mcp_task_id: &str,
    wait: RequestWait,
) -> Result<McpToolCallEnd, McpRequestError> {
    match requests
        .send_raw("tasks/result", Some(json!({ "taskId": mcp_task_id })), wait)
        .await
    {
        Ok(result) => Ok(McpToolCallEnd::Answered { result }),
        Err(McpRequestError::Refused { error, .. }) => Ok(McpToolCallEnd::Failed { error }),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests;
