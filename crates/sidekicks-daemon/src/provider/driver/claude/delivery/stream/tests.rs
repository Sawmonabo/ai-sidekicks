use jiff::Timestamp;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::event::usage::{ApiRetryErrorKind, UsageApiRequestRetriedPayload};
use sidekicks_contracts::run::failure_cause::RunFailureCause;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::integer::SafeInt;

use super::daemon_ends::ClaudeDaemonEndSettlement;
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, settle,
};
use crate::provider::driver::diagnostics::RecordedEvents;
use crate::provider::port::run_host::test_host::EngineCall;
use crate::provider::port::usage_sink::ProviderQuotaWindow;
use crate::provider::run::delivery::LateAppendableRow;
use crate::provider::run::state_entry::RunStateEntry;
use crate::provider::run::turn_end::TurnOutcome;

fn init() -> Value {
    json!({
        "type": "system",
        "subtype": "init",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "model": "opus",
    })
}

fn result(members: &Value) -> Value {
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

fn tool_call(message_id: &str, tool_use_id: &str, agent_id: Option<&str>) -> Value {
    let mut frame = json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": message_id,
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": tool_use_id, "name": "Bash", "input": {"command": "ls"}},
            ],
        },
    });
    if let (Some(frame), Some(agent_id)) = (frame.as_object_mut(), agent_id) {
        frame.insert("agent_id".to_owned(), Value::from(agent_id));
    }
    frame
}

fn moves_of(session: &ScriptedSession, run_id: RunId) -> Vec<RunStateEntry> {
    session
        .engine
        .run_moves()
        .into_iter()
        .filter_map(|delivery| delivery.change)
        .filter(|change| change.run_id == run_id)
        .map(|change| change.entry)
        .collect()
}

// Killed by reading a frame under the run holding the turn when the session's task reaches it: the
// reader releases the hold as it reads the `result`, so the turn's earlier frames would open a run
// of their own, and the lead run would never end.
#[tokio::test(start_paused = true)]
async fn a_turns_frames_stay_its_runs_after_the_reader_released_its_hold() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");

    session.frame(&init());
    session.frame(&tool_call("message-1", "call-1", None));
    session.frame(&result(&json!({})));
    settle().await;

    let calls = session.engine.calls();
    assert!(
        !calls
            .iter()
            .any(|call| matches!(call, EngineCall::StartDaemonTurn(_)))
    );
    assert!(calls.contains(&EngineCall::CountStep(run_id)));
    assert_eq!(
        moves_of(&session, run_id),
        [RunStateEntry::Completed {
            intended_close: None
        }]
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
    assert_eq!(moves_of(&session, run_id), []);
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
    assert_eq!(moves_of(&session, run_id), []);
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
    assert_eq!(moves_of(&session, run_id), []);

    match settlement {
        ClaudeDaemonEndSettlement::Interrupted => session.stream.interrupt_daemon_end(run_id),
        ClaudeDaemonEndSettlement::Released => session.stream.release_daemon_end(run_id),
        ClaudeDaemonEndSettlement::Confirmed => session.stream.confirm_daemon_end(run_id),
    }
    settle().await;

    assert_eq!(moves_of(&session, run_id), Vec::from_iter(delivered));
}

// Killed by counting each frame of one message as its own step, by counting a reply with no tool
// call, and by counting a helper's tool call against the lead's bound.
#[tokio::test(start_paused = true)]
async fn a_step_is_one_lead_message_carrying_a_tool_call() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");

    session.frame(&init());
    session.frame(&tool_call("message-1", "call-1", None));
    session.frame(&tool_call("message-1", "call-2", None));
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
    session.frame(&tool_call("message-3", "call-3", Some("helper")));
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

    assert_eq!(moves_of(&session, run_id), []);
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
        moves_of(&session, run_id),
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
        moves_of(&session, run_id),
        [RunStateEntry::Completed {
            intended_close: None
        }]
    );
}

