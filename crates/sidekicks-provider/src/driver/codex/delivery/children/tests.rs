use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio_util::sync::CancellationToken;

use super::{ChildRunLookup, CodexHelperStart};
use crate::driver::codex::delivery::rows::{CodexRowRun, test_row_run};
use crate::driver::codex::hooks::server::{
    CodexHookAnswer, CodexHookAnswerer, CodexHookEvent, CodexHookInput,
};
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::session::inbound::CodexSessionInbound;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession, turn_completed};
use crate::driver::registry::test_token;
use crate::driver::run_control::HelperStopReason;
use crate::port::reviewer_denial::ReviewerDenialPort;
use crate::port::reviewer_denial::recording::RecordingReviewerDenials;
use crate::port::run_host::test_host::RecordedDelivery;
use crate::run::delivery::{ChildRunSubagent, LateAppendableRow, RunSetupRefusal};
use crate::run::state_entry::RunStateEntry;

/// A helper's own conversation, which is its id.
const HELPER_THREAD: &str = "helper-thread";

/// The turn the helper is running as its run is refused.
const HELPER_TURN: &str = "helper-turn";

// A helper whose run the daemon refused stays bound to that ended run, has the turn it is running
// interrupted on its own conversation, and has its next tool call denied with the refusal's
// sentence. Killed by a refusal that stops nothing, by one that leaves the helper with no run, so
// its rows have no owner, and by a stop that drops the refusal's reason.
#[tokio::test]
async fn a_refused_helpers_running_turn_is_interrupted() {
    let mut session = TestCodexSession::start().await;
    let delivery = Arc::clone(&session.task.calls.forks.delivery);
    let refusal = RunSetupRefusal {
        cause: "the test's gate refuses the run".to_owned(),
        is_posture_rejection: true,
    };
    let refused = session.engine.refuse_next_child_run(refusal.clone());
    let mut lead = test_row_run();
    lead.session_id = session.task.record.session_id;
    session
        .task
        .record
        .note_spawn_call(TEST_THREAD, "call-1", &lead);

    delivery
        .start_child(
            &mut session.task.record,
            HELPER_THREAD,
            TEST_THREAD,
            HELPER_THREAD,
            Some("call-1"),
            CodexHelperStart {
                name: None,
                role: None,
                provider_path: None,
                model_id: None,
                effort: None,
            },
        )
        .await;

    let list = session.scripted.script.next_sent().await;
    assert_eq!(list["method"], "thread/turns/list");
    assert_eq!(list["params"]["threadId"], HELPER_THREAD);
    session.scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "id": list["id"],
        "result": {"data": [{"id": HELPER_TURN, "status": "inProgress"}]},
    }));
    let interrupt = session.scripted.script.next_sent().await;
    assert_eq!(interrupt["method"], "turn/interrupt");
    assert_eq!(
        interrupt["params"],
        json!({"threadId": HELPER_THREAD, "turnId": HELPER_TURN})
    );
    session.scripted.script.answer(&interrupt, &json!({}));
    let ChildRunLookup::Bound { run, .. } = session.task.record.child_run_on(HELPER_THREAD) else {
        panic!("the refused helper keeps its ended run");
    };
    assert_eq!(run.run_id, refused);
    let helper_call = CodexHookInput {
        event: CodexHookEvent::PreToolUse,
        thread_id: HELPER_THREAD.to_owned(),
        session_id: None,
        turn_id: None,
        tool_name: None,
        tool_use_id: None,
        tool_input: None,
        tool_response: None,
        cwd: None,
    };
    let answer = delivery
        .dependencies
        .stopped_helpers
        .answer(&helper_call, &CancellationToken::new())
        .await
        .expect("the stopped helpers never fail");
    assert_eq!(
        answer,
        Some(CodexHookAnswer::Deny {
            reason: HelperStopReason::SetupRefused { refusal }.sentence(),
        })
    );
}

/// A turn of the lead's live while its helpers are spawned.
const LEAD_TURN: &str = "lead-turn";

