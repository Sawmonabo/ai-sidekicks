//! A session's metered spend and its resting copies', recorded through the usage sink and priced
//! as it is recorded, and the models a session moves to marked in use.

use std::error::Error;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_std::mutex_lock::lock;
use tempfile::TempDir;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::super::intake::USAGE_RECORDER_QUEUE;
use super::{LiveCodexSession, TEST_TURN, driver_holding};
use crate::bounded_poll::poll_until;
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, bind_test_listener, start_scripted_codex_service,
};
use crate::driver::codex::session::side_questions::test_copies::{
    CopyTurnEnding, read_only_profile, resting_question, resting_session, serve_copy,
};
use crate::driver::codex::session::test_fixture::TEST_THREAD;
use crate::driver::ports::{HeldRequest, RequestHeldListener};
use crate::driver::session_control::ExportHandoverBriefParams;
use crate::driver::test_registry::{TestProviderAccounts, new_session_id};
use crate::driver::{CurrentProviderAccount, ProviderAccountReader};
use crate::port::usage_sink::{
    MeteredUsage, PricedRequest, ProviderQuotaWindow, RecordedUsage, UsageSink,
};
use crate::pricing::test_fixture::started_list;
use crate::runtime_binding::store::mint_runtime_binding_id;
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::usage_delta_accountant::UsageAxisCounts;

/// A usage record that records nothing until its gate opens, then records each delta in arrival
/// order as a row of its own, counting each delta it was handed, and keeps each row recorded,
/// each priced request and each request handed to the repricing.
pub(crate) struct GatedUsage {
    gate: watch::Receiver<bool>,
    handed: AtomicUsize,
    pub(crate) metered: Mutex<Vec<MeteredUsage>>,
    pub(crate) costs: Mutex<Vec<PricedRequest>>,
    pub(crate) held: Mutex<Vec<HeldRequest>>,
}

impl GatedUsage {
    /// A record whose gate `gate` opens.
    pub(crate) fn new(gate: watch::Receiver<bool>) -> Self {
        Self {
            gate,
            handed: AtomicUsize::new(0),
            metered: Mutex::default(),
            costs: Mutex::default(),
            held: Mutex::default(),
        }
    }

    // The input delta of each row recorded, in order.
    fn input_deltas(&self) -> Vec<Option<u64>> {
        lock(&self.metered)
            .iter()
            .map(|metered| metered.delta.axis_deltas.input)
            .collect()
    }
}

impl UsageSink for GatedUsage {
    fn record_metered(
        &self,
        metered: MeteredUsage,
    ) -> BoxFuture<'_, Result<Option<RecordedUsage>, Box<dyn Error + Send + Sync>>> {
        async move {
            let row = self.handed.fetch_add(1, Ordering::Relaxed);
            let mut gate = self.gate.clone();
            gate.wait_for(|is_open| *is_open)
                .await
                .expect("the test holds the gate open");
            lock(&self.metered).push(metered);
            Ok(Some(RecordedUsage {
                event_id: FreeFormText::new(format!("event-{row}")).expect("an event id"),
                run_id: None,
                provider_account_id: test_provider_account_id(),
                subagent_id: None,
            }))
        }
        .boxed()
    }

    fn record_cost(
        &self,
        request: PricedRequest,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.costs).push(request);
        async { Ok(()) }.boxed()
    }

    fn record_quota_windows(
        &self,
        _provider: ProviderId,
        _provider_account_id: ProviderAccountId,
        _windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Ok(()) }.boxed()
    }

    fn record_whole_quota_windows(
        &self,
        _provider: ProviderId,
        _provider_account_id: ProviderAccountId,
        _windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Ok(()) }.boxed()
    }

    fn read_prior_emitted(
        &self,
        _session_id: SessionId,
        _thread_id: String,
    ) -> BoxFuture<'_, Result<UsageAxisCounts, Box<dyn Error + Send + Sync>>> {
        async { Ok(UsageAxisCounts::default()) }.boxed()
    }

    fn read_thread_speed_at(
        &self,
        _session_id: SessionId,
        _at: sidekicks_contracts::wire::instant::WireInstant,
    ) -> BoxFuture<'_, Result<Option<String>, Box<dyn Error + Send + Sync>>> {
        async { Ok(None) }.boxed()
    }

    fn read_run_at(
        &self,
        _session_id: SessionId,
        _at: sidekicks_contracts::wire::instant::WireInstant,
    ) -> BoxFuture<
        '_,
        Result<Option<sidekicks_contracts::run::id::RunId>, Box<dyn Error + Send + Sync>>,
    > {
        async { Ok(None) }.boxed()
    }
}

impl RequestHeldListener for GatedUsage {
    fn request_held(
        &self,
        held: HeldRequest,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.held).push(held);
        async { Ok(()) }.boxed()
    }
}

/// A `thread/tokenUsage/updated` frame on `thread_id` and the test's turn with the conversation's
/// `total` and the last request's `last`.
pub(crate) fn token_usage_frame(thread_id: &str, total: &Value, last: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": thread_id,
            "turnId": TEST_TURN,
            "tokenUsage": { "total": total, "last": last, "modelContextWindow": 258_400 },
        },
    })
}

