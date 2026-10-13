//! Fractional numbers on the wire: a finite JSON number, each type with the range its schema
//! states. serde refuses a number past `f64`'s range, as JavaScript reads it as `Infinity`.

/// Declares a number newtype: its doc, its name, the rule a value keeps, the fault it is refused
/// with, and the schema keywords that state the rule.
macro_rules! number {
    (
        $(#[doc = $doc:literal])+
        $name:ident, |$value:ident| $rule:expr, $fault:literal, {$($keyword:tt)*}
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Copy, Debug, PartialEq, PartialOrd, serde::Serialize)]
        #[serde(transparent)]
        pub struct $name(f64);

        impl $name {
            /// `value` when it keeps the rule, else `None`.
            pub fn new($value: f64) -> Option<Self> {
                ($value.is_finite() && $rule).then_some(Self($value))
            }

            /// The number.
            pub const fn get(self) -> f64 {
                self.0
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = <f64 as serde::Deserialize>::deserialize(deserializer)?;
                Self::new(value).ok_or_else(|| <D::Error as serde::de::Error>::custom($fault))
            }
        }

        impl schemars::JsonSchema for $name {
            fn inline_schema() -> bool {
                true
            }

            fn schema_name() -> std::borrow::Cow<'static, str> {
                stringify!($name).into()
            }

            fn json_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                schemars::json_schema!({ "type": "number", $($keyword)* })
            }
        }
    };
}

number! {
    /// Any finite number: a coordinate or an offset.
    Number, |value| true, "a number is finite", {}
}

number! {
    /// A finite number at or above zero: a size or a share.
    NonNegativeNumber, |value| value >= 0.0, "the number is below zero", { "minimum": 0 }
}

number! {
    /// A finite number above zero: a duration or a scale.
    PositiveNumber, |value| value > 0.0, "the number is not above zero", { "exclusiveMinimum": 0 }
}

number! {
    /// A share in percent, from 0 to 100 inclusive; a fraction is allowed.
    Percent, |value| (0.0..=100.0).contains(&value), "the number is outside 0..=100",
    { "minimum": 0, "maximum": 100 }
}

number! {
    /// A finite number from zero to one, both included: a fraction of the whole.
    UnitFraction, |value| (0.0..=1.0).contains(&value), "the number is outside 0..=1",
    { "minimum": 0, "maximum": 1 }
}
