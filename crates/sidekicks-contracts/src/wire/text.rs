//! Free-form text on the wire: a name, a reason, a message. Its rules count what JavaScript and
//! Ajv count, so the Rust parser and the generated TypeScript check accept the same strings.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

/// Whether `character` is in ECMAScript's `\s` set: its `WhiteSpace` and `LineTerminator` code
/// points. Rust's `char::is_whitespace` differs from it on U+FEFF and U+0085.
pub fn is_ecmascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// The body of a regex class holding ECMAScript's `\s` set, spelled out so Rust's `regex` and
/// ECMAScript read it alike; it goes inside `concat!` in a pattern.
macro_rules! ecmascript_whitespace {
    () => {
        "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
    };
}

pub(crate) use ecmascript_whitespace;

/// The body of a regex class holding ECMAScript's `\s` set, for a caller outside this crate that
/// builds a pattern at run time; inside the crate, `concat!` takes the macro.
pub const ECMASCRIPT_WHITESPACE_CLASS: &str = ecmascript_whitespace!();

/// A pattern Rust's `regex` and ECMAScript read alike: text with no NUL and at least one character
/// outside ECMAScript's `\s` set.
pub(crate) const NON_BLANK_NUL_FREE_PATTERN: &str =
    concat!("^[^\\x00]*[^\\x00", ecmascript_whitespace!(), "][^\\x00]*$");

/// Why a text was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum TextError {
    /// The text holds a NUL, which cuts log lines and file names short.
    #[error("the text holds a NUL")]
    HoldsNul,
    /// The text is empty or only whitespace.
    #[error("the text is blank")]
    Blank,
    /// The text is longer than its cap, counted in code points.
    #[error("the text is longer than {cap} code points")]
    OverCap {
        /// The cap the text passed.
        cap: usize,
    },
}

/// Free-form text: not blank under ECMAScript's whitespace, no NUL, and at most `MAX` code points
/// (`usize::MAX` leaves it bounded only by the message cap).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct FreeFormText<const MAX: usize>(String);

impl<const MAX: usize> FreeFormText<MAX> {
    /// Checks `text`; refuses it with the first rule it breaks.
    pub fn new(text: String) -> Result<Self, TextError> {
        if text.contains('\0') {
            return Err(TextError::HoldsNul);
        }
        if text.chars().all(is_ecmascript_whitespace) {
            return Err(TextError::Blank);
        }
        if !is_within_length(&text, 0, MAX) {
            return Err(TextError::OverCap { cap: MAX });
        }
        Ok(Self(text))
    }

    /// The checked text.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The checked text, consuming the value.
    pub fn into_string(self) -> String {
        self.0
    }
}

impl<const MAX: usize> AsRef<str> for FreeFormText<MAX> {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl<'de, const MAX: usize> Deserialize<'de> for FreeFormText<MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

impl<const MAX: usize> JsonSchema for FreeFormText<MAX> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("FreeFormText{MAX}").into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        // Ajv's `maxLength` counts code points, as `new` does.
        let mut schema = json_schema!({
            "type": "string",
            "minLength": 1,
            "pattern": NON_BLANK_NUL_FREE_PATTERN,
        });
        if MAX != usize::MAX {
            schema.insert("maxLength".into(), MAX.into());
        }
        schema
    }
}

/// The schema of text of `min..=max` code points (`usize::MAX` leaves it uncapped); Ajv's
/// `minLength` and `maxLength` count code points.
pub fn length_schema(min: usize, max: usize) -> Schema {
    let mut schema = json_schema!({ "type": "string" });
    if min > 0 {
        schema.insert("minLength".into(), min.into());
    }
    if max != usize::MAX {
        schema.insert("maxLength".into(), max.into());
    }
    schema
}

/// Whether `text` holds `min..=max` code points (`usize::MAX` leaves it uncapped), counting no
/// further than one past `max`.
pub fn is_within_length(text: &str, min: usize, max: usize) -> bool {
    let is_long_enough = min == 0 || text.chars().nth(min - 1).is_some();
    let is_short_enough = max == usize::MAX || text.chars().nth(max).is_none();
    is_long_enough && is_short_enough
}

/// Text of `MIN..=MAX` code points with no rule on its content (`usize::MAX` leaves it bounded
/// only by the message cap): a token, a label a peer composes.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct BoundedText<const MIN: usize, const MAX: usize>(String);

impl<const MIN: usize, const MAX: usize> BoundedText<MIN, MAX> {
    /// `text` when its length in code points lies in `MIN..=MAX`, else `None`.
    pub fn new(text: String) -> Option<Self> {
        is_within_length(&text, MIN, MAX).then_some(Self(text))
    }

    /// The checked text.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The checked text, consuming the value.
    pub fn into_string(self) -> String {
        self.0
    }
}

impl<const MIN: usize, const MAX: usize> AsRef<str> for BoundedText<MIN, MAX> {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl<'de, const MIN: usize, const MAX: usize> Deserialize<'de> for BoundedText<MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).ok_or_else(|| {
            D::Error::custom(format!("the text is outside {MIN}..={MAX} code points"))
        })
    }
}

