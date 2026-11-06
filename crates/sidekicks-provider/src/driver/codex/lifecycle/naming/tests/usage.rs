//! What a title pass spends, recorded as the session's own and priced at what its start named.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::{
    SESSION_MODEL, TITLE_THREAD, TITLE_TURN, answer_config_read, answer_model_list,
    answer_thread_start, complete_title_turn, filing_over, next_turn_start, start_filed_pass,
};
use crate::driver::codex::lifecycle::tests::usage::{
    GatedUsage, answer_region_read, token_usage_frame,
};
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
use crate::driver::codex::session::side_questions::copy_turn::SessionUsageFiling;
use crate::driver::codex::session::test_fixture::turn_reply;
use crate::driver::ports::DriverPorts;
use crate::port::usage_sink::MeteredUsageOwner;
use crate::pricing::test_fixture::{ListServer, started_list};

/// How long a test on real time waits for a pass to end.
const PASS_WAIT: Duration = Duration::from_secs(10);

// A filing whose rows `usage` records and holds under their keys, since no sign-in kind is read,
// over a list whose fetch runs in `folder` until `stop`; and the list's server, which the caller
// keeps.
pub(super) async fn metered_filing(
    usage: &Arc<GatedUsage>,
    folder: &Path,
    stop: &CancellationToken,
) -> (SessionUsageFiling, Arc<ListServer>) {
    let (price_list, server) = started_list(
        &folder.join("price-list"),
        r#"W/"gpt-5""#,
        br#"{"m1": {"input_cost_per_token": 3e-06},
            "seed-only": {"input_cost_per_token": 2e-06},
            "gpt-5": {"input_cost_per_token": 1.25e-06, "output_cost_per_token": 1e-05}}"#,
        stop,
    )
    .await;
    let ports = DriverPorts::new();
    assert!(ports.usage.register(Arc::clone(usage) as _).is_ok());
    assert!(ports.request_held.register(Arc::clone(usage) as _).is_ok());
    assert!(ports.price_list.register(price_list).is_ok());
    (filing_over(&ports), server)
}

// The usage counts of a reading's `total` or `last`.
fn usage_counts(input: u64, output: u64) -> Value {
    json!({"inputTokens": input, "outputTokens": output, "totalTokens": input + output})
}

// Each row `usage` recorded: its binding, its owner and its input and output deltas.
pub(super) fn recorded_rows(
    usage: &GatedUsage,
) -> Vec<(String, MeteredUsageOwner, Option<u64>, Option<u64>)> {
    lock(&usage.metered)
        .iter()
        .map(|metered| {
            let deltas = &metered.delta.axis_deltas;
            (
                metered.binding_id.as_str().to_owned(),
                metered.owner.clone(),
                deltas.input,
                deltas.output,
            )
        })
        .collect()
}

// The key each request `usage` held is held under: its model, tier and region.
pub(super) fn held_keys(
    usage: &GatedUsage,
) -> Vec<(Option<String>, Option<String>, Option<String>)> {
    lock(&usage.held)
        .iter()
        .map(|held| {
            (
                held.key
                    .model_id
                    .as_ref()
                    .map(|model| model.as_str().to_owned()),
                held.key
                    .speed
                    .as_ref()
                    .map(|speed| speed.as_str().to_owned()),
                held.key
                    .processing_region
                    .as_ref()
                    .map(|region| region.as_str().to_owned()),
            )
        })
        .collect()
}

