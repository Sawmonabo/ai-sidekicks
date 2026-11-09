use std::time::SystemTime;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::control::{RunFailureCategory, StopTrigger};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageContent, QueueItemId};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_std::mutex_lock::lock;

use super::super::tests::result;
use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudePauseAnswer};
use crate::driver::claude::hooks::registration::CLAUDE_HOOK_HOLD_RENEWAL_AFTER;
use crate::driver::claude::session::scripted::driver::create_params;
use crate::driver::claude::session::scripted::held_calls::{helper_started, init};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
};
use crate::driver::run_control::{HelperStopReason, ResumeRunParams, WaitingMessage};
use crate::driver::session_control::{CreateSessionParams, SubagentPolicy};
use crate::port::run_host::test_host::RecordedDelivery;
use crate::run::delivery::{LateAppendableRow, RunSetupRefusal};
use crate::run::state_entry::RunStateEntry;

/// A helper's `task_started`, launched by the helper `parent` where one is named, started as
/// `role` where one is named.
pub(in super::super) fn nested_start(
    task_id: &str,
    call_id: &str,
    parent: Option<&str>,
    role: Option<&str>,
) -> Value {
    let mut frame = helper_started(task_id, "local_agent", call_id);
    if let Some(parent) = parent {
        frame["parent_task_id"] = json!(parent);
    }
    if let Some(role) = role {
        frame["subagent_type"] = json!(role);
    }
    frame
}

/// One child run delivery as a test reads it.
#[derive(Debug, PartialEq)]
pub(in super::super) struct ChildRunRead {
    /// The helper's agent id.
    pub(in super::super) helper: String,
    /// The run it starts beneath.
    pub(in super::super) parent_run_id: Option<RunId>,
    /// The helper that launched it.
    pub(in super::super) launcher: Option<String>,
    /// What it was started as.
    pub(in super::super) role: Option<String>,
    /// The call that started it.
    pub(in super::super) start_call: Option<String>,
}

/// Each child run delivery, in order.
pub(in super::super) fn child_runs(deliveries: &[RecordedDelivery]) -> Vec<ChildRunRead> {
    deliveries
        .iter()
        .filter(|delivery| delivery.kind == "childRun")
        .map(|delivery| {
            let subagent = delivery
                .subagent
                .clone()
                .expect("a child run delivery names its helper");
            ChildRunRead {
                helper: subagent.subagent_id.as_str().to_owned(),
                parent_run_id: delivery.parent_run_id,
                launcher: subagent
                    .parent_subagent_id
                    .map(|parent| parent.as_str().to_owned()),
                role: subagent.role.map(|role| role.as_str().to_owned()),
                start_call: subagent.start_call_id.map(|call| call.as_str().to_owned()),
            }
        })
        .collect()
}

/// Each lifecycle row of the helper `agent_id` as (is a start, the run it sits on, its child
/// run).
pub(in super::super) fn lifecycle_rows(
    deliveries: &[RecordedDelivery],
    agent_id: &str,
) -> Vec<(bool, RunId, Option<RunId>)> {
    deliveries
        .iter()
        .filter_map(|delivery| {
            if let Some(LateAppendableRow::AgentSubagentStarted(payload)) = &delivery.row {
                Some((true, payload))
            } else if let Some(LateAppendableRow::AgentSubagentCompleted(payload)) = &delivery.row {
                Some((false, payload))
            } else {
                None
            }
        })
        .filter(|(_, payload)| payload.subagent_id.as_str() == agent_id)
        .map(|(is_start, payload)| (is_start, payload.run_id, payload.child_run_id))
        .collect()
}

