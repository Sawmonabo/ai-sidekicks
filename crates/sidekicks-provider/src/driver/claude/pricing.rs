//! Claude Code's requests priced: its rule for pricing a request from the price list, and the
//! rows its process recorded, kept by model until the process's next lead `result` or its end
//! prices them.
//!
//! - **The rule.** A request is its message's rows, priced at the model's exact row, at the
//!   standard rates or `fast`'s, in no region or `us`, with every rate at the long-context tier
//!   when the whole request's input passes the row's threshold, the cache writes split by lifetime
//!   and the web searches at the row's per-search rate.
//! - **A result's rows.** At a lead `result` stating each model's usage and cost since the
//!   process's previous result, a model whose entry reads `list` or `managed` with a cost takes
//!   that cost, shared over the model's rows; any other stated model is priced from the price
//!   list. A model the result leaves out, or every model where it states no figures, keeps its
//!   rows for the next result that states them, since a call finishing after a result is stated on
//!   the next; the rows still kept when the process ends are priced from the price list.
//! - **The spend no message showed.** What an entry counts past the model's rows since the last
//!   result (an advisor's calls, a compaction, a title) is recorded as one more row on the model
//!   before the price is taken; rows past their entry carry over as the model's balance, and a
//!   figure with no row to land on is recorded on a row of its own with no tokens.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_std::port_registration::PortRegistration;

use crate::account::usage_turns::unpriced::{UnpricedRequest, UnpricedUsageKey, UnpricedUsageRow};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::transport::declarations::ClaudeModelCost;
use crate::driver::claude::spawn::launch::one_turn::ClaudeOneTurnSpend;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, OnceReportedDiagnostics,
};
use crate::port::usage_sink::{MeteredUsage, MeteredUsageOwner, UsageSink};
use crate::pricing::BoxedError;
use crate::pricing::list::PriceTable;
use crate::pricing::live::{LivePricing, LiveUsageRow};
use crate::pricing::quote::{RequestTokenCounts, RequestUsage, quote_request_rows};
use crate::pricing::rule::{RequestPricer, RequestPricing};
use crate::usage_delta_accountant::{
    MeteredUsageDelta, UsageAxisCounts, UsageRequestFacts, meter_from_zero,
};

// A model id as a usage row carries it.
type ModelId = FreeFormText<EVENT_FIELD_MAX_LEN>;

// The figures a result states per model that a row records: input, cached input, cache write,
// output and web searches.
const SPEND_FIGURES: usize = 5;

// The micro-dollars in a dollar, the unit `costUSD` is reported in.
const MICRO_DOLLARS_PER_DOLLAR: f64 = 1_000_000.0;

/// The region words a Claude message names that the price list's rows carry a multiplier for.
const CLAUDE_REGION_WORDS: &[&str] = &["us"];

/// The speed word whose rates the price list's rows carry, as the row's multiplier.
const CLAUDE_FAST_SPEED: &str = "fast";

/// The context size every search is priced at: each Anthropic row prices every size alike.
const CLAUDE_SEARCH_CONTEXT_SIZE: &str = "medium";

/// Claude Code's pricing rule, which reads no sign-in kind: a plan and an API key take the same
/// rates.
pub(crate) struct ClaudeRequestPricer;

impl RequestPricer for ClaudeRequestPricer {
    fn needs_sign_in_kind(&self) -> bool {
        false
    }

    fn prices_key(&self, table: &PriceTable, key: &UnpricedUsageKey) -> bool {
        let Some(row) = key
            .model_id
            .as_ref()
            .and_then(|model_id| table.row(model_id.as_str()))
        else {
            return false;
        };
        let Some(speed) = ClaudeSpeed::read(key.speed.as_ref().map(BoundedText::as_str)) else {
            return false;
        };
        let region = key.processing_region.as_ref().map(BoundedText::as_str);
        row.speed(speed.row_word()).is_some() && row.region(region, CLAUDE_REGION_WORDS).is_some()
    }

