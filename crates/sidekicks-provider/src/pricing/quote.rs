//! One request priced exactly from the held table, in whole micro-dollars, and the split that
//! shares a request's figure across its rows.

use sidekicks_contracts::session::cost::UsdMicros;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::pricing::decimal::ExactDecimal;
use crate::pricing::list::{PriceTable, RateBase, RegionPricing, SpeedPricing};

// A figure's scale in micro-dollars: six fractional digits of a dollar.
const MICRO_DOLLAR_SCALE: u32 = 6;

/// One request as its driver reads it: the selectors that pick its rates and the counts they price.
pub(crate) struct RequestUsage<'a> {
    /// The model's exact id in the table, any suffix already stripped by the driver.
    pub(crate) model_id: &'a str,
    /// The speed word the row prices, `None` for the standard rates.
    pub(crate) speed: Option<&'a str>,
    /// The processing region, `None` for none.
    pub(crate) region: Option<&'a str>,
    /// The driver's region names, the only provider-specific keys read as regions.
    pub(crate) region_words: &'a [&'a str],
    /// The whole request's tokens, counted the driver's way, that pick a long-context threshold;
    /// the whole request's sum even when one row of several is quoted.
    pub(crate) long_context_tokens: u64,
    /// The longer cache write's lifetime in hours, the key its rate carries.
    pub(crate) extended_cache_lifetime_hours: u32,
    /// The request's token counts.
    pub(crate) tokens: RequestTokenCounts,
    /// How many web searches the request ran.
    pub(crate) web_searches: u64,
    /// The searches' context size (`low`, `medium`, `high`).
    pub(crate) search_context_size: &'a str,
}

/// One request's token counts by the rate each takes.
pub(crate) struct RequestTokenCounts {
    /// Input tokens.
    pub(crate) input: u64,
    /// Output tokens.
    pub(crate) output: u64,
    /// Input tokens read from the cache.
    pub(crate) cache_read: u64,
    /// Input tokens written to the cache at the shorter lifetime only.
    pub(crate) cache_write: u64,
    /// Input tokens written to the cache at the longer lifetime.
    pub(crate) cache_write_extended: u64,
}

/// Why a request was left unpriced.
#[derive(Debug, thiserror::Error)]
pub(crate) enum QuoteRefusal {
    /// The table has no row for the model.
    #[error("the price list has no row for the model")]
    ModelAbsent,
    /// The row prices no such speed.
    #[error("the price list's row does not price the request's speed")]
    SpeedUnpriced,
    /// The row prices no such region.
    #[error("the price list's row does not price the request's region")]
    RegionUnpriced,
    /// A token count is non-zero and the row carries no rate at its key.
    #[error("the price list's row has no {base:?} rate at cache lifetime {cache_lifetime_hours:?}")]
    RateAbsent {
        /// The rate's kind.
        base: RateBase,
        /// The cache lifetime in hours the rate was looked up at, `None` for the shorter one.
        cache_lifetime_hours: Option<u32>,
    },
    /// The request ran searches and the row carries no rate at its context size.
    #[error("the price list's row has no per-search rate at the request's context size")]
    SearchRateAbsent,
    /// A step of the arithmetic, or the figure, is past what the integers hold.
    #[error("the request's figure is past what the arithmetic holds")]
    Overflow,
}