// A nested helper hangs under its launcher's run, a helper whose launcher no route knows under
// the lead with that launcher's id kept, and both of the nested helper's rows sit on its
// start's run. Killed by every start hanging under the lead, by dropping the launcher's id, by
// taking the router's filtered parent (the unknown launcher's id reads as none), by dropping
// the role, by leaving the nested helper's start or end row on the lead (the end tried on the
// turn's lead first), and by an unknown launcher not falling back to the lead.
#[tokio::test(start_paused = true)]
async fn a_nested_helper_hangs_under_its_launchers_run_and_an_unknown_one_under_the_lead() {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");

    session.frame(&init());
    session.frame(&nested_start("p", "call-p", None, Some("Explore")));
    session.frame(&nested_start("c", "call-c", Some("p"), Some("Plan")));
    session.frame(&nested_start("g", "call-g", Some("ghost"), None));
    settle().await;
    let routes = &session.start.routes;
    let parent_run = routes
        .child_run_for(session.session_id, "p")
        .expect("the launcher has its child run");
    let waiting_run = routes
        .child_run_for(session.session_id, "c")
        .expect("the waiting helper has its child run");
    session.frame(&json!({
        "type": "system",
        "subtype": "task_notification",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": "c",
        "tool_use_id": "call-c",
        "status": "completed",
        "summary": "Planned",
    }));
    settle().await;

    let deliveries = session.engine.deliveries();
    assert_eq!(
        child_runs(&deliveries),
        [
            ChildRunRead {
                helper: "p".to_owned(),
                parent_run_id: Some(lead_run),
                launcher: None,
                role: Some("Explore".to_owned()),
                start_call: Some("call-p".to_owned()),
            },
            ChildRunRead {
                helper: "c".to_owned(),
                parent_run_id: Some(parent_run),
                launcher: Some("p".to_owned()),
                role: Some("Plan".to_owned()),
                start_call: Some("call-c".to_owned()),
            },
            ChildRunRead {
                helper: "g".to_owned(),
                parent_run_id: Some(lead_run),
                launcher: Some("ghost".to_owned()),
                role: None,
                start_call: Some("call-g".to_owned()),
            },
        ]
    );
    assert_eq!(
        lifecycle_rows(&deliveries, "c"),
        [
            (true, parent_run, Some(waiting_run)),
            (false, parent_run, Some(waiting_run)),
        ]
    );
}

// A helper launched by one whose run the daemon refused hangs under the lead, the refused
// launcher's id kept, so it gets a run of its own. Killed by the refused launcher's ended run
// carrying the start (it hangs under that run).
#[tokio::test(start_paused = true)]
async fn a_helper_launched_by_a_refused_one_hangs_under_the_lead() {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");
    session.frame(&init());
    session.engine.refuse_next_child_run(earlier_refusal());
    session.frame(&nested_start("p", "call-p", None, None));
    session.frame(&nested_start("c", "call-c", Some("p"), None));
    settle().await;

    let nested = child_runs(&session.engine.deliveries())
        .into_iter()
        .find(|read| read.helper == "c")
        .expect("the nested helper's start is delivered");
    assert_eq!(nested.parent_run_id, Some(lead_run));
    assert_eq!(nested.launcher.as_deref(), Some("p"));
}

// A background helper that launches a helper after the lead's turn ended still carries it: the
// nested start hangs under the launcher's run on the lead's binding, and opens no turn. Killed
// by dropping the start as unmapped once no lead holds the turn, by opening the turn on the run
// the start hangs under, and by trying the launcher only while a lead holds the turn.
#[tokio::test(start_paused = true)]
async fn a_background_helpers_nested_start_after_the_turn_ended_hangs_under_it() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");

    session.frame(&init());
    session.frame(&helper_started("p", "local_agent", "call-p"));
    settle().await;
    let parent_run = session
        .start
        .routes
        .child_run_for(session.session_id, "p")
        .expect("the launcher has its child run");
    session.frame(&result(&json!({})));
    settle().await;
    let before_nested_start = session.engine.deliveries().len();
    session.frame(&nested_start("c2", "call-c2", Some("p"), None));
    settle().await;

    let deliveries = session.engine.deliveries();
    let after_turn = &deliveries[before_nested_start..];
    let nested_child_run = after_turn
        .iter()
        .find(|delivery| delivery.kind == "childRun")
        .expect("the nested start gets its child run");
    assert_eq!(nested_child_run.parent_run_id, Some(parent_run));
    assert_eq!(nested_child_run.binding_id, Some(binding_id("lead")));
    assert!(
        lifecycle_rows(after_turn, "c2")
            .iter()
            .any(|&(is_start, run_id, _)| is_start && run_id == parent_run),
        "the nested start's row sits on its launcher's run"
    );
    assert!(
        after_turn
            .iter()
            .all(|delivery| delivery.kind != "turnBoundary"),
        "a start after the turn ended opens no turn"
    );
}

