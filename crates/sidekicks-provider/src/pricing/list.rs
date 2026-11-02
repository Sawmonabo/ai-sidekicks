//! The price list read into exact rates: the rows a caller selects, each rate field parsed by one
//! suffix grammar, and the lookups a request is priced through.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;

use serde::Deserializer as _;
use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde_json::value::RawValue;
use serde_with::de::DeserializeAsWrap;
use serde_with::{BorrowCow, Map, Same};

use crate::pricing::decimal::ExactDecimal;

// The list's example row, which prices no model.
const SAMPLE_SPEC_KEY: &str = "sample_spec";
const PROVIDER_SPECIFIC_ENTRY_FIELD: &str = "provider_specific_entry";
const REGIONAL_MULTIPLIER_PREFIX: &str = "regional_processing_uplift_multiplier_";
const SEARCH_RATES_FIELD: &str = "search_context_cost_per_query";
const SEARCH_SIZE_PREFIX: &str = "search_context_size_";

/// Which of the list's rows to read: the ids in use, every other row skipped unread, or every row.
#[derive(Clone, Copy)]
pub enum PriceRowSelection<'a> {
    /// Only the rows whose model id the predicate holds for.
    InUse(&'a dyn Fn(&str) -> bool),
    /// Every row.
    Every,
}

impl PriceRowSelection<'_> {
    fn selects(self, model_id: &str) -> bool {
        match self {
            Self::InUse(is_in_use) => is_in_use(model_id),
            Self::Every => true,
        }
    }
}

/// Why a copy of the list was refused whole.
#[derive(Debug, thiserror::Error)]
pub enum PriceTableRefusal {
    /// The copy is not JSON.
    #[error("the price list is not JSON")]
    NotJson(#[source] serde_json::Error),
    /// The copy's top level is not an object.
    #[error("the price list's top level is not an object")]
    TopLevelNotObject,
    /// A selected row is not an object.
    #[error("the price list's row for {model_id} is not an object")]
    RowNotObject {
        /// The row's model id.
        model_id: String,
    },
}

/// A rate or multiplier field whose value was refused alone, its row and the copy kept; it names
/// the field, never the value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefusedPriceField {
    /// The row's model id.
    pub model_id: String,
    /// The field's name, a nested one written `<outer>.<key>`.
    pub field: String,
}

/// A decoded copy: the selected rows and every field refused while reading them.
#[derive(Debug)]
pub struct DecodedPriceTable {
    /// The selected rows' exact rates.
    pub table: PriceTable,
    /// The fields whose values were refused, each absent from its row unless a later repeat of
    /// the field in that row was kept.
    pub refused_fields: Vec<RefusedPriceField>,
}

/// The selected rows of the list by model id.
#[derive(Debug)]
pub struct PriceTable {
    rows: HashMap<String, PriceRow>,
}

impl PriceTable {
    /// The row of exactly this model id; a suffix such as a context-size mark is the driver's to
    /// strip first.
    pub fn row(&self, model_id: &str) -> Option<&PriceRow> {
        self.rows.get(model_id)
    }
}

/// The four kinds of per-token rate a row carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RateBase {
    /// Input tokens.
    Input,
    /// Output tokens.
    Output,
    /// Input tokens read from the cache.
    CacheRead,
    /// Input tokens written to the cache.
    CacheWrite,
}

impl RateBase {
    const ALL: [Self; 4] = [Self::Input, Self::Output, Self::CacheRead, Self::CacheWrite];

    fn field_name(self) -> &'static str {
        match self {
            Self::Input => "input_cost_per_token",
            Self::Output => "output_cost_per_token",
            Self::CacheRead => "cache_read_input_token_cost",
            Self::CacheWrite => "cache_creation_input_token_cost",
        }
    }
}

/// How a row prices a request's speed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeedPricing {
    /// The standard rates.
    Standard,
    /// The rates carrying the speed's own suffix, looked up with that word.
    SpeedRates,
    /// The standard rates times this multiplier.
    Multiplier(ExactDecimal),
}

/// How a row prices a request's processing region.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegionPricing {
    /// The rates with no regional multiplier.
    Base,
    /// The rates times this multiplier.
    Multiplier(ExactDecimal),
}

