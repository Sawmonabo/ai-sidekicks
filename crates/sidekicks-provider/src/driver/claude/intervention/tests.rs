use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;

use super::CLAUDE_INTERRUPT_CANCEL_QUEUED_CAPABILITY;
use crate::driver::claude::hooks::pause::ClaudePauseAnswer;
use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedWrite};
use crate::driver::claude::session::scripted::held_calls::init;
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, settle,
};
use crate::driver::claude::session::transport::declarations::ClaudeHandshakeDeclaration;
use crate::driver::claude::session::transport::user_message::ClaudeWriteDelivery;
use crate::driver::contract::params_and_results::{ProviderRequestAnswer, RespondToRequestParams};
use crate::driver::run_control::{
    ApplyInterventionParams, ApplyInterventionResponse, InterruptPayload, InterruptPendingChoice,
    InterventionResultStatus, SteerPayload,
};
use crate::driver::test_registry::new_message_id;
use crate::port::permission_ask::ProviderPermissionAnswer;
use crate::run::state_entry::RunStateEntry;

fn steer(
    run_id: RunId,
    message_id: &QueueItemId,
    text: &str,
    attachments: Vec<ArtifactId>,
    is_priority: bool,
) -> ApplyInterventionParams {
    ApplyInterventionParams::Steer {
        target_run_id: run_id,
        expected_run_version: SafeInt::new(0).expect("zero is a run version"),
        client_idempotency_key: *message_id,
        payload: SteerPayload {
            content: FreeFormText::new(text.to_owned()).expect("a test message fits"),
            attachments,
            skills: Vec::new(),
            expected_turn_id: None,
            is_priority,
        },
    }
}

fn interrupt(
    run_id: RunId,
    pending: InterruptPendingChoice,
    reorders_waiting: bool,
) -> ApplyInterventionParams {
    ApplyInterventionParams::Interrupt {
        target_run_id: run_id,
        expected_run_version: SafeInt::new(0).expect("zero is a run version"),
        client_idempotency_key: ClientUuid::new(mint_uuid_v7().to_string())
            .expect("a minted UUID is a client key"),
        payload: InterruptPayload {
            pending,
            reorders_waiting,
            reason: None,
        },
    }
}

fn declare_cancel_queued(session: &ScriptedSession) {
    session.start.handshakes.observe_handshake_declaration(
        session.session_id,
        &session.live.provider_session_id,
        ClaudeHandshakeDeclaration {
            capabilities: vec![CLAUDE_INTERRUPT_CANCEL_QUEUED_CAPABILITY.to_owned()],
            ..ClaudeHandshakeDeclaration::default()
        },
    );
}

async fn apply(
    session: &ScriptedSession,
    params: ApplyInterventionParams,
) -> ApplyInterventionResponse {
    session
        .interventions
        .apply_intervention(params)
        .await
        .expect("the intervention applies")
}

// The writes past the control requests: answers and user lines, in order.
fn answers_and_messages(session: &ScriptedSession) -> Vec<ScriptedWrite> {
    session
        .channel
        .writes()
        .into_iter()
        .filter(|write| matches!(write, ScriptedWrite::Answer { .. } | ScriptedWrite::User(_)))
        .collect()
}

