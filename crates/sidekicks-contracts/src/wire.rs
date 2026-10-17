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

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::typescript::{Definition, TypeScriptModule};

pub mod attachment;
pub mod base64;
pub mod date;
pub mod handle_id;
pub mod id;
pub mod instant;
pub mod integer;
pub mod list;
pub mod name;
pub mod number;
pub mod record;
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
        // `not: {}` refuses every value as `false` does, and still types as `never` when the
        // member's doc comment wraps it in an object schema.
        json_schema!({ "not": {}, "tsType": "never" })
    }
}

/// Any JSON value, which its receiver reads by a contract of its own; TypeScript reads it as
/// `unknown`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AnyValue(pub serde_json::Value);

impl JsonSchema for AnyValue {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "AnyValue".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "tsType": "unknown" })
    }
}

/// A member whose one value is the boolean `VALUE`: a page's `hasMore`, or a mark that is `true`
/// when present.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct BoolLiteral<const VALUE: bool>;

/// A member whose one value is `true`.
pub type True = BoolLiteral<true>;

/// A member whose one value is `false`.
pub type False = BoolLiteral<false>;

impl<const VALUE: bool> Serialize for BoolLiteral<VALUE> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(VALUE)
    }
}

impl<'de, const VALUE: bool> Deserialize<'de> for BoolLiteral<VALUE> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? == VALUE {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!(
                "this member is always `{VALUE}`"
            )))
        }
    }
}

impl<const VALUE: bool> JsonSchema for BoolLiteral<VALUE> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        if VALUE { "True" } else { "False" }.into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "boolean", "const": VALUE })
    }
}

/// Declares a one-value string type, for a member that holds exactly one wire word:
/// `literal! { /// doc \n pub enum DeviceLinkedKind = "device.linked"; }`. A word another closed
/// set owns is named by its constant text, so it is spelled once:
/// `pub enum AttachmentRefusedCode = const RefusalCode::SessionAttachmentRefused.as_str();`.
macro_rules! literal {
    ($($(#[doc = $doc:literal])+ pub enum $name:ident = $value:literal;)+) => {$(
        $(#[doc = $doc])+
        #[derive(
            Clone,
            Copy,
            Debug,
            PartialEq,
            Eq,
            Hash,
            serde::Serialize,
            serde::Deserialize,
            schemars::JsonSchema,
        )]
        #[schemars(inline)]
        pub enum $name {
            /// The one value.
            #[serde(rename = $value)]
            Value,
        }
    )+};
    ($($(#[doc = $doc:literal])+ pub enum $name:ident = const $value:expr;)+) => {$(
        $(#[doc = $doc])+
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name {
            /// The one value.
            Value,
        }

        impl $name {
            /// The one value's text.
            pub const TEXT: &str = $value;
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(Self::TEXT)
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = <std::borrow::Cow<'de, str> as serde::Deserialize>::deserialize(
                    deserializer,
                )?;
                if text == Self::TEXT {
                    Ok(Self::Value)
                } else {
                    Err(<D::Error as serde::de::Error>::invalid_value(
                        serde::de::Unexpected::Str(&text),
                        &Self::TEXT,
                    ))
                }
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
                schemars::json_schema!({
                    "description": $crate::schema::doc_description(concat!($($doc, "\n"),+)),
                    "type": "string",
                    "const": Self::TEXT,
                })
            }
        }
    )+};
}

pub(crate) use literal;

/// Declares a scalar a contract names as its own definition: `named_scalar! { /// doc \n
/// UsdMicros(SafeInt<0>), Copy }` gives a newtype that reads, writes and checks as its inner
/// scalar, with its own schema name and the doc as its description, so TypeScript gets a type and
/// a check by that name. Traits listed after the type are derived too; `unordered` after the type
/// instead leaves out the ordering and hash derives, for an inner type without them, and derives a
/// garde check that holds no rule, so a reply of any JSON can be a method's result.
macro_rules! named_scalar {
    (@schema $name:ident($inner:ty) $($doc:literal)+) => {
        impl schemars::JsonSchema for $name {
            fn schema_name() -> std::borrow::Cow<'static, str> {
                stringify!($name).into()
            }

            fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                let mut schema = <$inner as schemars::JsonSchema>::json_schema(generator);
                schema.insert(
                    "description".into(),
                    $crate::schema::doc_description(concat!($($doc, "\n"),+)).into(),
                );
                schema
            }
        }
    };
    ($(#[doc = $doc:literal])+ $name:ident($inner:ty) unordered) => {
        $(#[doc = $doc])+
        #[derive(
            Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, garde::Validate,
        )]
        #[serde(transparent)]
        #[garde(allow_unvalidated)]
        pub struct $name(pub $inner);

        $crate::wire::named_scalar!(@schema $name($inner) $($doc)+);
    };
    ($(#[doc = $doc:literal])+ $name:ident($inner:ty) $(, $derive:ident)* $(,)?) => {
        $(#[doc = $doc])+
        #[derive(
            Clone,
            Debug,
            PartialEq,
            Eq,
            PartialOrd,
            Ord,
            Hash,
            serde::Serialize,
            serde::Deserialize,
            $($derive),*
        )]
        #[serde(transparent)]
        pub struct $name(pub $inner);

        $crate::wire::named_scalar!(@schema $name($inner) $($doc)+);
    };
}

pub(crate) use named_scalar;

/// A checked definition for a scalar every member inlines: `name` with the scalar's own schema and
/// `doc` as its description, so TypeScript gets the scalar's check without a type alias per member.
macro_rules! inline_scalar_definition {
    ($type:ty, $name:literal, $doc:literal) => {
        $crate::typescript::Definition {
            name: || std::borrow::Cow::Borrowed($name),
            schema: |generator| {
                let mut schema = <$type as schemars::JsonSchema>::json_schema(generator);
                schema.insert("description".into(), $doc.into());
                schema
            },
            contract: $crate::typescript::SchemaContract::Read,
            is_checked: true,
        }
    };
}

pub(crate) use inline_scalar_definition;

/// The TypeScript module of the scalars every contract shares: the instant, the calendar date, the
/// count, composed text, the port and the byte attachment's placeholder.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "internal/wire-scalars",
    doc: "The scalars every contract module shares: an instant and a calendar date on the wire, a \
          count, the text the daemon composes, text that is not blank, a port and the placeholder \
          a byte member is written as.",
    definitions: &[
        Definition::read::<instant::WireInstant>().checked(),
        Definition::read::<date::WireDate>(),
        inline_scalar_definition!(
            integer::SafeInt<0>,
            "SafeInt0",
            "A count of things, or a number of seconds or bytes: a whole number, zero or more."
        ),
        inline_scalar_definition!(
            text::ComposedText,
            "ComposedText",
            "Text the daemon composed: a path, a provider's words, a name; never empty."
        ),
        Definition::read::<text::NonBlankText>(),
        Definition::read::<integer::Port>(),
        Definition::read::<attachment::BytesPlaceholder>(),
    ],
    constants: &[],
    method_tables: &[],
};

/// The wire's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[&TYPESCRIPT_MODULE];