/// One model's rates, multipliers and per-search rates, each field refused alone kept as carried
/// with no value, so a request needing it is unpriced rather than priced at another rate. A field
/// the row repeats takes its last value, as a JSON reader does.
#[derive(Debug)]
pub struct PriceRow {
    rate_fields: Vec<(RateKey, Option<ExactDecimal>)>,
    multipliers: Vec<(String, Option<ExactDecimal>)>,
    is_provider_specific_entry_refused: bool,
    regional_multipliers: Vec<(String, Option<ExactDecimal>)>,
    search_rates: Vec<(String, ExactDecimal)>,
}

impl PriceRow {
    /// The rate at exactly this key, `None` when the row carries none there; it never falls back
    /// to another cache lifetime, long-context threshold or speed.
    pub fn rate(
        &self,
        base: RateBase,
        cache_lifetime_hours: Option<u32>,
        above_thousand_tokens: Option<u32>,
        speed: Option<&str>,
    ) -> Option<ExactDecimal> {
        self.rate_fields
            .iter()
            .find(|(key, _)| {
                key.base == base
                    && key.cache_lifetime_hours == cache_lifetime_hours
                    && key.above_thousand_tokens == above_thousand_tokens
                    && key.speed.as_deref() == speed
            })
            .and_then(|(_, rate)| *rate)
    }

    /// The largest long-context threshold N, in thousands of tokens, that this many tokens is
    /// strictly above, or `None` below every threshold the row carries.
    pub fn long_context_threshold(&self, tokens: u64) -> Option<u32> {
        self.rate_fields
            .iter()
            .filter_map(|(key, _)| key.above_thousand_tokens)
            .filter(|threshold| tokens > u64::from(*threshold) * 1_000)
            .max()
    }

    /// How the row prices a request at this speed word (`None` is the standard speed), or `None`
    /// when the row carries neither rates nor a multiplier of that name, leaving it unpriced.
    pub fn speed(&self, word: Option<&str>) -> Option<SpeedPricing> {
        let Some(word) = word else {
            return Some(SpeedPricing::Standard);
        };
        if self
            .rate_fields
            .iter()
            .any(|(key, _)| key.speed.as_deref() == Some(word))
        {
            return Some(SpeedPricing::SpeedRates);
        }
        named_multiplier(&self.multipliers, word)?
            .1
            .map(SpeedPricing::Multiplier)
    }

    /// How the row prices a request in this region (`None` is no region), or `None` when the row
    /// carries regional multipliers but not this one, so the request is unpriced; `region_words`
    /// are the driver's region names, the only `provider_specific_entry` keys read as regions.
    pub fn region(&self, region: Option<&str>, region_words: &[&str]) -> Option<RegionPricing> {
        let Some(region) = region else {
            return Some(RegionPricing::Base);
        };
        if let Some((_, multiplier)) = named_multiplier(&self.regional_multipliers, region) {
            return multiplier.map(RegionPricing::Multiplier);
        }
        if region_words.contains(&region)
            && let Some((_, multiplier)) = named_multiplier(&self.multipliers, region)
        {
            return multiplier.map(RegionPricing::Multiplier);
        }
        // A refused `provider_specific_entry` may have held a region, so it counts as carried.
        let carries_regional_multiplier = !self.regional_multipliers.is_empty()
            || self.is_provider_specific_entry_refused
            || self
                .multipliers
                .iter()
                .any(|(name, _)| region_words.contains(&name.as_str()));
        (!carries_regional_multiplier).then_some(RegionPricing::Base)
    }

    /// The per-search rate at this context size (`low`, `medium`, `high`), `None` when the row
    /// carries none.
    pub fn search_rate(&self, size: &str) -> Option<ExactDecimal> {
        self.search_rates
            .iter()
            .find(|(name, _)| name == size)
            .map(|(_, rate)| *rate)
    }

