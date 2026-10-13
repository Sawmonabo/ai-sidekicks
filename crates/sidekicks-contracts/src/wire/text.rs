//! Free-form text on the wire: a name, a reason, a message. Its rules count what JavaScript and
//! Ajv count, so the Rust parser and the generated TypeScript check accept the same strings.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

/// Whether `character` is in ECMAScript's `\s` set: its WhiteSpace and LineTerminator code points.
/// Rust's `char::is_whitespace` differs from it on U+FEFF and U+0085.
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

/// A pattern Rust's `regex` and ECMAScript read alike: text with no NUL and at least one character
/// outside ECMAScript's `\s` set.
const NON_BLANK_NUL_FREE_PATTERN: &str = "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\
                                          \\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$";

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
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
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
        if MAX != usize::MAX && text.chars().nth(MAX).is_some() {
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
