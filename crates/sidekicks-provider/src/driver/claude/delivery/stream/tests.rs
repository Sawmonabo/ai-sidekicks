use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;

use super::daemon_ends::ClaudeDaemonEndSettlement;
use crate::driver::claude::hooks::callbacks::UNTIMED_BACKGROUND_REASON;
use crate::driver::claude::hooks::command_capture::tests::register_windows_capture;
use crate::driver::claude::hooks::pause::ClaudeHookAnswer;
use crate::driver::claude::session::scripted::held_calls::{helper_started, init, stand_in};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, settle,
};
use crate::driver::diagnostics::RecordedEvents;
use crate::driver::run_control::HelperStopReason;
use crate::port::command_capture::{
    CaptureCall, CommandWindowEnd, CommandWindowStart, next_call, no_call,
};
use crate::port::run_host::test_host::EngineCall;
use crate::run::delivery::LateAppendableRow;
use crate::run::delivery::RunSetupRefusal;
use crate::run::posture::compose_execution_posture;
use crate::run::state_entry::RunStateEntry;
use crate::run::turn_end::TurnOutcome;

mod exit;
mod held_calls;
mod resume;
mod steers;
mod traces;
mod usage;

pub(super) fn result(members: &Value) -> Value {
    let mut frame = json!({
        "type": "result",
        "subtype": "success",
        "is_error": false,
        "result": "done",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
    });
    if let (Some(frame), Some(members)) = (frame.as_object_mut(), members.as_object()) {
        frame.extend(members.clone());
    }
    frame
}

// An assistant frame calling the tool `tool_name` under `tool_use_id`, the helper `agent_id`'s or,
// with none, the lead's.
pub(super) fn tool_call(
    message_id: &str,
    tool_use_id: &str,
    tool_name: &str,
    agent_id: Option<&str>,
) -> Value {
    let mut frame = json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": message_id,
            "role": "assistant",
            "content": [{"type": "tool_use", "id": tool_use_id, "name": tool_name, "input": {}}],
        },
    });
    if let Some(agent_id) = agent_id {
        frame["agent_id"] = json!(agent_id);
    }
    frame
}

// Killed by reading a frame under the run holding the turn when the session's task reaches it: the
// reader releases the hold as it reads the `result`, so the turn's earlier frames would open a run
// of their own, and the lead run would never end.
#[tokio::test(start_paused = true)]
async fn a_turns_frames_stay_its_runs_after_the_reader_released_its_hold() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");

    session.frame(&init());
    session.frame(&tool_call("message-1", "call-1", "Bash", None));
    session.frame(&result(&json!({})));
    settle().await;

    assert_eq!(session.engine.first_daemon_turn_run(), None);
    assert!(
        session
            .engine
            .calls()
            .contains(&EngineCall::CountStep(run_id))
    );
    assert_eq!(
        session.engine.moves_of_run(run_id),
        [RunStateEntry::Completed {
            intended_close: None
        }]
    );
}

// The turn's opening is the queue item of the message the daemon wrote to open it, and a steer
// opens none. Killed by the opening dropped at the port, and by a steer passed as an opening.
#[rstest]
#[case::an_opening_message(false)]
#[case::only_a_steer(true)]
#[tokio::test(start_paused = true)]
async fn a_turn_opened_by_a_written_message_names_that_messages_item(#[case] is_steer: bool) {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    let item = QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id");
    session
        .start
        .prompts
        .lock()
        .expect("the prompts' lock holds")
        .record_written(session.session_id, run_id, &item.to_string(), is_steer);

    session.frame(&init());
    session.frame(&result(&json!({})));
    settle().await;

    let opening = (!is_steer).then_some(item);
    assert!(
        session
            .engine
            .calls()
            .contains(&EngineCall::StartTurn(run_id, opening)),
        "the turn's start names {opening:?}: {:?}",
        session.engine.calls()
    );
}

