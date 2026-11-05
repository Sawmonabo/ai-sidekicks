//! A live session's metered spend, recorded through the usage sink and priced as it is recorded,
//! and the models it moves to marked in use.

use std::error::Error;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use tempfile::TempDir;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::super::intake::USAGE_RECORDER_QUEUE;
use super::{LiveCodexSession, TEST_TURN};
use crate::driver::codex::session::test_fixture::TEST_THREAD;
use crate::driver::ports::{HeldRequest, RequestHeldListener};
use crate::driver::test_registry::TestProviderAccounts;
use crate::driver::{CurrentProviderAccount, ProviderAccountReader};
use crate::port::usage_sink::{
    MeteredUsage, PricedRequest, ProviderQuotaWindow, RecordedUsage, UsageSink,
};
use crate::pricing::test_fixture::started_list;
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::usage_delta_accountant::UsageAxisCounts;

/// A usage record that records nothing until its gate opens, then records each delta in arrival
/// order as a row of its own, counting each delta it was handed, and keeps each priced request
/// and each request handed to the repricing.
struct GatedUsage {
    gate: watch::Receiver<bool>,
    handed: AtomicUsize,
    input_deltas: Mutex<Vec<Option<u64>>>,
    costs: Mutex<Vec<PricedRequest>>,
    held: Mutex<Vec<HeldRequest>>,
}

impl GatedUsage {
    fn new(gate: watch::Receiver<bool>) -> Self {
        Self {
            gate,
            handed: AtomicUsize::new(0),
            input_deltas: Mutex::default(),
            costs: Mutex::default(),
            held: Mutex::default(),
        }
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
            lock(&self.input_deltas).push(metered.delta.axis_deltas.input);
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

// A `thread/tokenUsage/updated` frame on the test's turn with the conversation's `total` and the
// last request's `last`.
fn token_usage_frame(total: &Value, last: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": TEST_THREAD,
            "turnId": TEST_TURN,
            "tokenUsage": { "total": total, "last": last, "modelContextWindow": 258_400 },
        },
    })
}

// Answers the recorder's region read with no base URL set: the API's own host, no region.
async fn answer_region_read(live: &mut LiveCodexSession) {
    let request = live.scripted.next_request("config/read").await;
    live.scripted
        .script
        .answer(&request, &json!({ "config": {}, "origins": {} }));
}

// Waits until `is_done` holds.
async fn wait_until(is_done: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !is_done() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the recorder gets there");
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
            &json!({"inputTokens": total, "outputTokens": 0, "totalTokens": total}),
            &json!({"inputTokens": report, "outputTokens": 0, "totalTokens": report}),
        ));
    }
    answer_region_read(&mut live).await;
    // The paused clock moves only once every task waits, so the session's task has metered every
    // report it can, past the queue's room, and waits on the full queue.
    tokio::time::sleep(Duration::from_millis(10)).await;
    let handed_while_stalled = usage.handed.load(Ordering::Relaxed);
    open.send_replace(true);

    let expected: Vec<Option<u64>> = (1..=reports).map(Some).collect();
    wait_until(|| lock(&usage.input_deltas).len() >= expected.len()).await;
    // The sink held the first delta alone while stalled.
    assert_eq!(handed_while_stalled, 1);
    assert_eq!(*lock(&usage.input_deltas), expected);
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

    let counts = |input: u64, output: u64| json!({"inputTokens": input, "outputTokens": output, "totalTokens": input + output});
    let first = token_usage_frame(&counts(1_000, 100), &counts(1_000, 100));
    live.scripted.script.send(&first);
    live.scripted.script.send(&first);
    live.scripted
        .script
        .send(&token_usage_frame(&counts(3_000, 300), &counts(2_000, 200)));
    answer_region_read(&mut live).await;

    wait_until(|| lock(&usage.costs).len() >= 2).await;
    stop.cancel();
    assert_eq!(*lock(&usage.input_deltas), [Some(1_000), Some(2_000)]);
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
    wait_until(|| server.if_none_match().len() == 2).await;
    stop.cancel();

    assert_eq!(
        server.if_none_match(),
        [None, Some(r#"W/"gpt-5""#.to_owned())]
    );
}