    fn read(
        model_id: &str,
        fields: ObjectEntries<'_>,
        refused_fields: &mut Vec<RefusedPriceField>,
    ) -> Self {
        let mut row = Self {
            rate_fields: Vec::new(),
            multipliers: Vec::new(),
            is_provider_specific_entry_refused: false,
            regional_multipliers: Vec::new(),
            search_rates: Vec::new(),
        };
        let mut refuse = |field: String| {
            refused_fields.push(RefusedPriceField {
                model_id: model_id.to_owned(),
                field,
            });
        };
        for (name, value) in fields {
            if let Some(key) = RateKey::parse(&name) {
                match FieldValue::read(value) {
                    FieldValue::Absent => remove_entry(&mut row.rate_fields, &key),
                    FieldValue::Kept(rate) => set_entry(&mut row.rate_fields, key, Some(rate)),
                    FieldValue::Refused => {
                        refuse(name.into_owned());
                        set_entry(&mut row.rate_fields, key, None);
                    }
                }
            } else if let Some(region) = name.strip_prefix(REGIONAL_MULTIPLIER_PREFIX) {
                let region = region.to_owned();
                match FieldValue::read(value) {
                    FieldValue::Absent => remove_entry(&mut row.regional_multipliers, &region),
                    FieldValue::Kept(multiplier) => {
                        set_entry(&mut row.regional_multipliers, region, Some(multiplier));
                    }
                    FieldValue::Refused => {
                        set_entry(&mut row.regional_multipliers, region, None);
                        refuse(name.into_owned());
                    }
                }
            } else if name == PROVIDER_SPECIFIC_ENTRY_FIELD {
                row.multipliers.clear();
                row.is_provider_specific_entry_refused = false;
                if is_null(value) {
                    continue;
                }
                let Some(entries) = object_entries(value) else {
                    row.is_provider_specific_entry_refused = true;
                    refuse(name.into_owned());
                    continue;
                };
                for (key, value) in entries {
                    match FieldValue::read(value) {
                        FieldValue::Absent => remove_entry(&mut row.multipliers, &*key),
                        FieldValue::Kept(multiplier) => {
                            set_entry(&mut row.multipliers, key.into_owned(), Some(multiplier));
                        }
                        FieldValue::Refused => {
                            refuse(format!("{PROVIDER_SPECIFIC_ENTRY_FIELD}.{key}"));
                            set_entry(&mut row.multipliers, key.into_owned(), None);
                        }
                    }
                }
            } else if name == SEARCH_RATES_FIELD {
                row.search_rates.clear();
                if is_null(value) {
                    continue;
                }
                let Some(entries) = object_entries(value) else {
                    refuse(name.into_owned());
                    continue;
                };
                for (key, value) in entries {
                    let Some(size) = key.strip_prefix(SEARCH_SIZE_PREFIX) else {
                        continue;
                    };
                    let size = size.to_owned();
                    match FieldValue::read(value) {
                        FieldValue::Absent => remove_entry(&mut row.search_rates, &size),
                        FieldValue::Kept(rate) => set_entry(&mut row.search_rates, size, rate),
                        FieldValue::Refused => {
                            remove_entry(&mut row.search_rates, &size);
                            refuse(format!("{SEARCH_RATES_FIELD}.{key}"));
                        }
                    }
                }
            }
        }
        row
    }
}

// Sets `key`'s value in `entries`, over an earlier value of the same key.
fn set_entry<K: PartialEq, V>(entries: &mut Vec<(K, V)>, key: K, value: V) {
    match entries.iter_mut().find(|(entry_key, _)| *entry_key == key) {
        Some((_, entry_value)) => *entry_value = value,
        None => entries.push((key, value)),
    }
}

// Drops an earlier value of `key` from `entries`, for a later `null` or unread one.
fn remove_entry<K: PartialEq<Q>, Q: ?Sized, V>(entries: &mut Vec<(K, V)>, key: &Q) {
    entries.retain(|(entry_key, _)| *entry_key != *key);
}

// The carried multiplier of this name, its value `None` when it was refused.
fn named_multiplier<'a>(
    multipliers: &'a [(String, Option<ExactDecimal>)],
    name: &str,
) -> Option<&'a (String, Option<ExactDecimal>)> {
    multipliers
        .iter()
        .find(|(multiplier_name, _)| multiplier_name == name)
}

// Where a rate field sits in the suffix grammar: its base, then `_above_<H>hr`, then
// `_above_<N>k_tokens`, then `_<speed>`, each optional and in that order.
#[derive(Debug, PartialEq, Eq)]
struct RateKey {
    base: RateBase,
    cache_lifetime_hours: Option<u32>,
    above_thousand_tokens: Option<u32>,
    speed: Option<String>,
}