// A started helper's id, with the ask, model and effort its start named.
type HelperAsked = (String, Option<String>, Option<String>, Option<String>);

// The pre-tool callback of the `Agent` call `call_id` with `tool_input`, made by the helper
// `agent_id` where one is named, else the lead; its own `effort` is the caller's turn level.
fn helper_call_hook(call_id: &str, agent_id: Option<&str>, tool_input: &Value) -> Value {
    let mut input = json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "Agent",
        "tool_use_id": call_id,
        "tool_input": tool_input,
        "effort": {"level": "max"},
    });
    if let Some(agent_id) = agent_id {
        input["agent_id"] = json!(agent_id);
    }
    json!({
        "subtype": "hook_callback",
        "callback_id": "sidekicks-pause-before-tool",
        "input": input,
    })
}

// Each helper's child run names the ask, model and effort its `Agent` call asked for, read from
// the call's pre-tool hook, the lead's call or a helper's own; a fork names its ask but no model
// or effort, and a call naming none, a withdrawn call's and a call that failed inside the tool
// name none. Kills: the hook's input never read (`p` names nothing), the prompt never read (`p`
// asks nothing), an entry keyed by the request id (no start finds it), a helper's own call missed
// (`c` names nothing), a fork's values kept (`f` names `high`), a fork's call dropped whole (`f`
// asks nothing), the hook input's own `effort.level` read for the call's (`max` on every start), a
// withdrawal that forgets nothing (`w` names `opus`), a failed call's hook that forgets nothing
// (`x` names `sonnet`), and a held call released with a deny that forgets nothing (`d` names
// `opus`).
#[tokio::test(start_paused = true)]
async fn a_helpers_start_names_the_ask_model_and_effort_its_agent_call_asked_for() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.frame(&init());

    for (request_id, call_id, tool_input) in [
        (
            "hook-p",
            "call-p",
            json!({
                "subagent_type": "Explore",
                "description": "Find the flaky test",
                "prompt": "Find the test that fails one run in ten.",
                "model": "haiku",
                "effort": "low",
            }),
        ),
        (
            "hook-f",
            "call-f",
            json!({"subagent_type": "fork", "prompt": "Draft the note.", "effort": "high"}),
        ),
        ("hook-n", "call-n", json!({"subagent_type": "Plan"})),
        ("hook-w", "call-w", json!({"model": "opus"})),
        ("hook-x", "call-x", json!({"model": "sonnet"})),
    ] {
        session.request(request_id, &helper_call_hook(call_id, None, &tool_input));
    }
    session.cancel("hook-w");
    session.request(
        "failed-x",
        &json!({
            "subtype": "hook_callback",
            "callback_id": "sidekicks-helper-call-failed",
            "input": {
                "hook_event_name": "PostToolUseFailure",
                "tool_name": "Agent",
                "tool_use_id": "call-x",
                "error": "Agent type 'Missing' not found",
            },
        }),
    );
    for (task_id, call_id) in [
        ("p", "call-p"),
        ("f", "call-f"),
        ("n", "call-n"),
        ("w", "call-w"),
        ("x", "call-x"),
    ] {
        session.frame(&nested_start(task_id, call_id, None, None));
    }
    // `p` is paused, so its call `call-d` is held, then released denied with the person's words.
    lock(&session.parts.run_controls.pauses).pause_helper(&session.session_id, "p");
    session.request(
        "hook-d",
        &helper_call_hook("call-d", Some("p"), &json!({"model": "opus"})),
    );
    settle().await;
    let run_of_p = session
        .start
        .routes
        .child_run_for(session.session_id, "p")
        .expect("p has its child run");
    session
        .parts
        .run_controls
        .resume_run(ResumeRunParams {
            session_id: session.session_id,
            run_id: run_of_p,
            messages: vec![WaitingMessage {
                id: QueueItemId::new(&mint_uuid_v7().to_string())
                    .expect("a minted UUID is an item id"),
                content: MessageContent::new("look elsewhere".to_owned())
                    .expect("the words are a message"),
                attachments: Vec::new(),
                skills: Vec::new(),
            }],
            is_continuation_owed: false,
        })
        .await
        .expect("the paused helper continues");
    session.frame(&nested_start("d", "call-d", Some("p"), None));
    session.request(
        "hook-c",
        &helper_call_hook("call-c", Some("p"), &json!({"model": "haiku"})),
    );
    session.frame(&nested_start("c", "call-c", Some("p"), None));
    settle().await;

    let asked: Vec<HelperAsked> = session
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "childRun")
        .map(|delivery| {
            let subagent = delivery
                .subagent
                .expect("a child run delivery names its helper");
            (
                subagent.subagent_id.as_str().to_owned(),
                subagent.ask.map(|ask| ask.as_str().to_owned()),
                subagent.model_id.map(|model| model.as_str().to_owned()),
                subagent.effort.map(|effort| effort.as_str().to_owned()),
            )
        })
        .collect();
    let named = |helper: &str, ask: Option<&str>, model: Option<&str>, effort: Option<&str>| {
        (
            helper.to_owned(),
            ask.map(str::to_owned),
            model.map(str::to_owned),
            effort.map(str::to_owned),
        )
    };
    assert_eq!(
        asked,
        [
            named(
                "p",
                Some("Find the test that fails one run in ten."),
                Some("haiku"),
                Some("low")
            ),
            named("f", Some("Draft the note."), None, None),
            named("n", None, None, None),
            named("w", None, None, None),
            named("x", None, None, None),
            named("d", None, None, None),
            named("c", None, Some("haiku"), None),
        ]
    );
}

