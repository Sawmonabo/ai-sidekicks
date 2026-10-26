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
use tokio::sync::{Notify, watch};
use tokio_util::task::AbortOnDropHandle;

use crate::mcp::client::connection::McpServerConnection;
use crate::mcp::client::poll::{PollStep, follow_task as poll_until_end};
use crate::mcp::client::requests::{McpRequestError, RequestWait, ServerRequests};
use crate::mcp::client::tasks::{
    McpTaskContact, McpTaskGeneration, McpTaskHandleSink, McpToolCall, McpToolCallEnd,
    McpToolCallError, extract_mcp_task_id, observe_mcp_task_acceptance,
};
use crate::mutex_lock::lock;

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
mod tests {
    use serde_json::{Value, json};
    use tokio::time::{Duration, Instant, timeout};

    use super::read_task;
    use crate::mcp::client::tasks::{
        McpTaskContact, McpTaskGeneration, McpTaskHandleObservation, McpToolCallEnd,
    };
    use crate::mcp::client::test_server::{
        CountingSink, Reply, Responder, board_accepted, board_answer, board_form, contact,
        method_not_found, open_test_server, test_client, text_result, track_call, track_dispatch,
        v1_initialize_result,
    };

    /// A 2025-11-25 server whose `track` tool runs only as a task `task-1`, answering `tasks/get`
    /// through `poll_reply` with the poll's number and `tasks/result` through `result_reply`.
    fn task_server(
        mut poll_reply: impl FnMut(usize) -> Reply + Send + 'static,
        mut result_reply: impl FnMut() -> Reply + Send + 'static,
    ) -> Responder {
        let mut polls = 0;
        Box::new(move |method, _params| match method {
            "initialize" => Reply::Answer(json!({ "result": v1_initialize_result() })),
            "tools/list" => Reply::Answer(json!({ "result": { "tools": [{
                "name": "track",
                "inputSchema": { "type": "object" },
                "execution": { "taskSupport": "required" },
            }] } })),
            "tools/call" => Reply::Answer(json!({ "result": { "task": task("working") } })),
            "tasks/get" => {
                polls += 1;
                poll_reply(polls)
            }
            "tasks/result" => result_reply(),
            "tasks/cancel" => Reply::Answer(json!({ "result": task("cancelled") })),
            _ => method_not_found(),
        })
    }

    fn task(status: &str) -> Value {
        json!({
            "taskId": "task-1",
            "status": status,
            "createdAt": "2026-10-24T12:00:00.000Z",
            "ttl": 60_000,
            "pollInterval": 5_000,
        })
    }

    fn status_reply(status: &str) -> Reply {
        Reply::Answer(json!({ "result": task(status) }))
    }

