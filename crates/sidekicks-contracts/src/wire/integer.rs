//! Whole numbers on the wire, each with an explicit range its schema states, so no integer reaches
//! TypeScript past what a JavaScript number holds exactly.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

/// The largest integer a JavaScript number holds exactly, 2^53 − 1.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// A whole number from `MIN` to [`MAX_SAFE_INTEGER`]: a count, a size or a position.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct SafeInt<const MIN: u64>(u64);

impl<const MIN: u64> SafeInt<MIN> {
    /// `value` when it lies in `MIN..=MAX_SAFE_INTEGER`, else `None`.
    pub const fn new(value: u64) -> Option<Self> {
        if value >= MIN && value <= MAX_SAFE_INTEGER {
            Some(Self(value))
        } else {
            None
        }
    }

    /// The number.
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl SafeInt<0> {
    /// Zero: an empty count or the first position.
    pub const ZERO: Self = Self(0);
}

// Lossless: a safe integer is at most 2^53 - 1, well inside `i64`.
impl<const MIN: u64> From<SafeInt<MIN>> for i64 {
    fn from(value: SafeInt<MIN>) -> Self {
        value.0.cast_signed()
    }
}

impl<'de, const MIN: u64> Deserialize<'de> for SafeInt<MIN> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = u64::deserialize(deserializer)?;
        Self::new(value).ok_or_else(|| {
            D::Error::custom(format!("{value} is outside {MIN}..={MAX_SAFE_INTEGER}"))
        })
    }
}

impl<const MIN: u64> JsonSchema for SafeInt<MIN> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("SafeInt{MIN}").into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "integer", "minimum": MIN, "maximum": MAX_SAFE_INTEGER })
    }
}

/// [`MAX_SAFE_INTEGER`] as a signed number, the bound of a whole number of either sign.
pub const MAX_SAFE_SIGNED_INTEGER: i64 = MAX_SAFE_INTEGER.cast_signed();

/// `count` as a signed number, for a `BoundedInt` bound or a row count SQLite binds; past
/// [`MAX_SAFE_INTEGER`] it fails the build in a const and panics at run time.
pub const fn count_bound(count: usize) -> i64 {
    let count = count as u64;
    assert!(count <= MAX_SAFE_INTEGER, "a count bound is a safe integer");
    count.cast_signed()
}

/// A whole number of either sign within what a JavaScript number holds exactly, ±(2^53 − 1).
pub type SafeSignedInt = BoundedInt<{ -MAX_SAFE_SIGNED_INTEGER }, MAX_SAFE_SIGNED_INTEGER>;

/// A whole number from `MIN` to `MAX`, both inclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct BoundedInt<const MIN: i64, const MAX: i64>(i64);

impl<const MIN: i64, const MAX: i64> BoundedInt<MIN, MAX> {
    /// `value` when it lies in `MIN..=MAX`, else `None`.
    pub const fn new(value: i64) -> Option<Self> {
        if value >= MIN && value <= MAX {
            Some(Self(value))
        } else {
            None
        }
    }

    /// The number.
    pub const fn get(self) -> i64 {
        self.0
    }
}

impl<'de, const MIN: i64, const MAX: i64> Deserialize<'de> for BoundedInt<MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = i64::deserialize(deserializer)?;
        Self::new(value)
            .ok_or_else(|| D::Error::custom(format!("{value} is outside {MIN}..={MAX}")))
    }
}

impl<const MIN: i64, const MAX: i64> JsonSchema for BoundedInt<MIN, MAX> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("BoundedInt{MIN}To{MAX}").into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "integer", "minimum": MIN, "maximum": MAX })
    }
}

/// A TCP port number, from 1 to 65535.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Port(BoundedInt<1, 65_535>);

impl Port {
    /// `number` when it lies in `1..=65535`, else `None`.
    pub fn new(number: u16) -> Option<Self> {
        BoundedInt::new(i64::from(number)).map(Self)
    }

    /// The port number.
    pub fn get(self) -> u16 {
        u16::try_from(self.0.get()).expect("a port lies within 1..=65535")
    }
}

impl JsonSchema for Port {
    fn schema_name() -> Cow<'static, str> {
        "Port".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "A TCP port number: a whole number from 1 to 65535.",
            "type": "integer",
            "minimum": 1,
            "maximum": 65_535,
        })
    }
}

/// The whole number `text` writes when it is `0` or ASCII digits with no leading zero, as a
/// handle's or a branch's index is written; `None` for any other text or past `u64`.
pub fn canonical_index(text: &str) -> Option<u64> {
    let is_canonical = text == "0"
        || (text.starts_with(|first: char| ('1'..='9').contains(&first))
            && text.bytes().all(|digit| digit.is_ascii_digit()));
    if is_canonical {
        text.parse().ok()
    } else {
        None
    }
}