// Killed by sending `cancel_queued` on the wrong arm, by a missing `Degraded` where the build
// cannot drop what it holds, by reading a refusal as a failure, and by waiting on a process that
// never answers, or whose input took only part of the request, instead of stopping it.
#[rstest]
#[case::next_turn(
    InterruptPendingChoice::NextTurn,
    false,
    true,
    ScriptedAnswer::Reply(json!({})),
    false,
    (InterventionResultStatus::Applied, None),
    false
)]
#[case::return_to_draft(
    InterruptPendingChoice::ReturnToDraft,
    false,
    true,
    ScriptedAnswer::Reply(json!({})),
    true,
    (InterventionResultStatus::Applied, None),
    false
)]
#[case::reordered_next_turn(
    InterruptPendingChoice::NextTurn,
    true,
    true,
    ScriptedAnswer::Reply(json!({})),
    true,
    (InterventionResultStatus::Applied, None),
    false
)]
#[case::keep_waiting_on_an_older_build(
    InterruptPendingChoice::KeepWaiting,
    false,
    false,
    ScriptedAnswer::Reply(json!({})),
    false,
    (InterventionResultStatus::Degraded, Some("plain-interrupt")),
    false
)]
#[case::refused(
    InterruptPendingChoice::NextTurn,
    false,
    true,
    ScriptedAnswer::Refused,
    false,
    (InterventionResultStatus::Degraded, None),
    false
)]
#[case::unanswered(
    InterruptPendingChoice::NextTurn,
    false,
    true,
    ScriptedAnswer::Deadline,
    false,
    (InterventionResultStatus::Applied, None),
    true
)]
#[case::cut_mid_write(
    InterruptPendingChoice::NextTurn,
    false,
    true,
    ScriptedAnswer::WriteCut,
    false,
    (InterventionResultStatus::Applied, None),
    true
)]
#[tokio::test(start_paused = true)]
async fn an_interrupt_sends_and_answers_as_its_choice_and_the_build_allow(
    #[case] pending: InterruptPendingChoice,
    #[case] reorders_waiting: bool,
    #[case] declares_cancel_queued: bool,
    #[case] answer: ScriptedAnswer,
    #[case] sends_cancel_queued: bool,
    #[case] expected_response: (InterventionResultStatus, Option<&str>),
    #[case] stops_the_process: bool,
) {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    if declares_cancel_queued {
        declare_cancel_queued(&session);
    }
    session.channel.answer("interrupt", answer);

    let response = apply(&session, interrupt(run_id, pending, reorders_waiting)).await;

    let requests = session.control_requests_after_start();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["subtype"], "interrupt");
    assert_eq!(
        requests[0].get("cancel_queued") == Some(&Value::Bool(true)),
        sends_cancel_queued
    );
    assert_eq!(
        (
            response.status,
            response.fallback_action.as_ref().map(FreeFormText::as_str)
        ),
        expected_response
    );
    assert_eq!(
        session.channel.writes().contains(&ScriptedWrite::Terminate),
        stops_the_process
    );
}

// Killed by answering the receipt's ids unparsed, keeping one that names no queue item.
#[tokio::test(start_paused = true)]
async fn an_interrupt_answers_the_queue_items_claude_code_dropped() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    declare_cancel_queued(&session);
    let dropped = new_message_id();
    session.channel.answer(
        "interrupt",
        ScriptedAnswer::Reply(json!({"cancelled": [dropped.to_string(), "no-queue-item"]})),
    );

    let response = apply(
        &session,
        interrupt(run_id, InterruptPendingChoice::ReturnToDraft, false),
    )
    .await;

    assert_eq!(response.canceled, [dropped]);
}

// A helper's or a command's `task_started` in the foreground, by the tool call that started it,
// under the helper `parent_task_id` names where one started it.
fn foreground_task_started(
    task_id: &str,
    task_type: &str,
    tool_use_id: &str,
    parent_task_id: Option<&str>,
) -> Value {
    let mut frame = json!({
        "type": "system",
        "subtype": "task_started",
        "task_id": task_id,
        "task_type": task_type,
        "tool_use_id": tool_use_id,
        "is_backgrounded": false,
    });
    if let Some(parent_task_id) = parent_task_id {
        frame["parent_task_id"] = json!(parent_task_id);
    }
    frame
}

// The calls whose work the session asked to move to the background ahead of its interrupt, sorted.
fn backgrounded_before_interrupt(session: &ScriptedSession) -> Vec<Value> {
    let mut requests = session.control_requests_after_start();
    let last = requests.pop().expect("the interrupt went");
    assert_eq!(last["subtype"], "interrupt");
    let mut backgrounded: Vec<_> = requests
        .iter()
        .map(|request| {
            assert_eq!(request["subtype"], "background_tasks");
            request["tool_use_id"].clone()
        })
        .collect();
    backgrounded.sort_by_key(ToString::to_string);
    backgrounded
}

// Killed by an interrupt that moves no helper to the background first, by the bare request that
// would move the running command too, by moving a helper's helper, and by asking with no helper
// in the foreground.
#[tokio::test(start_paused = true)]
async fn an_interrupt_moves_each_foreground_helper_to_the_background_first() {
    let with_helpers = ScriptedSession::new().await;
    let run_id = with_helpers.hold_lead_turn("lead");
    for (task_id, task_type, tool_use_id, parent_task_id) in [
        ("helper-1", "local_agent", "call-1", None),
        ("helper-2", "local_agent", "call-2", None),
        ("command", "local_bash", "call-3", None),
        ("nested", "local_agent", "call-4", Some("helper-1")),
    ] {
        with_helpers.frame(&foreground_task_started(
            task_id,
            task_type,
            tool_use_id,
            parent_task_id,
        ));
    }
    settle().await;
    apply(
        &with_helpers,
        interrupt(run_id, InterruptPendingChoice::NextTurn, false),
    )
    .await;

    assert_eq!(
        backgrounded_before_interrupt(&with_helpers),
        [json!("call-1"), json!("call-2")]
    );

    let without_helpers = ScriptedSession::new().await;
    let run_id = without_helpers.hold_lead_turn("lead");
    apply(
        &without_helpers,
        interrupt(run_id, InterruptPendingChoice::NextTurn, false),
    )
    .await;
    let requests = without_helpers.control_requests_after_start();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["subtype"], "interrupt");
}

