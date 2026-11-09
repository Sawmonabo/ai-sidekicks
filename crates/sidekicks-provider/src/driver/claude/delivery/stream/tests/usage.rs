//! What a Claude Code session's usage frames write: retries announced and spent, the account's
//! quota windows, and the spend of the lead and its helpers.

use jiff::Timestamp;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::event::usage::{ApiRetryErrorKind, UsageApiRequestRetriedPayload};
use sidekicks_contracts::run::failure_cause::RunFailureCause;
use sidekicks_contracts::wire::integer::SafeInt;

use super::{helper_started, init, result};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
};
use crate::port::usage_sink::{MeteredUsageOwner, ProviderQuotaWindow};
use crate::run::delivery::LateAppendableRow;
use crate::run::state_entry::RunStateEntry;
use crate::runtime_binding::test_store::test_provider_account_id;

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

    let moves = session.engine.moves_of_run(run_id);
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
            test_provider_account_id(),
            vec![
                ProviderQuotaWindow {
                    limit_id: "session".to_owned(),
                    window_mins: Some(300),
                    label: None,
                    used_percent: 25.0,
                    resets_at: at(1_790_125_200),
                },
                ProviderQuotaWindow {
                    limit_id: "weekly_all".to_owned(),
                    window_mins: Some(10_080),
                    label: None,
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

fn usage_message(message_id: &str, agent_id: Option<&str>, input: u64, output: u64) -> Value {
    let mut frame = json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": message_id,
            "role": "assistant",
            "content": [{"type": "text", "text": "working"}],
            "usage": {"input_tokens": input, "output_tokens": output},
        },
    });
    if let (Some(frame), Some(agent_id)) = (frame.as_object_mut(), agent_id) {
        frame.insert("agent_id".to_owned(), Value::from(agent_id));
    }
    frame
}

// Fails when a helper's spend is recorded as the lead's, when a message read twice counts twice,
// when the lead's `result` does not raise its turn to the turn's own `usage`, or when the
// process-wide `modelUsage` is metered. Mutations: `record_metered` dropping the helper's id;
// `observe_message` adding each reading of one message; `confirm_turn` skipped; the `result`
// reading `modelUsage`.
#[tokio::test(start_paused = true)]
async fn a_helpers_usage_records_on_the_helper_and_the_lead_result_confirms_the_lead() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");

    session.frame(&init());
    session.frame(&helper_started("helper", "local_agent", "call-1"));
    session.frame(&usage_message("helper-message", Some("helper"), 100, 20));
    session.frame(&usage_message("lead-message", None, 10, 5));
    session.frame(&usage_message("lead-message", None, 10, 5));
    session.frame(&result(&json!({
        "usage": {"input_tokens": 10, "output_tokens": 8},
        "modelUsage": {"opus": {"inputTokens": 9_999, "outputTokens": 9_999}},
    })));
    settle().await;

    let metered: Vec<_> = session
        .usage
        .metered()
        .into_iter()
        .map(|metered| {
            (
                match metered.owner {
                    MeteredUsageOwner::Helper(subagent_id) => Some(subagent_id.as_str().to_owned()),
                    MeteredUsageOwner::Run | MeteredUsageOwner::SessionCopy => None,
                },
                metered.binding_id,
                metered.delta.axis_deltas.input.unwrap_or(0),
                metered.delta.axis_deltas.output.unwrap_or(0),
            )
        })
        .collect();
    assert_eq!(
        metered,
        [
            (Some("helper".to_owned()), binding_id("lead"), 100, 20),
            (None, binding_id("lead"), 10, 5),
            (None, binding_id("lead"), 0, 3),
        ]
    );
}

// Fails when a turn too long for the window files no row, or files one carrying counts. Mutation:
// the `is_too_long_for_window` check dropped or inverted.
#[tokio::test(start_paused = true)]
async fn a_turn_too_long_for_the_window_files_an_exceeded_row_with_no_counts() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");

    session.frame(&init());
    session.frame(&result(&json!({
        "subtype": "error_during_execution",
        "is_error": true,
        "terminal_reason": "prompt_too_long",
    })));
    settle().await;

    let windows: Vec<_> = session
        .engine
        .deliveries()
        .into_iter()
        .filter_map(|delivery| match delivery.row {
            Some(LateAppendableRow::UsageContextWindowUpdated(window)) => Some(window),
            _ => None,
        })
        .collect();
    assert_eq!(windows.len(), 1);
    let window = &windows[0];
    assert!(window.exceeded);
    assert_eq!(window.run_id, Some(run_id));
    assert_eq!(
        (window.window_used_tokens, window.window_max_tokens),
        (None, None)
    );
}