// Real time, since the list's fetch carries a client timeout a paused clock fires. The title turn's
// one reading is recorded as the session's own on the filing's binding and held under the model and
// tier the start named, the same where the pass asked for no model, as at rest. Killed by the
// reading left unfiled (no row), by owner `Run`, by the tier the start declared left unread (speed
// `None`), and by metering at the model asked for (none at rest, so nothing held).
#[rstest]
#[case::a_live_session_on_its_model(Some(SESSION_MODEL))]
#[case::a_resting_session_on_the_home_s_default(None)]
#[tokio::test]
async fn a_title_pass_records_its_turns_usage_as_the_session_s_spend_at_the_started_tier(
    #[case] session_model: Option<&str>,
) {
    let mut scripted = start_scripted_codex_service();
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let usage = Arc::new(GatedUsage::new(watch::channel(true).1));
    let stop = CancellationToken::new();
    let (filing, _server) = metered_filing(&usage, folder.path(), &stop).await;
    let binding = filing.binding_id.as_str().to_owned();
    let service = Arc::clone(&scripted.service);
    let (pass, mut script) =
        start_filed_pass(CancellationToken::new(), session_model, filing, service);
    answer_config_read(&mut script).await;
    answer_model_list(&mut script, &[SESSION_MODEL]).await;
    answer_thread_start(&mut script, "readOnly").await;
    let turn = next_turn_start(&mut script).await;
    let reading = usage_counts(1_000, 500);
    script.send(&token_usage_frame(TITLE_THREAD, &reading, &reading));
    complete_title_turn(&script, &turn, "A title");
    answer_region_read(&mut scripted).await;

    let drawn = tokio::time::timeout(PASS_WAIT, pass)
        .await
        .expect("the pass ends once its usage is filed")
        .expect("the pass's task ends");
    stop.cancel();

    assert_eq!(drawn.expect("the pass ran").as_deref(), Some("A title"));
    assert_eq!(
        recorded_rows(&usage),
        [(binding, MeteredUsageOwner::Session, Some(1_000), Some(500))]
    );
    assert_eq!(
        held_keys(&usage),
        [(
            Some(SESSION_MODEL.to_owned()),
            Some("priority".to_owned()),
            None
        )]
    );
}

// Real time, as the test above. A reading arrives, the pass is canceled, and the service sends a
// second reading before it answers the interrupt: both are filed. Killed by filing nothing after
// the stop (one row).
#[tokio::test]
async fn a_canceled_title_pass_files_the_readings_received_before_its_interrupt_answered() {
    let mut scripted = start_scripted_codex_service();
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let usage = Arc::new(GatedUsage::new(watch::channel(true).1));
    let stop = CancellationToken::new();
    let (filing, _server) = metered_filing(&usage, folder.path(), &stop).await;
    let cancel = CancellationToken::new();
    let service = Arc::clone(&scripted.service);
    let (pass, mut script) = start_filed_pass(cancel.clone(), Some(SESSION_MODEL), filing, service);
    answer_config_read(&mut script).await;
    answer_model_list(&mut script, &[SESSION_MODEL]).await;
    answer_thread_start(&mut script, "readOnly").await;
    let turn = next_turn_start(&mut script).await;
    script.answer(&turn, &turn_reply(TITLE_TURN));
    let first = usage_counts(1_000, 500);
    script.send(&token_usage_frame(TITLE_THREAD, &first, &first));
    // The first reading's filing reads the region, so it is under way before the cancel.
    answer_region_read(&mut scripted).await;
    cancel.cancel();

    let interrupt = script.next_sent().await;
    assert_eq!(interrupt["method"], "turn/interrupt");
    script.send(&token_usage_frame(
        TITLE_THREAD,
        &usage_counts(1_400, 600),
        &usage_counts(400, 100),
    ));
    script.answer(&interrupt, &json!({}));
    let drawn = tokio::time::timeout(PASS_WAIT, pass)
        .await
        .expect("the pass ends once its stop filed what it received")
        .expect("the pass's task ends");
    stop.cancel();

    assert_eq!(drawn.expect("the pass ran"), None);
    let deltas: Vec<(Option<u64>, Option<u64>)> = recorded_rows(&usage)
        .into_iter()
        .map(|(_binding, _owner, input, output)| (input, output))
        .collect();
    assert_eq!(deltas, [(Some(1_000), Some(500)), (Some(400), Some(100))]);
}