// A resume writes every waiting message into one turn, which the oldest opens, as the first of a
// start's messages opens a Codex turn; the newer lands in it as a message of its own. Killed by
// taking the newest message written as the opening.
#[tokio::test(start_paused = true)]
async fn a_turn_taking_two_written_messages_is_opened_by_the_older() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    let older = QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id");
    let newer = QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id");
    {
        let mut prompts = session
            .start
            .prompts
            .lock()
            .expect("the prompts' lock holds");
        prompts.record_written(session.session_id, run_id, &older.to_string(), false);
        prompts.record_written(session.session_id, run_id, &newer.to_string(), false);
    }

    session.frame(&init());
    session.frame(&result(&json!({})));
    settle().await;

    assert!(
        session
            .engine
            .calls()
            .contains(&EngineCall::StartTurn(run_id, Some(older))),
        "the turn's start names the older message: {:?}",
        session.engine.calls()
    );
}

// Killed by a carried turn that writes no turn end, and by ending the run at that turn's end
// rather than at the end of the turn Claude Code starts with the waiting steer.
#[tokio::test(start_paused = true)]
async fn a_turn_ending_with_a_steer_still_waiting_writes_its_end_and_moves_no_run() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    session
        .start
        .prompts
        .lock()
        .expect("the prompts' lock holds")
        .record_written(session.session_id, run_id, "waiting-steer", true);

    session.frame(&init());
    session.frame(&result(&json!({})));
    settle().await;

    assert!(
        session
            .engine
            .calls()
            .contains(&EngineCall::RecordTurnEnd(run_id, TurnOutcome::Completed))
    );
    assert_eq!(session.engine.moves_of_run(run_id), []);
    assert_eq!(
        session
            .start
            .routes
            .lead_run_on(session.session_id)
            .map(|lead| lead.run_id),
        Some(run_id)
    );
}

// Killed by delivering the turn end of a run whose end the daemon already wrote, a second end,
// and by writing no turn end for it.
#[tokio::test(start_paused = true)]
async fn a_turn_ending_after_the_daemon_wrote_the_runs_end_writes_only_the_turn_end() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    session.stream.lock().mark_daemon_end(run_id, true, false);

    session.frame(&init());
    session.frame(&result(&json!({})));
    settle().await;

    assert!(
        session
            .engine
            .calls()
            .contains(&EngineCall::RecordTurnEnd(run_id, TurnOutcome::Completed))
    );
    assert_eq!(session.engine.moves_of_run(run_id), []);
}

// Killed by swapping a release with an interrupt's answer, and by delivering the end the daemon
// confirmed it wrote.
#[rstest]
#[case::answered(
    ClaudeDaemonEndSettlement::Interrupted,
    Some(RunStateEntry::Interrupted { intended_close: None, trigger: None })
)]
#[case::released(
    ClaudeDaemonEndSettlement::Released,
    Some(RunStateEntry::Completed { intended_close: None })
)]
#[case::confirmed(ClaudeDaemonEndSettlement::Confirmed, None)]
#[tokio::test(start_paused = true)]
async fn a_held_turn_end_is_delivered_as_the_daemons_end_settles(
    #[case] settlement: ClaudeDaemonEndSettlement,
    #[case] delivered: Option<RunStateEntry>,
) {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    session.stream.hold_turn_end_for_interrupt(run_id);

    session.frame(&init());
    session.frame(&result(&json!({})));
    settle().await;
    assert_eq!(session.engine.moves_of_run(run_id), []);

    match settlement {
        ClaudeDaemonEndSettlement::Interrupted => session.stream.interrupt_daemon_end(run_id),
        ClaudeDaemonEndSettlement::Released => session.stream.release_daemon_end(run_id),
        ClaudeDaemonEndSettlement::Confirmed => session.stream.confirm_daemon_end(run_id),
    }
    settle().await;

    assert_eq!(
        session.engine.moves_of_run(run_id),
        Vec::from_iter(delivered)
    );
}

// Killed by counting each frame of one message as its own step, by counting a reply with no tool
// call, and by counting a helper's tool call against the lead's bound.
#[tokio::test(start_paused = true)]
async fn a_step_is_one_lead_message_carrying_a_tool_call() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");

    session.frame(&init());
    session.frame(&tool_call("message-1", "call-1", "Bash", None));
    session.frame(&tool_call("message-1", "call-2", "Bash", None));
    session.frame(&json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": "message-2",
            "role": "assistant",
            "content": [{"type": "text", "text": "done"}],
        },
    }));
    session.frame(&json!({
        "type": "system",
        "subtype": "task_started",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": "helper",
        "task_type": "local_agent",
        "tool_use_id": "call-1",
        "is_backgrounded": false,
    }));
    session.frame(&tool_call("message-3", "call-3", "Bash", Some("helper")));
    settle().await;

    let steps: Vec<_> = session
        .engine
        .calls()
        .into_iter()
        .filter(|call| matches!(call, EngineCall::CountStep(_)))
        .collect();
    assert_eq!(steps, [EngineCall::CountStep(run_id)]);
}