/// The model a spawn names for its helper, which the lead does not run on.
const HELPER_MODEL: &str = "gpt-5.4-mini";

/// Opens the live turn `turn_id` on [`TEST_THREAD`] under a run of its own, delivered on.
fn open_live_turn(session: &mut TestCodexSession, turn_id: &str) -> CodexRowRun {
    let mut run = test_row_run();
    run.session_id = session.task.record.session_id;
    session.task.run_routes.bind_run_delivery(
        run.run_id,
        CodexRunBinding {
            session_id: run.session_id,
            binding_id: run.binding_id.clone(),
            agent_id: run.agent_id,
            step_bound: None,
        },
    );
    session
        .task
        .record
        .add_active_turn(turn_id.to_owned(), run.run_id);
    run
}

/// A notification of `method` with `params`, as the session's queue carries it.
fn notification(method: &str, params: &Value) -> CodexSessionInbound {
    CodexSessionInbound::Frame {
        method: method.to_owned(),
        params: RawValue::from_string(params.to_string()).expect("the params are JSON"),
    }
}

/// An item frame of `method` carrying `item` on `turn_id` of [`TEST_THREAD`].
fn item_frame(method: &str, turn_id: &str, item: &Value) -> CodexSessionInbound {
    notification(
        method,
        &json!({"threadId": TEST_THREAD, "turnId": turn_id, "item": item}),
    )
}

/// Handles `frame` while answering the one `thread/read` of `helper_thread` it sends with `answer`,
/// a whole JSON-RPC answer but for its id.
async fn handle_answering_read(
    session: &mut TestCodexSession,
    frame: CodexSessionInbound,
    helper_thread: &str,
    mut answer: Value,
) {
    let script = &mut session.scripted.script;
    let answer_read = async {
        let read = script
            .next_sent_within(Duration::from_secs(1))
            .await
            .expect("the helper's conversation is read");
        assert_eq!(read["method"], "thread/read", "{read}");
        assert_eq!(read["params"]["threadId"], helper_thread, "{read}");
        answer["jsonrpc"] = json!("2.0");
        answer["id"] = read["id"].clone();
        script.send(&answer);
    };
    tokio::join!(session.task.handle(frame), answer_read);
}

/// The child runs started so far, by their helper's id.
fn child_runs(session: &TestCodexSession) -> HashMap<String, RecordedDelivery> {
    session
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "childRun")
        .map(|delivery| {
            let subagent = delivery
                .subagent
                .as_ref()
                .expect("a child run names its helper");
            (subagent.subagent_id.as_str().to_owned(), delivery)
        })
        .collect()
}

/// The call each `subagent.started` row names, by its helper's id.
fn started_row_calls(session: &TestCodexSession) -> HashMap<String, Option<String>> {
    session
        .engine
        .deliveries()
        .into_iter()
        .filter_map(|delivery| {
            let Some(LateAppendableRow::AgentSubagentStarted(row)) = delivery.row else {
                return None;
            };
            Some((
                row.subagent_id.as_str().to_owned(),
                row.parent_tool_call_id.map(|call| call.as_str().to_owned()),
            ))
        })
        .collect()
}

