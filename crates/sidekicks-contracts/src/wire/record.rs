//! A record on the wire: an object whose members a peer names. It refuses the member `__proto__`,
//! in its schema too, so no TypeScript reader meets a member that would replace an object's
//! prototype.

use std::borrow::Cow;
use std::collections::BTreeMap;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::wire::AnyValue;

/// The one member name a record refuses, since a JavaScript object reads it as its prototype.
pub(crate) const PROTOTYPE_KEY: &str = "__proto__";

/// The `propertyNames` rule of an object that refuses the member `__proto__`.
pub(crate) fn prototype_free_names() -> serde_json::Value {
    serde_json::json!({ "not": { "const": PROTOTYPE_KEY } })
}

/// Reads an object of any members but `__proto__`, for a map whose members a peer names
/// (`deserialize_with`); its schema states [`prototype_free_names`].
pub(crate) fn prototype_free<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<serde_json::Map<String, serde_json::Value>, D::Error> {
    let members = serde_json::Map::deserialize(deserializer)?;
    if members.contains_key(PROTOTYPE_KEY) {
        Err(D::Error::custom(
            "an object here never holds the member __proto__",
        ))
    } else {
        Ok(members)
    }
}

/// A record's member name, which can say whether it is the one name a record refuses.
pub trait RecordKey {
    /// Whether the name is `__proto__`.
    fn is_prototype_key(&self) -> bool;
}

impl<T: AsRef<str>> RecordKey for T {
    fn is_prototype_key(&self) -> bool {
        self.as_ref() == PROTOTYPE_KEY
    }
}

/// An object whose member names are `K` and whose values are `V`, in key order; the member
/// `__proto__` is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Record<K: Ord, V>(BTreeMap<K, V>);

impl<K: Ord + RecordKey, V> Record<K, V> {
    /// The record of `members`, or `None` when a member is named `__proto__`.
    pub fn new(members: BTreeMap<K, V>) -> Option<Self> {
        let is_prototype_free = !members.keys().any(RecordKey::is_prototype_key);
        is_prototype_free.then_some(Self(members))
    }
}

impl<K: Ord, V> Record<K, V> {
    /// The members by name.
    pub fn as_map(&self) -> &BTreeMap<K, V> {
        &self.0
    }

    /// The members by name, consuming the record.
    pub fn into_map(self) -> BTreeMap<K, V> {
        self.0
    }
}

impl<K: Ord, V> Default for Record<K, V> {
    fn default() -> Self {
        Self(BTreeMap::new())
    }
}

/// A record's checks are its values' checks, each reported under its member's name.
impl<K, V> garde::Validate for Record<K, V>
where
    K: Ord + Clone + garde::error::PathComponentKind,
    V: garde::Validate,
{
    type Context = V::Context;

    fn validate_into(
        &self,
        context: &Self::Context,
        parent: &mut dyn FnMut() -> garde::Path,
        report: &mut garde::Report,
    ) {
        self.0.validate_into(context, parent, report);
    }
}

impl<'de, K, V> Deserialize<'de> for Record<K, V>
where
    K: Ord + Deserialize<'de> + RecordKey,
    V: Deserialize<'de>,
{
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(BTreeMap::<K, V>::deserialize(deserializer)?)
            .ok_or_else(|| D::Error::custom("a record never holds the member __proto__"))
    }
}

impl<K: Ord + JsonSchema, V: JsonSchema> JsonSchema for Record<K, V> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("RecordOf{}To{}", K::schema_name(), V::schema_name()).into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "object",
            "propertyNames": {
                "allOf": [generator.subschema_for::<K>(), { "not": { "const": PROTOTYPE_KEY } }],
            },
            "additionalProperties": generator.subschema_for::<V>(),
        })
    }
}

/// An object of any members but `__proto__`, each read by a contract of its receiver's own.
pub type JsonRecord = Record<String, AnyValue>;
