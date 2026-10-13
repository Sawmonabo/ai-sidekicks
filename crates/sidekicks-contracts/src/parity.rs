//! The parity corpus's keys: each names a schema of today's TypeScript contracts and the Rust type
//! that replaces it, so the corpus test can read every recorded input into that type.

use std::borrow::Cow;

use bytes::Bytes;

/// One corpus key and how its Rust type reads an input.
#[derive(Clone, Copy, Debug)]
pub struct ParityKey {
    /// `<module path>#<export name>`, as the corpus names the schema.
    pub key: &'static str,
    /// The Rust type's schema name, which is the generated check's type name.
    pub type_name: fn() -> Cow<'static, str>,
    /// Reads an input's JSON text with its attachments into the type and runs its garde check;
    /// the error says why the input was refused.
    pub check: fn(&[u8], Vec<Bytes>) -> Result<(), String>,
}

/// Declares a module's `PARITY_KEYS`: `"module#ExportSchema" => Type;` reads the input with
/// serde, and `"module#ExportSchema" => Type, checked;` runs the type's garde check after it.
macro_rules! parity_keys {
    (@check $type:ty, checked) => {
        |json, attachments| {
            let value: $type = $crate::wire::attachment::parse(json, attachments)
                .map_err(|error| error.to_string())?;
            garde::Validate::validate(&value).map_err(|report| report.to_string())
        }
    };
    (@check $type:ty) => {
        |json, attachments| {
            $crate::wire::attachment::parse::<$type>(json, attachments)
                .map(drop)
                .map_err(|error| error.to_string())
        }
    };
    ($($key:literal => $type:ty $(, $checked:ident)?;)*) => {
        /// The corpus keys this module's types answer.
        pub(crate) const PARITY_KEYS: &[$crate::parity::ParityKey] = &[$(
            $crate::parity::ParityKey {
                key: $key,
                type_name: <$type as schemars::JsonSchema>::schema_name,
                check: $crate::parity::parity_keys!(@check $type $(, $checked)?),
            },
        )*];
    };
}

pub(crate) use parity_keys;

/// Every key a module registered, topic by topic.
pub fn keys() -> impl Iterator<Item = &'static ParityKey> {
    [crate::wire::PARITY_KEYS].into_iter().flatten()
}
