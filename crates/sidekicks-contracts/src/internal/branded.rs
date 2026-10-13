//! Branded ids: the macros that declare a UUID id or an opaque text id as its own newtype, which
//! TypeScript reads as a branded string, and the TypeScript module of the UUID text form.

use crate::typescript::TypeScriptModule;
use crate::wire::id::UuidTextForm;
use crate::wire::inline_scalar_definition;

/// Declares a UUID id: `branded_uuid_id! { /// doc \n SessionId }` gives a newtype over the id's
/// text that accepts only the UUID text form, branded `SessionId` in TypeScript.
macro_rules! branded_uuid_id {
    ($(#[doc = $doc:literal])+ $name:ident) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Checks `text`; refuses anything but the RFC 9562 UUID text form.
            pub fn new(text: String) -> Result<Self, $crate::wire::id::IdError> {
                $crate::wire::id::check_uuid_text(&text).map(|()| Self(text))
            }

            /// The id's text as received.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = <String as serde::Deserialize>::deserialize(deserializer)?;
                Self::new(text).map_err(<D::Error as serde::de::Error>::custom)
            }
        }

        impl schemars::JsonSchema for $name {
            fn schema_name() -> std::borrow::Cow<'static, str> {
                stringify!($name).into()
            }

            fn json_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                schemars::json_schema!({
                    "description": $crate::schema::doc_description(concat!($($doc, "\n"),+)),
                    "type": "string",
                    "pattern": $crate::wire::id::UUID_TEXT_FORM_PATTERN,
                    "tsType": concat!(
                        "string & { readonly __brand: \"", stringify!($name), "\" }"
                    ),
                })
            }
        }
    };
}

/// Declares an opaque text id: `branded_text_id! { /// doc \n NodeId, 256 }` gives a newtype over
/// a text of 1 to 256 code points whose format belongs to its writer, branded `NodeId` in
/// TypeScript.
macro_rules! branded_text_id {
    ($(#[doc = $doc:literal])+ $name:ident, $max:expr) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Checks `text`; refuses an empty text or one past the id's bound.
            pub fn new(text: String) -> Result<Self, $crate::wire::id::IdError> {
                $crate::wire::id::check_bounded_text(&text, $max).map(|()| Self(text))
            }

            /// The id's text as received.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = <String as serde::Deserialize>::deserialize(deserializer)?;
                Self::new(text).map_err(<D::Error as serde::de::Error>::custom)
            }
        }

        impl schemars::JsonSchema for $name {
            fn schema_name() -> std::borrow::Cow<'static, str> {
                stringify!($name).into()
            }

            fn json_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                schemars::json_schema!({
                    "description": $crate::schema::doc_description(concat!($($doc, "\n"),+)),
                    "type": "string",
                    "minLength": 1,
                    "maxLength": $max,
                    "tsType": concat!(
                        "string & { readonly __brand: \"", stringify!($name), "\" }"
                    ),
                })
            }
        }
    };
}

pub(crate) use {branded_text_id, branded_uuid_id};

/// The TypeScript module of the UUID text form every UUID id shares.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "internal/branded",
    doc: "The RFC 9562 UUID text form every UUID id accepts, for a member whose brand another \
          contract declares.",
    definitions: &[inline_scalar_definition!(
        UuidTextForm,
        "UuidTextForm",
        "A UUID in the RFC 9562 text form, either case, the Nil and Max UUIDs among them."
    )],
    constants: &[],
    method_tables: &[],
};
