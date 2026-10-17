//! Syntax color spans: the daemon colors code once and every client paints what it is handed. A
//! reply is a flat list of `[offset, length, class]` triples counted in UTF-16 code units, so a
//! client slices the source it holds directly. A class is an index into the span classes, never a
//! color, so a theme change repaints the same spans. The language is a closed set; an unknown one
//! is refused, not answered with an empty reply.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use strum::VariantArray;

use crate::jsonrpc::byte_length::fits_budget;
use crate::method::methods;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::{MAX_SAFE_INTEGER, SafeInt};
use crate::wire::text::{BoundedText, NonEmptyText};

/// One language the daemon can color.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "lowercase")]
pub enum HighlightLanguage {
    /// Bash.
    Bash,
    /// CSS.
    Css,
    /// A unified diff.
    Diff,
    /// Go.
    Go,
    /// HTML.
    Html,
    /// JavaScript.
    Javascript,
    /// JSON.
    Json,
    /// JSX.
    Jsx,
    /// Markdown.
    Markdown,
    /// Python.
    Python,
    /// Rust.
    Rust,
    /// SQL.
    Sql,
    /// TSX.
    Tsx,
    /// TypeScript.
    Typescript,
    /// YAML.
    Yaml,
}

/// One class a span paints as; plain text has no span. The first five mark code; the rest mark a
/// diff's lines and Markdown's own syntax. A span names its class by its index in `VARIANTS`.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum HighlightSpanClass {
    /// A keyword.
    Keyword,
    /// A name.
    Name,
    /// A string.
    String,
    /// A number.
    Number,
    /// A comment.
    Comment,
    /// A diff's inserted line.
    Inserted,
    /// A diff's deleted line.
    Deleted,
    /// A diff's hunk header.
    Hunk,
    /// A Markdown heading.
    Heading,
    /// Markdown emphasis.
    Emphasis,
    /// Markdown inline code.
    InlineCode,
}

ts_constants! {
    /// How many numbers one span takes in a reply: offset, length, class.
    pub const HIGHLIGHT_SPAN_WIDTH: usize = 3;
    /// The largest source the daemon colors, in UTF-8 bytes of its JSON as it travels. A larger
    /// block is left plain: coloring it would cost more than the span cache holds for everything
    /// else.
    pub const HIGHLIGHT_SOURCE_MAX_BYTES: usize = 262_144;
    /// The largest span list a reply carries, in UTF-8 bytes of its JSON as it travels: its own
    /// figure, which the reply with its envelope keeps well inside the message limit.
    pub const HIGHLIGHT_SPANS_MAX_BYTES: usize = 998_976;
    /// The longest block id a `highlight.read` carries.
    pub const HIGHLIGHT_BLOCK_ID_MAX_LENGTH: usize = 128;
    /// Every language the daemon can color.
    HIGHLIGHT_LANGUAGES = HighlightLanguage::VARIANTS;
    /// The classes a span paints as, in wire order.
    HIGHLIGHT_SPAN_CLASSES = HighlightSpanClass::VARIANTS;
}

/// The code a client wants colored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct HighlightReadRequest {
    /// The language.
    pub language: HighlightLanguage,
    /// The source, at most [`HIGHLIGHT_SOURCE_MAX_BYTES`] as its JSON travels.
    #[garde(custom(|source: &NonEmptyText, (): &()| {
        fits_budget(source, HIGHLIGHT_SOURCE_MAX_BYTES)
    }))]
    #[schemars(extend("maxJsonBytes" = HIGHLIGHT_SOURCE_MAX_BYTES))]
    pub source: NonEmptyText,
    /// The code block on screen this read is for, unique among the client's blocks; a newer read
    /// with the same block id on the same connection replaces this one while it waits.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BoundedText<1, HIGHLIGHT_BLOCK_ID_MAX_LENGTH>")]
    pub block_id: Option<BoundedText<1, HIGHLIGHT_BLOCK_ID_MAX_LENGTH>>,
}

/// One color span: where it starts and how long it is, in UTF-16 code units, and its class.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HighlightSpan {
    /// Where it starts.
    pub offset: SafeInt<0>,
    /// How long it is, at least one unit.
    pub length: SafeInt<1>,
    /// What it paints as.
    pub class: HighlightSpanClass,
}

/// A source's color spans, read from and written as the flat `[offset, length, class, …]` list.
/// The triples, a non-zero length and a known class are the type; source order without overlap
/// and the reply's byte bound are its check. A schema cannot state a repeating triple in a flat
/// array, so the TypeScript check accepts any list of whole numbers within the byte bound.
#[derive(Clone, Debug, PartialEq, Eq, garde::Validate)]
pub struct HighlightSpans(#[garde(custom(are_spans_paintable))] pub Vec<HighlightSpan>);

impl Serialize for HighlightSpans {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        flat_spans(&self.0).serialize(serializer)
    }
}

