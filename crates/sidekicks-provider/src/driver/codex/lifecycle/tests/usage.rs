//! A live session's metered spend, recorded through the usage sink.

use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::json;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;

use super::super::intake::USAGE_RECORDER_QUEUE;
use super::{LiveCodexSession, TEST_TURN};
use crate::driver::codex::session::test_fixture::TEST_THREAD;
use crate::port::usage_sink::{MeteredUsage, ProviderQuotaWindow, UsageSink};
use crate::usage_delta_accountant::UsageAxisCounts;

/// A usage sink that records nothing until its gate opens, then records each delta in arrival
/// order.
struct GatedUsage {
    gate: watch::Receiver<bool>,
    input_deltas: Mutex<Vec<Option<u64>>>,
}

impl UsageSink for GatedUsage {
    fn record_metered(
        &self,
        metered: MeteredUsage,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            let mut gate = self.gate.clone();
            gate.wait_for(|is_open| *is_open)
                .await
                .expect("the test holds the gate open");
            lock(&self.input_deltas).push(metered.delta.axis_deltas.input);
            Ok(())
        }
        .boxed()
    }

    fn record_quota_windows(
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

// More reports than the recorder's queue holds, metered while the sink is stalled, are each
// recorded once the sink moves, in metering order. Killed by a full queue that drops a batch, and
// by recording the batches out of order.
#[tokio::test]
async fn a_stalled_sink_loses_no_metered_spend_and_records_it_in_order() {
    let live = LiveCodexSession::start(&[]).await;
    let (open, gate) = watch::channel(false);
    let usage = Arc::new(GatedUsage {
        gate,
        input_deltas: Mutex::default(),
    });
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
        live.scripted.script.send(&json!({
            "jsonrpc": "2.0",
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": TEST_THREAD,
                "turnId": TEST_TURN,
                "tokenUsage": {
                    "total": {"inputTokens": total, "outputTokens": 0, "totalTokens": total},
                    "last": {"inputTokens": report, "outputTokens": 0, "totalTokens": report},
                    "modelContextWindow": 258_400,
                },
            },
        }));
    }
    open.send_replace(true);

    let expected: Vec<Option<u64>> = (1..=reports).map(Some).collect();
    tokio::time::timeout(Duration::from_secs(10), async {
        while lock(&usage.input_deltas).len() < expected.len() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("every report is recorded");
    assert_eq!(*lock(&usage.input_deltas), expected);
}