// A v2 spawn's `subAgentActivity` pair starts one child run beneath the run whose call the started
// item noted, named as the helper's `thread/read` names it, with the item's path, model and effort;
// its usage names the item's model; and a later `interacted` item naming it starts nothing. Another
// live run makes the noted call the only way to the parent. Kills: registration left on
// `thread/started` (no child run), the v2 call never noted (no parent run, so no child run), names
// never read, the path from another member, `reasoningEffort` never read, the start's model taken
// from the read alone (the read names none), no model or the lead's on the usage, and the kind not
// checked (a second child run on the `interacted` item).
#[tokio::test]
async fn a_v2_spawn_starts_its_helpers_child_run_as_codex_names_it() {
    let mut session = TestCodexSession::start().await;
    let lead = open_live_turn(&mut session, LEAD_TURN);
    open_live_turn(&mut session, "other-turn");
    let spawned = json!({
        "type": "subAgentActivity", "id": "call-1", "kind": "started",
        "agentThreadId": HELPER_THREAD, "agentPath": "/root/scout", "model": HELPER_MODEL,
        "reasoningEffort": "low",
    });

    session
        .task
        .handle(item_frame("item/started", LEAD_TURN, &spawned))
        .await;
    handle_answering_read(
        &mut session,
        item_frame("item/completed", LEAD_TURN, &spawned),
        HELPER_THREAD,
        json!({"result": {"thread": {
            "id": HELPER_THREAD, "agentNickname": "Scout", "agentRole": "explorer",
        }}}),
    )
    .await;
    let delivery = Arc::clone(&session.task.calls.forks.delivery);
    let usage = json!({
        "threadId": HELPER_THREAD, "turnId": HELPER_TURN,
        "tokenUsage": {"total": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}},
    });
    let routed = session
        .task
        .routing
        .route_notification(
            &delivery,
            &mut session.task.record,
            "thread/tokenUsage/updated".to_owned(),
            RawValue::from_string(usage.to_string()).expect("the params are JSON"),
        )
        .await;
    session
        .task
        .handle(notification(
            "turn/completed",
            &turn_completed(HELPER_THREAD, HELPER_TURN, "completed")["params"],
        ))
        .await;
    let interacted = json!({
        "type": "subAgentActivity", "id": "call-2", "kind": "interacted",
        "agentThreadId": HELPER_THREAD, "agentPath": "/root/scout",
    });
    for method in ["item/started", "item/completed"] {
        session
            .task
            .handle(item_frame(method, LEAD_TURN, &interacted))
            .await;
    }

    let child_runs = child_runs(&session);
    assert_eq!(child_runs.len(), 1, "one child run for the one spawn");
    let child_run = &child_runs[HELPER_THREAD];
    assert_eq!(child_run.parent_run_id, Some(lead.run_id));
    let handle = |text: &str| Some(FreeFormText::new(text.to_owned()).expect("a test name fits"));
    assert_eq!(
        child_run.subagent,
        Some(ChildRunSubagent {
            subagent_id: SubagentId::new(HELPER_THREAD.to_owned()).expect("a helper id"),
            parent_subagent_id: None,
            name: handle("Scout"),
            role: handle("explorer"),
            provider_path: handle("/root/scout"),
            model_id: Some(test_token(HELPER_MODEL)),
            effort: Some(test_token("low")),
            start_call_id: None,
        })
    );
    assert_eq!(
        started_row_calls(&session),
        HashMap::from([(HELPER_THREAD.to_owned(), Some("call-1".to_owned()))])
    );
    let metered = routed
        .metered_usage
        .last()
        .expect("the helper's usage metered");
    assert_eq!(
        metered.request.model_id.as_ref().map(FreeFormText::as_str),
        Some(HELPER_MODEL)
    );
}