    // A model listed as fast may run at `fast` besides the standard speed.
    fn prices_listed_model(&self, table: &PriceTable, model: &ProviderModel) -> bool {
        table
            .row(model.id.as_str())
            .is_some_and(|row| !model.fast || row.speed(ClaudeSpeed::Fast.row_word()).is_some())
    }

    fn price(
        &self,
        table: &PriceTable,
        key: &UnpricedUsageKey,
        request: &UnpricedRequest,
        _sign_in_kind: Option<ProviderAuthMode>,
    ) -> RequestPricing {
        let (Some(model_id), Some(speed)) = (
            key.model_id.as_ref(),
            ClaudeSpeed::read(key.speed.as_ref().map(BoundedText::as_str)),
        ) else {
            return RequestPricing::HeldForPrice;
        };
        let long_context_tokens = request
            .rows
            .iter()
            .map(|row| {
                let counts = RowCounts::of(row);
                counts
                    .input
                    .saturating_add(counts.cache_read)
                    .saturating_add(counts.cache_write)
            })
            .fold(0, u64::saturating_add);
        let rows: Vec<RequestUsage<'_>> = request
            .rows
            .iter()
            .map(|row| {
                let counts = RowCounts::of(row);
                let cache_write_extended = count(row.cache_write_extended_tokens);
                RequestUsage {
                    model_id: model_id.as_str(),
                    speed: speed.row_word(),
                    region: key.processing_region.as_ref().map(BoundedText::as_str),
                    region_words: CLAUDE_REGION_WORDS,
                    long_context_tokens,
                    extended_cache_lifetime_hours: 1,
                    tokens: RequestTokenCounts {
                        input: counts.input,
                        output: counts.output,
                        cache_read: counts.cache_read,
                        cache_write: counts.cache_write.saturating_sub(cache_write_extended),
                        cache_write_extended,
                    },
                    web_searches: count(row.web_search_requests),
                    search_context_size: CLAUDE_SEARCH_CONTEXT_SIZE,
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

/// One process's rows waiting for their price, by model, with what its results' figures and its
/// rows have not yet matched: the calls streamed ahead of the result that states them.
#[derive(Default)]
pub(crate) struct ClaudeResultPricing {
    kept: Vec<ClaudeModelRows>,
    // Each model's spend its rows showed past what its results have stated, as each figure's
    // shortfall, zero or below.
    balances: HashMap<ModelId, [i128; SPEND_FIGURES]>,
    // The `costBasis` words already logged on this process.
    basis_reports: OnceReportedDiagnostics,
}

/// One model's rows to price, with the provider's own figure for them in micro-dollars where it
/// reported one.
pub(crate) struct ClaudeModelRows {
    /// The model.
    pub(crate) model_id: ModelId,
    /// The rows, in the order they were recorded.
    pub(crate) rows: Vec<LiveUsageRow>,
    /// The provider's figure, `None` where the price list's rates price them.
    pub(crate) provider_figure_usd_micros: Option<f64>,
    // The rows' input, cached input, cache write, output and web searches summed.
    spent: [u64; SPEND_FIGURES],
    // The region the last row names.
    region: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
}

/// A recorded row kept for its price: its model, the row, its input, cached input, cache write,
/// output and web searches, and its region.
pub(crate) struct ClaudeKeptRow {
    model_id: ModelId,
    row: LiveUsageRow,
    spent: [u64; SPEND_FIGURES],
    region: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
}

/// Records `metered` through `sink`, answering the row to keep for its price where the record
/// wrote one for a delta naming a model; a row with no model has no rates, and the next start's
/// pass reads it. Fails as the record fails.
pub(crate) async fn record_for_price(
    sink: &dyn UsageSink,
    metered: MeteredUsage,
) -> Result<Option<ClaudeKeptRow>, BoxedError> {
    let session_id = metered.session_id;
    let priced =
        (metered.delta.request.model_id.clone()).map(|model_id| (model_id, metered.delta.clone()));
    let recorded = sink.record_metered(metered).await?;
    let (Some(recorded), Some((model_id, delta))) = (recorded, priced) else {
        return Ok(None);
    };
    let axes = &delta.axis_deltas;
    let spent = [
        axes.input,
        axes.cached_input,
        axes.cache_write_input,
        axes.output,
        delta.request.web_search_requests,
    ];
    Ok(Some(ClaudeKeptRow {
        model_id,
        row: LiveUsageRow::new(&recorded, session_id, &delta),
        spent: spent.map(|figure| figure.unwrap_or(0)),
        region: delta.request.processing_region,
    }))
}

/// Prices each of `models`, `session_id`'s rows by model, through `pricing`.
pub(crate) async fn price_claude_rows(
    pricing: &LivePricing,
    session_id: SessionId,
    models: Vec<ClaudeModelRows>,
) {
    for model in models {
        let figure = model.provider_figure_usd_micros;
        pricing
            .price(session_id, &model.model_id, model.rows, figure)
            .await;
    }
}

/// Where a one-turn process's spend is charged: its session, the binding and owner its rows are
/// recorded on, and the account it ran on.
pub(crate) struct ClaudeOneTurnCharge {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The binding the rows are recorded on.
    pub(crate) binding_id: RuntimeBindingId,
    /// Whose spend the rows are.
    pub(crate) owner: MeteredUsageOwner,
    /// The account the process ran on.
    pub(crate) provider_account_id: ProviderAccountId,
}

/// Records and prices what one-turn processes spent, through the usage record and the live
/// pricing the session's stream shares.
pub(crate) struct ClaudeOneTurnPricing {
    /// The usage record, once registered.
    pub(crate) usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
    /// The live pricing.
    pub(crate) live: Arc<LivePricing>,
}

impl ClaudeOneTurnPricing {
    /// Records `spend` as `charge` names and prices it: each message that spent anything a row of
    /// its own, as the stream drops a reading that changed nothing, with the figures its `result`
    /// states priced as the stream prices a result's, else from the price list. Nothing while no
    /// usage record is registered; a failed record is reported.
    pub(crate) async fn record(&self, spend: ClaudeOneTurnSpend, charge: ClaudeOneTurnCharge) {
        let Some(sink) = self.usage.port() else {
            return;
        };
        let (sink, mut pricing) = (&**sink, ClaudeResultPricing::default());
        let thread_id = spend.thread_id;
        for message in spend.messages {
            let request = message.whole_request();
            let provider = DESCRIPTOR.provider_id();
            let delta = meter_from_zero(provider, thread_id.clone(), message.counts, request);
            if !delta.is_unchanged() {
                record_one_turn_row(sink, &charge, delta, &mut pricing).await;
            }
        }
        let account = &charge.provider_account_id;
        let mut models = Vec::new();
        if let Some(model_costs) = spend.model_costs {
            for delta in pricing.take_unshown_spend(&model_costs, &thread_id) {
                record_one_turn_row(sink, &charge, delta, &mut pricing).await;
            }
            models = pricing.take_at_result(&model_costs, charge.session_id, account);
        }
        models.extend(pricing.take_all());
        price_claude_rows(&self.live, charge.session_id, models).await;
    }
}

// Records `delta` as `charge` names it and keeps its row in `pricing`; a failure is reported.
async fn record_one_turn_row(
    sink: &dyn UsageSink,
    charge: &ClaudeOneTurnCharge,
    delta: MeteredUsageDelta,
    pricing: &mut ClaudeResultPricing,
) {
    let metered = MeteredUsage {
        session_id: charge.session_id,
        binding_id: charge.binding_id.clone(),
        owner: charge.owner.clone(),
        delta,
        provider_account_id: None,
    };
    match record_for_price(sink, metered).await {
        Ok(Some(kept)) => pricing.keep(kept),
        Ok(None) => {}
        Err(error) => record_unheard_claude_failure(
            DriverDiagnosticKind::ProcessReportFailed,
            charge.session_id,
            "a one-turn process's usage",
            &*error,
        ),
    }
}

impl ClaudeResultPricing {
    /// Keeps `kept` until the process's next lead `result` or its end.
    pub(crate) fn keep(&mut self, kept: ClaudeKeptRow) {
        let index = self
            .kept
            .iter()
            .position(|model| model.model_id == kept.model_id);
        let index = index.unwrap_or_else(|| {
            self.kept.push(ClaudeModelRows {
                model_id: kept.model_id,
                rows: Vec::new(),
                provider_figure_usd_micros: None,
                spent: [0; SPEND_FIGURES],
                region: None,
            });
            self.kept.len() - 1
        });
        let model = &mut self.kept[index];
        for (spent, figure) in model.spent.iter_mut().zip(kept.spent) {
            *spent = spent.saturating_add(figure);
        }
        model.rows.push(kept.row);
        model.region = kept.region;
    }

    /// The spend each model's entry in `model_costs` states past the rows kept on it since the
    /// last result, as one delta per model on `thread_id`: at the entry's model, a request of its
    /// own at the standard speed, in the kept rows' region. A figure the rows exceed is carried as
    /// the model's balance, which the model's next stated spend fills before any delta comes of it.
    /// A `list` or `managed` figure with no tokens left to carry, on a model with no row kept since
    /// the last result, is still spend: one delta of no tokens at its model, which takes it whole.
    pub(crate) fn take_unshown_spend(
        &mut self,
        model_costs: &[ClaudeModelCost],
        thread_id: &str,
    ) -> Vec<MeteredUsageDelta> {
        let mut unshown = Vec::new();
        for entry in model_costs {
            let kept = (self.kept.iter()).find(|kept| kept.model_id == entry.model_id);
            let spent = kept.map_or([0; SPEND_FIGURES], |kept| kept.spent);
            let counts = &entry.counts;
            let stated = [
                counts.input,
                counts.cached_input,
                counts.cache_write_input,
                counts.output,
                entry.web_search_requests,
            ];
            let balance = self.balances.entry(entry.model_id.clone()).or_default();
            let mut parts = [0_u64; SPEND_FIGURES];
            for ((part, balance), (stated, spent)) in parts
                .iter_mut()
                .zip(balance.iter_mut())
                .zip(stated.into_iter().zip(spent))
            {
                let signed = i128::from(stated.unwrap_or(0)) - i128::from(spent) + *balance;
                (*part, *balance) = u64::try_from(signed).map_or((0, signed), |part| (part, 0));
            }
            let is_figure_alone =
                kept.is_none() && stated_figure(entry).is_some_and(|figure| figure > 0.0);
            if parts == [0; SPEND_FIGURES] && !is_figure_alone {
                continue;
            }
            let [input, cached_input, cache_write_input, output, web_searches] =
                parts.map(|part| (part > 0).then_some(part));
            let request = UsageRequestFacts {
                model_id: Some(entry.model_id.clone()),
                processing_region: kept.and_then(|kept| kept.region.clone()),
                web_search_requests: web_searches,
                ..UsageRequestFacts::default()
            };
            let counts = UsageAxisCounts {
                input,
                cached_input,
                cache_write_input,
                output,
                reasoning_output: None,
                total: None,
            };
            let (provider, thread) = (DESCRIPTOR.provider_id(), thread_id.to_owned());
            unshown.push(meter_from_zero(provider, thread, counts, request));
        }
        unshown
    }

    /// Takes the rows of each model `model_costs` states at a `result`, each model's cost since
    /// the process's previous result: a model whose entry reads `list` or `managed` with a cost
    /// takes that cost; any other takes none. A model the result leaves out keeps its rows for the
    /// result that states them, since a call that finishes after a result is stated on the next.
    /// A basis the driver does not know is logged once per process on `session_id` and
    /// `provider_account_id`.
    pub(crate) fn take_at_result(
        &mut self,
        model_costs: &[ClaudeModelCost],
        session_id: SessionId,
        provider_account_id: &ProviderAccountId,
    ) -> Vec<ClaudeModelRows> {
        let is_stated = |model: &ClaudeModelRows| {
            (model_costs.iter()).any(|entry| entry.model_id == model.model_id)
        };
        let (mut taken, waiting) = std::mem::take(&mut self.kept)
            .into_iter()
            .partition(is_stated);
        self.kept = waiting;
        for entry in model_costs {
            let figure = self.provider_figure(entry, session_id, provider_account_id);
            if let Some(model) = taken
                .iter_mut()
                .find(|model| model.model_id == entry.model_id)
            {
                model.provider_figure_usd_micros = figure;
            }
        }
        taken
    }

    /// Takes every kept model's rows, each to be priced from the price list.
    pub(crate) fn take_all(&mut self) -> Vec<ClaudeModelRows> {
        std::mem::take(&mut self.kept)
    }

    // The provider's figure `entry` states, in micro-dollars: its cost where its basis is `list`
    // or `managed`, else none.
    fn provider_figure(
        &mut self,
        entry: &ClaudeModelCost,
        session_id: SessionId,
        provider_account_id: &ProviderAccountId,
    ) -> Option<f64> {
        let figure = stated_figure(entry);
        match entry.cost_basis.as_deref() {
            Some("list" | "managed" | "unknown") | None => figure,
            Some(basis) => {
                self.report_basis(basis, &entry.model_id, session_id, provider_account_id);
                None
            }
        }
    }

    fn report_basis(
        &mut self,
        basis: &str,
        model_id: &ModelId,
        session_id: SessionId,
        provider_account_id: &ProviderAccountId,
    ) {
        self.basis_reports.report(&DriverDiagnosticRecord {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id: Some(provider_account_id.clone()),
            kind: DriverDiagnosticKind::UnmappedWireKind,
            raw_wire_type: Some(basis.to_owned()),
            disposition_reason: "a `model_usage_since_last_result` entry's `costBasis` is not one \
                                 the driver knows, so the model's requests are priced from the \
                                 price list"
                .to_owned(),
            details: Map::from_iter([
                ("sessionId".to_owned(), Value::from(session_id.to_string())),
                ("modelId".to_owned(), Value::from(model_id.as_str())),
            ]),
        });
    }
}

// The figure `entry` states in micro-dollars where its basis is `list` or `managed`.
fn stated_figure(entry: &ClaudeModelCost) -> Option<f64> {
    let is_figure = matches!(entry.cost_basis.as_deref(), Some("list" | "managed"));
    let cost_usd = entry.cost_usd.filter(|_| is_figure);
    cost_usd.map(|cost_usd| cost_usd * MICRO_DOLLARS_PER_DOLLAR)
}

// A stored row's input, output, cache-read and whole cache-write counts, each 0 where it holds
// none.
struct RowCounts {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}

impl RowCounts {
    fn of(row: &UnpricedUsageRow) -> Self {
        let [input, output, cache_read, cache_write, _reasoning] = row.tokens.map(count);
        Self {
            input,
            output,
            cache_read,
            cache_write,
        }
    }
}

fn count(figure: Option<SafeInt<0>>) -> u64 {
    figure.map_or(0, SafeInt::get)
}

// The speeds a Claude request is priced at.
#[derive(Clone, Copy)]
enum ClaudeSpeed {
    Standard,
    Fast,
}

impl ClaudeSpeed {
    // A message's `speed`: the standard rates for none or `standard`, `fast` for `fast`; `None` for
    // any other word, which leaves the request unpriced.
    fn read(speed: Option<&str>) -> Option<Self> {
        match speed {
            None | Some("standard") => Some(Self::Standard),
            Some(CLAUDE_FAST_SPEED) => Some(Self::Fast),
            Some(_) => None,
        }
    }

    // The speed word the row prices, `None` for its standard rates.
    fn row_word(self) -> Option<&'static str> {
        match self {
            Self::Standard => None,
            Self::Fast => Some(CLAUDE_FAST_SPEED),
        }
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::event::usage::UsageCostSource;
    use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
    use sidekicks_contracts::provider::account::record::ProviderAccountId;
    use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
    use sidekicks_contracts::session::cost::UsdMicros;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};

    use super::ClaudeRequestPricer;
    use crate::account::usage_turns::unpriced::{
        UnpricedRequest, UnpricedUsageKey, UnpricedUsageRow,
    };
    use crate::driver::claude::DESCRIPTOR;
    use crate::pricing::list::{PriceRowSelection, PriceTable, decode_price_table};
    use crate::pricing::rule::{RequestPricer, RequestPricing};

    // The vendored list's rows for the models the tests price, their batch rates left out.
    const CLAUDE_COPY: &str = r#"{
        "claude-haiku-4-5-20251001": {"input_cost_per_token": 1e-06,
            "output_cost_per_token": 5e-06, "cache_read_input_token_cost": 1e-07,
            "cache_creation_input_token_cost": 1.25e-06,
            "cache_creation_input_token_cost_above_1hr": 2e-06},
        "claude-opus-5-5": {"input_cost_per_token": 4e-06, "output_cost_per_token": 2e-05,
            "cache_read_input_token_cost": 2e-07, "cache_creation_input_token_cost": 5e-06,
            "cache_creation_input_token_cost_above_1hr": 8e-06,
            "search_context_cost_per_query": {"search_context_size_high": 0.01,
                "search_context_size_low": 0.01, "search_context_size_medium": 0.01},
            "provider_specific_entry": {"us": 1.1, "fast": 2}},
        "claude-haiku-5-5": {"input_cost_per_token": 1e-07, "output_cost_per_token": 5e-07,
            "cache_read_input_token_cost": 1e-08, "cache_creation_input_token_cost": 1.25e-07,
            "cache_creation_input_token_cost_above_1hr": 2e-07,
            "input_cost_per_token_above_100k_tokens": 5e-07,
            "output_cost_per_token_above_100k_tokens": 2.5e-06,
            "cache_read_input_token_cost_above_100k_tokens": 5e-08,
            "cache_creation_input_token_cost_above_100k_tokens": 6.25e-07,
            "cache_creation_input_token_cost_above_1hr_above_100k_tokens": 1e-06,
            "provider_specific_entry": {"us": 1.1}}
    }"#;

    // One row's input, output, cache read, whole cache write, its one-hour part and its searches.
    type Counts = [u64; 6];

    fn table() -> PriceTable {
        decode_price_table(CLAUDE_COPY, PriceRowSelection::Every)
            .expect("the copy is a price list")
            .table
    }

    fn fact(text: Option<&str>) -> Option<BoundedText<1, EVENT_FIELD_MAX_LEN>> {
        text.map(|text| BoundedText::new(text.to_owned()).expect("a request fact"))
    }

    fn key(model_id: &str, speed: Option<&str>, region: Option<&str>) -> UnpricedUsageKey {
        UnpricedUsageKey {
            provider: DESCRIPTOR.provider_id(),
            account_id: ProviderAccountId::new("account".to_owned()).expect("an account id"),
            model_id: Some(FreeFormText::new(model_id.to_owned()).expect("a model id")),
            speed: fact(speed),
            processing_region: fact(region),
        }
    }

    fn request(rows: &[Counts]) -> UnpricedRequest {
        let figure = |count: u64| Some(SafeInt::new(count).expect("a small count"));
        UnpricedRequest {
            request_key: fact(Some("message")),
            rows: rows
                .iter()
                .enumerate()
                .map(
                    |(index, &[input, output, read, write, write_1h, searches])| UnpricedUsageRow {
                        turn_id: FreeFormText::new(format!("row-{index}")).expect("a row id"),
                        session_id: None,
                        run_id: None,
                        subagent_id: None,
                        occurred_at: WireInstant::now(),
                        tokens: [
                            figure(input),
                            figure(output),
                            figure(read),
                            figure(write),
                            None,
                        ],
                        cache_write_extended_tokens: figure(write_1h),
                        web_search_requests: figure(searches),
                        thread_speed: None,
                    },
                )
                .collect(),
        }
    }

    /// Killed by the five-minute rate on a one-hour write (12,984 becomes 8,137); `fast`
    /// unmultiplied (14,000); input alone picking the long-context tier (6,500); `>=` against the
    /// threshold (5,500 becomes 27,500); the threshold read per row (32,650); searches unpriced;
    /// every region but `us` unpriced, no speed unpriced, `us` held on a row without it and 1.1
    /// taken there (1,650).
    #[rstest]
    #[case::one_hour_write(
        "claude-haiku-4-5-20251001",
        None,
        None,
        vec![[3, 11, 0, 6_463, 6_463, 0]],
        vec![12_984]
    )]
    #[case::fast(
        "claude-opus-5-5",
        Some("fast"),
        None,
        vec![[1_000, 500, 0, 0, 0, 0]],
        vec![28_000]
    )]
    #[case::long_context(
        "claude-haiku-5-5",
        None,
        None,
        vec![[60_000, 0, 50_000, 0, 0, 0]],
        vec![32_500]
    )]
    #[case::at_threshold(
        "claude-haiku-5-5",
        None,
        None,
        vec![[50_000, 0, 50_000, 0, 0, 0]],
        vec![5_500]
    )]
    #[case::long_context_rows(
        "claude-haiku-5-5",
        None,
        None,
        vec![[60_000, 0, 50_000, 0, 0, 0], [0, 300, 0, 0, 0, 0]],
        vec![32_500, 750]
    )]
    #[case::searches("claude-opus-5-5", None, None, vec![[1_000, 500, 0, 0, 0, 2]], vec![34_000])]
    #[case::no_region(
        "claude-opus-5-5",
        Some("standard"),
        None,
        vec![[1_000, 500, 0, 0, 0, 0]],
        vec![14_000]
    )]
    #[case::us("claude-opus-5-5", None, Some("us"), vec![[1_000, 500, 0, 0, 0, 0]], vec![15_400])]
    #[case::us_without_multiplier(
        "claude-haiku-4-5-20251001",
        None,
        Some("us"),
        vec![[1_000, 100, 0, 0, 0, 0]],
        vec![1_500]
    )]
    fn a_request_is_priced_at_its_rows_rates(
        #[case] model_id: &str,
        #[case] speed: Option<&str>,
        #[case] region: Option<&str>,
        #[case] rows: Vec<Counts>,
        #[case] shares: Vec<u64>,
    ) {
        let (table, key) = (table(), key(model_id, speed, region));
        assert!(ClaudeRequestPricer.prices_key(&table, &key));
        let shares = shares
            .into_iter()
            .map(|share| UsdMicros(SafeInt::new(share).expect("a small figure")))
            .collect();
        assert_eq!(
            ClaudeRequestPricer.price(&table, &key, &request(&rows), None),
            RequestPricing::Priced {
                cost_source: UsageCostSource::DerivedExact,
                shares,
            }
        );
    }

    /// Killed by a prefix match on the model, by an unknown speed word read as standard, and by a
    /// region the row lacks while it carries `us` read at the base rate.
    #[rstest]
    #[case::longer_model_id("claude-opus-5-5-x", None, None)]
    #[case::unknown_speed("claude-opus-5-5", Some("priority"), None)]
    #[case::unknown_region("claude-opus-5-5", None, Some("eu"))]
    fn a_key_the_rule_cannot_price_is_held(
        #[case] model_id: &str,
        #[case] speed: Option<&str>,
        #[case] region: Option<&str>,
    ) {
        assert!(!ClaudeRequestPricer.prices_key(&table(), &key(model_id, speed, region)));
    }

    /// Killed by a model listed as fast read as priced on a row with no `fast` rate or multiplier,
    /// which leaves the fetch for it until a fast request is held, and by a model listed at the
    /// standard speed alone read as lacking one.
    #[rstest]
    #[case::fast_priced("claude-opus-5-5", true, true)]
    #[case::fast_lacking("claude-haiku-4-5-20251001", true, false)]
    #[case::standard_alone("claude-haiku-4-5-20251001", false, true)]
    fn a_listed_model_is_priced_at_each_speed_it_offers(
        #[case] model_id: &str,
        #[case] fast: bool,
        #[case] is_priced: bool,
    ) {
        let text = |text: &str| FreeFormText::new(text.to_owned()).expect("a listing word");
        let model = ProviderModel {
            id: text(model_id),
            name: text(model_id),
            capabilities: Vec::new(),
            effort_levels: None,
            output_speed_levels: None,
            fast,
            larger_window: false,
            context_window: None,
        };
        assert_eq!(
            ClaudeRequestPricer.prices_listed_model(&table(), &model),
            is_priced
        );
    }
}