// Killed by ending the turn, and failing the run, on Claude Code's abort for a `Send now` steer,
// and by never ending the turn its own `result` ends.
#[tokio::test(start_paused = true)]
async fn only_the_result_naming_a_now_steer_ends_its_turn() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    session.stream.mark_now_steer("now-steer");

    session.frame(&init());
    session.frame(&result(&json!({
        "subtype": "error_during_execution",
        "is_error": true,
        "user_message_uuids": [],
    })));
    settle().await;

    assert_eq!(session.engine.moves_of_run(run_id), []);
    assert_eq!(
        session
            .start
            .routes
            .lead_run_on(session.session_id)
            .map(|lead| lead.run_id),
        Some(run_id)
    );

    session.frame(&result(&json!({"user_message_uuids": ["now-steer"]})));
    settle().await;

    assert_eq!(
        session.engine.moves_of_run(run_id),
        [RunStateEntry::Completed {
            intended_close: None
        }]
    );
}

// Killed by settling every turn the engine could not number under one version: a run's second
// such turn would be taken for its first, already settled, and its end dropped.
#[tokio::test(start_paused = true)]
async fn each_unnumbered_turn_of_a_run_settles_its_own_end() {
    let session = ScriptedSession::new().await;
    session.engine.leave_turns_unnumbered();
    let run_id = session.hold_lead_turn("lead");
    session
        .start
        .prompts
        .lock()
        .expect("the prompts' lock holds")
        .record_written(session.session_id, run_id, "waiting-steer", true);
    session.frame(&init());
    session.frame(&result(&json!({})));
    settle().await;

    session.frame(&init());
    session.frame(&json!({
        "type": "command_lifecycle",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "command_uuid": "waiting-steer",
        "state": "started",
    }));
    session.frame(&result(&json!({})));
    settle().await;

    assert_eq!(
        session.engine.moves_of_run(run_id),
        [RunStateEntry::Completed {
            intended_close: None
        }]
    );
}

// Killed by reporting every frame no daemon run holds (`record_unheld` logging past its
// once-reported set): a kind the build sends on every turn would log once per frame.
#[tokio::test(start_paused = true)]
async fn a_frame_no_run_holds_is_reported_once_per_kind_and_adds_nothing() {
    let session = ScriptedSession::new().await;
    let recorded = RecordedEvents::default();
    let recording = recorded.record_until_dropped();

    // Only a turn's `system/init` opens a run of the session's own; any other frame stays unheld.
    session.frame(&tool_call("message-1", "call-1", "Bash", None));
    session.frame(&tool_call("message-2", "call-2", "Bash", None));
    settle().await;
    drop(recording);

    assert_eq!(
        recorded.field_on("driver.normalize.unmappedWireKind", "raw_wire_type"),
        ["assistant"]
    );
    assert_eq!(session.engine.calls(), []);
}

// Killed by a router that reads an unlisted family as connection-scoped, by a reader that writes
// a quarantined frame onto the run holding the turn, and by reporting every frame of the family.
#[tokio::test(start_paused = true)]
async fn an_unlisted_frame_family_is_quarantined_once_and_adds_nothing() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let unlisted = json!({
        "type": "system",
        "subtype": "brand_new",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
    });

    let recorded = RecordedEvents::default();
    recorded.record_during(|| {
        session.frame(&unlisted);
        session.frame(&unlisted);
    });
    settle().await;

    assert_eq!(
        recorded.field_on("driver.threadRouter.quarantined", "raw_wire_type"),
        ["system/brand_new"]
    );
    assert_eq!(session.engine.calls(), []);
}

