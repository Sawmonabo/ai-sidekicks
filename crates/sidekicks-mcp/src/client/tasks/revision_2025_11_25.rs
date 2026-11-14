//! A task on a 2025-11-25 server: the call goes out task-augmented as the client's own
//! `tools/call`, and `tasks/get` and `tasks/result` are read from the raw copy, which keeps the
//! task's `ttl` and `pollInterval`. On `input_required` the client holds `tasks/result` on the
//! side, whose stream carries the server's `elicitation/create` requests and ends with the result,
//! and keeps polling `tasks/get` meanwhile, so the task's contact is read from answered polls
//! however long the person takes.
//!
//! A server that answers `tasks/result` with `-32601` before the task ends cannot give its result.
//!
//! A follow re-bound after its connection's close waits for the server to ask its question again
//! on the new connection: from the first answered poll that reads `input_required`, the server
//! has 300 s on the answered clock to ask. Past that, or once a poll reads another status, the
//! question kept for it is withdrawn and the contact reads that the server did not ask again where
//! the person's answer was kept; past the bound the task is also canceled, its end then lost. A
//! bound's cancel that fails lets the held `tasks/result` go and holds none until the cancel is
//! answered, sent again at each poll that reads `input_required`.
//!
//! A follow resumed after the daemon's restart, whose start withdrew the task's question, cancels
//! the task at the first answered poll that reads `input_required`, before any `tasks/result` is
//! held, so no question of a task about to end reaches the card. A failed cancel is sent again at
//! the next such poll, across a Reconnect too; a refused one, or another status first, leaves the
//! follow going on as a live one.

use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use rmcp::model::ErrorCode;
use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::{Notify, watch};
use tokio::time::Instant;
use tokio_util::task::AbortOnDropHandle;

use crate::client::connection::McpServerConnection;
use crate::client::poll::{
    AnsweredClock, PollError as _, PollFailure, PollStep, follow_task as poll_until_end,
};
use crate::client::requests::{McpRequestError, RequestWait, ServerRequests};
use crate::client::tasks::watches::TaskWatch;
use crate::client::tasks::{
    McpTaskCancelOutcome, McpTaskContact, McpTaskGeneration, McpTaskHandleSink, McpTaskResumption,
    McpToolCall, McpToolCallEnd, McpToolCallError, extract_mcp_task_id,
    observe_mcp_task_acceptance,
};

/// How long, on the answered clock, a re-bound task's server has to ask its question again once a
/// poll reads the task waiting on input.
const REASK_BOUND: Duration = Duration::from_secs(300);

/// A task's `tasks/result` held in a task of its own while the polls go on; dropped, it stops
/// waiting and the server is told the request is canceled.
type HeldResult = AbortOnDropHandle<Result<McpToolCallEnd, McpRequestError>>;

/// Where a re-bound follow's bound for the server's next ask stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReaskBound {
    /// No answered poll has read `input_required` since the re-bind.
    Unstarted,
    /// Running since this reading of the answered clock.
    Running {
        /// The answered clock's reading at the bound's start.
        started_at: Duration,
    },
    /// Ran out: the task's cancel is sent at each poll that reads `input_required` until the
    /// server answers it.
    RanOut,
    /// Done with: the server asked again, read another status or refused the cancel, or the
    /// follow was never re-bound.
    Spent,
}

/// What the cancel of a task waiting on input no question will answer came to.
enum WaitingTaskCancel {
    /// The task's end: lost once the server took the cancel, or read once after a `-32602`.
    Ended(McpToolCallEnd),
    /// The server cancels no task; the task runs on.
    Refused,
    /// The request failed otherwise, so the cancel is still owed.
    Failed(McpToolCallError),
}

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
    Ok(follow_task(connection, call.run_id, &mcp_task_id, None, contact).await)
}

/// Follows run `run_id`'s task `mcp_task_id` to its end, its questions asked in that run, as its
/// `resumption`, if any, says; a follow on a server at an address that its connection's close cut
/// leaves its watch to be re-bound, a re-bound one bounds the wait for the server's next ask, and
/// one resumed after a restart cancels a task it finds waiting on input.
pub(super) async fn follow_task(
    connection: &McpServerConnection,
    run_id: RunId,
    mcp_task_id: &str,
    resumption: Option<McpTaskResumption>,
    contact: &watch::Sender<McpTaskContact>,
) -> McpToolCallEnd {
    let watch =
        connection
            .scope
            .task_watches
            .watch(&connection.scope, run_id, mcp_task_id, contact);
    if resumption == Some(McpTaskResumption::AfterRestart) {
        watch.mark_restart_cancel_owed();
    }
    let held = Mutex::new(None);
    let bound = Mutex::new(ReaskBound::Unstarted);
    let end = poll_until_end(&watch.wake, &watch.contact, |answered| {
        poll_once(connection, mcp_task_id, &watch, &held, &bound, answered)
    })
    .await;
    watch.end(&end, connection.task_endpoint()).await;
    end
}

