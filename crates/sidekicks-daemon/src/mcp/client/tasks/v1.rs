//! A task on a 2025-11-25 server: the call goes out task-augmented as the client's own
//! `tools/call`, and `tasks/get` and `tasks/result` are read from the raw copy, which keeps the
//! task's `ttl` and `pollInterval`. On `input_required` the client calls `tasks/result` at once,
//! whose stream carries the server's `elicitation/create` requests and ends with the result.

use serde_json::{Map, Value, json};

use crate::mcp::client::connection::{McpRequestError, McpServerConnection};
use crate::mcp::client::poll::{PollOutcome, PollStep, follow_task};
use crate::mcp::client::tasks::{
    McpTaskGeneration, McpTaskHandleSink, McpToolCall, McpToolCallEnd, McpToolCallError,
    extract_mcp_task_id, observe_mcp_task_acceptance,
};

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
) -> Result<McpToolCallEnd, McpToolCallError> {
    let mut params = json!({ "name": call.dispatch.tool_name, "task": {} });
    if let Some(arguments) = &call.arguments {
        params["arguments"] = Value::Object(arguments.clone());
    }
    let acceptance = connection.send_raw("tools/call", Some(params)).await?;
    let Some(mcp_task_id) = extract_mcp_task_id(&acceptance).map(str::to_owned) else {
        return Err(McpToolCallError::AcceptanceWithoutHandle);
    };
    observe_mcp_task_acceptance(
        sink,
        call.dispatch.clone(),
        McpTaskGeneration::V1,
        &mcp_task_id,
    )
    .await;
    let watch = connection
        .scope
        .task_watches
        .watch(&connection.scope, &call, &mcp_task_id);
    let outcome = follow_task(&watch.wake, || poll_once(connection, &mcp_task_id)).await;
    watch.finish().await;
    Ok(match outcome {
        PollOutcome::Ended(end) => end,
        PollOutcome::Halted => McpToolCallEnd::Halted { mcp_task_id },
    })
}

/// One poll: the task's status, and on `input_required` or a terminal status its result.
async fn poll_once(
    connection: &McpServerConnection,
    mcp_task_id: &str,
) -> Result<PollStep<McpToolCallEnd>, McpRequestError> {
    let reading = read_task(connection, mcp_task_id).await?;
    tracing::debug!(
        status = reading.status.as_str(),
        ttl_ms = reading.ttl_ms,
        poll_interval_ms = reading.poll_interval_ms,
        "a tool server task was polled"
    );
    match reading.status.as_str() {
        "cancelled" => Ok(PollStep::End(McpToolCallEnd::Canceled {})),
        "completed" | "failed" | "input_required" => read_result(connection, mcp_task_id)
            .await
            .map(PollStep::End),
        _ => Ok(PollStep::Wait {
            suggested_interval_ms: reading.poll_interval_ms,
        }),
    }
}

/// The task's `tasks/get` reply, read raw. Fails as the request fails or when the reply names no
/// status.
pub(super) async fn read_task(
    connection: &McpServerConnection,
    mcp_task_id: &str,
) -> Result<V1TaskReading, McpRequestError> {
    let reply = connection
        .send_raw("tasks/get", Some(json!({ "taskId": mcp_task_id })))
        .await?;
    let status = reply
        .get("status")
        .and_then(Value::as_str)
        .ok_or(McpRequestError::Malformed {
            method: "tasks/get",
        })?;
    Ok(V1TaskReading {
        status: status.to_owned(),
        ttl_ms: reply.get("ttl").and_then(Value::as_u64),
        poll_interval_ms: reply.get("pollInterval").and_then(Value::as_u64),
    })
}

