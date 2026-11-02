use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_std::mutex_lock::lock;

use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedWrite};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, settle,
};
use crate::driver::run_control::{HelperStopOutcome, HelperStopReason, HelperTokenLimitParams};
use crate::run::state_entry::RunStateEntry;

// The stop of the helper `helper` whose own run is `run_id`.
fn helper_stop(session: &ScriptedSession, run_id: RunId) -> HelperTokenLimitParams {
    HelperTokenLimitParams {
        session_id: session.session_id,
        run_id,
        subagent_id: SubagentId::new("helper".to_owned()).expect("a subagent id"),
    }
}

// A pre-tool callback of the daemon's pause hook, the helper `agent_id`'s where one is named.
fn before_tool(agent_id: Option<&str>) -> Value {
    let mut input = json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_use_id": "call-1",
        "tool_input": {"command": "ls"},
    });
    if let (Some(input), Some(agent_id)) = (input.as_object_mut(), agent_id) {
        input.insert("agent_id".to_owned(), json!(agent_id));
    }
    json!({
        "subtype": "hook_callback",
        "callback_id": "sidekicks-pause-before-tool",
        "input": input,
    })
}

// The answer written to the request `request_id`, if any.
fn answer_to(session: &ScriptedSession, request_id: &str) -> Option<String> {
    session
        .channel
        .writes()
        .into_iter()
        .find_map(|write| match write {
            ScriptedWrite::Answer {
                request_id: answered,
                answer,
            } if answered == request_id => Some(answer.to_string()),
            ScriptedWrite::Answer { .. }
            | ScriptedWrite::Control(_)
            | ScriptedWrite::User(_)
            | ScriptedWrite::Terminate => None,
        })
}

// Whether the answer to `request_id` denies the tool use with the console stop's sentence.
fn is_denied_as_stopped(session: &ScriptedSession, request_id: &str) -> bool {
    answer_to(session, request_id).is_some_and(|answer| {
        answer.contains(r#""permissionDecision":"deny""#)
            && answer.contains(&HelperStopReason::StopAll.sentence())
    })
}

// Killed by a token limit that leaves the helper's next tool use allowed, by one that stops
// the lead too, and by a denial that does not carry the reason the helper reads.
#[tokio::test(start_paused = true)]
async fn a_helper_at_its_token_limit_is_denied_its_next_tool_use() {
    let session = ScriptedSession::new().await;
    let lead = session.hold_lead_turn("lead");
    let helper = session.bind_helper(lead, "helper");
    session
        .parts
        .run_controls
        .stop_helper_at_token_limit(&helper_stop(&session, helper))
        .expect("the session is live");

    session.request("helper-tool", &before_tool(Some("helper")));
    session.request("lead-tool", &before_tool(None));
    settle().await;

    let helper_answer = answer_to(&session, "helper-tool").expect("the hook is answered");
    assert!(helper_answer.contains(r#""permissionDecision":"deny""#));
    assert!(helper_answer.contains(&HelperStopReason::TokenLimit.sentence()));
    assert!(
        !answer_to(&session, "lead-tool")
            .expect("the hook is answered")
            .contains("deny")
    );
}

// A tool use racing the stop is denied while Claude Code has not yet answered it, and the helper's
// end then reads stopped for good, as the daemon's own. Killed by marking the helper after the
// stop is sent, or never (the racing call passes and the end reads interrupted), by a `stop_task`
// naming another task, and by an end not marked as the daemon's.
#[tokio::test(start_paused = true)]
async fn a_helper_stopped_from_the_console_is_denied_and_ends_stopped() {
    let session = ScriptedSession::new().await;
    let lead = session.hold_lead_turn("lead");
    let helper = session.bind_helper(lead, "helper");
    let stop = helper_stop(&session, helper);
    let release = session.channel.hold_next_control("stop_task");

    let (outcome, ()) = tokio::join!(session.parts.run_controls.stop_child_run(&stop), async {
        settle().await;
        session.request("helper-tool", &before_tool(Some("helper")));
        settle().await;
        drop(release);
    });
    session.frame(&json!({
        "type": "system",
        "subtype": "task_notification",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": "helper",
        "tool_use_id": "call-1",
        "status": "stopped",
        "summary": "Stopped",
    }));
    settle().await;

    assert_eq!(
        outcome.expect("the stop is answered"),
        HelperStopOutcome::Stopped
    );
    let requests = session.channel.control_requests();
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(requests[0]["subtype"], "stop_task");
    assert_eq!(requests[0]["task_id"], "helper");
    assert!(is_denied_as_stopped(&session, "helper-tool"));
    assert_eq!(
        session.engine.moves_of_run(helper),
        [RunStateEntry::Stopped {
            intended_close: None,
            trigger: None,
        }]
    );
    assert_eq!(session.engine.daemon_interrupt_ends_of_run(helper), [true]);
}

// A stop answers as Claude Code takes it. Killed by reading a refusal as a failure, by a cut write
// that leaves the process running, by dropping the mark or the pause on a failed stop (the next
// tool use is held, or the pause still holds its call), and, on a paused helper, by keeping the
// pause after the stop or answering the call it held.
#[rstest]
#[case::refused(ScriptedAnswer::Refused, false, Some(HelperStopOutcome::AlreadyEnded))]
#[case::write_cut(ScriptedAnswer::WriteCut, false, Some(HelperStopOutcome::Stopped))]
#[case::deadline(ScriptedAnswer::Deadline, true, None)]
#[case::paused(ScriptedAnswer::Reply(json!({})), true, Some(HelperStopOutcome::Stopped))]
#[tokio::test(start_paused = true)]
async fn a_helper_stop_answers_as_claude_code_takes_it(
    #[case] answer: ScriptedAnswer,
    #[case] is_paused: bool,
    #[case] expected: Option<HelperStopOutcome>,
) {
    let session = ScriptedSession::new().await;
    let lead = session.hold_lead_turn("lead");
    let helper = session.bind_helper(lead, "helper");
    let pauses = &session.parts.run_controls.pauses;
    if is_paused {
        lock(pauses).pause_helper(&session.session_id, "helper");
        session.request("held-tool", &before_tool(Some("helper")));
        settle().await;
    }
    let is_cut = matches!(answer, ScriptedAnswer::WriteCut);
    session.channel.answer("stop_task", answer);

    let outcome = session
        .parts
        .run_controls
        .stop_child_run(&helper_stop(&session, helper))
        .await;

    assert_eq!(outcome.ok(), expected);
    assert_eq!(
        session.channel.writes().contains(&ScriptedWrite::Terminate),
        is_cut
    );
    // A stopped process takes the session's pauses with it.
    if is_cut {
        return;
    }
    session.request("next-tool", &before_tool(Some("helper")));
    settle().await;
    assert!(is_denied_as_stopped(&session, "next-tool"));
    assert_eq!(answer_to(&session, "held-tool"), None);
    let still_held = lock(pauses).resume_helper(&session.session_id, "helper", None);
    assert_eq!(!still_held.is_empty(), is_paused && expected.is_none());
}
