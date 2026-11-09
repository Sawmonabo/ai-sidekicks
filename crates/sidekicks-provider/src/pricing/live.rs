//! A provider's requests priced as their usage rows are recorded, through the same pricer the
//! repricing of held requests calls, so a live request and a held one take one rule.
//!
//! - **One model's rows at a time.** The model is marked in use first, so a model the held copy
//!   lacks sends the list's fetch at once. The rows group into requests by their request key, a
//!   keyless row its own, and by the key a price list prices them by, which is the key the stored
//!   token row gives the repricing.
//! - **The table pass** prices each key as the repricing does: the key's rates, then the
//!   account's sign-in kind where the rule reads one, then each request. A provider's own figure,
//!   where one came, is shared by the table's quotes, or by tokens where the table prices none.
//! - **What is left** is handed to the repricing, one held request per key with its row ids; with
//!   no list registered nothing is priced or handed over, and the next start's pass reads the
//!   rows.

use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::cost::UsdMicros;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_std::port_registration::PortRegistration;

use crate::account::errors::is_account_not_found;
use crate::account::usage_turns::unpriced::{UnpricedRequest, UnpricedUsageKey, UnpricedUsageRow};
use crate::driver::ProviderAccountReader;
use crate::driver::ports::{DriverPorts, HeldRequest, RequestHeldListener};
use crate::port::usage_sink::{PricedRequest, PricedUsageRow, RecordedUsage, UsageSink};
use crate::pricing::BoxedError;
use crate::pricing::list::PriceTable;
use crate::pricing::rule::{RequestPricer, RequestPricing};
use crate::pricing::store::HeldPriceList;
use crate::usage_delta_accountant::{MeteredUsageDelta, resolve_cost_update_provenance};

/// One provider's live pricing: its pricer and the ports it marks models in use on, records costs
/// through and hands held requests to.
pub(crate) struct LivePricing {
    provider: ProviderId,
    pricer: Arc<dyn RequestPricer>,
    usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
    price_list: Arc<PortRegistration<Arc<HeldPriceList>>>,
    request_held: Arc<PortRegistration<Arc<dyn RequestHeldListener>>>,
    provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
}

/// A recorded usage row and what prices it: the key a price list prices it by, its request's key
/// and its counts as the stored row carries them.
pub(crate) struct LiveUsageRow {
    key: UnpricedUsageKey,
    request_key: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
    row: UnpricedUsageRow,
}

// What the table pass made of one row.
#[derive(Clone, Copy)]
enum RowPricing {
    Priced(UsdMicros),
    Held,
    // The account is gone, so its rows are neither priced nor held.
    Released,
}

// One request of a key, and the positions of its rows among the rows priced.
struct LiveRequest {
    request: UnpricedRequest,
    positions: Vec<usize>,
}

// One key's requests, in the order their first rows came.
struct KeyRequests<'a> {
    key: &'a UnpricedUsageKey,
    requests: Vec<LiveRequest>,
}

impl LivePricing {
    /// The live pricing of `provider` through `pricer`, over the usage record, the price list, the
    /// repricing's intake and the accounts' reads in `ports`.
    pub(crate) fn new(
        provider: ProviderId,
        pricer: Arc<dyn RequestPricer>,
        ports: &DriverPorts,
    ) -> Self {
        Self {
            provider,
            pricer,
            usage: Arc::clone(&ports.usage),
            price_list: Arc::clone(&ports.price_list),
            request_held: Arc::clone(&ports.request_held),
            provider_accounts: Arc::clone(&ports.provider_accounts),
        }
    }

    /// Adds `model_ids` to the price list's models in use; nothing while no list is registered.
    pub(crate) async fn mark_in_use(&self, model_ids: &[&str]) {
        if let Some(price_list) = self.price_list.port() {
            price_list.mark_in_use(model_ids).await;
        }
    }