// Killed by quarantining a `result` whose subtype the census does not list (the `result/` arm of
// `ClaudeWireFrameKind::read` dropped) or that carries none (its bare-`result` arm dropped): the
// run would stay running with nothing holding the turn; by ending it completed or twice; and by
// reporting it on every such frame.
#[rstest]
#[case::unlisted_subtype(
    result(&json!({"subtype": "error_unlisted"})),
    "error_unlisted: done",
    "result/error_unlisted"
)]
#[case::no_subtype(
    json!({"type": "result", "session_id": SCRIPTED_PROVIDER_SESSION_ID}),
    "result with no subtype",
    "result"
)]
#[tokio::test(start_paused = true)]
async fn a_result_of_an_unlisted_subtype_or_none_fails_its_run_once_and_is_reported_once(
    #[case] frame: Value,
    #[case] detail: &str,
    #[case] raw_wire_type: &str,
) {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    let recorded = RecordedEvents::default();
    let recording = recorded.record_until_dropped();

    session.frame(&init());
    session.frame(&frame);
    settle().await;
    drop(recording);

    let moves = session.engine.moves_of_run(run_id);
    assert!(
        matches!(
            moves.as_slice(),
            [RunStateEntry::Failed { provider_failure_detail: Some(failed), .. }]
                if failed.as_str() == detail
        ),
        "{moves:?}"
    );
    assert!(!session.start.routes.is_turn_held(session.session_id));
    assert_eq!(
        recorded.field_on("driver.normalize.unmappedWireKind", "raw_wire_type"),
        [raw_wire_type]
    );
}

