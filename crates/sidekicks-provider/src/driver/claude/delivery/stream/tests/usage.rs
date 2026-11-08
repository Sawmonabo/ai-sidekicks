//! What a Claude Code session's usage frames write: retries announced and spent, the account's
//! quota windows, and the spend of the lead and its helpers.

use axum::http::StatusCode;
use jiff::Timestamp;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::event::usage::{
    ApiRetryErrorKind, UsageApiRequestRetriedPayload, UsageCostSource,
};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::failure_cause::RunFailureCause;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio_util::sync::CancellationToken;

use super::{helper_started, init, result};
use crate::bounded_poll::poll_until;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, register_claude_price_list, settle,
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
// `observe_message` adding each reading of one message; `confirm_turn` skipped; a row read from
// `modelUsage`.
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
                    MeteredUsageOwner::Run | MeteredUsageOwner::Session => None,
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

// An assistant message on `model` of `input` and `output` tokens.
fn priced_message(message_id: &str, model: &str, input: u64, output: u64) -> Value {
    json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": message_id,
            "model": model,
            "role": "assistant",
            "content": [{"type": "text", "text": "working"}],
            "usage": {"input_tokens": input, "output_tokens": output},
        },
    })
}

// Killed by pricing from `modelUsage`, which a resumed process starts at its earlier turns' totals
// (5,100,000 first), by subtracting the previous result's figure (25,000 and 25,000), by pricing
// in dollars rather than micro-dollars, by keeping the larger-window mark on an entry's model (each
// turn priced from the table instead), and by charging a turn's rows to one account after its
// account moved. The record writes one cost event per account a priced request's rows name.
#[tokio::test]
async fn each_result_prices_the_spend_it_states_since_the_previous_result() {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let stop = CancellationToken::new();
    let session = ScriptedSession::new().await;
    register_claude_price_list(&session.price_list, &scratch, &stop).await;
    let opus = "claude-opus-5-5[1m]";
    let stated = |input: u64, output: u64, cost_usd: f64, total_usd: f64| {
        result(&json!({
            "model_usage_since_last_result": {opus: {"inputTokens": input,
                "outputTokens": output, "costUSD": cost_usd, "costBasis": "list"}},
            "modelUsage": {opus: {"costUSD": total_usd, "costBasis": "list"}},
        }))
    };

    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&priced_message("message-1", opus, 1_000, 500));
    session.frame(&stated(1_000, 500, 0.10, 5.10));
    poll_until(|| session.usage.priced(), |priced| priced.len() == 1).await;
    session.hold_lead_turn("lead");
    session.frame(&priced_message("message-2", opus, 1_000, 500));
    poll_until(|| session.usage.metered(), |metered| metered.len() == 2).await;
    let moved = ProviderAccountId::new("moved-account".to_owned()).expect("an account id");
    session.usage.charge_to(moved.clone());
    session.frame(&priced_message("message-3", opus, 1_000, 500));
    session.frame(&stated(2_000, 1_000, 0.15, 5.25));
    poll_until(|| session.usage.priced(), |priced| priced.len() == 2).await;
    stop.cancel();

    let first = test_provider_account_id().as_str().to_owned();
    assert_eq!(
        session.usage.priced_shares(),
        [
            (
                UsageCostSource::ProviderReported,
                vec![(first.clone(), 100_000)]
            ),
            (
                UsageCostSource::ProviderReported,
                vec![(first, 75_000), (moved.as_str().to_owned(), 75_000)]
            ),
        ]
    );
}

// A lead `result` stating `input` and `output` tokens on Opus 5.5 at `cost_usd`, naming the steers
// `steers` settles.
fn opus_result(input: u64, output: u64, cost_usd: f64, steers: &[&str]) -> Value {
    result(&json!({
        "user_message_uuids": steers,
        "model_usage_since_last_result": {"claude-opus-5-5": {"inputTokens": input,
            "outputTokens": output, "costUSD": cost_usd, "costBasis": "list"}},
    }))
}

// Killed by pricing only at the turn-ending `result`, which leaves a steer's mid-turn result's
// figure untaken (one request, 25,000 and 25,000).
#[tokio::test]
async fn a_steers_mid_turn_result_prices_the_spend_it_states() {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let stop = CancellationToken::new();
    let session = ScriptedSession::new().await;
    register_claude_price_list(&session.price_list, &scratch, &stop).await;
    session.hold_lead_turn("lead");
    session.stream.mark_now_steer("now-steer");

    session.frame(&init());
    session.frame(&priced_message("message-1", "claude-opus-5-5", 1_000, 500));
    session.frame(&opus_result(1_000, 500, 0.10, &[]));
    poll_until(|| session.usage.priced(), |priced| priced.len() == 1).await;
    session.frame(&priced_message("message-2", "claude-opus-5-5", 1_000, 500));
    session.frame(&opus_result(1_000, 500, 0.05, &["now-steer"]));
    poll_until(|| session.usage.priced(), |priced| priced.len() == 2).await;
    stop.cancel();

    let account = test_provider_account_id().as_str().to_owned();
    assert_eq!(
        session.usage.priced_shares(),
        [
            (
                UsageCostSource::ProviderReported,
                vec![(account.clone(), 100_000)]
            ),
            (UsageCostSource::ProviderReported, vec![(account, 50_000)]),
        ]
    );
}

