//! The one tag rule every tagged record follows: what a tag may hold, and how a list of tags holds
//! each tag once.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::name_fold::fold_name;
use crate::session::name::SESSION_NAME_MAX_LEN;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::list::{ListKey, UniqueList};
use crate::wire::text::{ecmascript_whitespace, is_within_length};

/// A tag's pattern: levels joined by `/`, each one or more characters that are neither a NUL, a
/// `/` nor ECMAScript whitespace, spelled out so Rust and ECMAScript read it alike.
const TAG_PATTERN: &str = concat!(
    "^[^\\x00/",
    ecmascript_whitespace!(),
    "]+(?:/[^\\x00/",
    ecmascript_whitespace!(),
    "]+)*$"
);

/// [`TAG_PATTERN`], compiled once.
static TAG_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(TAG_PATTERN).expect("the tag pattern is a valid regex"));

/// One tag, nested with `/` (`billing/stripe`): never empty, no whitespace or NUL anywhere, no
/// empty level around a `/` (`/billing`, `billing//stripe`, `billing/`), and no longer than a
/// session name.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct Tag(String);

impl Tag {
    /// `text` when it is a tag, else `None`.
    pub fn new(text: String) -> Option<Self> {
        let is_tag = TAG_REGEX.is_match(&text) && is_within_length(&text, 0, SESSION_NAME_MAX_LEN);
        is_tag.then_some(Self(text))
    }

    /// The tag's text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Tag {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).ok_or_else(|| {
            D::Error::custom(format!(
                "a tag has no whitespace, no empty level and at most {SESSION_NAME_MAX_LEN} \
                 characters"
            ))
        })
    }
}

impl JsonSchema for Tag {
    fn schema_name() -> Cow<'static, str> {
        "Tag".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "A tag, nested with /: no whitespace, never empty, and no empty level \
                            around a /.",
            "type": "string",
            "maxLength": SESSION_NAME_MAX_LEN,
            "pattern": TAG_PATTERN,
        })
    }
}

/// A record's tags, each held once: two tags that differ only in case (`Ops`, `ops`) are one tag,
/// compared by their [`fold_name`]. The check refuses a repeat at its index.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, garde::Validate)]
#[serde(transparent)]
#[garde(transparent)]
pub struct TagList(#[garde(dive)] pub UniqueList<Tag, 0, { usize::MAX }>);

impl JsonSchema for TagList {
    fn schema_name() -> Cow<'static, str> {
        "TagList".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        // JSON Schema cannot compare folds, so the generated check accepts a repeat the Rust
        // check refuses.
        json_schema!({
            "description": "Tags, each nested with / and held once ignoring case; no whitespace \
                            or empty level.",
            "type": "array",
            "items": generator.subschema_for::<Tag>(),
        })
    }
}

/// The TypeScript module of the tag rule.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "tag",
    doc: "The one tag rule every tagged record follows: what a tag may hold, and how a list of \
          tags holds each tag once.",
    definitions: &[
        Definition::read::<Tag>().checked(),
        Definition::read::<TagList>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};

impl ListKey for Tag {
    type Key = String;

    fn list_key(&self) -> String {
        fold_name(self.as_str())
    }

    // A tag carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}