// Each v1 spawn's helper starts beneath the run of its own call and its row names that call, though
// the later call completes first, and a helper whose `thread/read` fails starts all the same, with
// no name or role but the model and effort its completed item names. Kills: the oldest noted call
// taken (`helper-b` beneath the first call's run), a failed read starting no run, and the v1 item's
// `reasoningEffort` or model never read (the read fails, so the item is their only source).
#[tokio::test]
async fn each_v1_spawn_starts_its_helper_beneath_its_own_call() {
    let mut session = TestCodexSession::start().await;
    let first = open_live_turn(&mut session, LEAD_TURN);
    let second = open_live_turn(&mut session, "second-turn");
    let spawn_call = |call_id: &str, receivers: &[&str]| {
        let mut item = json!({
            "type": "collabAgentToolCall", "id": call_id, "tool": "spawnAgent",
            "status": if receivers.is_empty() { "inProgress" } else { "completed" },
            "senderThreadId": TEST_THREAD, "receiverThreadIds": receivers,
            "agentsStates": {},
        });
        if call_id == "call-1" && !receivers.is_empty() {
            item["model"] = json!("gpt-5.4");
            item["reasoningEffort"] = json!("high");
        }
        item
    };

    for (call_id, turn_id) in [("call-1", LEAD_TURN), ("call-2", "second-turn")] {
        session
            .task
            .handle(item_frame(
                "item/started",
                turn_id,
                &spawn_call(call_id, &[]),
            ))
            .await;
    }
    handle_answering_read(
        &mut session,
        item_frame(
            "item/completed",
            "second-turn",
            &spawn_call("call-2", &["helper-b"]),
        ),
        "helper-b",
        json!({"result": {"thread": {"id": "helper-b", "agentNickname": "Bee"}}}),
    )
    .await;
    handle_answering_read(
        &mut session,
        item_frame(
            "item/completed",
            LEAD_TURN,
            &spawn_call("call-1", &["helper-a"]),
        ),
        "helper-a",
        json!({"error": {"code": -32600, "message": "thread not loaded"}}),
    )
    .await;

    let child_runs = child_runs(&session);
    assert_eq!(child_runs["helper-b"].parent_run_id, Some(second.run_id));
    assert_eq!(child_runs["helper-a"].parent_run_id, Some(first.run_id));
    let helper_a = child_runs["helper-a"]
        .subagent
        .as_ref()
        .expect("a child run names its helper");
    assert_eq!((&helper_a.name, &helper_a.role), (&None, &None));
    assert_eq!(
        (&helper_a.model_id, &helper_a.effort),
        (&Some(test_token("gpt-5.4")), &Some(test_token("high")))
    );
    assert_eq!(
        started_row_calls(&session),
        HashMap::from([
            ("helper-a".to_owned(), Some("call-1".to_owned())),
            ("helper-b".to_owned(), Some("call-2".to_owned())),
        ])
    );
}

// A v1 spawn naming two receivers reads both helpers' conversations together, so the frame waits
// one read's bound, not one per helper, and each starts named by its own read. Killed by reads
// sent one after another (the second read comes only once the first is answered).
#[tokio::test]
async fn a_v1_spawn_reads_each_of_its_helpers_together() {
    let mut session = TestCodexSession::start().await;
    open_live_turn(&mut session, LEAD_TURN);
    let spawn = item_frame(
        "item/completed",
        LEAD_TURN,
        &json!({
            "type": "collabAgentToolCall", "id": "call-1", "tool": "spawnAgent",
            "status": "completed", "senderThreadId": TEST_THREAD,
            "receiverThreadIds": ["helper-a", "helper-b"], "agentsStates": {},
        }),
    );
    let script = &mut session.scripted.script;
    let answer_reads = async {
        let mut reads = Vec::new();
        for _ in 0..2 {
            let read = script
                .next_sent_within(Duration::from_secs(1))
                .await
                .expect("each read goes out before any is answered");
            assert_eq!(read["method"], "thread/read", "{read}");
            reads.push(read);
        }
        for read in &reads {
            let thread_id = read["params"]["threadId"].clone();
            let nickname = format!("Nick {}", thread_id.as_str().unwrap_or_default());
            script.answer(
                read,
                &json!({"thread": {"id": thread_id, "agentNickname": nickname}}),
            );
        }
    };
    tokio::join!(session.task.handle(spawn), answer_reads);

    let names: HashMap<String, Option<String>> = child_runs(&session)
        .into_iter()
        .map(|(helper, delivery)| {
            let name = delivery
                .subagent
                .and_then(|subagent| subagent.name)
                .map(|name| name.as_str().to_owned());
            (helper, name)
        })
        .collect();
    assert_eq!(
        names,
        HashMap::from([
            ("helper-a".to_owned(), Some("Nick helper-a".to_owned())),
            ("helper-b".to_owned(), Some("Nick helper-b".to_owned())),
        ])
    );
}