fn flat_spans(spans: &[HighlightSpan]) -> Vec<u64> {
    spans
        .iter()
        .flat_map(|span| {
            let class = HighlightSpanClass::VARIANTS
                .iter()
                .position(|class| *class == span.class)
                .expect("every class is listed");
            let class = u64::try_from(class).expect("eleven classes fit");
            [span.offset.get(), span.length.get(), class]
        })
        .collect()
}

impl<'de> Deserialize<'de> for HighlightSpans {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let numbers = Vec::<SafeInt<0>>::deserialize(deserializer)?;
        let (triples, rest) = numbers.as_chunks::<HIGHLIGHT_SPAN_WIDTH>();
        if !rest.is_empty() {
            return Err(D::Error::custom(
                "spans holds three numbers per span: offset, length and class",
            ));
        }
        triples
            .iter()
            .map(|triple| {
                let length = SafeInt::new(triple[1].get())
                    .ok_or_else(|| D::Error::custom("a span covers at least one character"))?;
                let class = usize::try_from(triple[2].get())
                    .ok()
                    .and_then(|index| HighlightSpanClass::VARIANTS.get(index))
                    .ok_or_else(|| {
                        D::Error::custom("a span's class is an index into the span classes")
                    })?;
                Ok(HighlightSpan {
                    offset: triple[0],
                    length,
                    class: *class,
                })
            })
            .collect::<Result<_, _>>()
            .map(Self)
    }
}

impl JsonSchema for HighlightSpans {
    fn schema_name() -> Cow<'static, str> {
        "HighlightSpans".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description":
                "A source's color spans: `[offset, length, class, …]` in source order.",
            "type": "array",
            "items": { "type": "integer", "minimum": 0, "maximum": MAX_SAFE_INTEGER },
            "maxJsonBytes": HIGHLIGHT_SPANS_MAX_BYTES,
        })
    }
}

/// Refuses spans out of source order or overlapping, and spans whose flat list measures over
/// [`HIGHLIGHT_SPANS_MAX_BYTES`] JSON bytes.
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "garde passes a check's context by reference"
)]
fn are_spans_paintable(spans: &Vec<HighlightSpan>, (): &()) -> garde::Result {
    let mut previous_end = 0;
    for span in spans {
        if span.offset.get() < previous_end {
            return Err(garde::Error::new(
                "spans run in source order and never overlap",
            ));
        }
        previous_end = span.offset.get() + span.length.get();
    }
    fits_budget(&flat_spans(spans), HIGHLIGHT_SPANS_MAX_BYTES)
}

/// A source's color spans, in source order, never overlapping.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HighlightReadResponse {
    /// The spans.
    #[garde(dive)]
    pub spans: HighlightSpans,
}

methods! {
    /// The `highlight.*` methods: one read, answered by the daemon's colorer.
    pub const HIGHLIGHT_METHOD_DESCRIPTORS = [
        /// Colors one source; a newer read for the same block replaces a waiting one.
        HighlightRead = query "highlight.read" {
            mutating: false,
            params: HighlightReadRequest,
            result: HighlightReadResponse,
            refusals: [HighlightReadReplaced],
        },
    ];
}

/// The TypeScript module of syntax color spans.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "highlight",
    doc: "Syntax color spans: the daemon colors code once and every client paints what it is \
          handed.",
    definitions: &[
        Definition::read::<HighlightLanguage>().checked(),
        Definition::read::<HighlightSpanClass>(),
        Definition::read::<HighlightReadRequest>().checked(),
        Definition::read::<HighlightSpans>(),
        Definition::read::<HighlightReadResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&HIGHLIGHT_METHOD_DESCRIPTORS],
};

#[cfg(test)]
mod tests {
    use garde::Validate;

    use super::HighlightReadResponse;

    fn read(json: &str) -> Result<HighlightReadResponse, String> {
        let response: HighlightReadResponse =
            serde_json::from_str(json).map_err(|error| error.to_string())?;
        response.validate().map_err(|report| report.to_string())?;
        Ok(response)
    }

    #[test]
    fn reads_only_spans_a_client_can_paint() {
        let response = read(r#"{"spans":[0,2,0,2,3,10]}"#).expect("two spans in order");
        assert_eq!(
            serde_json::to_string(&response).expect("writes"),
            r#"{"spans":[0,2,0,2,3,10]}"#
        );
        for refused in [
            r#"{"spans":[0,2]}"#,
            r#"{"spans":[0,0,1]}"#,
            r#"{"spans":[0,1,11]}"#,
            r#"{"spans":[4,2,0,5,1,0]}"#,
        ] {
            assert!(read(refused).is_err(), "{refused}");
        }
    }
}
