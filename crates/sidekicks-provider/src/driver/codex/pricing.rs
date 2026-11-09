//! What a Codex request costs: its rule, which its live pricing and the repricing of held requests
//! both call.
//!
//! - **A plan sign-in** (a subscription or a token from one) is valued at the standard rates, or
//!   its tier's where the row has them: a cache write at the input rate, never long context and no
//!   region.
//! - **An API key** takes the long-context rates once the request's input, cache reads and writes
//!   pass the row's threshold, its region's multiplier where the service's host is one of the API's
//!   regional hosts, and every cache write at the row's 30-minute rate. Any other host is unpriced.
//! - **Any other sign-in kind**, or none read yet, holds the request for the kind.
//!
//! Web searches carry no count on Codex's usage, so none is priced.
//!
//! A session's recorder, and each side question's or hand-over's copy, prices each row as it
//! records it: it reads its service's region once per service, stamps it on every row so the
//! stored row and the live key carry one region, and hands each model's recorded rows to the
//! driver's one live pricing, which a reroute also marks its model in use on. A row naming no model
//! is recorded unpriced.

use std::path::Path;
use std::sync::Arc;

use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAuthMode;
use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};

use crate::account::usage_turns::unpriced::{UnpricedRequest, UnpricedUsageKey};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::config_read::{
    CodexProcessingRegion, OPENAI_REGION_PREFIXES, read_codex_processing_region,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceId};
use crate::port::usage_sink::{MeteredUsage, UsageSink};
use crate::pricing::BoxedError;
use crate::pricing::list::{PriceRow, PriceTable, SpeedPricing};
use crate::pricing::live::{LivePricing, LiveUsageRow};
use crate::pricing::quote::{RequestTokenCounts, RequestUsage, quote_request_rows};
use crate::pricing::rule::{RequestPricer, RequestPricing};
use crate::usage_delta_accountant::UsageRequestFacts;
type RegionWord = BoundedText<1, EVENT_FIELD_MAX_LEN>;

// The region a service on a host that is neither the API's own nor one of its regional hosts
// stamps on its rows; no regional prefix equals it, so the rule holds an API key's requests.
const UNKNOWN_HOST_REGION: &str = "unknownHost";

/// The models Codex's automatic reviewer runs by default, on a plan sign-in and on an API key.
pub(crate) const CODEX_REVIEWER_MODELS: [&str; 2] = ["codex-auto-review", "gpt-5.6-luna"];

/// The facts a Codex request carries: its `model`, and the `tier` it was sent at as both its own
/// speed and its thread's; shared by a copy's readings and the export's responses.
pub(crate) fn compose_codex_request_facts(model: &str, tier: Option<&str>) -> UsageRequestFacts {
    let speed = tier.and_then(|tier| BoundedText::new(tier.to_owned()));
    UsageRequestFacts {
        model_id: FreeFormText::new(model.to_owned()).ok(),
        speed: speed.clone(),
        thread_speed: speed,
        ..UsageRequestFacts::default()
    }
}

/// Codex's rule for pricing its requests from the held price table by the account's sign-in kind.
pub(crate) struct CodexRequestPricer;

impl RequestPricer for CodexRequestPricer {
    fn needs_sign_in_kind(&self) -> bool {
        true
    }

    // The table has the model's own row and the row prices its tier with rates of its own; a tier
    // the row prices only by a multiplier is unpriced. The region is left to `price`, which reads
    // it only for an API key.
    fn prices_key(&self, table: &PriceTable, key: &UnpricedUsageKey) -> bool {
        key.model_id
            .as_ref()
            .and_then(|model_id| table.row(model_id.as_str()))
            .is_some_and(|row| prices_tier(row, rate_speed(key)))
    }

    // Each tier the model lists is a speed its requests may run at.
    fn prices_listed_model(&self, table: &PriceTable, model: &ProviderModel) -> bool {
        table.row(model.id.as_str()).is_some_and(|row| {
            (model.output_speed_levels.iter().flatten())
                .map(FreeFormText::as_str)
                .filter(|tier| *tier != DESCRIPTOR.standard_output_speed)
                .all(|tier| prices_tier(row, Some(tier)))
        })
    }

