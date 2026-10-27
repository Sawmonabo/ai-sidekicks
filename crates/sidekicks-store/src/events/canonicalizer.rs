//! RFC 8785 canonical bytes (the JSON Canonicalization Scheme): the one place a value or an event
//! envelope becomes the bytes a hash is taken over or a version stub keeps, and where an
//! `occurredAt` takes the one form the log stores. The append path keeps no canonical bytes, so
//! it never runs here.

use serde_json::Value;
use sidekicks_contracts::event::envelope::{
    EventEnvelope, EventOccurredAt, OccurredAtRefusal, parse_occurred_at,
};

/// The deepest container nesting [`canonicalize_json`] serializes, `{}` being depth 1. The
/// serializer recurses, so a deeper value is refused before it reaches the stack.
const CANONICAL_JSON_MAX_DEPTH: usize = 64;

/// The UTF-8 bytes of an RFC 8785 canonicalization; only this module makes one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalBytes(Vec<u8>);

impl CanonicalBytes {
    /// The bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

/// Why an `occurredAt` cannot take the stored form `YYYY-MM-DDTHH:MM:SS.sssZ`.
#[derive(Debug, thiserror::Error)]
pub enum OccurredAtNormalizationRefusal {
    /// The contract's reading refused the text.
    #[error(transparent)]
    Unreadable(#[from] OccurredAtRefusal),
    /// Folded to UTC, the instant falls before year 0000, which the stored four-digit year cannot
    /// write.
    #[error("an occurredAt folds to UTC before year 0000, which the stored form cannot write")]
    BeforeYearZero,
}

/// Why a value or an envelope has no canonical bytes. Each guard refuses on its own variant, and
/// none quotes the value, which may carry a person's words.
#[derive(Debug, thiserror::Error)]
pub enum CanonicalizationRefusal {
    /// The envelope's `occurredAt` cannot take the stored form.
    #[error("the envelope's occurredAt cannot take the stored form")]
    OccurredAt(#[from] OccurredAtNormalizationRefusal),
    /// The value nests containers deeper than [`CANONICAL_JSON_MAX_DEPTH`].
    #[error("the value nests containers deeper than {CANONICAL_JSON_MAX_DEPTH} levels")]
    TooDeep,
    /// The serializer refused the value.
    #[error("the RFC 8785 serializer refused the value")]
    Serializer(#[from] serde_json::Error),
}

/// `occurred_at` in the stored form, UTC to the millisecond (`YYYY-MM-DDTHH:MM:SS.sssZ`), the
/// instant it names kept exactly. Refuses what the contract's reading refuses, and an instant that
/// folds to UTC before year 0000.
pub fn normalize_occurred_at(
    occurred_at: &str,
) -> Result<EventOccurredAt, OccurredAtNormalizationRefusal> {
    // jiff holds years back to -9999, so a fold before year 0000 still reads; one past year 9999
    // is already outside jiff's range and refused by the reading.
    EventOccurredAt::from_timestamp(parse_occurred_at(occurred_at)?)
        .ok_or(OccurredAtNormalizationRefusal::BeforeYearZero)
}

/// `value`'s RFC 8785 bytes. Refuses a value nesting containers deeper than
/// [`CANONICAL_JSON_MAX_DEPTH`], and one the serializer refuses.
pub fn canonicalize_json(value: &Value) -> Result<CanonicalBytes, CanonicalizationRefusal> {
    refuse_over_deep(value)?;
    Ok(CanonicalBytes(serde_json_canonicalizer::to_vec(value)?))
}

/// `envelope`'s RFC 8785 bytes, with its `occurredAt` in the stored form. An absent `actor` and a
/// `null` one give different bytes, so the envelope must already hold the actor the row stores.
/// Refuses, in this order, an `occurredAt` that cannot take the stored form, then what
/// [`canonicalize_json`] refuses.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the version stub that keeps an event of a newer producer's type as its \
                  canonical bytes"
    )
)]
pub(crate) fn canonicalize_event(
    envelope: &EventEnvelope,
) -> Result<CanonicalBytes, CanonicalizationRefusal> {
    let occurred_at = normalize_occurred_at(envelope.occurred_at.as_str())?;
    let mut members = serde_json::to_value(envelope)?;
    members
        .as_object_mut()
        .expect("an envelope serializes to a JSON object")
        .insert(
            "occurredAt".to_owned(),
            Value::String(occurred_at.as_str().to_owned()),
        );
    canonicalize_json(&members)
}

/// Refuses `value` when it nests containers deeper than [`CANONICAL_JSON_MAX_DEPTH`], walking it
/// with a list rather than recursion, so the check itself cannot exhaust the stack.
fn refuse_over_deep(value: &Value) -> Result<(), CanonicalizationRefusal> {
    let is_container = |node: &&Value| node.is_array() || node.is_object();
    let mut pending = vec![(value, 1)];
    while let Some((node, depth)) = pending.pop() {
        match node {
            Value::Array(_) | Value::Object(_) if depth > CANONICAL_JSON_MAX_DEPTH => {
                return Err(CanonicalizationRefusal::TooDeep);
            }
            Value::Array(items) => {
                pending.extend(
                    items
                        .iter()
                        .filter(is_container)
                        .map(|item| (item, depth + 1)),
                );
            }
            Value::Object(members) => {
                pending.extend(
                    members
                        .values()
                        .filter(is_container)
                        .map(|member| (member, depth + 1)),
                );
            }
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde::Deserialize;
    use serde_json::{Number, Value};
    use sidekicks_contracts::event::envelope::{EventEnvelope, OccurredAtRefusal};

    use super::{
        CanonicalizationRefusal, OccurredAtNormalizationRefusal, canonicalize_event,
        canonicalize_json, normalize_occurred_at,
    };

    /// The canonical-bytes table: the RFC's published vectors and the pinned envelopes.
    const CASES: &str = include_str!("../../tests/fixtures/canonicalizer.json");

    /// The bytes a case must produce: canonical text, or hex in the RFC's grouping.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    enum Expected {
        Canonical(String),
        CanonicalHex(Vec<String>),
    }

    impl Expected {
        fn bytes(&self) -> Vec<u8> {
            match self {
                Self::Canonical(text) => text.as_bytes().to_vec(),
                Self::CanonicalHex(lines) => lines
                    .iter()
                    .flat_map(|line| line.split_whitespace())
                    .map(|pair| u8::from_str_radix(pair, 16).expect("the hex reads"))
                    .collect(),
            }
        }
    }

    /// JSON text, read as a value and canonicalized.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct JsonTextCase {
        name: String,
        source: String,
        expected: Expected,
    }

    /// An RFC 8785 Appendix B row: an IEEE 754 double's bits and its canonical text.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct NumberCase {
        ieee754_hex: String,
        canonical: String,
    }