    /// Prices `rows`, all of `session_id` and on `model_id`, with the provider's own figure in
    /// micro-dollars where it reported one: one priced request recorded for what is priced, and one
    /// held request handed over per key left unpriced. A failure is logged, its rows held.
    pub(crate) async fn price(
        &self,
        session_id: SessionId,
        model_id: &FreeFormText<EVENT_FIELD_MAX_LEN>,
        rows: Vec<LiveUsageRow>,
        provider_figure_usd_micros: Option<f64>,
    ) {
        let Some(price_list) = self.price_list.port() else {
            return;
        };
        price_list.mark_in_use(&[model_id.as_str()]).await;
        let table = price_list.table();
        let mut row_pricings = vec![RowPricing::Released; rows.len()];
        for key_requests in group_requests(&rows) {
            self.price_key(&table, &key_requests, &mut row_pricings)
                .await;
        }
        let table_shares: Option<Vec<UsdMicros>> = row_pricings
            .iter()
            .map(|pricing| match pricing {
                RowPricing::Priced(share) => Some(*share),
                RowPricing::Held | RowPricing::Released => None,
            })
            .collect();
        let weights: Vec<u64> = match &table_shares {
            Some(shares) => shares.iter().map(|share| share.0.get()).collect(),
            None => rows.iter().map(|row| row_token_sum(&row.row)).collect(),
        };
        let table_pass = || match table_shares {
            Some(shares) => RequestPricing::Priced {
                cost_source: UsageCostSource::DerivedExact,
                shares,
            },
            None => RequestPricing::HeldForPrice,
        };
        let (cost_source, priced, mut held): (_, Vec<(usize, UsdMicros)>, Vec<usize>) =
            match resolve_cost_update_provenance(
                self.provider.clone(),
                provider_figure_usd_micros,
                &weights,
                table_pass,
            ) {
                RequestPricing::Priced {
                    cost_source,
                    shares,
                } => (
                    cost_source,
                    shares.into_iter().enumerate().collect(),
                    Vec::new(),
                ),
                RequestPricing::HeldForPrice | RequestPricing::HeldForSignInKind => {
                    let mut priced = Vec::new();
                    let mut held = Vec::new();
                    for (position, pricing) in row_pricings.iter().enumerate() {
                        match pricing {
                            RowPricing::Priced(share) => priced.push((position, *share)),
                            RowPricing::Held => held.push(position),
                            RowPricing::Released => {}
                        }
                    }
                    (UsageCostSource::DerivedExact, priced, held)
                }
            };
        if !priced.is_empty() {
            let request = PricedRequest {
                session_id,
                model_id: model_id.clone(),
                cost_source,
                rows: priced
                    .iter()
                    .map(|&(position, cost_usd_micros)| PricedUsageRow {
                        row: recorded_usage(&rows[position]),
                        cost_usd_micros,
                    })
                    .collect(),
            };
            if let Err(error) = self.record_cost(request).await {
                tracing::warn!(
                    error = &*error as &(dyn Error + 'static),
                    provider = self.provider.as_str(),
                    "a live request's cost was not recorded, so it is held for the repricing"
                );
                held.extend(priced.iter().map(|&(position, _)| position));
                held.sort_unstable();
            }
        }
        self.hand_over_held(&rows, &held).await;
    }

    // Prices `key_requests` as the repricing prices a key, setting each of its rows' pricing.
    async fn price_key(
        &self,
        table: &PriceTable,
        key_requests: &KeyRequests<'_>,
        row_pricings: &mut [RowPricing],
    ) {
        let key = key_requests.key;
        let set_key = |row_pricings: &mut [RowPricing], pricing: RowPricing| {
            for request in &key_requests.requests {
                for &position in &request.positions {
                    row_pricings[position] = pricing;
                }
            }
        };
        if !self.pricer.prices_key(table, key) {
            set_key(row_pricings, RowPricing::Held);
            return;
        }
        let sign_in_kind = if self.pricer.needs_sign_in_kind() {
            match self.read_sign_in_kind(&key.account_id).await {
                Ok(sign_in_kind) => sign_in_kind,
                Err(error) if is_account_not_found(&*error) => {
                    set_key(row_pricings, RowPricing::Released);
                    return;
                }
                Err(error) => {
                    tracing::warn!(
                        error = &*error as &(dyn Error + 'static),
                        provider = key.provider.as_str(),
                        account_id = key.account_id.as_str(),
                        "the account's sign-in kind was not read, so a live request is held"
                    );
                    set_key(row_pricings, RowPricing::Held);
                    return;
                }
            }
        } else {
            None
        };
        for LiveRequest { request, positions } in &key_requests.requests {
            match self.pricer.price(table, key, request, sign_in_kind) {
                RequestPricing::Priced {
                    cost_source: _,
                    shares,
                } => {
                    for (&position, share) in positions.iter().zip(shares) {
                        row_pricings[position] = RowPricing::Priced(share);
                    }
                }
                RequestPricing::HeldForPrice | RequestPricing::HeldForSignInKind => {
                    for &position in positions {
                        row_pricings[position] = RowPricing::Held;
                    }
                }
            }
        }
    }

    async fn read_sign_in_kind(
        &self,
        account_id: &ProviderAccountId,
    ) -> Result<Option<ProviderAuthMode>, BoxedError> {
        self.provider_accounts
            .require_port()?
            .read_observed_auth_mode(account_id.clone())
            .await
    }

    async fn record_cost(&self, request: PricedRequest) -> Result<(), BoxedError> {
        self.usage.require_port()?.record_cost(request).await
    }

    // Hands the rows at `held` to the repricing, one held request per key with its rows' ids.
    async fn hand_over_held(&self, rows: &[LiveUsageRow], held: &[usize]) {
        let Some(listener) = self.request_held.port() else {
            return;
        };
        let mut held_requests: Vec<HeldRequest> = Vec::new();
        for &position in held {
            let row = &rows[position];
            let row_id = row.row.turn_id.clone();
            match held_requests.iter_mut().find(|held| held.key == row.key) {
                Some(held) => held.row_ids.push(row_id),
                None => held_requests.push(HeldRequest {
                    key: row.key.clone(),
                    row_ids: vec![row_id],
                }),
            }
        }
        for held in held_requests {
            if let Err(error) = listener.request_held(held).await {
                tracing::warn!(
                    error = &*error as &(dyn Error + 'static),
                    provider = self.provider.as_str(),
                    "a live request was not handed to the repricing; it waits for the next start"
                );
            }
        }
    }
}

impl LiveUsageRow {
    /// The row `recorded` wrote on `session_id` from `delta`, keyed by the delta's model, speed and
    /// region exactly as the stored token row keeps them, so a live key and a repriced one are one.
    pub(crate) fn new(
        recorded: &RecordedUsage,
        session_id: SessionId,
        delta: &MeteredUsageDelta,
    ) -> Self {
        let figures = delta
            .row_figures()
            .expect("the record wrote the row from these figures, so each is in range");
        Self {
            key: UnpricedUsageKey {
                provider: delta.provider.clone(),
                account_id: recorded.provider_account_id.clone(),
                model_id: delta.request.model_id.clone(),
                speed: delta.request.speed.clone(),
                processing_region: delta.request.processing_region.clone(),
            },
            request_key: delta.request.request_key.clone(),
            row: UnpricedUsageRow {
                turn_id: recorded.event_id.clone(),
                session_id: Some(session_id),
                run_id: recorded.run_id,
                subagent_id: recorded.subagent_id.clone(),
                occurred_at: WireInstant::now(),
                tokens: [
                    figures.input,
                    figures.output,
                    figures.cache_read,
                    figures.cache_write,
                    figures.reasoning,
                ],
                cache_write_extended_tokens: figures.cache_write_extended,
                web_search_requests: figures.web_searches,
                thread_speed: delta.request.thread_speed.clone(),
            },
        }
    }
}

// The rows grouped by key, and within a key into requests by request key, a keyless row its own,
// each in the order its first row came.
fn group_requests(rows: &[LiveUsageRow]) -> Vec<KeyRequests<'_>> {
    let mut keys: Vec<KeyRequests<'_>> = Vec::new();
    for (position, row) in rows.iter().enumerate() {
        let key_index = keys
            .iter()
            .position(|key| *key.key == row.key)
            .unwrap_or_else(|| {
                keys.push(KeyRequests {
                    key: &row.key,
                    requests: Vec::new(),
                });
                keys.len() - 1
            });
        let requests = &mut keys[key_index].requests;
        let joined = row.request_key.as_ref().and_then(|request_key| {
            requests
                .iter_mut()
                .find(|live| live.request.request_key.as_ref() == Some(request_key))
        });
        match joined {
            Some(live) => {
                live.request.rows.push(row.row.clone());
                live.positions.push(position);
            }
            None => requests.push(LiveRequest {
                request: UnpricedRequest {
                    request_key: row.request_key.clone(),
                    rows: vec![row.row.clone()],
                },
                positions: vec![position],
            }),
        }
    }
    keys
}

// The row's tokens summed, its weight where the table prices none of the request.
fn row_token_sum(row: &UnpricedUsageRow) -> u64 {
    row.tokens
        .iter()
        .flatten()
        .map(|count| count.get())
        .fold(0, u64::saturating_add)
}

fn recorded_usage(live: &LiveUsageRow) -> RecordedUsage {
    RecordedUsage {
        event_id: live.row.turn_id.clone(),
        run_id: live.row.run_id,
        provider_account_id: live.key.account_id.clone(),
        subagent_id: live.row.subagent_id.clone(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use sidekicks_contracts::event::usage::{UsageContainment, UsageCostSource};
    use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::cost::UsdMicros;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
    use sidekicks_std::mutex_lock::lock;
    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    use super::{LivePricing, LiveUsageRow};
    use crate::account::usage_turns::unpriced::{UnpricedRequest, UnpricedUsageKey};
    use crate::driver::ports::{DriverPorts, HeldRequest, RequestHeldListener};
    use crate::driver::test_registry::fixed_session_id;
    use crate::port::usage_sink::{
        MeteredUsage, PricedRequest, ProviderQuotaWindow, RecordedUsage, UsageSink,
    };
    use crate::pricing::list::PriceTable;
    use crate::pricing::quote::{RequestTokenCounts, RequestUsage, quote_request_rows};
    use crate::pricing::rule::{RequestPricer, RequestPricing};
    use crate::pricing::test_fixture::started_list;
    use crate::usage_delta_accountant::{
        MeteredUsageDelta, UsageAxisCounts, UsageDiagnosticBand, UsageRequestFacts,
    };

    // The list's copy: the fixture's two models kept, and Opus 5.5 with no `fast` rates.
    const OPUS_COPY: &[u8] = br#"{"m1": {"input_cost_per_token": 3e-06},
        "seed-only": {"input_cost_per_token": 2e-06},
        "claude-opus-5-5": {"input_cost_per_token": 5e-06,
            "cache_read_input_token_cost": 2e-07, "output_cost_per_token": 2e-05}}"#;
    const OPUS: &str = "claude-opus-5-5";

    type Failure = Box<dyn std::error::Error + Send + Sync>;
    type BoxedAnswer<'a, T> = BoxFuture<'a, Result<T, Failure>>;

    // A rule that prices a key whose row prices its speed, each request by the request quote.
    struct QuotePricer;

    impl RequestPricer for QuotePricer {
        fn needs_sign_in_kind(&self) -> bool {
            false
        }

        fn prices_key(&self, table: &PriceTable, key: &UnpricedUsageKey) -> bool {
            key.model_id
                .as_ref()
                .and_then(|model_id| table.row(model_id.as_str()))
                .is_some_and(|row| {
                    row.speed(key.speed.as_ref().map(BoundedText::as_str))
                        .is_some()
                })
        }

        fn price(
            &self,
            table: &PriceTable,
            key: &UnpricedUsageKey,
            request: &UnpricedRequest,
            _sign_in_kind: Option<ProviderAuthMode>,
        ) -> RequestPricing {
            let model_id = key.model_id.as_ref().expect("a priced key names its model");
            let rows: Vec<RequestUsage<'_>> = request
                .rows
                .iter()
                .map(|row| {
                    let count = |axis: usize| row.tokens[axis].map_or(0, SafeInt::get);
                    RequestUsage {
                        model_id: model_id.as_str(),
                        speed: None,
                        region: None,
                        region_words: &[],
                        long_context_tokens: 0,
                        extended_cache_lifetime_hours: 1,
                        tokens: RequestTokenCounts {
                            input: count(0),
                            output: count(1),
                            cache_read: count(2),
                            cache_write: count(3),
                            cache_write_extended: 0,
                        },
                        web_searches: 0,
                        search_context_size: "medium",
                    }
                })
                .collect();
            match quote_request_rows(table, &rows) {
                Ok(shares) => RequestPricing::Priced {
                    cost_source: UsageCostSource::DerivedExact,
                    shares,
                },
                Err(_refusal) => RequestPricing::HeldForPrice,
            }
        }
    }

    // The usage record's cost write and the repricing's intake, each keeping what it was handed.
    #[derive(Default)]
    struct Handed {
        costs: Mutex<Vec<PricedRequest>>,
        held: Mutex<Vec<HeldRequest>>,
    }

    impl UsageSink for Handed {
        fn record_metered(&self, _metered: MeteredUsage) -> BoxedAnswer<'_, Option<RecordedUsage>> {
            async { Err("the test meters nothing".into()) }.boxed()
        }

        fn record_cost(&self, request: PricedRequest) -> BoxedAnswer<'_, ()> {
            lock(&self.costs).push(request);
            async { Ok(()) }.boxed()
        }

        fn record_quota_windows(
            &self,
            _provider: ProviderId,
            _provider_account_id: ProviderAccountId,
            _windows: Vec<ProviderQuotaWindow>,
        ) -> BoxedAnswer<'_, ()> {
            async { Err("the test keeps no window".into()) }.boxed()
        }

        fn record_whole_quota_windows(
            &self,
            _provider: ProviderId,
            _provider_account_id: ProviderAccountId,
            _windows: Vec<ProviderQuotaWindow>,
        ) -> BoxedAnswer<'_, ()> {
            async { Err("the test keeps no window".into()) }.boxed()
        }