/// One poll, `answered` the answered clock as it starts: a held result that came back ends the
/// call; else the task's status, which settles a restarted follow's cancel and keeps a re-bound
/// follow's bound, holds the result on `input_required` and reads it at a terminal status.
async fn poll_once(
    connection: &McpServerConnection,
    mcp_task_id: &str,
    watch: &TaskWatch<'_>,
    held: &Mutex<Option<HeldResult>>,
    bound: &Mutex<ReaskBound>,
    answered: AnsweredClock,
) -> Result<PollStep, McpRequestError> {
    if let Some(end) = take_held_end(connection, held) {
        return Ok(PollStep::End(end));
    }
    let reading = read_task(connection, mcp_task_id).await?;
    let answered = answered.counted_at(Instant::now());
    tracing::debug!(
        status = reading.status.as_str(),
        ttl_ms = reading.ttl_ms,
        poll_interval_ms = reading.poll_interval_ms,
        "a tool server task was polled"
    );
    if let Some(step) = cancel_after_restart(connection, mcp_task_id, watch, bound, &reading).await
    {
        return Ok(step);
    }
    if let Some(step) = keep_reask_bound(
        connection,
        mcp_task_id,
        watch,
        held,
        bound,
        &reading,
        answered,
    )
    .await
    {
        return Ok(step);
    }
    let status = reading.status.as_str();
    if matches!(status, "completed" | "failed") {
        if let Some(end) = take_held_end(connection, held) {
            return Ok(PollStep::End(end));
        }
        // A hold still waiting is dropped and the result read afresh.
        *lock(held) = None;
    }
    if let Some(end) = read_terminal_end(connection, mcp_task_id, status).await {
        return end.map(PollStep::End);
    }
    if status == "input_required" {
        lock(held).get_or_insert_with(|| hold_result(connection, mcp_task_id, &watch.wake));
    }
    Ok(PollStep::Wait {
        suggested_interval_ms: reading.poll_interval_ms,
    })
}

/// Keeps the bound of a follow re-bound after its connection's close, from a poll that read
/// `reading` at `answered` on the answered clock. The bound starts at the first such poll that
/// reads `input_required` and is done with once the server asks again. A poll that reads another
/// status first withdraws the question kept for the ask; one past 300 s withdraws it too, writes
/// the contact `DidNotAskAgain` and cancels the task. Gives the step that cancel reads: the end,
/// `InputLost` once taken or one read of the task for a `-32602`; or, for a failed cancel, which
/// is logged, a wait with the result `held` let go and none held, the cancel sent again at the
/// next poll reading `input_required`. A refused cancel leaves the follow going on.
async fn keep_reask_bound(
    connection: &McpServerConnection,
    mcp_task_id: &str,
    watch: &TaskWatch<'_>,
    held: &Mutex<Option<HeldResult>>,
    bound: &Mutex<ReaskBound>,
    reading: &V1TaskReading,
    answered: Duration,
) -> Option<PollStep> {
    let is_waiting_on_input = reading.status == "input_required";
    let current = *lock(bound);
    let next = match current {
        ReaskBound::Spent => return None,
        ReaskBound::RanOut if is_waiting_on_input => ReaskBound::RanOut,
        ReaskBound::RanOut => ReaskBound::Spent,
        ReaskBound::Unstarted | ReaskBound::Running { .. } if !watch.is_awaiting_reask() => {
            ReaskBound::Spent
        }
        ReaskBound::Unstarted | ReaskBound::Running { .. } if !is_waiting_on_input => {
            // The server moved on before asking again.
            if watch.end_reask_wait().await {
                write_did_not_ask_again(watch, true);
            }
            ReaskBound::Spent
        }
        ReaskBound::Unstarted => ReaskBound::Running {
            started_at: answered,
        },
        ReaskBound::Running { started_at } if answered.saturating_sub(started_at) < REASK_BOUND => {
            current
        }
        ReaskBound::Running { .. } => {
            let has_undelivered_answer = watch.end_reask_wait().await;
            write_did_not_ask_again(watch, has_undelivered_answer);
            ReaskBound::RanOut
        }
    };
    *lock(bound) = next;
    if next != ReaskBound::RanOut {
        return None;
    }
    match cancel_waiting_task(connection, mcp_task_id).await {
        WaitingTaskCancel::Ended(end) => Some(PollStep::End(end)),
        WaitingTaskCancel::Refused => {
            *lock(bound) = ReaskBound::Spent;
            None
        }
        WaitingTaskCancel::Failed(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                server = connection.scope.server_name.as_str(),
                "a tool server task that did not ask again was not canceled; it is sent again"
            );
            // Let go, so no ask of a task owed a cancel reaches the card.
            *lock(held) = None;
            Some(PollStep::Wait {
                suggested_interval_ms: reading.poll_interval_ms,
            })
        }
    }
}

