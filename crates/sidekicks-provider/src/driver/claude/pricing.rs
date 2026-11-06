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
//!   that cost, shared over the model's rows; any other model is priced from the price list. A
//!   `result` stating no figures leaves the rows for the next one, and the rows still kept when the
//!   process ends are priced from the price list.
//! - **The spend no message showed.** What an entry counts past the model's rows since the last
//!   result (an advisor's calls, a compaction, a title) is recorded as one more row on the model
//!   before the price is taken; rows past their entry carry over as the model's balance, and a
//!   figure with no row to land on carries to the model's next rows.

use std::collections::HashMap;

use serde_json::{Map, Value};
use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};

use crate::account::usage_turns::unpriced::{UnpricedRequest, UnpricedUsageKey, UnpricedUsageRow};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::transport::declarations::ClaudeModelCost;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, OnceReportedDiagnostics,
};
use crate::pricing::list::PriceTable;
use crate::pricing::live::LiveUsageRow;
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
/// rows have not yet matched: the calls streamed ahead of the result that states them, and the
/// figures no row was kept to carry.
#[derive(Default)]
pub(crate) struct ClaudeResultPricing {
    kept: Vec<ClaudeModelRows>,
    // Each model's spend its rows showed past what its results have stated, as each figure's
    // shortfall, zero or below.
    balances: HashMap<ModelId, [i128; SPEND_FIGURES]>,
    // Each model's provider figure in micro-dollars that no kept row has carried yet.
    carried_usd_micros: HashMap<ModelId, f64>,
    // The `costBasis` words and the dropped figures already logged on this process.
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

impl ClaudeResultPricing {
    /// Keeps `row`, recorded on `model_id` from `delta`, until the process's next lead `result` or
    /// its end.
    pub(crate) fn keep(&mut self, model_id: ModelId, row: LiveUsageRow, delta: &MeteredUsageDelta) {
        let index = self.kept.iter().position(|kept| kept.model_id == model_id);
        let index = index.unwrap_or_else(|| {
            self.kept.push(ClaudeModelRows {
                model_id,
                rows: Vec::new(),
                provider_figure_usd_micros: None,
                spent: [0; SPEND_FIGURES],
                region: None,
            });
            self.kept.len() - 1
        });
        let kept = &mut self.kept[index];
        let axes = &delta.axis_deltas;
        let figures = [
            axes.input,
            axes.cached_input,
            axes.cache_write_input,
            axes.output,
            delta.request.web_search_requests,
        ];
        for (spent, figure) in kept.spent.iter_mut().zip(figures) {
            *spent = spent.saturating_add(figure.unwrap_or(0));
        }
        kept.rows.push(row);
        kept.region.clone_from(&delta.request.processing_region);
    }

    /// The spend each model's entry in `model_costs` states past the rows kept on it since the
    /// last result, as one delta per model on `thread_id`: at the entry's model, a request of its
    /// own at the standard speed, in the kept rows' region. A figure the rows exceed is carried as
    /// the model's balance, which the model's next stated spend fills before any delta comes of it.
    pub(crate) fn take_unshown_spend(
        &mut self,
        model_costs: &[ClaudeModelCost],
        thread_id: &str,
    ) -> Vec<MeteredUsageDelta> {
        let mut unshown = Vec::new();
        for entry in model_costs {
            let kept = self
                .kept
                .iter()
                .find(|kept| kept.model_id == entry.model_id);
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
            if parts == [0; SPEND_FIGURES] {
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
            let provider = DESCRIPTOR.provider_id();
            unshown.push(meter_from_zero(
                provider,
                thread_id.to_owned(),
                counts,
                request,
            ));
        }
        unshown
    }

    /// Takes every kept model's rows at a `result` stating `model_costs`, each model's cost since
    /// the process's previous result: a model whose entry reads `list` or `managed` with a cost
    /// takes that cost, with any figure carried for it; any other takes none. A figure for a model
    /// with no kept rows is carried to its next. A basis the driver does not know is logged once
    /// per process on `session_id` and `provider_account_id`.
    pub(crate) fn take_at_result(
        &mut self,
        model_costs: &[ClaudeModelCost],
        session_id: SessionId,
        provider_account_id: &ProviderAccountId,
    ) -> Vec<ClaudeModelRows> {
        let mut taken = std::mem::take(&mut self.kept);
        for entry in model_costs {
            let figure = self.provider_figure(entry, session_id, provider_account_id);
            if let Some(model) = taken
                .iter_mut()
                .find(|model| model.model_id == entry.model_id)
            {
                model.provider_figure_usd_micros = figure.map(|figure| {
                    figure
                        + self
                            .carried_usd_micros
                            .remove(&model.model_id)
                            .unwrap_or(0.0)
                });
            } else if let Some(figure) = figure {
                *self
                    .carried_usd_micros
                    .entry(entry.model_id.clone())
                    .or_default() += figure;
            }
        }
        taken
    }

    /// Takes every kept model's rows, each to be priced from the price list. A figure still carried
    /// for a model no row took is dropped, logged once per process on `session_id` and
    /// `provider_account_id`.
    pub(crate) fn take_all(
        &mut self,
        session_id: SessionId,
        provider_account_id: &ProviderAccountId,
    ) -> Vec<ClaudeModelRows> {
        for (model_id, carried_usd_micros) in std::mem::take(&mut self.carried_usd_micros) {
            self.basis_reports.report(&DriverDiagnosticRecord {
                provider: DESCRIPTOR.provider_id(),
                provider_account_id: Some(provider_account_id.clone()),
                kind: DriverDiagnosticKind::UsageCrossCheckMismatch,
                raw_wire_type: Some(model_id.as_str().to_owned()),
                disposition_reason: "a result's figure for a model found no row to carry it \
                                     before the process ended, so it is dropped"
                    .to_owned(),
                details: Map::from_iter([
                    ("sessionId".to_owned(), Value::from(session_id.to_string())),
                    ("modelId".to_owned(), Value::from(model_id.as_str())),
                    (
                        "carriedUsdMicros".to_owned(),
                        Value::from(carried_usd_micros),
                    ),
                ]),
            });
        }
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
        match (entry.cost_basis.as_deref(), entry.cost_usd) {
            (Some("list" | "managed"), Some(cost_usd)) => Some(cost_usd * MICRO_DOLLARS_PER_DOLLAR),
            (Some("list" | "managed" | "unknown") | None, _) => None,
            (Some(basis), _) => {
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

// A stored row's input, output, cache-read and whole cache-write counts, each 0 where it holds none.
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
}