/// Starts the helper on `helper_thread` beneath the session's lead, by a spawn call of the lead's,
/// and answers its child run.
async fn start_helper(session: &mut TestCodexSession, helper_thread: &str) -> RunId {
    let delivery = Arc::clone(&session.task.calls.forks.delivery);
    let mut lead = test_row_run();
    lead.session_id = session.task.record.session_id;
    let spawn_call = format!("spawn-{helper_thread}");
    session
        .task
        .record
        .note_spawn_call(TEST_THREAD, &spawn_call, &lead);
    delivery
        .start_child(
            &mut session.task.record,
            helper_thread,
            TEST_THREAD,
            helper_thread,
            Some(&spawn_call),
            CodexHelperStart {
                name: None,
                role: None,
                provider_path: None,
                model_id: None,
                effort: None,
            },
        )
        .await;
    let ChildRunLookup::Bound { run, .. } = session.task.record.child_run_on(helper_thread) else {
        panic!("the helper's child run started");
    };
    run.run_id
}

/// Ends the helper on `helper_thread` with its last turn's `turn/completed` ending `status`.
async fn end_helper(session: &mut TestCodexSession, helper_thread: &str, status: &str) {
    let delivery = Arc::clone(&session.task.calls.forks.delivery);
    let members = turn_completed(helper_thread, HELPER_TURN, status)["params"]
        .as_object()
        .cloned()
        .expect("the params are an object");
    let params = RawValue::from_string(serde_json::to_string(&members).expect("JSON writes"))
        .expect("the params are JSON");
    delivery
        .complete_child(&mut session.task.record, helper_thread, &params, &members)
        .await;
}

// A helper stopped at its token limit ends stopped for it, whether its interrupted turn ended
// interrupted or finished first, while its failure keeps failed and a helper never stopped ends
// interrupted as Codex says. Kills: the token stop not read (interrupted), every interrupted end
// read stopped (the last case), and a failure overwritten (the failed case).
#[rstest]
#[case::limit_interrupted(true, "interrupted")]
#[case::limit_completed(true, "completed")]
#[case::limit_failed(true, "failed")]
#[case::never_stopped_interrupted(false, "interrupted")]
#[tokio::test]
async fn a_helpers_end_reads_its_token_limit_stop(
    #[case] is_stopped_at_limit: bool,
    #[case] status: &str,
) {
    let mut session = TestCodexSession::start().await;
    let child_run = start_helper(&mut session, HELPER_THREAD).await;
    if is_stopped_at_limit {
        Arc::clone(&session.task.calls.forks.delivery)
            .dependencies
            .stopped_helpers
            .stop(
                session.task.record.session_id,
                HELPER_THREAD,
                HelperStopReason::TokenLimit,
            );
    }

    end_helper(&mut session, HELPER_THREAD, status).await;

    let expected = match (is_stopped_at_limit, status) {
        (_, "failed") => RunStateEntry::Failed {
            intended_close: None,
            failure_cause: None,
            provider_failure_detail: None,
            process_exit: None,
        },
        (true, _) => RunStateEntry::Stopped {
            intended_close: None,
            trigger: Some(StopTrigger::TokenLimit),
        },
        (false, _) => RunStateEntry::Interrupted {
            intended_close: None,
            trigger: None,
        },
    };
    assert_eq!(session.engine.moves_of_run(child_run), vec![expected]);
}

// The end of a helper the daemon interrupted says it is that interrupt's, while another helper's
// end does not, and each helper's route goes with its end. Kills: the mark not read, which reports
// a late event for every helper the person interrupts, and a route left behind at the end.
#[tokio::test]
async fn a_daemon_interrupted_helpers_end_is_marked_and_its_route_retired() {
    let mut session = TestCodexSession::start().await;
    let run_routes = Arc::clone(&session.task.calls.forks.delivery.dependencies.run_routes);
    let interrupted_run = start_helper(&mut session, HELPER_THREAD).await;
    let other_run = start_helper(&mut session, "other-helper").await;
    assert!(
        run_routes.begin_helper_interrupt(interrupted_run).is_some(),
        "the started helper's run is routed"
    );

    end_helper(&mut session, HELPER_THREAD, "interrupted").await;
    end_helper(&mut session, "other-helper", "interrupted").await;

    let engine = &session.engine;
    assert_eq!(
        engine.daemon_interrupt_ends_of_run(interrupted_run),
        vec![true]
    );
    assert_eq!(engine.daemon_interrupt_ends_of_run(other_run), vec![false]);
    for run_id in [interrupted_run, other_run] {
        assert_eq!(
            run_routes.begin_helper_interrupt(run_id),
            None,
            "an ended helper's route is gone"
        );
    }
}