impl RateKey {
    // `None` for a field the grammar does not match, which is not read.
    fn parse(name: &str) -> Option<Self> {
        let (base, suffixes) = RateBase::ALL.iter().find_map(|base| {
            name.strip_prefix(base.field_name())
                .map(|suffixes| (*base, suffixes))
        })?;
        let (cache_lifetime_hours, suffixes) = take_above(suffixes, "hr")
            .map_or((None, suffixes), |(hours, rest)| (Some(hours), rest));
        let (above_thousand_tokens, suffixes) = take_above(suffixes, "k_tokens")
            .map_or((None, suffixes), |(threshold, rest)| {
                (Some(threshold), rest)
            });
        let speed = if suffixes.is_empty() {
            None
        } else {
            let word = suffixes.strip_prefix('_')?;
            if word.is_empty() || !word.bytes().all(|byte| byte.is_ascii_lowercase()) {
                return None;
            }
            Some(word.to_owned())
        };
        Some(Self {
            base,
            cache_lifetime_hours,
            above_thousand_tokens,
            speed,
        })
    }
}

// `_above_<digits><unit>` at the start of the suffixes: the number and what follows it, which is
// empty or starts the next suffix.
fn take_above<'a>(suffixes: &'a str, unit: &str) -> Option<(u32, &'a str)> {
    let after = suffixes.strip_prefix("_above_")?;
    let digit_count = after.bytes().take_while(u8::is_ascii_digit).count();
    let (digits, after_digits) = after.split_at(digit_count);
    let rest = after_digits.strip_prefix(unit)?;
    if !(rest.is_empty() || rest.starts_with('_')) {
        return None;
    }
    let number = digits.parse().ok()?;
    Some((number, rest))
}

// One rate or multiplier field's value.
enum FieldValue {
    Absent,
    Kept(ExactDecimal),
    Refused,
}

impl FieldValue {
    // `null` is absent; a number is kept exact or refused; any other type is refused.
    fn read(value: &RawValue) -> Self {
        if is_null(value) {
            return Self::Absent;
        }
        ExactDecimal::parse_json_number(value.get()).map_or(Self::Refused, Self::Kept)
    }
}

fn is_null(value: &RawValue) -> bool {
    value.get() == "null"
}

type ObjectEntries<'a> = Vec<(Cow<'a, str>, &'a RawValue)>;

// An object's members in order, an escaped key read owned; `None` when the value is not an object,
// the one way an already parsed value fails this read.
fn object_entries(value: &RawValue) -> Option<ObjectEntries<'_>> {
    serde_json::from_str::<DeserializeAsWrap<ObjectEntries<'_>, Map<BorrowCow, Same>>>(value.get())
        .ok()
        .map(DeserializeAsWrap::into_inner)
}

/// Reads a copy of the list into exact rates for the selected rows. A bad rate is refused alone and
/// named in `refused_fields`; the copy is refused only when it is not JSON, its top level is not an
/// object, or a selected row is not an object.
pub fn decode_price_table(
    copy: &str,
    rows: PriceRowSelection<'_>,
) -> Result<DecodedPriceTable, PriceTableRefusal> {
    let mut deserializer = serde_json::Deserializer::from_str(copy);
    let selected = match (&mut deserializer)
        .deserialize_map(SelectedRowsVisitor { selection: rows })
        .and_then(|selected| deserializer.end().map(|()| selected))
    {
        Ok(selected) => selected,
        // The visitor reads only a map and takes each value raw, so a type error is the top level.
        Err(error) if error.is_data() => return Err(PriceTableRefusal::TopLevelNotObject),
        Err(error) => return Err(PriceTableRefusal::NotJson(error)),
    };
    let mut table = HashMap::with_capacity(selected.len());
    let mut refused_fields = Vec::new();
    for (model_id, raw_row) in selected {
        let Some(fields) = object_entries(raw_row) else {
            return Err(PriceTableRefusal::RowNotObject {
                model_id: model_id.into_owned(),
            });
        };
        let row = PriceRow::read(&model_id, fields, &mut refused_fields);
        table.insert(model_id.into_owned(), row);
    }
    Ok(DecodedPriceTable {
        table: PriceTable { rows: table },
        refused_fields,
    })
}

