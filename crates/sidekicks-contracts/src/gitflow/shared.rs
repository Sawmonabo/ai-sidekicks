//! The scalars the git-flow modules share: a commit's short id, a ref name, an address on the
//! hosting service, a change request's number and an id the hosting service minted.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use url::Url;

use crate::typescript::{Definition, TypeScriptModule};
use crate::web_address::web_address_fault;
use crate::wire::integer::SafeInt;
use crate::wire::text::{BoundedText, FreeFormText, pattern_text};

pattern_text! {
    /// A commit's short id, git's own abbreviation, which is as long as the repository needs.
    pub struct GitShortObjectId("^[0-9a-f]{4,64}$");
}

/// A branch or other ref name; git's own rule judges it, so the wire sets no length.
pub type GitRefName = FreeFormText<{ usize::MAX }>;

/// An id the hosting service minted (a thread, a comment, a check), opaque to every client.
pub type HostHandle = BoundedText<1, { usize::MAX }>;

/// A change request's number on its host: `#482` on GitHub, `!482` on GitLab.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(transparent)]
pub struct ChangeRequestNumber(SafeInt<1>);

/// An `http:` or `https:` address on the hosting service, opened in the system browser and kept as
/// the host wrote it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct HostingAddress(String);

impl HostingAddress {
    /// `text` when it parses as an `http:` or `https:` address, else `None`.
    pub fn new(text: String) -> Option<Self> {
        Url::parse(&text)
            .is_ok_and(|address| web_address_fault(&address).is_none())
            .then_some(Self(text))
    }

    /// The address as written.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for HostingAddress {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?)
            .ok_or_else(|| D::Error::custom("not an http or https address"))
    }
}

impl JsonSchema for HostingAddress {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "HostingAddress".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "format": "web-url" })
    }
}

/// The TypeScript module of the scalars the git-flow modules share.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "gitflow/shared",
    doc: "The scalars the git-flow modules share.",
    definitions: &[
        Definition::read::<GitShortObjectId>().checked(),
        Definition::read::<ChangeRequestNumber>().checked(),
        Definition::read::<HostingAddress>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