/// Cancels a task resumed after a restart once a poll reads it `input_required`, since the
/// question it waits on was withdrawn at the start, and gives the step the poll ends with: the end
/// the cancel reads, or a wait when the cancel failed, nothing held, so the next poll that reads
/// `input_required` sends it again. `None` once no cancel is owed: none was, the poll read another
/// status, or the server refused, which takes `CancelRefused` as the task's standing arm, no stop
/// having asked for it, unless a stop's refusal stands, and leaves the follow going on as a live
/// one.
async fn cancel_after_restart(
    connection: &McpServerConnection,
    mcp_task_id: &str,
    watch: &TaskWatch<'_>,
    bound: &Mutex<ReaskBound>,
    reading: &V1TaskReading,
) -> Option<PollStep> {
    if !watch.is_restart_cancel_owed() {
        return None;
    }
    let watches = &connection.scope.task_watches;
    if reading.status != "input_required" {
        // The task no longer waits on input.
        watches.settle_restart_cancel(&connection.scope, mcp_task_id);
        return None;
    }
    match cancel_waiting_task(connection, mcp_task_id).await {
        WaitingTaskCancel::Ended(end) => Some(PollStep::End(end)),
        WaitingTaskCancel::Refused => {
            watches.settle_restart_cancel(&connection.scope, mcp_task_id);
            // A re-bound follow's bound would cancel the task again.
            *lock(bound) = ReaskBound::Spent;
            watch.contact.write_standing(McpTaskContact::CancelRefused {
                is_from_stop: false,
            });
            None
        }
        WaitingTaskCancel::Failed(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                server = connection.scope.server_name.as_str(),
                "a resumed tool server task waiting on input was not canceled; it is sent again"
            );
            Some(PollStep::Wait {
                suggested_interval_ms: reading.poll_interval_ms,
            })
        }
    }
}

/// Cancels task `mcp_task_id`, which waits on input no question will answer: taken, its end is
/// lost; a `-32602`, for a task that ended meanwhile or that the server no longer knows, is
/// followed by one read of the task, its end lost when that gives none.
async fn cancel_waiting_task(
    connection: &McpServerConnection,
    mcp_task_id: &str,
) -> WaitingTaskCancel {
    match connection
        .cancel_task(McpTaskGeneration::V1, mcp_task_id)
        .await
    {
        Ok(McpTaskCancelOutcome::Taken) => WaitingTaskCancel::Ended(McpToolCallEnd::InputLost),
        Ok(McpTaskCancelOutcome::Refused) => WaitingTaskCancel::Refused,
        Err(error) if matches!(error.poll_failure(), PollFailure::TaskIdRejected { .. }) => {
            WaitingTaskCancel::Ended(
                connection
                    .read_task_end(McpTaskGeneration::V1, mcp_task_id)
                    .await
                    .unwrap_or(McpToolCallEnd::InputLost),
            )
        }
        Err(error) => WaitingTaskCancel::Failed(error),
    }
}

// Takes `DidNotAskAgain` as the task's standing arm, a kept answer undelivered as
// `has_undelivered_answer` says.
fn write_did_not_ask_again(watch: &TaskWatch<'_>, has_undelivered_answer: bool) {
    watch
        .contact
        .write_standing(McpTaskContact::DidNotAskAgain {
            has_undelivered_answer,
        });
}

/// The end of task `mcp_task_id` from one `tasks/get`, as its follow reads a terminal status;
/// `None` for any other status. Fails as either request fails.
pub(super) async fn read_task_end(
    connection: &McpServerConnection,
    mcp_task_id: &str,
) -> Result<Option<McpToolCallEnd>, McpRequestError> {
    let reading = read_task(connection, mcp_task_id).await?;
    read_terminal_end(connection, mcp_task_id, &reading.status)
        .await
        .transpose()
}

/// The end a terminal `status` of task `mcp_task_id` gives: canceled, or the result `tasks/result`
/// reads after `completed` or `failed`; `None` for a status that is not terminal.
async fn read_terminal_end(
    connection: &McpServerConnection,
    mcp_task_id: &str,
    status: &str,
) -> Option<Result<McpToolCallEnd, McpRequestError>> {
    match status {
        "cancelled" => Some(Ok(McpToolCallEnd::Canceled)),
        "completed" | "failed" => Some(
            read_result(
                &connection.requests,
                mcp_task_id,
                RequestWait::Ordinary,
                true,
            )
            .await,
        ),
        _ => None,
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
        let read = read_result(&requests, &mcp_task_id, RequestWait::HeldResult, false).await;
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

/// The task's result through `tasks/result`, waiting within `wait`'s bound, `has_ended` saying
/// whether a poll had read the task's terminal status: the tool's result, or the JSON-RPC error
/// the task failed with. Before the end, a `-32601` reads as the task's end being unknown.
async fn read_result(
    requests: &ServerRequests,
    mcp_task_id: &str,
    wait: RequestWait,
    has_ended: bool,
) -> Result<McpToolCallEnd, McpRequestError> {
    match requests
        .send_raw("tasks/result", Some(json!({ "taskId": mcp_task_id })), wait)
        .await
    {
        Ok(result) => Ok(McpToolCallEnd::Answered { result }),
        Err(McpRequestError::Refused { code, error })
            if !has_ended && code == i64::from(ErrorCode::METHOD_NOT_FOUND.0) =>
        {
            Ok(McpToolCallEnd::TaskUnknown { error })
        }
        Err(McpRequestError::Refused { error, .. }) => Ok(McpToolCallEnd::Failed { error }),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests;