// Killed by forgetting a helper's call only at its `task_notification`, so an interrupt after the
// call's result asks Claude Code to move a helper that already ended, and by a foreground start
// naming a `SendMessage` call already answered waiting on that call, which the interrupt moves.
#[tokio::test(start_paused = true)]
async fn an_interrupt_moves_only_the_helpers_whose_calls_are_still_waited_on() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    session.frame(&foreground_task_started(
        "helper-1",
        "local_agent",
        "call-1",
        None,
    ));
    session.frame(&foreground_task_started(
        "helper-2",
        "local_agent",
        "call-2",
        None,
    ));
    session.frame(&json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "call-1", "content": "done"}],
        },
    }));
    session.frame(&json!({
        "type": "assistant",
        "message": {
            "id": "message-1",
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "send-1", "name": "SendMessage", "input": {}}],
        },
    }));
    session.frame(&json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "send-1", "content": "sent"}],
        },
    }));
    session.frame(&foreground_task_started(
        "helper-1",
        "local_agent",
        "send-1",
        None,
    ));
    settle().await;
    apply(
        &session,
        interrupt(run_id, InterruptPendingChoice::NextTurn, false),
    )
    .await;

    assert_eq!(backgrounded_before_interrupt(&session), [json!("call-2")]);
}

// Killed by sending the interrupt after a helper's move was cut mid-write, which would misframe
// it, or by leaving that process running.
#[tokio::test(start_paused = true)]
async fn a_helper_move_cut_mid_write_stops_the_process_in_place_of_the_interrupt() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    session.frame(&foreground_task_started(
        "helper-1",
        "local_agent",
        "call-1",
        None,
    ));
    settle().await;
    session
        .channel
        .answer("background_tasks", ScriptedAnswer::WriteCut);

    let response = apply(
        &session,
        interrupt(run_id, InterruptPendingChoice::NextTurn, false),
    )
    .await;

    let subtypes: Vec<_> = session
        .control_requests_after_start()
        .iter()
        .map(|request| request["subtype"].clone())
        .collect();
    assert_eq!(subtypes, [json!("background_tasks")]);
    assert!(session.channel.writes().contains(&ScriptedWrite::Terminate));
    assert_eq!(response.status, InterventionResultStatus::Applied);
}

// An interrupt on a helper's run holds that helper at its next tool call, its pause already in
// effect, and stops the commands it runs, not its lead's, sending no interrupt; a stop Claude Code
// never answers degrades the interrupt, the hold kept, and a stop whose write was cut stops the
// process, which ends the command. Killed by no helper arm (an `interrupt` is written), by no hold
// (the call passes), by no mark of the hold's effect (the hold reports a pause), by leaving the
// helper's command running, by stopping the lead's command too, by a failed stop answered
// `Applied` or failing the interrupt, and by a cut stop leaving the process running.
#[rstest]
#[case::stopped(ScriptedAnswer::Reply(json!({})), InterventionResultStatus::Applied)]
#[case::unanswered(ScriptedAnswer::Deadline, InterventionResultStatus::Degraded)]
#[case::cut(ScriptedAnswer::WriteCut, InterventionResultStatus::Applied)]
#[tokio::test(start_paused = true)]
async fn a_helpers_interrupt_holds_it_and_stops_its_commands_its_lead_going_on(
    #[case] stop_answer: ScriptedAnswer,
    #[case] expected_status: InterventionResultStatus,
) {
    let session = ScriptedSession::new().await;
    let lead_run = session.hold_lead_turn("lead");
    let helper_run = session.bind_helper(lead_run, "agent-1");
    session.frame(&foreground_task_started(
        "cmd-1",
        "local_bash",
        "call-1",
        Some("agent-1"),
    ));
    session.frame(&foreground_task_started(
        "cmd-lead",
        "local_bash",
        "call-2",
        None,
    ));
    settle().await;
    let is_cut = matches!(stop_answer, ScriptedAnswer::WriteCut);
    session.channel.answer("stop_task", stop_answer);

    let response = apply(
        &session,
        interrupt(helper_run, InterruptPendingChoice::NextTurn, false),
    )
    .await;

    assert_eq!(response.status, expected_status);
    let requests = session.control_requests_after_start();
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(requests[0]["subtype"], "stop_task");
    assert_eq!(requests[0]["task_id"], "cmd-1");
    assert_eq!(
        session.channel.writes().contains(&ScriptedWrite::Terminate),
        is_cut
    );
    // A stopped process takes the session's pauses with it.
    if is_cut {
        return;
    }
    assert_eq!(
        lock(&session.parts.run_controls.pauses).answer_before_tool(
            &session.session_id,
            Some("agent-1"),
            "r1",
            &mut None,
        ),
        ClaudePauseAnswer::Hold {
            has_taken_effect: false
        }
    );
}

