//! A secret a provider keeps in a saved sign-in, read from its file's text member straight into a
//! secret, so no plain copy of it outlives the parse.

use secrecy::SecretString;
use serde::{Deserialize as _, Deserializer};

/// A text member read straight into a secret, for a `deserialize_with`.
pub(crate) fn read_secret<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<SecretString, D::Error> {
    String::deserialize(deserializer).map(SecretString::from)
}

/// An optional text member read straight into a secret, for a `deserialize_with`.
pub(crate) fn read_optional_secret<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<SecretString>, D::Error> {
    Option::<String>::deserialize(deserializer).map(|text| text.map(SecretString::from))
}