/// Answers the recorder's region read on `scripted` with no base URL set: the API's own host, no
/// region.
pub(crate) async fn answer_region_read(scripted: &mut ScriptedCodexService) {
    let request = scripted.next_request("config/read").await;
    scripted
        .script
        .answer(&request, &json!({ "config": {}, "origins": {} }));
}

// More reports than the recorder's queue holds, metered while the sink is stalled, are each
// recorded once the sink moves, in metering order. Killed by a full queue that drops a batch, and
// by recording the batches out of order.
#[tokio::test]
async fn a_stalled_sink_loses_no_metered_spend_and_records_it_in_order() {
    let mut live = LiveCodexSession::start(&[]).await;
    tokio::time::pause();
    let (open, gate) = watch::channel(false);
    let usage = Arc::new(GatedUsage::new(gate));
    assert!(
        live.driver
            .ports
            .usage
            .register(Arc::clone(&usage) as _)
            .is_ok()
    );
    // Report k carries k tokens more than the one before.
    let reports = u64::try_from(USAGE_RECORDER_QUEUE).expect("the queue's size fits") + 8;
    let mut total = 0;
    for report in 1..=reports {
        total += report;
        live.scripted.script.send(&token_usage_frame(
            TEST_THREAD,
            &json!({"inputTokens": total, "outputTokens": 0, "totalTokens": total}),
            &json!({"inputTokens": report, "outputTokens": 0, "totalTokens": report}),
        ));
    }
    answer_region_read(&mut live.scripted).await;
    // The paused clock moves only once every task waits, so the session's task has metered every
    // report it can, past the queue's room, and waits on the full queue.
    tokio::time::sleep(Duration::from_millis(10)).await;
    let handed_while_stalled = usage.handed.load(Ordering::Relaxed);
    open.send_replace(true);

    let expected: Vec<Option<u64>> = (1..=reports).map(Some).collect();
    poll_until(
        || usage.input_deltas(),
        |deltas| deltas.len() >= expected.len(),
    )
    .await;
    // The sink held the first delta alone while stalled.
    assert_eq!(handed_while_stalled, 1);
    assert_eq!(usage.input_deltas(), expected);
}

// Probe 11's frames on a plan sign-in: a `last` with `total` T, the same frame again, then the
// compaction's `last` with `total` grown. The repeat records no row, and each other request is
// priced once at the standard rates as it is recorded. Killed by pricing every `last`.
#[tokio::test]
async fn a_total_that_did_not_grow_records_and_prices_nothing() {
    let mut live = LiveCodexSession::start(&[]).await;
    let usage = Arc::new(GatedUsage::new(watch::channel(true).1));
    let accounts = Arc::new(TestProviderAccounts::new(
        CurrentProviderAccount::NoneRegistered,
    ));
    accounts.set_sign_in_kind(Some(ProviderAuthMode::OauthSubscription));
    let scratch = TempDir::new().expect("a scratch folder");
    let stop = CancellationToken::new();
    let (price_list, _server) = started_list(
        &scratch.path().join("price-list"),
        r#"W/"gpt-5""#,
        br#"{"m1": {"input_cost_per_token": 3e-06},
            "seed-only": {"input_cost_per_token": 2e-06},
            "gpt-5": {"input_cost_per_token": 1.25e-06, "output_cost_per_token": 1e-05}}"#,
        &stop,
    )
    .await;
    let ports = &live.driver.ports;
    assert!(ports.usage.register(Arc::clone(&usage) as _).is_ok());
    assert!(ports.request_held.register(Arc::clone(&usage) as _).is_ok());
    assert!(ports.price_list.register(price_list).is_ok());
    assert!(
        ports
            .provider_accounts
            .register(accounts as Arc<dyn ProviderAccountReader>)
            .is_ok()
    );

    let counts = |input: u64, output: u64| {
        let total = input + output;
        json!({"inputTokens": input, "outputTokens": output, "totalTokens": total})
    };
    let first = token_usage_frame(TEST_THREAD, &counts(1_000, 100), &counts(1_000, 100));
    live.scripted.script.send(&first);
    live.scripted.script.send(&first);
    live.scripted.script.send(&token_usage_frame(
        TEST_THREAD,
        &counts(3_000, 300),
        &counts(2_000, 200),
    ));
    answer_region_read(&mut live.scripted).await;

    poll_until(|| lock(&usage.costs).len(), |priced| *priced >= 2).await;
    stop.cancel();
    assert_eq!(usage.input_deltas(), [Some(1_000), Some(2_000)]);
    let costs: Vec<(UsageCostSource, Vec<u64>)> = lock(&usage.costs)
        .iter()
        .map(|request| {
            let shares = request.rows.iter().map(|row| row.cost_usd_micros.0.get());
            (request.cost_source, shares.collect())
        })
        .collect();
    assert_eq!(
        costs,
        [
            (UsageCostSource::DerivedExact, vec![2_250]),
            (UsageCostSource::DerivedExact, vec![4_500]),
        ]
    );
    assert!(lock(&usage.held).is_empty());
}