// Each metered row's owner, binding, model and input and output.
fn metered_rows(session: &ScriptedSession) -> Vec<(bool, RuntimeBindingId, String, u64, u64)> {
    session
        .usage
        .metered()
        .into_iter()
        .map(|metered| {
            let model = metered
                .delta
                .request
                .model_id
                .map(|model| model.as_str().to_owned());
            (
                matches!(metered.owner, MeteredUsageOwner::Run),
                metered.binding_id,
                model.unwrap_or_default(),
                metered.delta.axis_deltas.input.unwrap_or(0),
                metered.delta.axis_deltas.output.unwrap_or(0),
            )
        })
        .collect()
}

// Killed by recording every entry at the session's model, by recording an entry's counts without
// the kept rows taken off (Opus {1,400, 600}), and by recording a row only for a model with no
// message (Opus's figure on the message alone, 20,000).
#[tokio::test]
async fn the_spend_no_message_showed_is_recorded_at_its_model_and_priced() {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let stop = CancellationToken::new();
    let session = ScriptedSession::new().await;
    register_claude_price_list(&session.price_list, &scratch, &stop).await;
    let (opus, sonnet) = ("claude-opus-5-5", "claude-sonnet-5-5");

    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&priced_message("message-1", opus, 1_000, 500));
    session.frame(&result(&json!({"model_usage_since_last_result": {
        opus: {"inputTokens": 1_400, "outputTokens": 600, "costUSD": 0.02, "costBasis": "list"},
        sonnet: {"inputTokens": 3_000, "outputTokens": 200, "costUSD": 0.01, "costBasis": "list"},
    }})));
    poll_until(|| session.usage.priced(), |priced| priced.len() == 2).await;
    stop.cancel();

    let lead = binding_id("lead");
    assert_eq!(
        metered_rows(&session),
        [
            (true, lead.clone(), opus.to_owned(), 1_000, 500),
            (true, lead.clone(), opus.to_owned(), 400, 100),
            (true, lead, sonnet.to_owned(), 3_000, 200),
        ]
    );
    let account = test_provider_account_id().as_str().to_owned();
    assert_eq!(
        session.usage.priced_shares(),
        [
            (
                UsageCostSource::ProviderReported,
                vec![(account.clone(), 15_909), (account.clone(), 4_091)]
            ),
            (UsageCostSource::ProviderReported, vec![(account, 10_000)]),
        ]
    );
}

// Killed by dropping the balance, which records a 400-input row at the second result, by carrying
// the figure no row took to the model's next rows (two requests, 10,000 and 16,000), and by
// dropping it (no request at the second result).
#[tokio::test]
async fn rows_past_their_result_carry_a_balance_and_a_figure_with_no_row_is_recorded_at_once() {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let stop = CancellationToken::new();
    let session = ScriptedSession::new().await;
    register_claude_price_list(&session.price_list, &scratch, &stop).await;
    let opus = "claude-opus-5-5";

    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&priced_message("message-1", opus, 1_000, 500));
    session.frame(&opus_result(600, 500, 0.01, &[]));
    poll_until(|| session.usage.priced(), |priced| priced.len() == 1).await;
    session.hold_lead_turn("lead");
    session.frame(&opus_result(400, 0, 0.002, &[]));
    session.hold_lead_turn("lead");
    session.frame(&priced_message("message-2", opus, 1_000, 500));
    session.frame(&opus_result(1_000, 500, 0.014, &[]));
    // Each row is a request of its own, so the last result is priced once every row is.
    poll_until(
        || (session.usage.metered(), session.usage.priced()),
        |(metered, priced)| {
            let messages =
                (metered.iter()).filter(|row| row.delta.axis_deltas.input == Some(1_000));
            messages.count() == 2 && priced.len() == metered.len()
        },
    )
    .await;
    stop.cancel();

    let lead = binding_id("lead");
    assert_eq!(
        metered_rows(&session),
        [
            (true, lead.clone(), opus.to_owned(), 1_000, 500),
            (true, lead.clone(), opus.to_owned(), 0, 0),
            (true, lead, opus.to_owned(), 1_000, 500),
        ]
    );
    let account = test_provider_account_id().as_str().to_owned();
    let reported = |share: u64| {
        (
            UsageCostSource::ProviderReported,
            vec![(account.clone(), share)],
        )
    };
    assert_eq!(
        session.usage.priced_shares(),
        [reported(10_000), reported(2_000), reported(14_000)]
    );
}