/// Prices one request exactly from its row, rounded half to even once to whole micro-dollars:
/// each token term times the speed and region multipliers, searches at their flat rate. Refused
/// with [`QuoteRefusal`] when the row, a selector or a needed rate is missing, or on overflow.
pub(crate) fn quote_request(
    table: &PriceTable,
    request: &RequestUsage<'_>,
) -> Result<UsdMicros, QuoteRefusal> {
    let row = table
        .row(request.model_id)
        .ok_or(QuoteRefusal::ModelAbsent)?;
    let speed = row
        .speed(request.speed)
        .ok_or(QuoteRefusal::SpeedUnpriced)?;
    let region = row
        .region(request.region, request.region_words)
        .ok_or(QuoteRefusal::RegionUnpriced)?;
    let threshold = row.long_context_threshold(request.long_context_tokens);
    let (rate_speed, speed_multiplier) = match speed {
        SpeedPricing::Standard => (None, None),
        SpeedPricing::SpeedRates => (request.speed, None),
        SpeedPricing::Multiplier(multiplier) => (None, Some(multiplier)),
    };
    let region_multiplier = match region {
        RegionPricing::Base => None,
        RegionPricing::Multiplier(multiplier) => Some(multiplier),
    };
    let token_multiplier = [speed_multiplier, region_multiplier]
        .into_iter()
        .flatten()
        .try_fold(ScaledAmount::ONE, |product, multiplier| {
            product.times(ScaledAmount::from(multiplier))
        })?;
    let tokens = &request.tokens;
    let extended_lifetime = Some(request.extended_cache_lifetime_hours);
    let token_terms = [
        (RateBase::Input, None, tokens.input),
        (RateBase::Output, None, tokens.output),
        (RateBase::CacheRead, None, tokens.cache_read),
        (RateBase::CacheWrite, None, tokens.cache_write),
        (
            RateBase::CacheWrite,
            extended_lifetime,
            tokens.cache_write_extended,
        ),
    ];
    let mut total = ScaledAmount::ZERO;
    for (base, cache_lifetime_hours, count) in token_terms {
        if count == 0 {
            continue;
        }
        let rate = row
            .rate(base, cache_lifetime_hours, threshold, rate_speed)
            .ok_or(QuoteRefusal::RateAbsent {
                base,
                cache_lifetime_hours,
            })?;
        let term = ScaledAmount::from(rate)
            .times(token_multiplier)?
            .times_count(count)?;
        total = total.plus(term)?;
    }
    if request.web_searches > 0 {
        let search_rate = row
            .search_rate(request.search_context_size)
            .ok_or(QuoteRefusal::SearchRateAbsent)?;
        let term = ScaledAmount::from(search_rate).times_count(request.web_searches)?;
        total = total.plus(term)?;
    }
    total.to_usd_micros()
}