impl<const MIN: usize, const MAX: usize> JsonSchema for BoundedText<MIN, MAX> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("BoundedText{MIN}To{MAX}").into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        length_schema(MIN, MAX)
    }
}

/// Text of at least one code point, bounded only by the message cap.
pub type NonEmptyText = BoundedText<1, { usize::MAX }>;

/// Text the daemon composed (a path, a provider's words, a name): at least one code point, the one
/// rule a reply's own text is held to.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ComposedText(NonEmptyText);

impl ComposedText {
    /// `text` when it holds at least one code point, else `None`.
    pub fn new(text: String) -> Option<Self> {
        NonEmptyText::new(text).map(Self)
    }

    /// The checked text.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl JsonSchema for ComposedText {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "ComposedText".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        NonEmptyText::json_schema(generator)
    }
}

/// Text with no NUL, possibly empty, of at most `MAX` code points (`usize::MAX` leaves it bounded
/// only by the message cap): a query the person types, an environment value.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct NulFreeText<const MAX: usize>(String);

impl<const MAX: usize> NulFreeText<MAX> {
    /// Checks `text`; refuses a NUL or more than `MAX` code points.
    pub fn new(text: String) -> Result<Self, TextError> {
        if text.contains('\0') {
            return Err(TextError::HoldsNul);
        }
        if !is_within_length(&text, 0, MAX) {
            return Err(TextError::OverCap { cap: MAX });
        }
        Ok(Self(text))
    }

    /// The checked text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de, const MAX: usize> Deserialize<'de> for NulFreeText<MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

impl<const MAX: usize> JsonSchema for NulFreeText<MAX> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("NulFreeText{MAX}").into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        let mut schema = length_schema(0, MAX);
        schema.insert("pattern".into(), "^[^\\x00]*$".into());
        schema
    }
}

/// Declares a text newtype held to one pattern, checked when it is read and stated in its schema:
///
/// ```ignore
/// pattern_text! {
///     /// A git object id: 40 lower-case hex digits.
///     pub struct GitObjectId("^[0-9a-f]{40}$");
/// }
/// ```
///
/// Writing `, max = N` after the pattern also caps the text at `N` code points; `branded` after the
/// parentheses gives the TypeScript type a brand of the type's name, and `redacted` keeps the text
/// out of its `Debug` form, for a secret. The pattern spells every class out, so Rust and
/// ECMAScript read it alike.
macro_rules! pattern_text {
    (@ts_type $name:ident branded) => {
        Some(concat!("string & { readonly __brand: \"", stringify!($name), "\" }"))
    };
    (@ts_type $name:ident $($option:ident)?) => {
        None::<&str>
    };
    (@debug $name:ident redacted) => {
        impl std::fmt::Debug for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("<redacted>")
            }
        }
    };
    (@debug $name:ident $($option:ident)?) => {
        impl std::fmt::Debug for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.debug_tuple(stringify!($name)).field(&self.0).finish()
            }
        }
    };
    (@max_length) => { None::<usize> };
    (@max_length $max:expr) => { Some($max) };
    ($(
        $(#[doc = $doc:literal])+
        pub struct $name:ident($pattern:expr $(, max = $max:expr)?) $($option:ident)?;
    )+) => {$(
        $(#[doc = $doc])+
        #[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        $crate::wire::text::pattern_text!(@debug $name $($option)?);

        impl $name {
            /// The type's pattern.
            pub const PATTERN: &str = $pattern;

            /// `text` when it matches the type's pattern and length, else `None`.
            pub fn new(text: String) -> Option<Self> {
                static PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                    regex::Regex::new($name::PATTERN).expect("the pattern is a valid regex")
                });
                let is_within_length = $crate::wire::text::pattern_text!(@max_length $($max)?)
                    .is_none_or(|max| $crate::wire::text::is_within_length(&text, 0, max));
                (is_within_length && PATTERN.is_match(&text)).then_some(Self(text))
            }

            /// The checked text.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = <String as serde::Deserialize>::deserialize(deserializer)?;
                Self::new(text).ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom(concat!(
                        "the text does not match ",
                        stringify!($name),
                        "'s pattern"
                    ))
                })
            }
        }

        impl schemars::JsonSchema for $name {
            fn schema_name() -> std::borrow::Cow<'static, str> {
                stringify!($name).into()
            }

            fn json_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                let mut schema = schemars::json_schema!({
                    "description": $crate::schema::doc_description(concat!($($doc, "\n"),+)),
                    "type": "string",
                    "pattern": $name::PATTERN,
                });
                if let Some(max) = $crate::wire::text::pattern_text!(@max_length $($max)?) {
                    schema.insert("maxLength".into(), max.into());
                }
                let ts_type = $crate::wire::text::pattern_text!(@ts_type $name $($option)?);
                if let Some(ts_type) = ts_type {
                    schema.insert("tsType".into(), ts_type.into());
                }
                schema
            }
        }
    )+};
}

pub(crate) use pattern_text;