// The pre-tool hook of the `tool_name` call `tool_use_id`, the helper `agent_id`'s or, with none,
// the lead's.
fn before_tool(tool_name: &str, tool_use_id: &str, agent_id: Option<&str>) -> Value {
    let mut input = json!({
        "hook_event_name": "PreToolUse",
        "tool_name": tool_name,
        "tool_use_id": tool_use_id,
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

// A helper whose run the daemon refused after Claude Code started it stays bound to that ended run
// and is denied its next tool use with the refusal's sentence, which names the setup's own cause,
// while the lead's next call passes. Killed by leaving the refused helper's route unbound, by not
// recording its stop, by stopping it with the token limit's sentence, and by a sentence that drops
// the setup's cause.
#[tokio::test(start_paused = true)]
async fn a_refused_helper_is_denied_its_next_tool_use_and_the_lead_goes_on() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let refusal = RunSetupRefusal {
        cause: "the writable root '/gone/repo.git' could not be resolved".to_owned(),
        is_posture_rejection: true,
    };
    let refused = session.engine.refuse_next_child_run(refusal.clone());

    session.frame(&init());
    session.frame(&helper_started("helper", "local_agent", "call-1"));
    settle().await;
    session.request(
        "helper-tool",
        &before_tool("Bash", "call-2", Some("helper")),
    );
    session.request("lead-tool", &before_tool("Bash", "call-2", None));

    assert_eq!(
        session
            .start
            .routes
            .child_run_for(session.session_id, "helper"),
        Some(refused),
        "the refused helper's frames reach its ended run"
    );
    let helper_answer = session.channel.answer_to("helper-tool").await.to_string();
    assert!(helper_answer.contains(r#""permissionDecision":"deny""#));
    assert!(helper_answer.contains(&HelperStopReason::SetupRefused { refusal }.sentence()));
    assert!(helper_answer.contains("/gone/repo.git"));
    assert!(!helper_answer.contains(&HelperStopReason::TokenLimit.sentence()));
    assert!(
        !session
            .channel
            .answer_to("lead-tool")
            .await
            .to_string()
            .contains("deny")
    );
}

// A helper start, the lead's or a helper's, is checked against the live session's own posture:
// denied with the refusal's cause while its writable root is gone, passed once the root is back.
// Killed by checking no posture in the session's task, and by not taking the checked route.
#[tokio::test(start_paused = true)]
async fn a_helper_start_is_checked_against_the_live_posture() {
    let session = ScriptedSession::new().await;
    let folder = tempfile::tempdir().expect("a temporary folder");
    let root = folder.path().join("repo");
    let sandboxed_over_root = compose_execution_posture(
        PermissionLevel::Sandboxed,
        FilesystemPath::new(root.to_string_lossy().into_owned()).expect("a valid path"),
    );
    lock(&session.live.settings).execution_posture = Some(sandboxed_over_root);
    session.frame(&init());

    session.request("gone-start", &before_tool("Agent", "call-2", None));
    let refused = session.channel.answer_to("gone-start").await.to_string();
    assert!(refused.contains(r#""permissionDecision":"deny""#));
    assert!(refused.contains("Not started: this session's permission level cannot run right now"));

    std::fs::create_dir(&root).expect("the root is made");
    session.request(
        "back-start",
        &before_tool("Agent", "call-2", Some("helper")),
    );
    assert!(
        !session
            .channel
            .answer_to("back-start")
            .await
            .to_string()
            .contains("deny")
    );
}

// Killed by classifying the lead `result` before the conversation file is read to its end: the
// goal would still read active with no record, so the turn would post `goalCheckUnfinished`, and
// the completion only at the next turn's end; and by the goal line also delivered as a message.
#[tokio::test(start_paused = true)]
async fn a_goal_met_just_before_the_result_reads_complete_and_no_unfinished_check() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": "goal-line",
            "role": "assistant",
            "content": [{"type": "text", "text": "Goal set: ship it"}],
        },
    }));
    settle().await;
    let (_, home) = session
        .live
        .spawn_bound_legs
        .spawn_environment
        .iter()
        .find(|(name, _)| name == "HOME")
        .expect("the fixture names Claude Code's home");
    let project = std::path::Path::new(home).join(".claude/projects/work");
    std::fs::create_dir_all(&project).expect("the project folder is made");
    let record = json!({
        "type": "attachment",
        "attachment": {"type": "goal_status", "met": true, "condition": "ship it"},
    });
    std::fs::write(
        project.join(format!("{}.jsonl", session.live.provider_session_id)),
        format!("{record}\n"),
    )
    .expect("the conversation is written");

    session.frame(&result(&json!({})));
    settle().await;

    let goal_rows: Vec<Value> = session
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| matches!(delivery.kind, "sessionEvent" | "sessionNotice"))
        .filter_map(|delivery| delivery.payload)
        .filter(|row| {
            row.get("status").is_some()
                || matches!(
                    row["kind"].as_str(),
                    Some("goalNotMet" | "goalCheckUnfinished")
                )
        })
        .collect();
    assert_eq!(
        goal_rows
            .iter()
            .map(|row| (row["goal"]["text"].clone(), row["status"].clone()))
            .collect::<Vec<_>>(),
        [
            (json!("ship it"), json!("active")),
            (json!("ship it"), json!("complete")),
        ]
    );
    assert!(
        !session
            .engine
            .deliveries()
            .iter()
            .any(|delivery| matches!(delivery.row, Some(LateAppendableRow::AgentMessageSent(_)))),
        "the goal line is no message of the agent's"
    );
}

/// A session whose command windows open through a capture that lets every open through, with
/// the lead's turn held, its process started and, where `helper` names one, that helper started;
/// the `PowerShell` call `call-2` of `helper` or the lead has its window open and its hook
/// answered. Answers the receiver the capture's calls arrive on.
pub(crate) async fn session_with_open_window(
    helper: Option<&str>,
) -> (
    ScriptedSession,
    tokio::sync::mpsc::UnboundedReceiver<CaptureCall>,
) {
    let session = ScriptedSession::new().await;
    let (_opens, held) = watch::channel(Some(true));
    let windows = &session.parts.establishment.task_services.command_windows;
    let mut called = register_windows_capture(windows, held);
    session.hold_lead_turn("lead");
    session.frame(&init());
    if let Some(helper) = helper {
        session.frame(&helper_started(helper, "local_agent", "call-1"));
        settle().await;
    }
    session.request("pre", &before_tool("PowerShell", "call-2", helper));
    assert_eq!(next_call(&mut called).await, CaptureCall::Open(1));
    assert_eq!(next_call(&mut called).await, CaptureCall::Began(1, true));
    session.channel.answer_to("pre").await;
    (session, called)
}

/// Which frame settles the call.
#[derive(Clone, Copy, Debug)]
enum SettlingFrame {
    LeadResult,
    HelperResult,
    Refusal,
}