// The helper calls the session's stream keeps for a start to take, by call id, sorted.
fn recorded_helper_calls(session: &ScriptedSession) -> Vec<String> {
    let stream = session
        .start
        .streams
        .get(session.session_id)
        .expect("the session has its stream");
    let mut calls: Vec<String> = stream.lock().helper_calls.keys().cloned().collect();
    calls.sort();
    calls
}

// A lead's call the helper limit holds, then withdraws, is forgotten by its call id, though the
// pause hook's request recorded it. Killed by a withdrawal that forgets only by the withdrawn
// request's id (`call-l` kept).
#[tokio::test(start_paused = true)]
async fn a_withdrawn_helper_limit_hold_forgets_what_its_call_asked_for() {
    let session = ScriptedSession::created_with(|session_id| CreateSessionParams {
        subagent_policy: Some(SubagentPolicy::Enabled {
            helpers_at_once: Some(SafeInt::new(1).expect("1 is a safe integer")),
            definitions: Vec::new(),
        }),
        ..create_params(session_id)
    })
    .await;
    session.hold_lead_turn("lead");
    session.frame(&init());
    let mut limit_hook = helper_call_hook("call-l", None, &json!({"model": "opus"}));
    limit_hook["callback_id"] = json!("sidekicks-helper-limit");
    let mut first_limit_hook = limit_hook.clone();
    first_limit_hook["input"]["tool_use_id"] = json!("call-h");
    session.request("limit-h", &first_limit_hook);
    session.request(
        "hook-l",
        &helper_call_hook("call-l", None, &json!({"model": "opus"})),
    );
    session.request("limit-l", &limit_hook);
    settle().await;
    assert_eq!(recorded_helper_calls(&session), ["call-l"]);
    assert_eq!(
        session.channel.written_answer("limit-l"),
        None,
        "the limit holds the second start"
    );

    session.cancel("limit-l");
    settle().await;
    assert_eq!(recorded_helper_calls(&session), Vec::<String>::new());
}

