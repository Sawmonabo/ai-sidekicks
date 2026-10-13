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