// Killed by a reroute that marks no model in use, which leaves the list's fetch for the model to
// the first request's miss: a reroute to a model the held copy lacks fetches the list at once.
#[tokio::test]
async fn a_reroute_to_a_model_the_list_lacks_fetches_the_list_at_once() {
    let live = LiveCodexSession::start(&[]).await;
    let scratch = TempDir::new().expect("a scratch folder");
    let stop = CancellationToken::new();
    let (price_list, server) = started_list(
        &scratch.path().join("price-list"),
        r#"W/"gpt-5""#,
        br#"{"m1": {"input_cost_per_token": 3e-06},
            "seed-only": {"input_cost_per_token": 2e-06},
            "gpt-5": {"input_cost_per_token": 1.25e-06}}"#,
        &stop,
    )
    .await;
    server.script(StatusCode::NOT_MODIFIED, Some(r#"W/"gpt-5""#), b"");
    assert!(live.driver.ports.price_list.register(price_list).is_ok());

    live.scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "method": "model/rerouted",
        "params": {
            "threadId": TEST_THREAD, "turnId": TEST_TURN, "fromModel": "gpt-5",
            "toModel": "gpt-5.5-cyber", "reason": "highRiskCyberActivity",
        },
    }));
    poll_until(|| server.if_none_match(), |tags| tags.len() == 2).await;
    stop.cancel();

    assert_eq!(
        server.if_none_match(),
        [None, Some(r#"W/"gpt-5""#.to_owned())]
    );
}

/// The resting copy a test asks a question of.
enum RestingCopy {
    /// A side question's, asked at rest.
    SideQuestion,
    /// The hand-over summary's.
    HandOver,
}

// Real time, since the list's fetch carries a client timeout a paused clock fires. With no sign-in
// kind read, the copy's one row is held under its model and its fork's tier, and counts only its
// request, not the figures its fork restored. Killed by a copy's reading recorded and never priced
// (none held), by the tier its fork declared left unread (speed `None`), by either path's facts
// not composed (none held), and by a copy based fresh (input 51,000).
#[rstest]
#[case::a_side_question_at_rest(RestingCopy::SideQuestion)]
#[case::the_hand_over(RestingCopy::HandOver)]
#[tokio::test(flavor = "multi_thread")]
async fn a_resting_copy_s_rows_are_priced_at_its_model_and_declared_tier(
    #[case] copy: RestingCopy,
) {
    let mut scripted = start_scripted_codex_service();
    let Some(listener) = bind_test_listener(scripted.service.socket_path()) else {
        return;
    };
    let folder = TempDir::new().expect("a scratch folder");
    let driver = driver_holding(&scripted, folder.path());
    let usage = Arc::new(GatedUsage::new(watch::channel(true).1));
    let stop = CancellationToken::new();
    let (price_list, _server) = started_list(
        &folder.path().join("price-list"),
        r#"W/"gpt-5""#,
        br#"{"m1": {"input_cost_per_token": 3e-06},
            "seed-only": {"input_cost_per_token": 2e-06},
            "gpt-5": {"input_cost_per_token": 1.25e-06, "output_cost_per_token": 1e-05}}"#,
        &stop,
    )
    .await;
    let ports = &driver.ports;
    assert!(ports.usage.register(Arc::clone(&usage) as _).is_ok());
    assert!(ports.request_held.register(Arc::clone(&usage) as _).is_ok());
    assert!(ports.price_list.register(price_list).is_ok());
    let served = tokio::spawn(serve_copy(
        listener,
        read_only_profile(folder.path()),
        CopyTurnEnding::MeteredThenAnswered,
    ));
    let session_id = new_session_id();
    let asked = async {
        match copy {
            RestingCopy::SideQuestion => {
                driver
                    .ask_side_question(resting_question(session_id, folder.path()))
                    .await
            }
            RestingCopy::HandOver => driver
                .export_handover_brief(ExportHandoverBriefParams {
                    session_id,
                    binding_id: mint_runtime_binding_id(),
                    resume: resting_session(session_id, folder.path()),
                })
                .await
                .map(|_summary| ()),
        }
    };

    let (asked, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(asked, answer_region_read(&mut scripted))
    })
    .await
    .expect("the copy answers once its region is read");
    asked.expect("the copy answers");
    tokio::time::timeout(Duration::from_secs(10), served)
        .await
        .expect("the daemon lets the copy's connection go")
        .expect("the service served the copy");
    stop.cancel();

    let held = lock(&usage.held);
    let keys: Vec<(Option<&str>, Option<&str>, Option<&str>)> = held
        .iter()
        .map(|held| {
            (
                held.key.model_id.as_ref().map(FreeFormText::as_str),
                held.key.speed.as_ref().map(BoundedText::as_str),
                held.key.processing_region.as_ref().map(BoundedText::as_str),
            )
        })
        .collect();
    assert_eq!(keys, [(Some("gpt-5"), Some("priority"), None)]);
    assert!(lock(&usage.costs).is_empty());
    assert_eq!(usage.input_deltas(), [Some(1_000)]);
}
