//! Branded ids: the macros that declare a UUID id or an opaque text id as its own newtype, which
//! TypeScript reads as a branded string, and the TypeScript module of the UUID text form.

use crate::typescript::TypeScriptModule;
use crate::wire::id::UuidTextForm;
use crate::wire::inline_scalar_definition;

/// Declares a UUID id: `branded_uuid_id! { /// doc \n SessionId }` gives a newtype over a
/// `uuid::Uuid` that accepts only the UUID text form, written lowercase, branded `SessionId` in
/// TypeScript.
macro_rules! branded_uuid_id {
    ($(#[doc = $doc:literal])+ $name:ident) => {
        $(#[doc = $doc])+
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(uuid::Uuid);

        impl $name {
            /// Reads `text`; refuses anything but the RFC 9562 UUID text form.
            pub fn new(text: &str) -> Result<Self, $crate::wire::id::IdError> {
                $crate::wire::id::parse_uuid_text(text).map(Self)
            }

            /// The id's lowercase text, held on the stack.
            pub fn text(&self) -> $crate::wire::id::UuidText {
                $crate::wire::id::UuidText::new(self.0)
            }
        }

        impl TryFrom<uuid::Uuid> for $name {
            type Error = $crate::wire::id::IdError;

            /// Takes a UUID of a version from 1 to 8 with the RFC variant, or the Nil or Max UUID.
            fn try_from(uuid: uuid::Uuid) -> Result<Self, Self::Error> {
                if $crate::wire::id::is_uuid_text_form(uuid) {
                    Ok(Self(uuid))
                } else {
                    Err($crate::wire::id::IdError::NotUuid)
                }
            }
        }

        impl From<$name> for uuid::Uuid {
            fn from(id: $name) -> Self {
                id.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                std::fmt::Display::fmt(&self.0.hyphenated(), formatter)
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.text().as_str())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                $crate::wire::id::deserialize_uuid_text(deserializer).map(Self)
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

pub(crate) use branded_uuid_id;

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

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use crate::session::id::SessionId;
    use crate::wire::id::UuidTextForm;

    #[rstest]
    #[case(
        "0190F1C4-7E3A-7B1C-9D2E-3F4A5B6C7D8E",
        "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d8e"
    )]
    #[case(
        "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
        "ffffffff-ffff-ffff-ffff-ffffffffffff"
    )]
    fn an_uppercase_uuid_reads_back_lowercase_and_equals_its_lowercase_spelling(
        #[case] upper: &str,
        #[case] lower: &str,
    ) {
        let read = |text: &str| -> SessionId {
            serde_json::from_value(serde_json::Value::from(text)).expect("a UUID id reads")
        };
        assert_eq!(
            serde_json::to_value(read(upper)).expect("writes"),
            serde_json::Value::from(lower)
        );
        assert_eq!(read(upper), read(lower));
        let form: UuidTextForm =
            serde_json::from_value(serde_json::Value::from(upper)).expect("a UUID reads");
        assert_eq!(
            serde_json::to_value(form).expect("writes"),
            serde_json::Value::from(lower)
        );
    }
}