// Killed by taking the session's steer order only after a steer's files are read, which lets a
// later steer with no files overtake one whose files are slow.
#[tokio::test(start_paused = true)]
async fn steers_are_written_in_the_order_handed_over() {
    let session = Arc::new(ScriptedSession::new().await);
    let run_id = session.hold_lead_turn("lead");
    let (first, second) = (new_message_id(), new_message_id());
    let slow_file = session.attachments.slow_file(Duration::from_secs(5));

    let first_steer = tokio::spawn({
        let session = Arc::clone(&session);
        let params = steer(run_id, &first, "first", vec![slow_file], false);
        async move { session.interventions.apply_intervention(params).await }
    });
    tokio::task::yield_now().await;
    let second_steer = tokio::spawn({
        let session = Arc::clone(&session);
        let params = steer(run_id, &second, "second", Vec::new(), false);
        async move { session.interventions.apply_intervention(params).await }
    });
    first_steer
        .await
        .expect("the first steer's task ends")
        .expect("the first steer is written");
    second_steer
        .await
        .expect("the second steer's task ends")
        .expect("the second steer is written");

    let written: Vec<_> = session
        .channel
        .writes()
        .iter()
        .filter_map(|write| write.user_uuid().map(str::to_owned))
        .collect();
    assert_eq!(written, [first.to_string(), second.to_string()]);
}

// Killed by dropping the `now` mark or the person's origin from a `Send now`, and by marking every
// steer `now`.
#[tokio::test(start_paused = true)]
async fn a_send_now_is_written_with_the_now_mark_and_a_plain_steer_without_it() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");

    apply(
        &session,
        steer(run_id, &new_message_id(), "now", Vec::new(), true),
    )
    .await;
    apply(
        &session,
        steer(run_id, &new_message_id(), "next", Vec::new(), false),
    )
    .await;

    let frames = session.channel.user_frames();
    assert_eq!(frames[0]["priority"], "now");
    assert_eq!(frames[0]["origin"], json!({"kind": "human"}));
    assert_eq!(frames[1].get("priority"), None);
    assert_eq!(frames[1]["origin"], json!({"kind": "human"}));
}