// A call no start took by its caller's end was denied or interrupted before it ran: the lead's
// are forgotten at its turn-ending `result`, a helper's at its own end, and a helper's call made
// across the lead's `result` still names its helper. Killed by keeping the lead's at the turn's
// end (`call-l` kept), by forgetting a helper's there too (`c` names nothing), and by keeping a
// helper's at its end (`call-e` kept).
#[tokio::test(start_paused = true)]
async fn a_helper_call_no_start_took_is_forgotten_when_its_caller_ends() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.frame(&init());
    session.request(
        "hook-p",
        &helper_call_hook("call-p", None, &json!({"subagent_type": "Explore"})),
    );
    session.frame(&nested_start("p", "call-p", None, None));
    session.request(
        "hook-l",
        &helper_call_hook("call-l", None, &json!({"model": "opus"})),
    );
    for (request_id, call_id) in [("hook-c", "call-c"), ("hook-e", "call-e")] {
        session.request(
            request_id,
            &helper_call_hook(call_id, Some("p"), &json!({"model": "haiku"})),
        );
    }
    settle().await;
    assert_eq!(
        recorded_helper_calls(&session),
        ["call-c", "call-e", "call-l"]
    );

    session.frame(&result(&json!({})));
    settle().await;
    assert_eq!(recorded_helper_calls(&session), ["call-c", "call-e"]);
    session.frame(&nested_start("c", "call-c", Some("p"), None));
    settle().await;
    let started_c = session
        .engine
        .deliveries()
        .into_iter()
        .filter_map(|delivery| delivery.subagent)
        .find(|subagent| subagent.subagent_id.as_str() == "c")
        .expect("c gets its child run");
    assert_eq!(
        started_c.model_id.map(|model| model.as_str().to_owned()),
        Some("haiku".to_owned())
    );

    session.frame(&helper_ended("p", "completed", "done"));
    settle().await;
    assert_eq!(recorded_helper_calls(&session), Vec::<String>::new());
}