/// The `thread/read` answer of a loaded helper spawned at `agent_path`, with Codex's own answer.
fn helper_thread_answer(agent_path: &Value, can_accept_direct_input: bool) -> Value {
    json!({"result": {"thread": {
        "id": HELPER_THREAD,
        "source": {"subAgent": {"thread_spawn": {
            "parent_thread_id": TEST_THREAD, "depth": 1, "agent_path": agent_path,
            "agent_nickname": null, "agent_role": null,
        }}},
        "canAcceptDirectInput": can_accept_direct_input,
    }}})
}

// A reviewer's denial on a helper's thread may be allowed once only when the read of its
// conversation says Codex takes direct input to it, and the lead's is never read. Kills: the block
// handed over unread, every helper's block made not overridable, a failed read answering `true`,
// and the lead's block read (its read waits out the bound and answers `false`) or narrowed.
#[rstest]
#[case::a_v2_helper(
    HELPER_THREAD,
    HELPER_TURN,
    Some(helper_thread_answer(&json!("/root/scout"), false)),
    false
)]
#[case::a_v1_helper(
    HELPER_THREAD,
    HELPER_TURN,
    Some(helper_thread_answer(&Value::Null, true)),
    true
)]
#[case::a_helper_whose_read_fails(
    HELPER_THREAD,
    HELPER_TURN,
    Some(json!({"error": {"code": -32600, "message": "the thread is not loaded"}})),
    false
)]
#[case::the_lead(TEST_THREAD, LEAD_TURN, None, true)]
#[tokio::test]
async fn a_block_inside_a_v2_helper_may_not_be_allowed_once(
    #[case] thread_id: &str,
    #[case] turn_id: &str,
    #[case] read_answer: Option<Value>,
    #[case] is_overridable: bool,
) {
    let mut session = TestCodexSession::start().await;
    open_live_turn(&mut session, LEAD_TURN);
    let spawned = json!({
        "type": "subAgentActivity", "id": "call-1", "kind": "started",
        "agentThreadId": HELPER_THREAD, "agentPath": "/root/scout",
    });
    session
        .task
        .handle(item_frame("item/started", LEAD_TURN, &spawned))
        .await;
    handle_answering_read(
        &mut session,
        item_frame("item/completed", LEAD_TURN, &spawned),
        HELPER_THREAD,
        json!({"result": {"thread": {"id": HELPER_THREAD}}}),
    )
    .await;
    let denials = Arc::new(RecordingReviewerDenials::new(|_released| {}));
    session
        .task
        .calls
        .forks
        .delivery
        .dependencies
        .reviewer_denials
        .register(Arc::clone(&denials) as Arc<dyn ReviewerDenialPort>)
        .expect("the port registers once");
    let review = notification(
        "item/autoApprovalReview/completed",
        &json!({
            "threadId": thread_id, "turnId": turn_id, "startedAtMs": 10, "completedAtMs": 20,
            "reviewId": "review-1", "targetItemId": "item-1", "decisionSource": "agent",
            "review": {"status": "denied", "rationale": "deletes the build"},
            "action": {"type": "command", "source": "unifiedExec", "command": "rm -rf build",
                "cwd": "/work"},
        }),
    );

    match read_answer {
        Some(answer) => handle_answering_read(&mut session, review, thread_id, answer).await,
        None => session.task.handle(review).await,
    }

    assert_eq!(denials.overridable(), [is_overridable]);
}