// Killed by writing a `Send now` while an ask is open, which would cancel its card, by losing the
// order of the rows held behind it, and by leaving held rows out of what an interrupt that takes
// the waiting messages back answers.
#[tokio::test(start_paused = true)]
async fn a_send_now_waits_for_the_open_ask_and_keeps_the_rows_behind_it() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    let open_ask = json!({
        "subtype": "can_use_tool",
        "tool_name": "Bash",
        "input": {"command": "ls"},
        "tool_use_id": "call-1",
    });
    session.request("ask", &open_ask);
    settle().await;
    let (now, next) = (new_message_id(), new_message_id());

    let held_now = apply(&session, steer(run_id, &now, "now", Vec::new(), true)).await;
    let held_next = apply(&session, steer(run_id, &next, "next", Vec::new(), false)).await;
    assert_eq!(held_now.status, InterventionResultStatus::Applied);
    assert_eq!(held_next.status, InterventionResultStatus::Applied);
    assert_eq!(answers_and_messages(&session), []);

    session
        .parts
        .run_controls
        .respond_to_request(RespondToRequestParams {
            run_id,
            request_id: "ask".to_owned(),
            response: ProviderRequestAnswer::Permission(ProviderPermissionAnswer::Allow {
                correction: None,
                made_rule: None,
                answered_by_rule: None,
            }),
        })
        .await
        .expect("the answer is written");
    settle().await;

    let written = answers_and_messages(&session);
    assert!(matches!(&written[0], ScriptedWrite::Answer { request_id, .. } if request_id == "ask"));
    let ScriptedWrite::User(first) = &written[1] else {
        unreachable!("the held `Send now` follows the answer")
    };
    assert_eq!(first["uuid"], now.to_string());
    let ScriptedWrite::User(second) = &written[2] else {
        unreachable!("the row held behind it follows")
    };
    assert_eq!(second["uuid"], next.to_string());

    let taken_back = ScriptedSession::new().await;
    let run_id = taken_back.hold_lead_turn("lead");
    taken_back.request("ask", &open_ask);
    settle().await;
    let (now, next) = (new_message_id(), new_message_id());
    apply(&taken_back, steer(run_id, &now, "now", Vec::new(), true)).await;
    apply(&taken_back, steer(run_id, &next, "next", Vec::new(), false)).await;

    let response = apply(
        &taken_back,
        interrupt(run_id, InterruptPendingChoice::ReturnToDraft, false),
    )
    .await;

    assert_eq!(response.canceled, [now, next]);
    assert_eq!(taken_back.channel.user_frames(), Vec::<Value>::new());
}

// Killed by recording a written message only once its write returns: Claude Code reports it taken
// first, so the report would name no write and the steer would be left waiting forever.
#[tokio::test(start_paused = true)]
async fn a_steer_taken_before_its_write_returns_is_reported_under_its_run() {
    let session = Arc::new(ScriptedSession::new().await);
    let run_id = session.hold_lead_turn("lead");
    let steered = new_message_id();
    let release_write = session.channel.hold_next_user_write();

    let steering = tokio::spawn({
        let session = Arc::clone(&session);
        let params = steer(run_id, &steered, "steer", Vec::new(), false);
        async move { session.interventions.apply_intervention(params).await }
    });
    settle().await;
    session.frame(&json!({
        "type": "command_lifecycle",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "command_uuid": steered.to_string(),
        "state": "started",
    }));
    settle().await;
    release_write.send(()).expect("the write is still held");
    steering
        .await
        .expect("the steer's task ends")
        .expect("the steer is written");

    assert_eq!(session.ports.taken(), [(steered.to_string(), run_id)]);
    assert!(
        !session
            .start
            .prompts
            .lock()
            .expect("the prompts' lock holds")
            .has_untaken_steer(run_id)
    );
}

// Killed by a choice settled off the session's task that reaches the run engine at once: a frame
// queued on the session before a held `Send now` is released would land after the choice's end.
#[tokio::test(start_paused = true)]
async fn a_released_send_now_settles_its_runs_choice_behind_the_frames_queued_before_it() {
    let session = Arc::new(ScriptedSession::new().await);
    let run_id = session.hold_lead_turn("lead");
    session.request(
        "refusal",
        &json!({
            "subtype": "request_user_dialog",
            "dialog_kind": "refusal_fallback_prompt",
            "payload": {"originalModel": "claude-fable-5", "fallbackModel": "claude-opus-5"},
        }),
    );
    session.request(
        "ask",
        &json!({
            "subtype": "can_use_tool",
            "tool_name": "Bash",
            "input": {"command": "ls"},
            "tool_use_id": "call-1",
        }),
    );
    settle().await;
    apply(
        &session,
        steer(run_id, &new_message_id(), "now", Vec::new(), true),
    )
    .await;
    // The session's task waits on the turn's opening while the next frame queues behind it.
    let release_turn = session.engine.hold_next_turn_start();
    session.frame(&json!({
        "type": "system",
        "subtype": "init",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
    }));
    session.frame(&json!({
        "type": "system",
        "subtype": "informational",
        "level": "warning",
        "content": "queued first",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
    }));
    settle().await;

    let answering = tokio::spawn({
        let session = Arc::clone(&session);
        async move {
            session
                .parts
                .run_controls
                .respond_to_request(RespondToRequestParams {
                    run_id,
                    request_id: "ask".to_owned(),
                    response: ProviderRequestAnswer::Permission(ProviderPermissionAnswer::Allow {
                        correction: None,
                        made_rule: None,
                        answered_by_rule: None,
                    }),
                })
                .await
        }
    });
    settle().await;
    drop(release_turn);
    answering
        .await
        .expect("the answer's task ends")
        .expect("the answer is written");
    settle().await;

    assert!(
        answers_and_messages(&session).contains(&ScriptedWrite::Answer {
            request_id: "refusal".to_owned(),
            answer: json!({"behavior": "cancelled"}),
        })
    );
    let kinds: Vec<_> = session
        .engine
        .deliveries()
        .into_iter()
        .map(|delivery| delivery.kind)
        .collect();
    let queued = kinds.iter().position(|kind| *kind == "sessionNotice");
    let settled = kinds.iter().rposition(|kind| *kind == "unstampedRow");
    assert!(
        matches!((queued, settled), (Some(queued), Some(settled)) if queued < settled),
        "{kinds:?}"
    );
}