// A lead's call its pause denies is never kept, and a held helper's call its renewal denies is
// forgotten. Killed by recording a denied call (`call-q` kept), and by a renewal that forgets
// nothing (`call-r` kept).
#[tokio::test(start_paused = true)]
async fn a_denied_helper_call_is_never_kept() {
    let session = ScriptedSession::new().await;
    let lead = session.hold_lead_turn("lead");
    session.frame(&init());
    session.request(
        "hook-p",
        &helper_call_hook("call-p", None, &json!({"subagent_type": "Explore"})),
    );
    session.frame(&nested_start("p", "call-p", None, None));
    lock(&session.parts.run_controls.pauses).pause_lead(&session.session_id, &lead);
    session.request(
        "hook-q",
        &helper_call_hook("call-q", None, &json!({"model": "opus"})),
    );
    settle().await;
    let denied = session
        .channel
        .written_answer("hook-q")
        .expect("the paused lead's call is answered")
        .to_string();
    assert!(denied.contains(r#""permissionDecision":"deny""#));
    assert_eq!(recorded_helper_calls(&session), Vec::<String>::new());

    lock(&session.parts.run_controls.pauses).pause_helper(&session.session_id, "p");
    session.request(
        "hook-r",
        &helper_call_hook("call-r", Some("p"), &json!({"model": "haiku"})),
    );
    settle().await;
    // Read after the renewal was armed, so it falls due at the latest a renewal's span from here.
    let now = SystemTime::now();
    session.wall_clock.set_now(now);
    assert_eq!(recorded_helper_calls(&session), ["call-r"]);

    session
        .wall_clock
        .set_now(now + CLAUDE_HOOK_HOLD_RENEWAL_AFTER);
    settle().await;
    assert!(
        session.channel.written_answer("hook-r").is_some(),
        "the renewal denies the held call"
    );
    assert_eq!(recorded_helper_calls(&session), Vec::<String>::new());
}

/// The `task_notification` that ends the helper `task_id` with `status`.
pub(in super::super) fn helper_ended(task_id: &str, status: &str, summary: &str) -> Value {
    json!({
        "type": "system",
        "subtype": "task_notification",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": task_id,
        "tool_use_id": "call-1",
        "status": status,
        "summary": summary,
    })
}

// How the daemon answers the helper `agent_id`'s next pre-tool callback.
fn helper_tool_answer(session: &ScriptedSession, agent_id: &str) -> ClaudePauseAnswer {
    lock(&session.parts.run_controls.pauses).answer_before_tool(
        &session.session_id,
        Some(agent_id),
        "helper-tool",
    )
}

// Whether the helper `agent_id`'s next tool use is denied with words holding `words`.
fn is_denied_with(session: &ScriptedSession, agent_id: &str, words: &str) -> bool {
    matches!(
        helper_tool_answer(session, agent_id),
        ClaudePauseAnswer::Answer(ClaudeHookAnswer::Deny { reason }) if reason.contains(words)
    )
}

// A helper's end reads by why the daemon stopped it: a stop from the console is final, a token
// limit stops it with that trigger even when it finished, and Claude Code's own stop reads as
// an interruption. The end is the daemon's own where the console stopped the helper, its pause
// already dropped, or an interrupt holds it. Killed by reading every `stopped` as final, by
// reading the console's stop as an interruption, by leaving a token-limited finish completed,
// by dropping the trigger, by answering the console's stop with another reason's sentence, by
// marking the end of neither the console's stop nor a held helper as the daemon's, and by
// marking every end so.
#[rstest]
#[case::stop_all(
    Some(HelperStopReason::StopAll),
    false,
    "stopped",
    RunStateEntry::Stopped { intended_close: None, trigger: Some(StopTrigger::StopAll) },
    true
)]
#[case::token_limit_stopped(
    Some(HelperStopReason::TokenLimit),
    false,
    "stopped",
    RunStateEntry::Stopped { intended_close: None, trigger: Some(StopTrigger::TokenLimit) },
    false
)]
#[case::token_limit_completed(
    Some(HelperStopReason::TokenLimit),
    false,
    "completed",
    RunStateEntry::Stopped { intended_close: None, trigger: Some(StopTrigger::TokenLimit) },
    false
)]
#[case::held(
    None,
    true,
    "stopped",
    RunStateEntry::Interrupted { intended_close: None, trigger: None },
    true
)]
#[case::own_stop(
    None,
    false,
    "stopped",
    RunStateEntry::Interrupted { intended_close: None, trigger: None },
    false
)]
#[case::own_finish(
    None,
    false,
    "completed",
    RunStateEntry::Completed { intended_close: None },
    false
)]
#[tokio::test(start_paused = true)]
async fn a_helpers_end_reads_by_why_it_was_stopped(
    #[case] stop: Option<HelperStopReason>,
    #[case] is_held: bool,
    #[case] status: &str,
    #[case] expected: RunStateEntry,
    #[case] is_daemon_interrupt_end: bool,
) {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&helper_started("helper", "local_agent", "call-1"));
    settle().await;
    let child_run = session
        .start
        .routes
        .child_run_for(session.session_id, "helper")
        .expect("the helper has its child run");
    let is_stop_all = stop == Some(HelperStopReason::StopAll);
    if let Some(stop) = stop {
        lock(&session.parts.run_controls.pauses).stop_helper(session.session_id, "helper", stop);
    }
    if is_held {
        lock(&session.parts.run_controls.pauses)
            .hold_interrupted_helper(&session.session_id, "helper");
    }

    session.frame(&helper_ended("helper", status, "Reported"));
    settle().await;

    assert_eq!(session.engine.moves_of_run(child_run), [expected]);
    assert_eq!(
        session.engine.daemon_interrupt_ends_of_run(child_run),
        [is_daemon_interrupt_end]
    );
    if is_stop_all {
        assert!(is_denied_with(&session, "helper", "will not be resumed"));
    }
}

// A failed helper keeps its own words and category while its lead completes. Killed by taking
// the child's end from the lead's.
#[tokio::test(start_paused = true)]
async fn a_failed_helper_keeps_its_words_while_the_lead_completes() {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&helper_started("helper", "local_agent", "call-1"));
    settle().await;
    let child_run = session
        .start
        .routes
        .child_run_for(session.session_id, "helper")
        .expect("the helper has its child run");

    session.frame(&helper_ended("helper", "failed", "the build broke"));
    session.frame(&result(&json!({})));
    settle().await;

    let moves = session.engine.run_moves();
    let child_moves: Vec<_> = moves
        .iter()
        .filter(|change| change.run_id == child_run)
        .collect();
    assert!(
        matches!(
            child_moves.as_slice(),
            [change] if change.failure_category == Some(RunFailureCategory::ProviderFailure)
                && matches!(
                    &change.entry,
                    RunStateEntry::Failed { provider_failure_detail: Some(words), .. }
                        if words.as_str() == "the build broke"
                )
        ),
        "{child_moves:?}"
    );
    assert_eq!(
        session.engine.moves_of_run(lead_run),
        [RunStateEntry::Completed {
            intended_close: None
        }]
    );
}