    /// An envelope and its canonical bytes.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct EnvelopeCase {
        name: String,
        envelope: EventEnvelope,
        expected: Expected,
    }

    /// The container a nesting case wraps its leaf in.
    #[derive(Clone, Copy, Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    enum Container {
        Object,
        Array,
    }

    /// `leaf` wrapped in `container_levels` containers, and whether the depth ceiling refuses it.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct NestingCase {
        container: Container,
        container_levels: usize,
        leaf: Value,
        is_refused: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct CanonicalCases {
        json_text: Vec<JsonTextCase>,
        numbers: Vec<NumberCase>,
        envelopes: Vec<EnvelopeCase>,
        nesting: Vec<NestingCase>,
    }

    #[test]
    fn values_and_envelopes_canonicalize_to_their_pinned_bytes() {
        let cases: CanonicalCases = serde_json::from_str(CASES).expect("the cases read");
        for case in cases.json_text {
            let value: Value = serde_json::from_str(&case.source).expect("the source reads");
            let bytes = canonicalize_json(&value).map(|bytes| bytes.0);
            assert_eq!(bytes.ok(), Some(case.expected.bytes()), "{}", case.name);
        }
        for case in cases.numbers {
            let bits = u64::from_str_radix(&case.ieee754_hex, 16).expect("the bits read");
            let number = Number::from_f64(f64::from_bits(bits)).expect("the row is finite");
            let bytes = canonicalize_json(&Value::Number(number)).map(|bytes| bytes.0);
            assert_eq!(
                bytes.ok().and_then(|bytes| String::from_utf8(bytes).ok()),
                Some(case.canonical),
                "{}",
                case.ieee754_hex
            );
        }
        for case in cases.envelopes {
            let bytes = canonicalize_event(&case.envelope).map(|bytes| bytes.0);
            assert_eq!(bytes.ok(), Some(case.expected.bytes()), "{}", case.name);
        }
        for case in cases.nesting {
            let nested =
                (0..case.container_levels).fold(case.leaf, |inner, _| match case.container {
                    Container::Object => {
                        Value::Object([("a".to_owned(), inner)].into_iter().collect())
                    }
                    Container::Array => Value::Array(vec![inner]),
                });
            let refusal = canonicalize_json(&nested).err();
            assert_eq!(
                matches!(refusal, Some(CanonicalizationRefusal::TooDeep)),
                case.is_refused,
                "{} levels of {:?}",
                case.container_levels,
                case.container
            );
            assert_eq!(refusal.is_some(), case.is_refused);
        }
    }

    /// The refusal's variant, by name, so a case names the guard it expects to fire.
    fn refusal_name(refusal: &OccurredAtNormalizationRefusal) -> &'static str {
        match refusal {
            OccurredAtNormalizationRefusal::Unreadable(OccurredAtRefusal::Shape) => "Shape",
            OccurredAtNormalizationRefusal::Unreadable(OccurredAtRefusal::SubMillisecond) => {
                "SubMillisecond"
            }
            OccurredAtNormalizationRefusal::Unreadable(OccurredAtRefusal::NotACalendarDate) => {
                "NotACalendarDate"
            }
            OccurredAtNormalizationRefusal::Unreadable(OccurredAtRefusal::OutOfRange) => {
                "OutOfRange"
            }
            OccurredAtNormalizationRefusal::BeforeYearZero => "BeforeYearZero",
        }
    }

    #[rstest]
    #[case::folds_an_offset_across_a_year(
        "2025-12-31T19:00:00-05:00",
        Ok("2026-01-01T00:00:00.000Z")
    )]
    #[case::pads_a_year_below_1000("0999-03-04T05:06:07.1Z", Ok("0999-03-04T05:06:07.100Z"))]
    #[case::folds_onto_year_zero("0000-01-01T05:00:00+05:00", Ok("0000-01-01T00:00:00.000Z"))]
    #[case::refuses_february_30("2026-02-30T00:00:00Z", Err("NotACalendarDate"))]
    #[case::refuses_a_fold_before_year_zero("0000-01-01T00:00:00+05:00", Err("BeforeYearZero"))]
    #[case::refuses_a_fold_past_year_9999("9999-12-31T23:59:59-05:00", Err("OutOfRange"))]
    #[case::names_hour_24_before_a_sub_millisecond_digit("2026-01-01T24:00:00.0001Z", Err("Shape"))]
    #[case::names_a_sub_millisecond_digit_before_february_30(
        "2026-02-30T00:00:00.0001Z",
        Err("SubMillisecond")
    )]
    fn an_occurred_at_takes_the_stored_form_or_names_its_refusal(
        #[case] occurred_at: &str,
        #[case] expected: Result<&str, &str>,
    ) {
        let outcome = normalize_occurred_at(occurred_at)
            .map(|stored| stored.as_str().to_owned())
            .map_err(|refusal| refusal_name(&refusal));
        assert_eq!(outcome, expected.map(str::to_owned), "{occurred_at}");
    }
}
