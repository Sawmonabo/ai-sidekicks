use serde_json::{Map, Value, json};
use sidekicks_provider::port::question::{
    QuestionPort as _, is_tool_server_request_id, mint_tool_server_request_id,
};
use tokio::time::{Duration, Instant, timeout};

use super::read_task;
use crate::client::tasks::watches::answers::ElicitationAnswer;
use crate::client::tasks::watches::compose_question;
use crate::client::tasks::{
    McpTaskCancelOutcome, McpTaskContact, McpTaskGeneration, McpToolCallEnd,
};
use crate::client::test_server::{
    CountingSink, Reply, Responder, board_accepted, board_answer, board_form,
    call_tool_as_dispatched, contact, method_not_found, open_test_server, test_client, text_result,
    track_call, track_task_handle, tracked_end, v1_initialize_result, v1_status_reply, v1_task,
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
        "tools/call" => Reply::Answer(json!({ "result": { "task": v1_task("working") } })),
        "tasks/get" => {
            polls += 1;
            poll_reply(polls)
        }
        "tasks/result" => result_reply(),
        "tasks/cancel" => Reply::Answer(json!({ "result": v1_task("cancelled") })),
        _ => method_not_found(),
    })
}

// Mutations: in `read_task`, read `ttl` from a missing member ("ttlMs"), or pass `None` as
// `poll_once`'s suggested interval, which polls at the 2 s default; move
// `observe_mcp_task_acceptance` after `follow_task`; never hold the result on
// "input_required"; or in `connection.rs`'s `create_elicitation`, read the task id from the
// request's params instead of `context.meta`, which leaves the question unasked; or mint the
// question's id anywhere but `mint_tool_server_request_id`.
#[tokio::test(start_paused = true)]
async fn a_2025_11_25_task_keeps_its_handle_and_interval_and_asks_its_question_on_the_card() {
    let (client, card) = test_client();
    let (connection, server) = open_test_server(
        &client,
        task_server(
            |poll| match poll {
                1 | 2 => v1_status_reply("working"),
                3 => v1_status_reply("input_required"),
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
        call_tool_as_dispatched(&connection, call, &sink, &contact),
        card.answer_open(board_answer()),
    );

    assert_eq!(end.expect("the call ends"), tracked_end());
    assert_eq!(card.taken().len(), 1, "the question is asked once");
    assert_eq!(
        (question.session_id, question.run_id),
        (server.session_id, run_id)
    );
    assert!(
        is_tool_server_request_id(&question.request_id),
        "the question's id is minted for the start's withdrawal to find"
    );
    assert_eq!(
        server.answer_to("server-1").expect("the client answered")["result"],
        board_accepted()
    );
    let polls = server.requests("tasks/get");
    assert_eq!(polls.len(), 3, "one read before the call, then two polls");
    assert_eq!(
        sink.recorded(),
        vec![(1, track_task_handle(McpTaskGeneration::V1))],
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
                9 => v1_status_reply("working"),
                _ => v1_status_reply("completed"),
            },
            || Reply::Answer(json!({ "result": text_result("tracked") })),
        ),
    )
    .await;
    let sink = CountingSink::new(&server);
    let contact = contact();
    let mut seen = contact.subscribe();
    let started = Instant::now();
    let call = call_tool_as_dispatched(&connection, track_call(), &sink, &contact);
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
            1 => v1_status_reply("working"),
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

// Mutation: in `poll_once`, await the result in the "input_required" arm, which stops the
// polls while the question waits.
#[tokio::test(start_paused = true)]
async fn a_task_whose_question_waits_31_minutes_keeps_one_held_result_and_its_contact() {
    let (client, card) = test_client();
    let (connection, server) = open_test_server(
        &client,
        held_question_server(|_| v1_status_reply("input_required")),
    )
    .await;
    let sink = CountingSink::new(&server);
    let contact = contact();
    let mut seen = contact.subscribe();
    let call = call_tool_as_dispatched(&connection, track_call(), &sink, &contact);
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

// A result held past the person's answer, while the task keeps working, stays held: the
// connection's 30 min idle window on stdio, which runs again once no question is open, never
// cancels it. Mutation: in `hold_result`, hold the result under `RequestWait::ToolCall`, whose
// idle window then cancels the hold 30 min after the answer.
#[tokio::test(start_paused = true)]
async fn a_result_held_past_the_answer_while_the_task_works_on_is_never_canceled() {
    let (client, card) = test_client();
    let (connection, server) = open_test_server(
        &client,
        task_server(
            |poll| match poll {
                2 => v1_status_reply("input_required"),
                _ => v1_status_reply("working"),
            },
            || {
                let mut params = board_form();
                params["_meta"] = json!({
                    "io.modelcontextprotocol/related-task": { "taskId": "task-1" },
                });
                Reply::AskThenSilent {
                    request: json!({ "method": "elicitation/create", "params": params }),
                }
            },
        ),
    )
    .await;
    let sink = CountingSink::new(&server);
    let contact = contact();
    let call = call_tool_as_dispatched(&connection, track_call(), &sink, &contact);
    tokio::pin!(call);

    tokio::select! {
        _ = &mut call => panic!("the call ended while its task worked"),
        () = async {
            card.answer_open(board_answer()).await;
            tokio::time::sleep(Duration::from_mins(31)).await;
        } => {}
    }

    assert_eq!(
        server.answer_to("server-1").expect("the client answered")["result"],
        board_accepted()
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
            2 | 3 | 11 => v1_status_reply("input_required"),
            4..=10 => Reply::Silent,
            _ => v1_status_reply("completed"),
        }),
    )
    .await;
    let sink = CountingSink::new(&server);
    let contact = contact();
    let mut seen = contact.subscribe();
    let started = Instant::now();
    let call = call_tool_as_dispatched(&connection, track_call(), &sink, &contact);
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

/// A 2025-11-25 task server whose `initialize` declares `tasks.cancel` when `is_cancel_declared`,
/// whose `tasks/cancel` answers through `cancel_reply`, and whose polls read `working` until
/// `canceled` is set and `after` from then on, its `tasks/result` answering a text result.
fn cancel_server(
    is_cancel_declared: bool,
    cancel_reply: fn() -> Reply,
    after: &'static str,
    canceled: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Responder {
    let mut tasks = task_server(
        move |_| {
            if canceled.load(std::sync::atomic::Ordering::SeqCst) {
                v1_status_reply(after)
            } else {
                v1_status_reply("working")
            }
        },
        || Reply::Answer(json!({ "result": text_result("tracked") })),
    );
    Box::new(move |method, params| match method {
        "initialize" => {
            let mut result = v1_initialize_result();
            if !is_cancel_declared {
                result["capabilities"]["tasks"]
                    .as_object_mut()
                    .expect("the tasks capability is an object")
                    .remove("cancel");
            }
            Reply::Answer(json!({ "result": result }))
        }
        "tasks/cancel" => cancel_reply(),
        _ => tasks(method, params),
    })
}

// Mutations: in `tasks.rs`'s `cancel_task`, read a `-32601` as a failure, which fails the refused
// case; leave `can_cancel_tasks` unread, which sends the undeclared case's cancel; send the cancel
// under another method or without `taskId`; or in `poll_once`, poll on past "cancelled".
#[rstest::rstest]
#[case::taken(
    true,
    || v1_status_reply("cancelled"),
    "cancelled",
    McpTaskCancelOutcome::Taken,
    McpToolCallEnd::Canceled,
    1
)]
#[case::refused_with_method_not_found(
    true,
    method_not_found,
    "completed",
    McpTaskCancelOutcome::Refused,
    tracked_end(),
    1
)]
#[case::not_declared(
    false,
    || v1_status_reply("cancelled"),
    "completed",
    McpTaskCancelOutcome::Refused,
    tracked_end(),
    0
)]
#[tokio::test(start_paused = true)]
async fn a_2025_11_25_cancel_is_taken_or_refused_and_the_follow_reads_the_end(
    #[case] is_cancel_declared: bool,
    #[case] cancel_reply: fn() -> Reply,
    #[case] after: &'static str,
    #[case] expected_outcome: McpTaskCancelOutcome,
    #[case] expected_end: McpToolCallEnd,
    #[case] expected_cancels: usize,
) {
    let (client, _card) = test_client();
    let canceled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (connection, server) = open_test_server(
        &client,
        cancel_server(
            is_cancel_declared,
            cancel_reply,
            after,
            std::sync::Arc::clone(&canceled),
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
            .expect("the cancel is taken or refused")
    };
    let (end, outcome) = tokio::join!(
        call_tool_as_dispatched(&connection, track_call(), &sink, &contact),
        cancel
    );

    assert_eq!(outcome, expected_outcome);
    assert_eq!(end.expect("the call ends"), expected_end);
    let cancels = server.requests("tasks/cancel");
    assert_eq!(cancels.len(), expected_cancels);
    let polls = server.requests("tasks/get");
    if let Some((canceled_at, cancel)) = cancels.first() {
        assert_eq!(cancel["params"]["taskId"], "task-1");
        assert!(
            polls.last().expect("a poll").0 >= *canceled_at,
            "a poll comes after the cancel"
        );
    }
    if expected_end == McpToolCallEnd::Canceled {
        let canceled_at = cancels[0].0;
        let polls_after_cancel = polls.iter().filter(|(at, _)| *at >= canceled_at).count();
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
}

/// `value`, a JSON object.
fn object(value: Value) -> Map<String, Value> {
    serde_json::from_value(value).expect("an object")
}

/// A 2025-11-25 task whose second poll waits on input, which its `tasks/result` asks for.
fn asking_task_server() -> Responder {
    task_server(
        |poll| match poll {
            1 => v1_status_reply("working"),
            _ => v1_status_reply("input_required"),
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
        call_tool_as_dispatched(&first, first_call, &first_sink, &first_contact),
        call_tool_as_dispatched(&second, second_call, &second_sink, &second_contact),
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
                1..=4 => v1_status_reply("working"),
                _ => v1_status_reply("completed"),
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
        call_tool_as_dispatched(&connection, track_call(), &sink, &contact),
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
    let mut call = Box::pin(call_tool_as_dispatched(
        &connection,
        track_call(),
        &sink,
        &contact,
    ));

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

// A task dropped while its question waits for the run, which waits on another question,
// takes that question off the card at once. Mutation: in `TaskWatch`'s drop, leave out the
// cancel of the task's end; the question then waits on until the other is answered.
#[tokio::test(start_paused = true)]
async fn a_task_dropped_while_its_question_waits_for_the_run_withdraws_it() {
    let (client, card) = test_client();
    let (connection, server) = open_test_server(&client, asking_task_server()).await;
    let call = track_call();
    let request_id = mint_tool_server_request_id();
    let (answer, _answered) = ElicitationAnswer::open(board_form());
    card.take_tool_server_question(
        compose_question(&connection.scope, call.run_id, request_id, &board_form()),
        answer,
    )
    .await
    .expect("the card takes the run's other question");
    let sink = CountingSink::new(&server);
    let contact = contact();
    let mut asking = Box::pin(call_tool_as_dispatched(&connection, call, &sink, &contact));
    tokio::select! {
        _ = &mut asking => panic!("the call ended before its question was asked"),
        () = card.wait_until_waiting(1) => {}
    }

    drop(asking);

    card.wait_until_none_waiting().await;
    assert_eq!(
        card.taken().len(),
        1,
        "the dropped task's question never opens"
    );
}

/// A task's failure with its `data`.
fn quota_error() -> Value {
    json!({ "code": -32603, "message": "quota", "data": { "retryAfterMs": 500 } })
}

// Mutations: in `read_result`, rebuild the failure from the error's code and message alone, which
// drops its `data`; read every `-32601` as the end unknown, which fails the failed task's case; or
// read the held result's `-32601` as a failure.
#[rstest::rstest]
#[case::failed_with_data(
    "failed",
    || Reply::Answer(json!({ "error": quota_error() })),
    McpToolCallEnd::Failed { error: object(quota_error()) }
)]
#[case::failed_with_method_not_found(
    "failed",
    method_not_found,
    McpToolCallEnd::Failed {
        error: object(json!({ "code": -32601, "message": "Method not found" })),
    }
)]
#[case::held_with_method_not_found(
    "input_required",
    method_not_found,
    McpToolCallEnd::TaskUnknown {
        error: object(json!({ "code": -32601, "message": "Method not found" })),
    }
)]
#[tokio::test(start_paused = true)]
async fn a_2025_11_25_result_error_reads_unknown_before_the_end_and_failed_after(
    #[case] status: &'static str,
    #[case] result_reply: fn() -> Reply,
    #[case] expected_end: McpToolCallEnd,
) {
    let (client, _card) = test_client();
    let (connection, server) = open_test_server(
        &client,
        task_server(move |_| v1_status_reply(status), result_reply),
    )
    .await;
    let sink = CountingSink::new(&server);

    let end = call_tool_as_dispatched(&connection, track_call(), &sink, &contact())
        .await
        .expect("the call ends");

    assert_eq!(end, expected_end);
    assert_eq!(server.requests("tasks/get").len(), 1);
}