// A helper's new own run clears a stop that is not final, a stop from the console holds, and a
// helper refused again is stopped again for that refusal. Killed by never clearing the stop
// (the token limit's case is denied), by clearing the console's stop, and by clearing after the
// refusal's stop (the refused-again case passes).
#[rstest]
#[case::token_limit(HelperStopReason::TokenLimit, false, None)]
#[case::setup_refused(
    HelperStopReason::SetupRefused { refusal: earlier_refusal() },
    false,
    None
)]
#[case::stop_all(HelperStopReason::StopAll, false, Some("will not be resumed"))]
#[case::refused_again(HelperStopReason::TokenLimit, true, Some("/gone/again.git"))]
#[tokio::test(start_paused = true)]
async fn a_new_own_run_clears_a_stop_that_is_not_final(
    #[case] stop: HelperStopReason,
    #[case] is_refused_again: bool,
    #[case] denial: Option<&str>,
) {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&helper_started("helper", "local_agent", "call-1"));
    session.frame(&helper_ended("helper", "completed", "Reported"));
    settle().await;
    lock(&session.parts.run_controls.pauses).stop_helper(session.session_id, "helper", stop);
    if is_refused_again {
        session.engine.refuse_next_child_run(RunSetupRefusal {
            cause: "the writable root '/gone/again.git' could not be resolved".to_owned(),
            is_posture_rejection: false,
        });
    }

    session.frame(&helper_started("helper", "local_agent", "call-1"));
    settle().await;

    match denial {
        Some(words) => assert!(is_denied_with(&session, "helper", words)),
        None => assert_eq!(
            helper_tool_answer(&session, "helper"),
            ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass)
        ),
    }
}

// An interrupt's hold ends with the helper's run, so the first tool call of its next own run
// passes rather than being held with no `paused` reported. Killed by the hold kept past the end
// (the call is held).
#[tokio::test(start_paused = true)]
async fn an_interrupted_helpers_hold_ends_with_its_run() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&helper_started("helper", "local_agent", "call-1"));
    settle().await;
    lock(&session.parts.run_controls.pauses).hold_interrupted_helper(&session.session_id, "helper");

    session.frame(&helper_ended("helper", "stopped", "Interrupted"));
    session.frame(&helper_started("helper", "local_agent", "call-1"));
    settle().await;

    assert_eq!(
        helper_tool_answer(&session, "helper"),
        ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass)
    );
}

// The refusal a helper's earlier run was stopped for.
fn earlier_refusal() -> RunSetupRefusal {
    RunSetupRefusal {
        cause: "the writable root '/gone/repo.git' could not be resolved".to_owned(),
        is_posture_rejection: false,
    }
}

// A foreground helper whose launcher has not started yet waits on its call under the lead; the
// launcher's answer to that call, held until the launcher starts, writes the helper's end row,
// naming its child run, once the start releases it. Killed by reading a released frame for its
// metering alone (no end row).
#[tokio::test(start_paused = true)]
async fn a_held_frame_that_ends_a_helper_writes_its_end_once_released() {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");
    session.frame(&init());
    let mut nested = nested_start("c", "call-c", Some("p"), None);
    nested["is_backgrounded"] = json!(false);
    session.frame(&nested);
    session.frame(&json!({
        "type": "user",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "agent_id": "p",
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "call-c", "content": "Planned"}],
        },
    }));
    settle().await;
    let waiting_run = session.start.routes.child_run_for(session.session_id, "c");
    assert!(
        waiting_run.is_some(),
        "the waiting helper has its child run"
    );
    assert_eq!(
        lifecycle_rows(&session.engine.deliveries(), "c"),
        [(true, lead_run, waiting_run)]
    );

    session.frame(&nested_start("p", "call-p", None, None));
    settle().await;

    assert_eq!(
        lifecycle_rows(&session.engine.deliveries(), "c"),
        [
            (true, lead_run, waiting_run),
            (false, lead_run, waiting_run)
        ]
    );
}