// Killed by reading only one of Claude Code's two names for its retry announcement, which would
// fail a turn whose retries were spent as a plain provider failure.
#[rstest]
#[case::api_retry("api_retry")]
#[case::api_error("api_error")]
#[tokio::test(start_paused = true)]
async fn a_turn_failing_after_its_last_announced_retry_fails_as_retries_spent(
    #[case] subtype: &str,
) {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");

    session.frame(&init());
    session.frame(&json!({
        "type": "system",
        "subtype": subtype,
        "attempt": 10,
        "max_retries": 10,
        "retry_delay_ms": 0,
        "error_status": 529,
        "error": "overloaded",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
    }));
    session.frame(&result(&json!({
        "subtype": "error_during_execution",
        "is_error": true,
    })));
    settle().await;

    let moves = moves_of(&session, run_id);
    assert!(
        matches!(
            moves.as_slice(),
            [RunStateEntry::Failed {
                failure_cause: Some(RunFailureCause::RetriesExhausted { .. }),
                ..
            }]
        ),
        "{moves:?}"
    );
}

// Killed by dropping the event's windows, by reading a share as a percent, by a wrong window length
// or reset, and by reading the event only while a run holds the session's turn.
#[tokio::test(start_paused = true)]
async fn a_rate_limit_event_hands_the_accounts_quota_windows_to_the_usage_record() {
    let session = ScriptedSession::new().await;

    session.frame(&json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "allowed_warning",
            "resetsAt": 1_790_524_800,
            "rateLimitType": "seven_day",
            "utilization": 0.54,
            "unifiedWindows": {
                "five_hour": {"utilization": 0.25, "resetsAt": 1_790_125_200},
                "seven_day": {"utilization": 0.5, "resetsAt": 1_790_524_800},
            },
        },
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
    }));
    settle().await;

    let at = |seconds| Some(Timestamp::from_second(seconds).expect("the instant is in range"));
    assert_eq!(
        session.usage.quota_windows(),
        [(
            None,
            vec![
                ProviderQuotaWindow {
                    limit_id: "session".to_owned(),
                    window_mins: 300,
                    used_percent: 25.0,
                    resets_at: at(1_790_125_200),
                },
                ProviderQuotaWindow {
                    limit_id: "weekly_all".to_owned(),
                    window_mins: 10_080,
                    used_percent: 50.0,
                    resets_at: at(1_790_524_800),
                },
            ]
        )]
    );
}

// Killed by an `api_retry` frame that writes no row, or one for each of its reads, by a cause,
// wait or attempt read from the wrong member, by a cause the vocabulary names read as `unknown`
// (`account_on_hold`), and by an `api_error` frame read as a retry too.
#[rstest]
#[case::overloaded("overloaded", ApiRetryErrorKind::Overloaded)]
#[case::account_on_hold("account_on_hold", ApiRetryErrorKind::AccountOnHold)]
#[tokio::test(start_paused = true)]
async fn each_api_retry_frame_writes_one_retried_request_with_its_cause_wait_and_attempt(
    #[case] error: &str,
    #[case] error_kind: ApiRetryErrorKind,
) {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    let retry = |subtype: &str| {
        json!({
            "type": "system",
            "subtype": subtype,
            "attempt": 2,
            "max_retries": 10,
            "retry_delay_ms": 1_500,
            "error_status": 529,
            "error": error,
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        })
    };

    session.frame(&retry("api_retry"));
    session.frame(&retry("api_error"));
    settle().await;

    let rows: Vec<_> = session
        .engine
        .deliveries()
        .into_iter()
        .filter_map(|delivery| delivery.row)
        .collect();
    assert_eq!(
        rows,
        [LateAppendableRow::UsageApiRequestRetried(
            UsageApiRequestRetriedPayload {
                session_id: session.session_id,
                run_id: Some(run_id),
                provider: DESCRIPTOR.provider_id(),
                error_kind,
                retry_delay_ms: SafeInt::new(1_500),
                attempt: SafeInt::new(2),
                source_epoch: None,
                source_position: None,
            }
        )]
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
    session.frame(&tool_call("message-1", "call-1", None));
    session.frame(&tool_call("message-2", "call-2", None));
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

    let moves = moves_of(&session, run_id);
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
