//! The wire's building blocks: the field forms every contract member takes, the member an arm
//! leaves out, and the scalar newtypes whose schemas state the rules their parsers hold.
//!
//! A member is written in one of three forms, and never as a bare `Option<T>`, which serde reads
//! as absent or `null` alike:
//! - absent allowed, `null` refused: `Option<T>` with `#[serde(default, skip_serializing_if =
//!   "Option::is_none", deserialize_with = "wire::present")]` and `#[schemars(with = "T")]`;
//! - `null` allowed, the key required: `Option<T>` with `#[serde(deserialize_with =
//!   "wire::nullable")]` and `#[schemars(with = "wire::NullableSchema<T>")]`;
//! - absent, `null` and a value: `Option<Option<T>>` with `#[serde(default, skip_serializing_if =
//!   "Option::is_none", with = "serde_with::rust::double_option")]` and `#[schemars(with =
//!   "wire::NullableSchema<T>")]`.

use std::borrow::Cow;
use std::marker::PhantomData;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::typescript::{Definition, TypeScriptModule};

pub mod attachment;
pub mod handle_id;
pub mod instant;
pub mod integer;
pub mod text;

/// Reads a member that may be absent but is never `null`: a present value must parse as `T`.
pub fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Reads a member whose key is required and whose value may be `null`.
pub fn nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// The schema of a member that holds `T` or `null`; it stands in for the member's type through
/// `#[schemars(with = …)]` and is never a value.
pub struct NullableSchema<T>(PhantomData<T>);

impl<T: JsonSchema> JsonSchema for NullableSchema<T> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("Nullable{}", T::schema_name()).into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        <Option<T> as JsonSchema>::json_schema(generator)
    }
}

/// A member that belongs to another arm of a union: absent is the only form it takes, so any
/// present value is refused and TypeScript reads it as `name?: never`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Never {}

impl Serialize for Never {
    fn serialize<S: Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
        match *self {}
    }
}

impl<'de> Deserialize<'de> for Never {
    fn deserialize<D: Deserializer<'de>>(_deserializer: D) -> Result<Self, D::Error> {
        Err(serde::de::Error::custom(
            "this member belongs to another arm",
        ))
    }
}

impl JsonSchema for Never {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "Never".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        Schema::from(false)
    }
}

/// The TypeScript module of the scalars every contract shares: the instant and the byte
/// attachment's placeholder.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "internal/wire-scalars",
    doc: "The scalars every contract module shares: an instant on the wire and the placeholder a \
          byte member is written as.",
    definitions: &[
        Definition::read::<instant::WireInstant>().checked(),
        Definition::read::<attachment::BytesPlaceholder>(),
    ],
    constants: &[],
    method_tables: &[],
};

/// The wire's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[&TYPESCRIPT_MODULE];