// The top level's visitor: each selected row taken raw, the example row and every other row
// skipped unread.
struct SelectedRowsVisitor<'s> {
    selection: PriceRowSelection<'s>,
}

impl<'de> Visitor<'de> for SelectedRowsVisitor<'_> {
    type Value = ObjectEntries<'de>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an object of price rows by model id")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut selected = Vec::new();
        while let Some(key) = map.next_key::<DeserializeAsWrap<Cow<'de, str>, BorrowCow>>()? {
            let model_id = key.into_inner();
            if model_id != SAMPLE_SPEC_KEY && self.selection.selects(&model_id) {
                selected.push((model_id, map.next_value::<&'de RawValue>()?));
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(selected)
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::*;

    type RateLookup = (RateBase, Option<u32>, Option<u32>, Option<&'static str>);

    // Killed by a read through `f64` (it reads 1e-06), by the first of a repeated row or rate
    // field kept, and by a rate looked up at a neighboring key.
    #[rstest]
    #[case::exact_past_a_float(
        r#"{"m": {"input_cost_per_token": 1.00000000000000000001e-06}}"#,
        (RateBase::Input, None, None, None),
        (100_000_000_000_000_000_001, 26),
        &[],
        &[]
    )]
    #[case::a_repeated_row_and_field_take_their_last(
        r#"{"m": {"input_cost_per_token": 3e-06},
            "m": {"input_cost_per_token": "abc", "input_cost_per_token": 1e-06}}"#,
        (RateBase::Input, None, None, None),
        (1, 6),
        &[],
        &["input_cost_per_token"]
    )]
    #[case::a_bad_rate_refused_alone(
        r#"{"m": {"input_cost_per_token": "abc", "output_cost_per_token": 1e-06}}"#,
        (RateBase::Output, None, None, None),
        (1, 6),
        &[(RateBase::Input, None, None, None)],
        &["input_cost_per_token"]
    )]
    #[case::suffixes_read_in_order(
        r#"{"m": {"cache_creation_input_token_cost_above_12hr_above_272k_tokens_priority": 1e-05}}"#,
        (RateBase::CacheWrite, Some(12), Some(272), Some("priority")),
        (1, 5),
        &[
            (RateBase::CacheWrite, None, Some(272), Some("priority")),
            (RateBase::CacheWrite, Some(12), None, Some("priority")),
            (RateBase::CacheWrite, Some(12), Some(272), None),
            (RateBase::CacheWrite, Some(272), Some(12), Some("priority")),
        ],
        &[]
    )]
    fn a_rate_is_read_exactly_at_its_own_key(
        #[case] copy: &str,
        #[case] key: RateLookup,
        #[case] expected: (u128, u8),
        #[case] absent: &[RateLookup],
        #[case] refused: &[&str],
    ) {
        let is_in_use = |model_id: &str| model_id == "m";
        let decoded = decode_price_table(copy, PriceRowSelection::InUse(&is_in_use))
            .expect("one bad rate never refuses the copy");
        let row = decoded.table.row("m").expect("the row is kept");
        let (base, cache_lifetime_hours, above_thousand_tokens, speed) = key;
        let rate = row
            .rate(base, cache_lifetime_hours, above_thousand_tokens, speed)
            .expect("the rate is kept at its key");
        assert_eq!((rate.significand(), rate.scale()), expected);
        assert_eq!(
            row.rate_fields
                .iter()
                .filter(|(_, rate)| rate.is_some())
                .count(),
            1
        );
        for (base, cache_lifetime_hours, above_thousand_tokens, speed) in absent {
            assert!(
                row.rate(*base, *cache_lifetime_hours, *above_thousand_tokens, *speed)
                    .is_none(),
                "a rate is found only at its own key"
            );
        }
        let refused: Vec<RefusedPriceField> = refused
            .iter()
            .map(|field| RefusedPriceField {
                model_id: "m".to_owned(),
                field: (*field).to_owned(),
            })
            .collect();
        assert_eq!(decoded.refused_fields, refused);
    }
}