/// Prices one request of several rows, each row as a [`RequestUsage`] naming the request's own
/// selectors and its whole long-context sum: the figure is one quote over the rows' summed counts
/// and searches, shared across them by [`split_figure`] over each row's own quote. Answers one
/// share per row, in order; refused as [`quote_request`] refuses any of those quotes, or with
/// [`QuoteRefusal::Overflow`] when a sum passes the integers.
pub(crate) fn quote_request_rows(
    table: &PriceTable,
    rows: &[RequestUsage<'_>],
) -> Result<Vec<UsdMicros>, QuoteRefusal> {
    let Some(first) = rows.first() else {
        return Ok(Vec::new());
    };
    let mut tokens = RequestTokenCounts {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        cache_write_extended: 0,
    };
    let mut web_searches: u64 = 0;
    let mut row_quotes = Vec::with_capacity(rows.len());
    for row in rows {
        let sum = |total: u64, count: u64| total.checked_add(count).ok_or(QuoteRefusal::Overflow);
        tokens.input = sum(tokens.input, row.tokens.input)?;
        tokens.output = sum(tokens.output, row.tokens.output)?;
        tokens.cache_read = sum(tokens.cache_read, row.tokens.cache_read)?;
        tokens.cache_write = sum(tokens.cache_write, row.tokens.cache_write)?;
        tokens.cache_write_extended =
            sum(tokens.cache_write_extended, row.tokens.cache_write_extended)?;
        web_searches = sum(web_searches, row.web_searches)?;
        row_quotes.push(quote_request(table, row)?.0.get());
    }
    let whole = RequestUsage {
        tokens,
        web_searches,
        ..*first
    };
    Ok(split_figure(quote_request(table, &whole)?, &row_quotes))
}

/// Shares one request's figure across its rows by weight: each share but the last is the floor of
/// its weighted part and the last takes the remainder, so the shares add up to the figure. The
/// whole figure goes on the last share when every weight is zero; no weights give no shares.
pub(crate) fn split_figure(figure: UsdMicros, weights: &[u64]) -> Vec<UsdMicros> {
    let Some((_, leading_weights)) = weights.split_last() else {
        return Vec::new();
    };
    let whole = figure.0.get();
    let total_weight: u128 = weights.iter().copied().map(u128::from).sum();
    let mut shares = Vec::with_capacity(weights.len());
    let mut shared: u64 = 0;
    for weight in leading_weights {
        // A figure below 2^53 times a weight below 2^64 fits `u128`; all-zero weights share nothing
        // before the last.
        let share = (u128::from(whole) * u128::from(*weight))
            .checked_div(total_weight)
            .map_or(0, |part| {
                u64::try_from(part).expect("a weighted part is at most the figure")
            });
        shared += share;
        shares.push(usd_micros_within(share));
    }
    shares.push(usd_micros_within(whole - shared));
    shares
}

// A share no larger than the figure it was taken from, so within the wire's range.
fn usd_micros_within(share: u64) -> UsdMicros {
    UsdMicros(SafeInt::new(share).expect("a share is at most the figure"))
}

// An exact amount in dollars, `significand × 10^-scale`, the scale growing as factors multiply.
#[derive(Clone, Copy)]
struct ScaledAmount {
    significand: u128,
    scale: u32,
}

impl ScaledAmount {
    const ZERO: Self = Self {
        significand: 0,
        scale: 0,
    };
    const ONE: Self = Self {
        significand: 1,
        scale: 0,
    };

    fn times(self, other: Self) -> Result<Self, QuoteRefusal> {
        Ok(Self {
            significand: self
                .significand
                .checked_mul(other.significand)
                .ok_or(QuoteRefusal::Overflow)?,
            scale: self.scale + other.scale,
        })
    }

    fn times_count(self, count: u64) -> Result<Self, QuoteRefusal> {
        self.times(Self {
            significand: u128::from(count),
            scale: 0,
        })
    }

    // The sum at the larger of the two scales, the finer side's digits kept whole.
    fn plus(self, other: Self) -> Result<Self, QuoteRefusal> {
        let scale = self.scale.max(other.scale);
        let significand = self
            .significand_at(scale)?
            .checked_add(other.significand_at(scale)?)
            .ok_or(QuoteRefusal::Overflow)?;
        Ok(Self { significand, scale })
    }

    fn significand_at(self, scale: u32) -> Result<u128, QuoteRefusal> {
        power_of_ten(scale - self.scale)?
            .checked_mul(self.significand)
            .ok_or(QuoteRefusal::Overflow)
    }

    // Whole micro-dollars, one division rounded half to even when the amount is finer.
    fn to_usd_micros(self) -> Result<UsdMicros, QuoteRefusal> {
        let micros = if self.scale <= MICRO_DOLLAR_SCALE {
            self.significand_at(MICRO_DOLLAR_SCALE)?
        } else {
            let divisor = power_of_ten(self.scale - MICRO_DOLLAR_SCALE)?;
            let quotient = self.significand / divisor;
            let remainder = self.significand % divisor;
            // The divisor is a power of ten above one, so its half is exact.
            let half = divisor / 2;
            let is_rounded_up =
                remainder > half || (remainder == half && !quotient.is_multiple_of(2));
            if is_rounded_up {
                quotient.checked_add(1).ok_or(QuoteRefusal::Overflow)?
            } else {
                quotient
            }
        };
        u64::try_from(micros)
            .ok()
            .and_then(SafeInt::new)
            .map(UsdMicros)
            .ok_or(QuoteRefusal::Overflow)
    }
}

impl From<ExactDecimal> for ScaledAmount {
    fn from(decimal: ExactDecimal) -> Self {
        Self {
            significand: decimal.significand(),
            scale: u32::from(decimal.scale()),
        }
    }
}

fn power_of_ten(exponent: u32) -> Result<u128, QuoteRefusal> {
    10_u128.checked_pow(exponent).ok_or(QuoteRefusal::Overflow)
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::session::cost::UsdMicros;
    use sidekicks_contracts::wire::integer::SafeInt;

    use super::{RequestTokenCounts, RequestUsage, quote_request, split_figure};
    use crate::pricing::list::{PriceRowSelection, PriceTable, decode_price_table};

    fn table(copy: &str) -> PriceTable {
        decode_price_table(copy, PriceRowSelection::Every)
            .expect("the copy is a price list")
            .table
    }

    fn usd_micros(whole: u64) -> UsdMicros {
        UsdMicros(SafeInt::new(whole).expect("a small whole figure"))
    }

    fn no_tokens() -> RequestTokenCounts {
        RequestTokenCounts {
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            cache_write_extended: 0,
        }
    }

    // A standard-speed request with no region and no searches.
    fn request(model_id: &str, tokens: RequestTokenCounts) -> RequestUsage<'_> {
        RequestUsage {
            model_id,
            speed: None,
            region: None,
            region_words: &[],
            long_context_tokens: 0,
            extended_cache_lifetime_hours: 1,
            tokens,
            web_searches: 0,
            search_context_size: "medium",
        }
    }

    /// Killed by float arithmetic (7 and 9) and by rounding half up (7): 6.5 and 9.5 micro-dollars
    /// round half to even.
    #[rstest]
    #[case::input(RequestTokenCounts { input: 2_600, ..no_tokens() }, 6)]
    #[case::output(RequestTokenCounts { output: 760, ..no_tokens() }, 10)]
    fn a_figure_is_exact_and_rounded_half_to_even(
        #[case] tokens: RequestTokenCounts,
        #[case] expected: u64,
    ) {
        let table =
            table(r#"{"m": {"input_cost_per_token": 2.5e-09, "output_cost_per_token": 1.25e-08}}"#);
        let figure = quote_request(&table, &request("m", tokens)).expect("the request is priced");
        assert_eq!(figure, usd_micros(expected));
    }

    /// Killed by applying the regional multiplier in floating point (127): 126.5 micro-dollars
    /// rounds half to even.
    #[test]
    fn a_regional_multiplier_applies_exactly() {
        let table = table(
            r#"{"claude-haiku-5-5": {
                "input_cost_per_token": 1e-07,
                "provider_specific_entry": {"us": 1.1}
            }}"#,
        );
        let tokens = RequestTokenCounts {
            input: 1_150,
            ..no_tokens()
        };
        let us_request = RequestUsage {
            region: Some("us"),
            region_words: &["us"],
            ..request("claude-haiku-5-5", tokens)
        };
        let figure = quote_request(&table, &us_request).expect("the request is priced");
        assert_eq!(figure, usd_micros(126));
    }

    /// Killed by rounding each share on its own (shares totaling 10,000) and by splitting by tokens
    /// (58,823 and 1,177).
    #[test]
    fn a_figure_splits_by_quote_with_the_remainder_last() {
        assert_eq!(
            split_figure(usd_micros(10_001), &[7, 7]),
            [usd_micros(5_000), usd_micros(5_001)]
        );
        let table = table(
            r#"{"claude-opus-5-5": {
                "cache_read_input_token_cost": 2e-07,
                "output_cost_per_token": 2e-05
            }}"#,
        );
        let quote = |tokens| {
            quote_request(&table, &request("claude-opus-5-5", tokens))
                .expect("the row is priced")
                .0
                .get()
        };
        let weights = [
            quote(RequestTokenCounts {
                cache_read: 100_000,
                ..no_tokens()
            }),
            quote(RequestTokenCounts {
                output: 2_000,
                ..no_tokens()
            }),
        ];
        assert_eq!(weights, [20_000, 40_000]);
        assert_eq!(
            split_figure(usd_micros(60_000), &weights),
            [usd_micros(20_000), usd_micros(40_000)]
        );
    }
}