/// The task's result through `tasks/result`, which the server holds until the task ends: the
/// tool's result, or the JSON-RPC error the task failed with.
async fn read_result(
    connection: &McpServerConnection,
    mcp_task_id: &str,
) -> Result<McpToolCallEnd, McpRequestError> {
    match connection
        .send_raw("tasks/result", Some(json!({ "taskId": mcp_task_id })))
        .await
    {
        Ok(result) => Ok(McpToolCallEnd::Answered { result }),
        Err(McpRequestError::Refused { code, message }) => Ok(McpToolCallEnd::Failed {
            error: Map::from_iter([
                ("code".to_owned(), Value::from(code)),
                ("message".to_owned(), Value::from(message)),
            ]),
        }),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use serde_json::{Value, json};
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use tokio::time::{Duration, Instant};

    use super::read_task;
    use crate::mcp::client::connection::McpServerConnection;
    use crate::mcp::client::tasks::{
        McpTaskDispatchIdentity, McpTaskGeneration, McpTaskHandleObservation, McpTaskHandleSink,
        McpToolCall, McpToolCallEnd,
    };
    use crate::mcp::client::test_server::{
        Responder, TestServer, open_test_server, test_client, v1_initialize_result,
    };

    /// A sink that keeps each handle with how many `tasks/get` the server had received by then.
    struct CountingSink {
        received: Arc<Mutex<Vec<(Instant, Value)>>>,
        recorded: Mutex<Vec<(usize, McpTaskHandleObservation)>>,
    }

    impl McpTaskHandleSink for CountingSink {
        fn record(&self, observation: McpTaskHandleObservation) -> BoxFuture<'_, ()> {
            let polls = self
                .received
                .lock()
                .expect("never poisoned")
                .iter()
                .filter(|(_, message)| message["method"] == "tasks/get")
                .count();
            self.recorded
                .lock()
                .expect("never poisoned")
                .push((polls, observation));
            async {}.boxed()
        }
    }

    /// A 2025-11-25 server whose `track` tool runs only as a task, answering `tasks/get` through
    /// `task_reading` with the poll's number.
    fn task_server(mut task_reading: impl FnMut(usize) -> Value + Send + 'static) -> Responder {
        let mut polls = 0;
        Box::new(move |method, _params| match method {
            "initialize" => json!({ "result": v1_initialize_result() }),
            "tools/list" => json!({ "result": { "tools": [{
                "name": "track",
                "inputSchema": { "type": "object" },
                "execution": { "taskSupport": "required" },
            }] } }),
            "tools/call" => json!({ "result": { "task": {
                "taskId": "task-1",
                "status": "working",
                "createdAt": "2026-10-24T12:00:00.000Z",
                "ttl": 60_000,
                "pollInterval": 5_000,
            } } }),
            "tasks/get" => {
                polls += 1;
                task_reading(polls)
            }
            "tasks/result" => json!({ "result": {
                "content": [{ "type": "text", "text": "tracked" }],
            } }),
            _ => json!({ "error": { "code": -32601, "message": "Method not found" } }),
        })
    }

    fn task_status(status: &str) -> Value {
        json!({ "result": {
            "taskId": "task-1",
            "status": status,
            "createdAt": "2026-10-24T12:00:00.000Z",
            "ttl": 60_000,
            "pollInterval": 5_000,
        } })
    }

    async fn call_track(
        connection: &McpServerConnection,
        server: &TestServer,
    ) -> (McpToolCallEnd, Vec<(usize, McpTaskHandleObservation)>) {
        let sink = CountingSink {
            received: Arc::clone(&server.received),
            recorded: Mutex::new(Vec::new()),
        };
        let call = McpToolCall {
            dispatch: McpTaskDispatchIdentity {
                command_id: "command-1".to_owned(),
                server_name: "tracker".to_owned(),
                tool_name: "track".to_owned(),
            },
            arguments: None,
            session_id: server.session_id,
            run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        };
        let end = connection
            .call_tool(call, &sink)
            .await
            .expect("the call ends");
        (end, sink.recorded.into_inner().expect("never poisoned"))
    }

    // Mutation: in `read_task`, read `ttl` from a missing member ("ttlMs"); or in `poll_once`,
    // pass `None` as the suggested interval, which polls at the 2 s default; or move
    // `observe_mcp_task_acceptance` after `follow_task`; or drop "input_required" from the arm
    // that reads the result.
    #[tokio::test(start_paused = true)]
    async fn a_2025_11_25_task_keeps_its_handle_ttl_and_interval_and_reads_its_result_on_input() {
        let client = test_client();
        let (connection, server) = open_test_server(
            &client,
            task_server(|poll| match poll {
                1 | 2 => task_status("working"),
                3 => task_status("input_required"),
                _ => json!({ "error": { "code": -32603, "message": "polled past its input" } }),
            }),
        )
        .await;

        let reading = read_task(&connection, "task-1")
            .await
            .expect("the task reads");
        assert_eq!(
            (reading.ttl_ms, reading.poll_interval_ms),
            (Some(60_000), Some(5_000))
        );

        let (end, recorded) = call_track(&connection, &server).await;
        assert_eq!(
            end,
            McpToolCallEnd::Answered {
                result: json!({ "content": [{ "type": "text", "text": "tracked" }] })
                    .as_object()
                    .expect("an object")
                    .clone(),
            }
        );
        let polls = server.requests("tasks/get");
        assert_eq!(polls.len(), 3, "one read before the call, then two polls");
        assert_eq!(
            recorded,
            vec![(
                1,
                McpTaskHandleObservation {
                    dispatch: McpTaskDispatchIdentity {
                        command_id: "command-1".to_owned(),
                        server_name: "tracker".to_owned(),
                        tool_name: "track".to_owned(),
                    },
                    mcp_task_id: "task-1".to_owned(),
                    mcp_task_generation: McpTaskGeneration::V1,
                }
            )],
            "the handle is recorded before the call's first poll"
        );
        assert!(
            polls[2].0 - polls[1].0 >= Duration::from_secs(5),
            "the second poll waits the server's interval"
        );
        assert_eq!(server.requests("tasks/result").len(), 1);
    }

    // Mutation: in `poll.rs`, raise `MAX_FAILED_POLLS` or reset the failure count on a failure.
    #[tokio::test(start_paused = true)]
    async fn five_failed_polls_in_a_row_halt_the_call_with_its_handle() {
        let client = test_client();
        let (connection, server) = open_test_server(
            &client,
            task_server(|_| json!({ "error": { "code": -32603, "message": "store offline" } })),
        )
        .await;

        let (end, recorded) = call_track(&connection, &server).await;

        assert_eq!(
            end,
            McpToolCallEnd::Halted {
                mcp_task_id: "task-1".to_owned()
            }
        );
        assert_eq!(server.requests("tasks/get").len(), 5);
        assert_eq!(recorded.len(), 1);
    }
}