// Killed by no reader, by the reader in one branch only, and by the refusal frame unread.
#[rstest]
#[case::the_leads_result(SettlingFrame::LeadResult, CommandWindowEnd::Untold)]
#[case::a_helpers_result(SettlingFrame::HelperResult, CommandWindowEnd::Untold)]
#[case::a_refusal(SettlingFrame::Refusal, CommandWindowEnd::Unrun)]
#[tokio::test(start_paused = true)]
async fn a_frame_closes_its_window(#[case] settling: SettlingFrame, #[case] end: CommandWindowEnd) {
    let helper = matches!(settling, SettlingFrame::HelperResult).then_some("helper");
    let (session, mut called) = session_with_open_window(helper).await;

    let mut frame = match settling {
        SettlingFrame::LeadResult | SettlingFrame::HelperResult => stand_in("call-2", "Exit 1"),
        SettlingFrame::Refusal => json!({
            "type": "system",
            "subtype": "permission_denied",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "tool_use_id": "call-2",
            "message": "Permission to use PowerShell has been denied.",
        }),
    };
    if let Some(helper) = helper {
        frame["agent_id"] = json!(helper);
    }
    session.frame(&frame);
    settle().await;

    assert_eq!(next_call(&mut called).await, CaptureCall::Close(1, end));
    no_call(&mut called, "a window closed twice").await;
}

// Killed by a background window closed at its result, and by the task frame unread.
#[tokio::test(start_paused = true)]
async fn a_background_call_closes_at_its_task_notification() {
    let (session, mut called) = session_with_open_window(None).await;
    session.request(
        "post",
        &json!({
            "subtype": "hook_callback",
            "callback_id": "sidekicks-capture-after-tool",
            "input": {
                "hook_event_name": "PostToolUse",
                "tool_name": "PowerShell",
                "tool_use_id": "call-2",
                "tool_response": {"backgroundTaskId": "shell-1"},
            },
        }),
    );
    session.channel.answer_to("post").await;
    session.frame(&stand_in("call-2", "Running in the background"));
    settle().await;
    no_call(&mut called, "a background window closed at its result").await;

    session.frame(&json!({
        "type": "system",
        "subtype": "task_notification",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": "shell-1",
        "tool_use_id": "call-2",
        "status": "completed",
    }));
    settle().await;
    assert_eq!(
        next_call(&mut called).await,
        CaptureCall::Close(1, CommandWindowEnd::Untold)
    );
}

// Killed by the route not noting the shell call, and by the background-work refusal's mark not
// taken.
#[cfg(unix)]
#[rstest]
#[case::in_the_foreground(false)]
#[case::refused_in_the_background(true)]
#[tokio::test(start_paused = true)]
async fn a_bash_call_no_wrapper_paired_is_named_at_its_result(#[case] is_refused: bool) {
    let session = ScriptedSession::new().await;
    let (_opens, held) = watch::channel(Some(true));
    let windows = &session.parts.establishment.task_services.command_windows;
    let mut called = register_windows_capture(windows, held);
    session.hold_lead_turn("lead");
    session.frame(&init());
    let mut hook = before_tool("Bash", "call-2", None);
    if is_refused {
        hook["input"]["tool_input"]["run_in_background"] = json!(true);
        let mut background_work = hook.clone();
        background_work["callback_id"] = json!("sidekicks-background-claude");
        session.request("background", &background_work);
        let denied = ClaudeHookAnswer::Deny {
            reason: UNTIMED_BACKGROUND_REASON.to_owned(),
        };
        assert_eq!(
            session.channel.answer_to("background").await,
            serde_json::to_value(denied).expect("an answer serializes")
        );
    }

    session.request("pre", &hook);
    assert_eq!(session.channel.answer_to("pre").await, json!({}));
    session.frame(&stand_in("call-2", "done"));
    settle().await;

    if !is_refused {
        let named = CommandWindowStart {
            session_id: session.session_id,
            apart_run: None,
            command: "ls".to_owned(),
            tool_call_id: Some(ToolCallId::new("call-2".to_owned()).expect("a call id")),
        };
        assert_eq!(next_call(&mut called).await, CaptureCall::Uncovered(named));
    }
    no_call(&mut called, "a call named again, or a refused call named").await;
}