// Killed by pricing a result's rows from the table when it states no figures (a `derivedExact`
// 14,000 first), which the next result's figures would then price again.
#[tokio::test]
async fn a_result_stating_no_figures_leaves_its_rows_for_the_next() {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let stop = CancellationToken::new();
    let session = ScriptedSession::new().await;
    register_claude_price_list(&session.price_list, &scratch, &stop).await;
    let opus = "claude-opus-5-5";

    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&priced_message("message-1", opus, 1_000, 500));
    session.frame(&result(&json!({})));
    session.hold_lead_turn("lead");
    session.frame(&priced_message("message-2", opus, 1_000, 500));
    session.frame(&opus_result(2_000, 1_000, 0.20, &[]));
    poll_until(|| session.usage.priced(), |priced| !priced.is_empty()).await;
    stop.cancel();

    let account = test_provider_account_id().as_str().to_owned();
    assert_eq!(
        session.usage.priced_shares(),
        [(
            UsageCostSource::ProviderReported,
            vec![(account.clone(), 100_000), (account, 100_000)]
        )]
    );
}

// Killed by pricing at once from the list the rows of a model a result leaves out (`derivedExact`
// 14,000), which the next result's entry then records again as spend no message showed (a
// {1,000, 500} row priced 20,000).
#[tokio::test]
async fn a_model_the_result_leaves_out_keeps_its_rows_for_the_result_that_states_them() {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let stop = CancellationToken::new();
    let session = ScriptedSession::new().await;
    register_claude_price_list(&session.price_list, &scratch, &stop).await;
    let opus = "claude-opus-5-5";

    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&priced_message("message-1", opus, 1_000, 500));
    session.frame(&result(&json!({"model_usage_since_last_result": {}})));
    session.hold_lead_turn("lead");
    session.frame(&opus_result(1_000, 500, 0.02, &[]));
    poll_until(|| session.usage.priced(), |priced| !priced.is_empty()).await;
    stop.cancel();

    let lead = binding_id("lead");
    assert_eq!(
        metered_rows(&session),
        [(true, lead, opus.to_owned(), 1_000, 500)]
    );
    let account = test_provider_account_id().as_str().to_owned();
    assert_eq!(
        session.usage.priced_shares(),
        [(UsageCostSource::ProviderReported, vec![(account, 20_000)])]
    );
}

// Killed by leaving a turn's rows unpriced until a restart when its process ends before its
// `result`: they are priced from the price list as the process ends. Killed too by reading
// `not_available` as a region, which holds the request, and by pricing `us` at the base rate.
#[rstest]
#[case::no_region(None, 14_000)]
#[case::global(Some("global"), 14_000)]
#[case::not_available(Some("not_available"), 14_000)]
#[case::us(Some("us"), 15_400)]
#[tokio::test]
async fn a_process_that_ends_before_its_result_prices_its_rows_from_the_list(
    #[case] region: Option<&str>,
    #[case] cost_usd_micros: u64,
) {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let stop = CancellationToken::new();
    let session = ScriptedSession::new().await;
    register_claude_price_list(&session.price_list, &scratch, &stop).await;
    let mut message = priced_message("message-1", "claude-opus-5-5", 1_000, 500);
    if let Some(region) = region {
        message["message"]["usage"]["inference_geo"] = Value::from(region);
    }

    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&message);
    poll_until(|| session.usage.metered(), |metered| metered.len() == 1).await;
    session.exit();
    poll_until(|| session.usage.priced(), |priced| priced.len() == 1).await;
    stop.cancel();

    assert_eq!(
        session.usage.priced_shares(),
        [(
            UsageCostSource::DerivedExact,
            vec![(
                test_provider_account_id().as_str().to_owned(),
                cost_usd_micros
            )]
        )]
    );
}

// Killed by a reroute that marks no model in use, which leaves the list's fetch for the model to
// the first request's miss: a reroute to a model the held copy lacks fetches the list at once.
#[tokio::test]
async fn a_reroute_to_a_model_the_list_lacks_fetches_the_list_at_once() {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let stop = CancellationToken::new();
    let session = ScriptedSession::new().await;
    let server = register_claude_price_list(&session.price_list, &scratch, &stop).await;
    server.script(StatusCode::NOT_MODIFIED, Some(r#"W/"opus""#), b"");

    session.hold_lead_turn("lead");
    session.frame(&init());
    session.frame(&json!({
        "type": "system",
        "subtype": "model_fallback",
        "original_model": "claude-opus-5-5",
        "fallback_model": "claude-haiku-5-5[1m]",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
    }));
    poll_until(|| server.if_none_match(), |sent| sent.len() == 2).await;
    stop.cancel();

    assert_eq!(
        server.if_none_match(),
        [None, Some(r#"W/"opus""#.to_owned())]
    );
}