    // Mutations: in `read_task`, read `ttl` from a missing member ("ttlMs"), or pass `None` as
    // `poll_once`'s suggested interval, which polls at the 2 s default; move
    // `observe_mcp_task_acceptance` after `follow_task`; never hold the result on
    // "input_required"; or in `connection.rs`'s `create_elicitation`, read the task id from the
    // request's params instead of `context.meta`, which leaves the question unasked.
    #[tokio::test(start_paused = true)]
    async fn a_2025_11_25_task_keeps_its_handle_and_interval_and_asks_its_question_on_the_card() {
        let (client, card) = test_client();
        let (connection, server) = open_test_server(
            &client,
            task_server(
                |poll| match poll {
                    1 | 2 => status_reply("working"),
                    3 => status_reply("input_required"),
                    _ => Reply::Answer(json!({ "error": { "code": -32603, "message": "late" } })),
                },
                || {
                    let mut params = board_form();
                    params["_meta"] = json!({
                        "io.modelcontextprotocol/related-task": { "taskId": "task-1" },
                    });
                    Reply::AskFirst {
                        request: json!({ "method": "elicitation/create", "params": params }),
                        then: json!({ "result": text_result("tracked") }),
                    }
                },
            ),
        )
        .await;

        let reading = read_task(&connection, "task-1")
            .await
            .expect("the task reads");
        assert_eq!(
            (reading.ttl_ms, reading.poll_interval_ms),
            (Some(60_000), Some(5_000))
        );

        let call = track_call();
        let run_id = call.run_id;
        let sink = CountingSink::new(&server);
        let contact = contact();
        let (end, question) = tokio::join!(
            connection.call_tool(call, &sink, &contact),
            card.answer_open(board_answer()),
        );

        assert_eq!(
            end.expect("the call ends"),
            McpToolCallEnd::Answered {
                result: text_result("tracked")
                    .as_object()
                    .expect("an object")
                    .clone(),
            }
        );
        assert_eq!(card.taken().len(), 1, "the question is asked once");
        assert_eq!(
            (question.session_id, question.run_id),
            (server.session_id, run_id)
        );
        assert_eq!(
            server.answer_to("server-1").expect("the client answered")["result"],
            board_accepted()
        );
        let polls = server.requests("tasks/get");
        assert_eq!(polls.len(), 3, "one read before the call, then two polls");
        assert_eq!(
            sink.recorded(),
            vec![(
                1,
                McpTaskHandleObservation {
                    dispatch: track_dispatch(),
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

    // Mutations: in `poll.rs`'s `follow_task`, end the call after some failed polls; set `Lost`
    // before `CONTACT_LOST_AFTER`; or never set `Reached` again on an answered poll.
    #[tokio::test(start_paused = true)]
    async fn a_task_whose_server_stops_answering_reads_contact_lost_at_300_s_and_back_on_answer() {
        let (client, _card) = test_client();
        let (connection, server) = open_test_server(
            &client,
            task_server(
                |poll| match poll {
                    1..=8 => Reply::Silent,
                    9 => status_reply("working"),
                    _ => status_reply("completed"),
                },
                || Reply::Answer(json!({ "result": text_result("tracked") })),
            ),
        )
        .await;
        let sink = CountingSink::new(&server);
        let contact = contact();
        let mut seen = contact.subscribe();
        let started = Instant::now();
        let call = connection.call_tool(track_call(), &sink, &contact);
        tokio::pin!(call);

        // Bounded so a mutant that never reads lost fails here, not at the runner's kill.
        tokio::select! {
            _ = &mut call => panic!("the call ended while its server was silent"),
            changed = seen.wait_for(|state| *state == McpTaskContact::Lost) => {
                changed.expect("the state is kept");
            }
            () = tokio::time::sleep(Duration::from_secs(400)) => panic!("never lost"),
        }
        let lost_at = started.elapsed();
        assert!(
            server.requests("tasks/get").len() >= 5,
            "five unanswered polls keep polling"
        );
        assert!(
            lost_at >= Duration::from_secs(300) && lost_at < Duration::from_secs(400),
            "contact reads lost once 300 s pass with no answered poll, not at {lost_at:?}"
        );

        tokio::select! {
            _ = &mut call => panic!("the call ended before an answered poll cleared the state"),
            changed = seen.wait_for(|state| *state == McpTaskContact::Reached) => {
                changed.expect("the state is kept");
            }
            // The silent polls left, each waiting out its 60 s, come before the answered one.
            () = tokio::time::sleep(Duration::from_secs(600)) => panic!("never reached"),
        }
        assert_eq!(server.requests("tasks/get").len(), 9);
        let end = timeout(Duration::from_secs(60), call)
            .await
            .expect("the call ends at the next poll")
            .expect("the call ends");
        assert!(matches!(end, McpToolCallEnd::Answered { .. }));
    }

    /// A 2025-11-25 task waiting on input from its second poll, whose polls answer through
    /// `poll_reply` past that and whose first `tasks/result` asks the question, a later one
    /// answering at once.
    fn held_question_server(poll_reply: impl Fn(usize) -> Reply + Send + 'static) -> Responder {
        let mut results = 0;
        task_server(
            move |poll| match poll {
                1 => status_reply("working"),
                _ => poll_reply(poll),
            },
            move || {
                results += 1;
                if results > 1 {
                    return Reply::Answer(json!({ "result": text_result("tracked") }));
                }
                let mut params = board_form();
                params["_meta"] = json!({
                    "io.modelcontextprotocol/related-task": { "taskId": "task-1" },
                });
                Reply::AskFirst {
                    request: json!({ "method": "elicitation/create", "params": params }),
                    then: json!({ "result": text_result("tracked") }),
                }
            },
        )
    }

    // Mutations: in `hold_result`, hold the result under `RequestWait::ToolCall`, whose 30 min
    // idle window on stdio ends the hold, so the server is told it was canceled and asked for the
    // result again; or in `poll_once`, await the result in the "input_required" arm, which stops
    // the polls while the question waits.
    #[tokio::test(start_paused = true)]
    async fn a_task_whose_question_waits_31_minutes_keeps_one_held_result_and_its_contact() {
        let (client, card) = test_client();
        let (connection, server) = open_test_server(
            &client,
            held_question_server(|_| status_reply("input_required")),
        )
        .await;
        let sink = CountingSink::new(&server);
        let contact = contact();
        let mut seen = contact.subscribe();
        let call = connection.call_tool(track_call(), &sink, &contact);
        tokio::pin!(call);

        tokio::select! {
            _ = &mut call => panic!("the call ended while its question waited"),
            changed = seen.wait_for(|state| *state == McpTaskContact::Lost) => {
                changed.expect("the state is kept");
                panic!("the contact read lost while every poll was answered");
            }
            () = tokio::time::sleep(Duration::from_mins(31)) => {}
        }

        assert_eq!(card.taken().len(), 1, "the question is asked once");
        assert!(
            server.requests("tasks/get").len() > 300,
            "the task is polled at its 5 s interval while its result is held"
        );
        assert_eq!(
            server.requests("tasks/result").len(),
            1,
            "one result is held the whole time"
        );
        assert!(
            server.requests("notifications/cancelled").is_empty(),
            "the held result is never canceled"
        );
    }

    // Mutation: in `poll_once`, await the result in the "input_required" arm instead of holding
    // it on the side; no poll then runs while the question waits, and the contact never reads
    // lost.
    #[tokio::test(start_paused = true)]
    async fn a_task_holding_its_result_reads_contact_lost_when_its_polls_go_unanswered() {
        let (client, _card) = test_client();
        let (connection, server) = open_test_server(
            &client,
            held_question_server(|poll| match poll {
                2 | 3 | 11 => status_reply("input_required"),
                4..=10 => Reply::Silent,
                _ => status_reply("completed"),
            }),
        )
        .await;
        let sink = CountingSink::new(&server);
        let contact = contact();
        let mut seen = contact.subscribe();
        let started = Instant::now();
        let call = connection.call_tool(track_call(), &sink, &contact);
        tokio::pin!(call);

        tokio::select! {
            _ = &mut call => panic!("the call ended while its server was silent"),
            changed = seen.wait_for(|state| *state == McpTaskContact::Lost) => {
                changed.expect("the state is kept");
            }
            () = tokio::time::sleep(Duration::from_secs(400)) => panic!("never lost"),
        }
        let lost_at = started.elapsed();
        assert!(
            lost_at >= Duration::from_secs(300) && lost_at < Duration::from_secs(400),
            "contact reads lost once 300 s pass with no answered poll, not at {lost_at:?}"
        );
        tokio::select! {
            _ = &mut call => panic!("the call ended before an answered poll cleared the state"),
            changed = seen.wait_for(|state| *state == McpTaskContact::Reached) => {
                changed.expect("the state is kept");
            }
            () = tokio::time::sleep(Duration::from_secs(600)) => panic!("never reached"),
        }
        assert_eq!(server.requests("tasks/get").len(), 11);

        let end = timeout(Duration::from_secs(60), call)
            .await
            .expect("the call ends at the next poll")
            .expect("the call ends");
        assert!(matches!(end, McpToolCallEnd::Answered { .. }));
        assert_eq!(
            server.requests("tasks/result").len(),
            2,
            "the result still held at the end is dropped and read afresh"
        );
    }

    // Mutation: in `tasks.rs`'s `cancel_task`, send the cancel under another method or without
    // `taskId`; or in `poll_once`, poll on past "cancelled".
    #[tokio::test(start_paused = true)]
    async fn canceling_a_2025_11_25_task_sends_one_cancel_and_the_next_poll_ends_it() {
        let (client, _card) = test_client();
        let canceled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let is_canceled = std::sync::Arc::clone(&canceled);
        let (connection, server) = open_test_server(
            &client,
            task_server(
                move |_| {
                    if is_canceled.load(std::sync::atomic::Ordering::SeqCst) {
                        status_reply("cancelled")
                    } else {
                        status_reply("working")
                    }
                },
                || Reply::Answer(json!({ "error": { "code": -32603, "message": "unasked" } })),
            ),
        )
        .await;
        let sink = CountingSink::new(&server);
        let contact = contact();
        let cancel = async {
            timeout(Duration::from_secs(60), async {
                while sink.recorded().is_empty() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the handle is recorded");
            canceled.store(true, std::sync::atomic::Ordering::SeqCst);
            connection
                .cancel_task(McpTaskGeneration::V1, "task-1")
                .await
                .expect("the server takes the cancel");
        };
        let (end, ()) = tokio::join!(connection.call_tool(track_call(), &sink, &contact), cancel);

        assert_eq!(end.expect("the call ends"), McpToolCallEnd::Canceled);
        let cancels = server.requests("tasks/cancel");
        assert_eq!(cancels.len(), 1);
        assert_eq!(cancels[0].1["params"]["taskId"], "task-1");
        let polls = server.requests("tasks/get");
        assert!(
            polls.last().expect("a poll").0 >= cancels[0].0,
            "the poll that reads the cancel comes after it"
        );
        let polls_after_cancel = polls.iter().filter(|(at, _)| *at >= cancels[0].0).count();
        assert_eq!(
            polls_after_cancel, 1,
            "no poll follows the one reading the end"
        );
        assert_eq!(
            server.requests("tasks/result").len(),
            0,
            "a canceled task has no result"
        );
    }

    /// A 2025-11-25 task whose second poll waits on input, which its `tasks/result` asks for.
    fn asking_task_server() -> Responder {
        task_server(
            |poll| match poll {
                1 => status_reply("working"),
                _ => status_reply("input_required"),
            },
            || {
                let mut params = board_form();
                params["_meta"] = json!({
                    "io.modelcontextprotocol/related-task": { "taskId": "task-1" },
                });
                Reply::AskFirst {
                    request: json!({ "method": "elicitation/create", "params": params }),
                    then: json!({ "result": text_result("tracked") }),
                }
            },
        )
    }

    // Mutation: in `tasks.rs`'s `watch_key`, leave out the session; the second watch then
    // replaces the first and one session's question goes out under the other's run.
    #[tokio::test(start_paused = true)]
    async fn two_sessions_whose_servers_mint_the_same_task_id_each_ask_their_own_question() {
        let (client, card) = test_client();
        let (first, first_server) = open_test_server(&client, asking_task_server()).await;
        let (second, second_server) = open_test_server(&client, asking_task_server()).await;
        let (first_call, second_call) = (track_call(), track_call());
        let expected = [
            (first_server.session_id, first_call.run_id),
            (second_server.session_id, second_call.run_id),
        ];
        let (first_sink, second_sink) = (
            CountingSink::new(&first_server),
            CountingSink::new(&second_server),
        );
        let (first_contact, second_contact) = (contact(), contact());
        let person = async {
            let one = card.answer_open(board_answer()).await;
            let other = card.answer_open(board_answer()).await;
            [one, other]
        };

        let (first_end, second_end, questions) = tokio::join!(
            first.call_tool(first_call, &first_sink, &first_contact),
            second.call_tool(second_call, &second_sink, &second_contact),
            person,
        );

        assert!(matches!(
            first_end.expect("the first call ends"),
            McpToolCallEnd::Answered { .. }
        ));
        assert!(matches!(
            second_end.expect("the second call ends"),
            McpToolCallEnd::Answered { .. }
        ));
        let mut asked: Vec<_> = questions
            .iter()
            .map(|question| (question.session_id, question.run_id))
            .collect();
        asked.sort_by_key(|(session_id, _)| *session_id == expected[1].0);
        assert_eq!(
            asked, expected,
            "each question carries its own session's run"
        );
        for server in [&first_server, &second_server] {
            assert_eq!(
                server.answer_to("server-1").expect("the client answered")["result"],
                board_accepted()
            );
        }
    }

    // Mutation: in `poll.rs`'s `follow_task`, poll at once when woken instead of waiting out
    // `MIN_POLL_INTERVAL` from the last poll.
    #[tokio::test(start_paused = true)]
    async fn a_server_flooding_status_notifications_is_polled_no_more_often_than_250_ms() {
        let (client, _card) = test_client();
        let (connection, server) = open_test_server(
            &client,
            task_server(
                |poll| match poll {
                    1..=4 => status_reply("working"),
                    _ => status_reply("completed"),
                },
                || Reply::Answer(json!({ "result": text_result("tracked") })),
            ),
        )
        .await;
        let sink = CountingSink::new(&server);
        let contact = contact();
        let status = json!({
            "jsonrpc": "2.0",
            "method": "notifications/tasks/status",
            "params": { "taskId": "task-1", "status": "working" },
        })
        .to_string();
        let flood = async {
            loop {
                if server.unasked.send(status.clone()).is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };

        let call = timeout(
            Duration::from_secs(60),
            connection.call_tool(track_call(), &sink, &contact),
        );
        let end = tokio::select! {
            end = call => end,
            () = flood => panic!("the server stopped"),
        };

        assert!(matches!(
            end.expect("the call ends").expect("the call ends"),
            McpToolCallEnd::Answered { .. }
        ));
        let polls = server.requests("tasks/get");
        assert_eq!(polls.len(), 5);
        for pair in polls.windows(2) {
            let gap = pair[1].0 - pair[0].0;
            assert!(
                gap >= Duration::from_millis(250) && gap < Duration::from_secs(5),
                "a woken poll waits 250 ms from the last, not {gap:?}"
            );
        }
    }

    // Mutations: in `TaskWatch`'s drop, forget the task without withdrawing its questions; or
    // in `connection.rs`'s `create_elicitation`, ignore `context.ct`, or in `AwaitedQuestion`'s
    // drop, withdraw nothing. Either way the question stays open on the card.
    #[rstest::rstest]
    #[case::the_call_is_dropped(false)]
    #[case::the_server_cancels_its_request(true)]
    #[tokio::test(start_paused = true)]
    async fn a_task_question_nobody_waits_on_is_withdrawn_from_the_card(
        #[case] is_canceled_by_the_server: bool,
    ) {
        let (client, card) = test_client();
        let (connection, server) = open_test_server(&client, asking_task_server()).await;
        let sink = CountingSink::new(&server);
        let contact = contact();
        let mut call = Box::pin(connection.call_tool(track_call(), &sink, &contact));

        tokio::select! {
            _ = &mut call => panic!("the call ended before its question was asked"),
            () = card.wait_until_taken(1) => {}
        }
        if is_canceled_by_the_server {
            let canceled = json!({
                "jsonrpc": "2.0",
                "method": "notifications/cancelled",
                "params": { "requestId": "server-1" },
            });
            server
                .unasked
                .send(canceled.to_string())
                .expect("the server is running");
            tokio::select! {
                _ = &mut call => {}
                () = card.wait_until_none_open() => {}
                () = tokio::time::sleep(Duration::from_secs(5)) => {}
            }
        } else {
            drop(call);
        }

        card.wait_until_none_open().await;
    }

    // Mutation: in `read_result`, rebuild the failure from the error's code and message alone,
    // which drops its `data`.
    #[tokio::test(start_paused = true)]
    async fn a_failed_2025_11_25_task_keeps_its_whole_error() {
        let (client, _card) = test_client();
        let error = json!({ "code": -32603, "message": "quota", "data": { "retryAfterMs": 500 } });
        let reply = json!({ "error": error.clone() });
        let (connection, server) = open_test_server(
            &client,
            task_server(
                |_| status_reply("failed"),
                move || Reply::Answer(reply.clone()),
            ),
        )
        .await;
        let sink = CountingSink::new(&server);

        let end = connection
            .call_tool(track_call(), &sink, &contact())
            .await
            .expect("the call ends");

        assert_eq!(
            end,
            McpToolCallEnd::Failed {
                error: error.as_object().expect("an object").clone(),
            }
        );
    }
}