/// Declares a branded text newtype of `MIN..=MAX` code points, an id or a name a peer mints
/// opaquely, which TypeScript reads as a branded string:
///
/// ```ignore
/// branded_text! {
///     /// The daemon-minted id of one shell in a session, opaque to every client.
///     pub struct TerminalId(1..=TERMINAL_ID_MAX_LEN);
/// }
/// ```
macro_rules! branded_text {
    ($(
        $(#[doc = $doc:literal])+
        pub struct $name:ident($min:literal..=$max:expr);
    )+) => {$(
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// `text` when its length in code points lies in the type's bounds, else `None`.
            pub fn new(text: String) -> Option<Self> {
                $crate::wire::text::is_within_length(&text, $min, $max).then_some(Self(text))
            }

            /// The checked text.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = <String as serde::Deserialize>::deserialize(deserializer)?;
                Self::new(text).ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom(concat!(
                        "the text is outside ",
                        stringify!($name),
                        "'s length"
                    ))
                })
            }
        }

        impl schemars::JsonSchema for $name {
            fn schema_name() -> std::borrow::Cow<'static, str> {
                stringify!($name).into()
            }

            fn json_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                let mut schema = $crate::wire::text::length_schema($min, $max);
                schema.insert(
                    "description".into(),
                    $crate::schema::doc_description(concat!($($doc, "\n"),+)).into(),
                );
                schema.insert(
                    "tsType".into(),
                    concat!("string & { readonly __brand: \"", stringify!($name), "\" }").into(),
                );
                schema
            }
        }
    )+};
}

pub(crate) use branded_text;

/// Declares a branded newtype over [`FreeFormText`] of at most `MAX` code points, an id a peer
/// mints opaquely that keeps free-form text's rules (no NUL, not blank), which TypeScript reads as
/// a branded string:
///
/// ```ignore
/// branded_free_form_text! {
///     /// A provider's id of one turn.
///     pub struct ProviderTurnId(PROVIDER_WIRE_HANDLE_MAX_LEN);
/// }
/// ```
macro_rules! branded_free_form_text {
    ($(
        $(#[doc = $doc:literal])+
        pub struct $name:ident($max:expr);
    )+) => {$(
        $(#[doc = $doc])+
        #[derive(
            Clone,
            Debug,
            PartialEq,
            Eq,
            Hash,
            PartialOrd,
            Ord,
            serde::Serialize,
            serde::Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name($crate::wire::text::FreeFormText<{ $max }>);

        impl $name {
            /// Checks `text` as free-form text of the type's cap; refuses it with the first rule it
            /// breaks.
            pub fn new(text: String) -> Result<Self, $crate::wire::text::TextError> {
                $crate::wire::text::FreeFormText::new(text).map(Self)
            }

            /// The checked text.
            pub fn as_str(&self) -> &str {
                self.0.as_str()
            }

            /// The checked text, consuming the value.
            pub fn into_string(self) -> String {
                self.0.into_string()
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.0.as_str()
            }
        }

        impl schemars::JsonSchema for $name {
            fn schema_name() -> std::borrow::Cow<'static, str> {
                stringify!($name).into()
            }

            fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                type Text = $crate::wire::text::FreeFormText<{ $max }>;
                let mut schema = <Text as schemars::JsonSchema>::json_schema(generator);
                schema.insert(
                    "description".into(),
                    $crate::schema::doc_description(concat!($($doc, "\n"),+)).into(),
                );
                schema.insert(
                    "tsType".into(),
                    concat!("string & { readonly __brand: \"", stringify!($name), "\" }").into(),
                );
                schema
            }
        }
    )+};
}

pub(crate) use branded_free_form_text;

pattern_text! {
    /// Text holding at least one character outside ECMAScript's `\s` set; unlike free-form text it
    /// may hold a NUL.
    pub struct NonBlankText(concat!("[^", ecmascript_whitespace!(), "]"));
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{FreeFormText, TextError};

    #[rstest]
    #[case::at_the_cap("abcd", Ok(()))]
    #[case::past_the_cap("abcde", Err(TextError::OverCap { cap: 4 }))]
    #[case::astral_characters_count_once("😀😀😀😀", Ok(()))]
    #[case::astral_character_past_the_cap("😀😀😀😀😀", Err(TextError::OverCap { cap: 4 }))]
    #[case::byte_order_mark_is_blank("\u{feff} ", Err(TextError::Blank))]
    #[case::next_line_is_not_blank("\u{85}", Ok(()))]
    #[case::nul("a\0", Err(TextError::HoldsNul))]
    fn free_form_text_counts_code_points_and_ecmascript_whitespace(
        #[case] text: &str,
        #[case] expected: Result<(), TextError>,
    ) {
        let parsed = FreeFormText::<4>::new(text.to_owned()).map(|_| ());
        assert_eq!(parsed, expected);
        let schema = serde_json::to_value(schemars::schema_for!(FreeFormText<4>))
            .expect("a schema serializes");
        let pattern = regex::Regex::new(schema["pattern"].as_str().expect("a pattern"))
            .expect("the pattern compiles");
        let schema_accepts = pattern.is_match(text) && text.chars().count() <= 4;
        assert_eq!(
            schema_accepts,
            expected.is_ok(),
            "the schema states the same rule"
        );
    }
}