    fn price(
        &self,
        table: &PriceTable,
        key: &UnpricedUsageKey,
        request: &UnpricedRequest,
        sign_in_kind: Option<ProviderAuthMode>,
    ) -> RequestPricing {
        let is_plan = match sign_in_kind {
            Some(ProviderAuthMode::OauthSubscription | ProviderAuthMode::OauthToken) => true,
            Some(ProviderAuthMode::ApiKey) => false,
            Some(
                ProviderAuthMode::External | ProviderAuthMode::None | ProviderAuthMode::Unknown,
            )
            | None => return RequestPricing::HeldForSignInKind,
        };
        let Some(model_id) = &key.model_id else {
            return RequestPricing::HeldForPrice;
        };
        let region = if is_plan {
            None
        } else {
            key.processing_region.as_ref().map(BoundedText::as_str)
        };
        if region.is_some_and(|region| !OPENAI_REGION_PREFIXES.contains(&region)) {
            return RequestPricing::HeldForPrice;
        }
        let row_tokens: Vec<RequestTokenCounts> = request
            .rows
            .iter()
            .map(|row| {
                let count = |axis: usize| row.tokens[axis].map_or(0, SafeInt::get);
                let (input, cache_write) = if is_plan {
                    (count(0).saturating_add(count(3)), 0)
                } else {
                    (count(0), count(3))
                };
                RequestTokenCounts {
                    input,
                    output: count(1),
                    cache_read: count(2),
                    cache_write,
                    cache_write_extended: 0,
                }
            })
            .collect();
        let long_context_tokens = if is_plan {
            0
        } else {
            row_tokens
                .iter()
                .map(|tokens| {
                    tokens
                        .input
                        .saturating_add(tokens.cache_read)
                        .saturating_add(tokens.cache_write)
                })
                .fold(0, u64::saturating_add)
        };
        let rows: Vec<RequestUsage<'_>> = row_tokens
            .into_iter()
            .map(|tokens| RequestUsage {
                model_id: model_id.as_str(),
                speed: rate_speed(key),
                region,
                region_words: &OPENAI_REGION_PREFIXES,
                long_context_tokens,
                // Codex writes the cache at one lifetime only, so no count reads this.
                extended_cache_lifetime_hours: 1,
                tokens,
                web_searches: 0,
                search_context_size: "medium",
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

/// One recorder's pricing of Codex rows: the driver's one live pricing, and the region of the
/// service it last read one on.
#[derive(Clone)]
pub(crate) struct CodexRecorderPricing {
    live: Arc<LivePricing>,
    region: Option<(CodexServiceId, Option<RegionWord>)>,
}

impl CodexRecorderPricing {
    /// The recorder-side pricing through `live`, the driver's live pricing of Codex's rule.
    pub(crate) fn new(live: Arc<LivePricing>) -> Self {
        Self { live, region: None }
    }

    /// Records `batch`, metered on `service` for `folder`, through `sink` in order, each delta
    /// stamped with the service's region, then prices what was recorded once per model. A region
    /// that could not be read, which leaves the batch on the unknown host's region, and a delta
    /// that was not recorded are each handed to `report`.
    pub(crate) async fn record(
        &mut self,
        sink: &dyn UsageSink,
        batch: Vec<MeteredUsage>,
        service: &CodexService,
        folder: &Path,
        report: &impl Fn(BoxedError),
    ) {
        let region = self.read_region(service, folder, report).await;
        let mut rows_by_model: Vec<(
            SessionId,
            FreeFormText<EVENT_FIELD_MAX_LEN>,
            Vec<LiveUsageRow>,
        )> = Vec::new();
        for mut metered in batch {
            metered.delta.request.processing_region.clone_from(&region);
            let session_id = metered.session_id;
            let priced = metered
                .delta
                .request
                .model_id
                .clone()
                .map(|model_id| (model_id, metered.delta.clone()));
            match sink.record_metered(metered).await {
                Ok(Some(recorded)) => {
                    let Some((model_id, delta)) = priced else {
                        continue;
                    };
                    let row = LiveUsageRow::new(&recorded, session_id, &delta);
                    match rows_by_model
                        .iter_mut()
                        .find(|(session, model, _)| *session == session_id && *model == model_id)
                    {
                        Some((_, _, rows)) => rows.push(row),
                        None => rows_by_model.push((session_id, model_id, vec![row])),
                    }
                }
                Ok(None) => {}
                Err(error) => report(error),
            }
        }
        for (session_id, model_id, rows) in rows_by_model {
            self.live.price(session_id, &model_id, rows, None).await;
        }
    }

    // The region of `service`'s model provider, read once per service; a failed read is reported
    // and answers the unknown host's region, kept for no later batch.
    async fn read_region(
        &mut self,
        service: &CodexService,
        folder: &Path,
        report: &impl Fn(BoxedError),
    ) -> Option<RegionWord> {
        if let Some((service_id, region)) = &self.region
            && *service_id == service.id()
        {
            return region.clone();
        }
        let read = match service.connection() {
            Ok(connection) => read_codex_processing_region(&connection, folder).await,
            Err(error) => Err(error),
        };
        let region = match read {
            Ok(region) => region,
            Err(error) => {
                report(Box::new(error));
                return region_word(&CodexProcessingRegion::UnknownHost);
            }
        };
        let word = region_word(&region);
        self.region = Some((service.id(), word.clone()));
        word
    }
}

// The word a row carries for `region`: none, the regional host's prefix, or the unknown host's.
fn region_word(region: &CodexProcessingRegion) -> Option<RegionWord> {
    match region {
        CodexProcessingRegion::NoRegion => None,
        CodexProcessingRegion::Region(prefix) => BoundedText::new(prefix.clone()),
        CodexProcessingRegion::UnknownHost => BoundedText::new(UNKNOWN_HOST_REGION.to_owned()),
    }
}

// Whether `row` prices `tier` (`None` the standard one) with rates of its own.
fn prices_tier(row: &PriceRow, tier: Option<&str>) -> bool {
    matches!(
        row.speed(tier),
        Some(SpeedPricing::Standard | SpeedPricing::SpeedRates)
    )
}

// The tier whose rates the key's requests take: `None` for the standard tier, which Codex names
// `default` or leaves unset.
fn rate_speed(key: &UnpricedUsageKey) -> Option<&str> {
    key.speed
        .as_ref()
        .map(BoundedText::as_str)
        .filter(|speed| *speed != DESCRIPTOR.standard_output_speed)
}

#[cfg(test)]
pub(crate) mod tests {
    use rstest::rstest;
    use sidekicks_contracts::event::usage::UsageCostSource;
    use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
    use sidekicks_contracts::session::cost::UsdMicros;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};

    use super::CodexRequestPricer;
    use crate::account::usage_turns::unpriced::{
        UnpricedRequest, UnpricedUsageKey, UnpricedUsageRow,
    };
    use crate::driver::codex::DESCRIPTOR;
    use crate::pricing::list::{PriceRowSelection, decode_price_table};
    use crate::pricing::rule::{RequestPricer, RequestPricing};

    // Two of the list's OpenAI rows as it carries them, cut to the rates the tests read: one with
    // regional multipliers, long-context and `priority` rates, one with neither.
    const OPENAI_COPY: &str = r#"{
        "gpt-6.1-sol": {
            "input_cost_per_token": 2e-06,
            "input_cost_per_token_above_272k_tokens": 4e-06,
            "input_cost_per_token_priority": 4e-06,
            "cache_read_input_token_cost": 1e-07,
            "cache_read_input_token_cost_above_272k_tokens": 2e-07,
            "cache_creation_input_token_cost": 2.5e-06,
            "cache_creation_input_token_cost_above_12hr": 5e-06,
            "output_cost_per_token": 1e-05,
            "output_cost_per_token_priority": 2e-05,
            "regional_processing_uplift_multiplier_eu": 1.1,
            "regional_processing_uplift_multiplier_us": 1.1
        },
        "gpt-5.3-codex": {
            "input_cost_per_token": 1.75e-06,
            "cache_read_input_token_cost": 1.75e-07,
            "output_cost_per_token": 1.4e-05
        }
    }"#;

    const API_KEY: Option<ProviderAuthMode> = Some(ProviderAuthMode::ApiKey);
    /// A plan sign-in, valued at the standard rates or its tier's.
    pub(crate) const PLAN: Option<ProviderAuthMode> = Some(ProviderAuthMode::OauthSubscription);

    /// One request's counts: input, output, cache read and cache write.
    pub(crate) type Counts = [u64; 4];

    /// What one request of `counts` on `model` at `speed` in `region` makes under `sign_in_kind`,
    /// through `prices_key` first as both callers ask, from two rows as the list carries them.
    pub(crate) fn price(
        model: &str,
        speed: Option<&str>,
        region: Option<&str>,
        sign_in_kind: Option<ProviderAuthMode>,
        counts: Counts,
    ) -> RequestPricing {
        let table = decode_price_table(OPENAI_COPY, PriceRowSelection::Every)
            .expect("the copy is a price list")
            .table;
        let fact = |text: Option<&str>| {
            text.map(|text| BoundedText::new(text.to_owned()).expect("a fact"))
        };
        let key = UnpricedUsageKey {
            provider: DESCRIPTOR.provider_id(),
            account_id: ProviderAccountId::new("account-a".to_owned()).expect("an account id"),
            model_id: Some(FreeFormText::new(model.to_owned()).expect("a model id")),
            speed: fact(speed),
            processing_region: fact(region),
        };
        let figure = |count: u64| Some(SafeInt::new(count).expect("a small count"));
        let [input, output, cache_read, cache_write] = counts;
        let request = UnpricedRequest {
            request_key: None,
            rows: vec![UnpricedUsageRow {
                turn_id: FreeFormText::new("event-1".to_owned()).expect("an event id"),
                session_id: None,
                run_id: None,
                subagent_id: None,
                occurred_at: WireInstant::now(),
                tokens: [
                    figure(input),
                    figure(output),
                    figure(cache_read),
                    figure(cache_write),
                    None,
                ],
                cache_write_extended_tokens: None,
                web_search_requests: None,
                thread_speed: None,
            }],
        };
        assert!(CodexRequestPricer.prices_key(&table, &key));
        CodexRequestPricer.price(&table, &key, &request, sign_in_kind)
    }

    fn priced(whole: u64) -> RequestPricing {
        RequestPricing::Priced {
            cost_source: UsageCostSource::DerivedExact,
            shares: vec![UsdMicros(SafeInt::new(whole).expect("a small figure"))],
        }
    }

    // Killed by leaving cached input in the input count (24,000), by `>=` at the threshold
    // (814,400 for 272,000 tokens), by long context or the region on a plan (818,400; 450,120), by
    // a plan's write at the write rate (409,700), by `default` read as a tier (unpriced), by a
    // write at the longer lifetime (5,000), by the region ignored (3,000) and by pricing a kind
    // that holds.
    #[rstest]
    #[case::standard("gpt-6.1-sol", None, None, API_KEY, [1_000, 100, 10_000, 0], priced(4_000))]
    #[case::default_tier(
        "gpt-6.1-sol",
        Some("default"),
        None,
        API_KEY,
        [1_000, 100, 0, 0],
        priced(3_000)
    )]
    #[case::long_context_past_n(
        "gpt-6.1-sol",
        None,
        None,
        API_KEY,
        [200_000, 0, 72_001, 0],
        priced(814_400)
    )]
    #[case::long_context_at_n(
        "gpt-6.1-sol",
        None,
        None,
        API_KEY,
        [200_000, 0, 72_000, 0],
        priced(407_200)
    )]
    #[case::priority(
        "gpt-6.1-sol",
        Some("priority"),
        None,
        API_KEY,
        [1_000, 100, 0, 0],
        priced(6_000)
    )]
    #[case::thirty_minute_write(
        "gpt-6.1-sol",
        None,
        None,
        API_KEY,
        [0, 0, 0, 1_000],
        priced(2_500)
    )]
    #[case::plan(
        "gpt-6.1-sol",
        None,
        Some("eu"),
        PLAN,
        [200_000, 0, 72_001, 1_000],
        priced(409_200)
    )]
    #[case::regional_host(
        "gpt-6.1-sol",
        None,
        Some("eu"),
        API_KEY,
        [1_000, 100, 0, 0],
        priced(3_300)
    )]
    #[case::unknown_host(
        "gpt-5.3-codex",
        None,
        Some("unknownHost"),
        API_KEY,
        [1_000, 100, 0, 0],
        RequestPricing::HeldForPrice
    )]
    #[case::no_kind(
        "gpt-6.1-sol",
        None,
        None,
        None,
        [1_000, 100, 0, 0],
        RequestPricing::HeldForSignInKind
    )]
    #[case::external_kind(
        "gpt-6.1-sol",
        None,
        None,
        Some(ProviderAuthMode::External),
        [1_000, 100, 0, 0],
        RequestPricing::HeldForSignInKind
    )]
    fn prices_a_request_by_the_sign_in_kind(
        #[case] model: &str,
        #[case] speed: Option<&str>,
        #[case] region: Option<&str>,
        #[case] sign_in_kind: Option<ProviderAuthMode>,
        #[case] counts: Counts,
        #[case] expected: RequestPricing,
    ) {
        assert_eq!(price(model, speed, region, sign_in_kind, counts), expected);
    }

    // A regional host on a row with no regional multiplier takes the base rates, and a region the
    // row lacks while it carries others is held. Killed by holding the first, by its 1.1 (3,465)
    // and by the base rate on the second.
    #[test]
    fn a_region_the_row_does_not_name_is_base_or_held_by_what_the_row_carries() {
        let counts = [1_000, 100, 0, 0];
        assert_eq!(
            price("gpt-5.3-codex", None, Some("eu"), API_KEY, counts),
            priced(3_150)
        );
        assert_eq!(
            price("gpt-6.1-sol", None, Some("ae"), API_KEY, counts),
            RequestPricing::HeldForPrice
        );
    }
}
