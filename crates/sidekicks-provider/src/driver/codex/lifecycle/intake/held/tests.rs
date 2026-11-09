use std::error::Error;
use std::sync::Mutex;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_std::mutex_lock::lock;
use tokio::time::Instant;

use super::check_rollout_response;
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::held_responses::{CodexExportedResponse, CodexRolloutFacts};
use crate::driver::test_registry::new_session_id;
use crate::port::usage_sink::{
    MeteredUsage, PricedRequest, ProviderQuotaWindow, RecordedUsage, UsageSink,
};
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::usage_delta_accountant::UsageAxisCounts;

/// When the helper's root thread turned to the priority tier, in Unix milliseconds.
const PRIORITY_FROM_MS: u64 = 1_000_000;

/// When the rollout record was written, after the root's tier turned.
const RECORD_AT_MS: u64 = 1_500_000;

// A session's stored rows as the rollout check reads them: the request keys its account holds,
// the run its rows name, its root thread's tiers by the time each took hold, and every instant a
// row was read at; or a record that cannot be read.
struct StoredRows {
    recorded_keys: Vec<String>,
    run: Option<RunId>,
    root_tiers: Vec<(u64, &'static str)>,
    is_unreadable: bool,
    read_at_ms: Mutex<Vec<u64>>,
}

type Answer<'answer, Value> = BoxFuture<'answer, Result<Value, Box<dyn Error + Send + Sync>>>;

impl StoredRows {
    fn read<Value: Send + 'static>(&self, value: Value) -> Answer<'_, Value> {
        let is_unreadable = self.is_unreadable;
        async move {
            if is_unreadable {
                Err("the record is unreadable".into())
            } else {
                Ok(value)
            }
        }
        .boxed()
    }

    fn note(&self, at: &WireInstant) -> u64 {
        let at_ms = at
            .unix_millisecond()
            .and_then(|at_ms| u64::try_from(at_ms).ok())
            .expect("the read's instant is after 1970");
        lock(&self.read_at_ms).push(at_ms);
        at_ms
    }
}

impl UsageSink for StoredRows {
    fn record_metered(&self, _metered: MeteredUsage) -> Answer<'_, Option<RecordedUsage>> {
        unreachable!("the rollout check records nothing")
    }

    fn record_cost(&self, _request: PricedRequest) -> Answer<'_, ()> {
        unreachable!("the rollout check records nothing")
    }

    fn record_quota_windows(
        &self,
        _provider: ProviderId,
        _provider_account_id: ProviderAccountId,
        _windows: Vec<ProviderQuotaWindow>,
    ) -> Answer<'_, ()> {
        unreachable!("the rollout check records nothing")
    }

    fn record_whole_quota_windows(
        &self,
        _provider: ProviderId,
        _provider_account_id: ProviderAccountId,
        _windows: Vec<ProviderQuotaWindow>,
    ) -> Answer<'_, ()> {
        unreachable!("the rollout check records nothing")
    }

    fn read_prior_emitted(
        &self,
        _session_id: SessionId,
        _thread_id: String,
    ) -> Answer<'_, UsageAxisCounts> {
        unreachable!("the rollout check reads no prior counts")
    }

    fn is_request_recorded(
        &self,
        _provider_account_id: ProviderAccountId,
        request_key: String,
    ) -> Answer<'_, bool> {
        self.read(self.recorded_keys.contains(&request_key))
    }

    fn read_thread_speed_at(
        &self,
        _session_id: SessionId,
        at: WireInstant,
    ) -> Answer<'_, Option<String>> {
        let at_ms = self.note(&at);
        let tier = self
            .root_tiers
            .iter()
            .rfind(|(from_ms, _tier)| *from_ms <= at_ms)
            .map(|(_from_ms, tier)| (*tier).to_owned());
        self.read(tier)
    }

    fn read_run_at(&self, _session_id: SessionId, at: WireInstant) -> Answer<'_, Option<RunId>> {
        self.note(&at);
        self.read(self.run)
    }
}

// A response the rollout file stated at `RECORD_AT_MS` on its own `flex` tier, a spawned
// helper's where `is_root_tier`.
fn rollout_response(is_root_tier: bool) -> CodexExportedResponse {
    CodexExportedResponse {
        response: CodexCompletedResponse {
            conversation_id: "child-thread".to_owned(),
            model_id: FreeFormText::new("gpt-6.1-sol".to_owned()).expect("a model id"),
            service_tier: BoundedText::new("flex".to_owned()),
            counts: UsageAxisCounts {
                input: Some(1_000),
                output: Some(100),
                ..UsageAxisCounts::default()
            },
            observed_at_ms: RECORD_AT_MS,
            provider_account_id: Some(test_provider_account_id()),
        },
        arrived_at: Instant::now(),
        placed: None,
        rollout: Some(CodexRolloutFacts {
            request_key: BoundedText::new("response-1".to_owned()).expect("a key"),
            is_root_tier,
            filing_run: None,
        }),
    }
}

// A rollout response already recorded under its account is passed over before any other read; an
// unrecorded one is filed on the run the stored rows name at its record's time, a spawned
// helper's at the root tier those rows carry then and any other at its own; a record that cannot
// be read refuses it. Killed by skipping the stored-key check (priced twice), by reading the run
// or the tier at any time but the record's (the helper's own start reads the standard tier), by
// keeping a helper's own tier, by dropping the run read, and by pricing past a failed read.
#[rstest]
#[case::already_recorded(&["response-1"], true, false, false, None)]
#[case::helper_at_the_root_tier(&[], true, false, true, Some("priority"))]
#[case::own_thread_at_its_own_tier(&[], false, false, true, Some("flex"))]
#[case::unreadable_record(&[], true, true, false, None)]
#[tokio::test]
async fn a_rollout_response_is_checked_against_the_stored_rows_at_its_record_s_time(
    #[case] recorded_keys: &[&str],
    #[case] is_root_tier: bool,
    #[case] is_unreadable: bool,
    #[case] is_priced: bool,
    #[case] tier: Option<&str>,
) {
    let run = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let rows = StoredRows {
        recorded_keys: recorded_keys.iter().map(|key| (*key).to_owned()).collect(),
        run: Some(run),
        root_tiers: vec![(0, "default"), (PRIORITY_FROM_MS, "priority")],
        is_unreadable,
        read_at_ms: Mutex::new(Vec::new()),
    };
    let mut exported = rollout_response(is_root_tier);

    let answer = check_rollout_response(
        &rows,
        new_session_id(),
        &test_provider_account_id(),
        &mut exported,
    )
    .await;

    assert_eq!(answer, is_priced);
    if !is_priced {
        assert!(
            lock(&rows.read_at_ms).is_empty(),
            "nothing past the key is read"
        );
        return;
    }
    assert!(
        lock(&rows.read_at_ms)
            .iter()
            .all(|at_ms| *at_ms == RECORD_AT_MS)
    );
    assert_eq!(
        exported
            .response
            .service_tier
            .as_ref()
            .map(BoundedText::as_str),
        tier
    );
    assert_eq!(
        exported.rollout.and_then(|rollout| rollout.filing_run),
        Some(run)
    );
}