// Killed by recording the refusal's end on the interrupt (a second settlement row and a refused
// move), by sending Claude Code's interrupt beside the cancel, by delivering the turn end Claude
// Code sends after the cancel as the run's end, by leaving that turn end held for good, and, with a
// steer written before the dialog and never taken, by carrying the ended run into Claude Code's
// next turn (that turn's end moves the run again).
#[rstest]
#[case::alone(false)]
#[case::after_an_untaken_steer(true)]
#[tokio::test(start_paused = true)]
async fn an_interrupt_of_a_waiting_refusal_answers_claude_code_and_leaves_the_end_to_the_engine(
    #[case] has_untaken_steer: bool,
) {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    if has_untaken_steer {
        apply(
            &session,
            steer(run_id, &new_message_id(), "steer", Vec::new(), false),
        )
        .await;
    }
    session.request(
        "refusal",
        &json!({
            "subtype": "request_user_dialog",
            "dialog_kind": "refusal_fallback_prompt",
            "payload": {"originalModel": "claude-fable-5", "fallbackModel": "claude-opus-5"},
        }),
    );
    settle().await;

    let response = apply(
        &session,
        interrupt(run_id, InterruptPendingChoice::NextTurn, false),
    )
    .await;
    settle().await;
    let is_held_before_the_turn_end = session.stream.is_turn_ending_for_interrupt(run_id);
    let turn_end = json!({
        "type": "result",
        "subtype": "success",
        "is_error": false,
        "result": "",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
    });
    session.frame(&init());
    session.frame(&turn_end);
    settle().await;
    let is_held_after_the_turn_end = session.stream.is_turn_ending_for_interrupt(run_id);
    // Claude Code's next turn, which starts with any steer the refused turn left untaken.
    session.frame(&init());
    session.frame(&turn_end);
    settle().await;

    assert_eq!(response.status, InterventionResultStatus::Applied);
    let writes = answers_and_messages(&session);
    assert_eq!(
        writes.last(),
        Some(&ScriptedWrite::Answer {
            request_id: "refusal".to_owned(),
            answer: json!({"behavior": "cancelled"}),
        })
    );
    assert_eq!(
        writes.len(),
        usize::from(has_untaken_steer) + 1,
        "{writes:?}"
    );
    assert!(
        session
            .channel
            .control_requests()
            .iter()
            .all(|request| request["subtype"] != "interrupt")
    );
    assert_eq!(
        session.engine.moves_of_run(run_id),
        [RunStateEntry::WaitingForInput]
    );
    let rows = session
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "unstampedRow")
        .count();
    assert_eq!(rows, 1);
    assert!(is_held_before_the_turn_end);
    assert!(!is_held_after_the_turn_end);
}

// Killed by an interrupt whose refusal cancel was never written that leaves the run's turn end
// held for the interrupt, a missing `release_daemon_end`: the turn end Claude Code then sends would
// never be delivered.
#[tokio::test(start_paused = true)]
async fn an_interrupt_whose_refusal_cancel_is_unsent_holds_no_turn_end() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    session.request(
        "refusal",
        &json!({
            "subtype": "request_user_dialog",
            "dialog_kind": "refusal_fallback_prompt",
            "payload": {"originalModel": "claude-fable-5", "fallbackModel": "claude-opus-5"},
        }),
    );
    settle().await;
    session
        .channel
        .fail_next_answer(ClaudeWriteDelivery::Unsent);

    let interrupted = session
        .interventions
        .apply_intervention(interrupt(run_id, InterruptPendingChoice::NextTurn, false))
        .await;
    settle().await;

    assert!(interrupted.is_err(), "{interrupted:?}");
    assert!(!session.stream.is_turn_ending_for_interrupt(run_id));
}