        fn read_prior_emitted(
            &self,
            _session_id: SessionId,
            _thread_id: String,
        ) -> BoxedAnswer<'_, UsageAxisCounts> {
            async { Err("the test keeps no sum".into()) }.boxed()
        }

        fn is_request_recorded(
            &self,
            _provider_account_id: ProviderAccountId,
            _request_key: String,
        ) -> BoxedAnswer<'_, bool> {
            async { Ok(false) }.boxed()
        }

        fn read_thread_speed_at(
            &self,
            _session_id: SessionId,
            _at: sidekicks_contracts::wire::instant::WireInstant,
        ) -> BoxedAnswer<'_, Option<String>> {
            async { Ok(None) }.boxed()
        }
    }

    impl RequestHeldListener for Handed {
        fn request_held(&self, held: HeldRequest) -> BoxedAnswer<'_, ()> {
            lock(&self.held).push(held);
            async { Ok(()) }.boxed()
        }
    }

    // The live pricing over a list that took `OPUS_COPY`, recording into `handed`.
    async fn live_pricing(
        handed: &Arc<Handed>,
        scratch: &TempDir,
        stop: &CancellationToken,
    ) -> LivePricing {
        let folder = scratch.path().join("price-list");
        let (price_list, _server) = started_list(&folder, r#"W/"opus""#, OPUS_COPY, stop).await;
        let ports = DriverPorts::new();
        ports
            .usage
            .register(Arc::clone(handed) as _)
            .expect("the usage port registers once");
        ports
            .price_list
            .register(price_list)
            .expect("the price list registers once");
        ports
            .request_held
            .register(Arc::clone(handed) as _)
            .expect("the repricing registers once");
        LivePricing::new(provider(), Arc::new(QuotePricer), &ports)
    }

    // The row `event_id` recorded from a delta of `axes` on Opus 5.5 at `speed`.
    fn live_row(
        event_id: &str,
        request_key: Option<&str>,
        speed: Option<&str>,
        axes: UsageAxisCounts,
    ) -> LiveUsageRow {
        let fact = |text: Option<&str>| {
            text.map(|text| BoundedText::new(text.to_owned()).expect("a fact"))
        };
        let delta = MeteredUsageDelta {
            provider: provider(),
            thread_id: "thread".to_owned(),
            attributed_turn_id: None,
            axis_deltas: axes,
            normalized_input_tokens: axes.input.unwrap_or(0),
            normalized_output_tokens: axes.output.unwrap_or(0),
            containment: UsageContainment::ConfirmedSubtracted,
            diagnostic_band: UsageDiagnosticBand {
                cache_read_tokens_delta: axes.cached_input.unwrap_or(0),
                cache_write_tokens_delta: 0,
            },
            request: UsageRequestFacts {
                model_id: Some(opus()),
                request_key: fact(request_key),
                speed: fact(speed),
                ..UsageRequestFacts::default()
            },
        };
        let recorded = RecordedUsage {
            event_id: FreeFormText::new(event_id.to_owned()).expect("an event id"),
            run_id: None,
            provider_account_id: ProviderAccountId::new("account-a".to_owned())
                .expect("an account id"),
            subagent_id: None,
        };
        LiveUsageRow::new(&recorded, fixed_session_id(), &delta)
    }

    fn provider() -> ProviderId {
        ProviderId::new("quote-rule".to_owned()).expect("a provider id")
    }

    fn opus() -> FreeFormText<{ sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN }> {
        FreeFormText::new(OPUS.to_owned()).expect("a model id")
    }

    fn usd_micros(whole: u64) -> UsdMicros {
        UsdMicros(SafeInt::new(whole).expect("a small whole figure"))
    }

    // Each recorded request's source and its rows' event ids with their shares.
    fn costs(handed: &Handed) -> Vec<(UsageCostSource, Vec<(String, UsdMicros)>)> {
        lock(&handed.costs)
            .iter()
            .map(|request| {
                let rows = request.rows.iter().map(|priced| {
                    (
                        priced.row.event_id.as_str().to_owned(),
                        priced.cost_usd_micros,
                    )
                });
                (request.cost_source, rows.collect())
            })
            .collect()
    }

    /// Killed by weighing the provider's figure by tokens where the table prices the request
    /// (58,823 and 1,177): Opus 5.5's $0.06 over a 100,000-cache-read row and a 2,000-output row
    /// splits 20,000 and 40,000 by their quotes.
    #[tokio::test]
    async fn a_provider_figure_splits_by_the_rows_quotes() {
        let scratch = tempfile::tempdir().expect("a scratch folder is made");
        let stop = CancellationToken::new();
        let handed = Arc::new(Handed::default());
        let live = live_pricing(&handed, &scratch, &stop).await;
        let rows = vec![
            live_row(
                "row-read",
                Some("message-1"),
                None,
                UsageAxisCounts {
                    cached_input: Some(100_000),
                    ..UsageAxisCounts::default()
                },
            ),
            live_row(
                "row-output",
                Some("message-1"),
                None,
                UsageAxisCounts {
                    output: Some(2_000),
                    ..UsageAxisCounts::default()
                },
            ),
        ];
        live.price(fixed_session_id(), &opus(), rows, Some(60_000.0))
            .await;
        stop.cancel();
        assert_eq!(
            costs(&handed),
            [(
                UsageCostSource::ProviderReported,
                vec![
                    ("row-read".to_owned(), usd_micros(20_000)),
                    ("row-output".to_owned(), usd_micros(40_000)),
                ],
            )]
        );
        assert!(
            lock(&handed.held).is_empty(),
            "a priced request holds nothing"
        );
    }

    /// Killed by giving the held key a cost and by holding the priced key: of a key the table
    /// prices and one whose speed it lacks, the first records its quote and the second is handed
    /// over alone, with only its own row's id.
    #[tokio::test]
    async fn a_key_the_table_lacks_is_held_alone() {
        let scratch = tempfile::tempdir().expect("a scratch folder is made");
        let stop = CancellationToken::new();
        let handed = Arc::new(Handed::default());
        let live = live_pricing(&handed, &scratch, &stop).await;
        let input = UsageAxisCounts {
            input: Some(1_000),
            ..UsageAxisCounts::default()
        };
        let rows = vec![
            live_row("row-standard", None, None, input),
            live_row("row-fast", None, Some("fast"), input),
        ];
        live.price(fixed_session_id(), &opus(), rows, None).await;
        stop.cancel();
        assert_eq!(
            costs(&handed),
            [(
                UsageCostSource::DerivedExact,
                vec![("row-standard".to_owned(), usd_micros(5_000))],
            )]
        );
        let held = lock(&handed.held);
        assert_eq!(held.len(), 1, "one key is held");
        assert_eq!(
            held[0].key.speed.as_ref().map(BoundedText::as_str),
            Some("fast")
        );
        assert_eq!(
            held[0]
                .row_ids
                .iter()
                .map(FreeFormText::as_str)
                .collect::<Vec<_>>(),
            ["row-fast"]
        );
    }
}
