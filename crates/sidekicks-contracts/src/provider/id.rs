//! The open id a provider's driver answers to. The set is open: the daemon checks an id against
//! the drivers it registered wherever a request or a provider message brings one in, a stored row
//! keeps the id it was written with, and the name a person reads comes from the provider read.

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::record::RecordKey;
use crate::wire::text::pattern_text;

pattern_text! {
    /// A provider's id as its driver declares it: a lowercase letter, then up to 31 lowercase
    /// letters, digits or hyphens. Opaque to every client, which never branches on its value.
    pub struct ProviderId("^[a-z][a-z0-9-]{0,31}$") branded;
}

/// Whether `id` matches [`ProviderId`]'s pattern, `^[a-z][a-z0-9-]{0,31}$`, in a form a constant
/// can call, so a table of ids is checked when it compiles.
pub const fn is_provider_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    let mut i = 1;
    while i < bytes.len() {
        let byte = bytes[i];
        if !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') {
            return false;
        }
        i += 1;
    }
    true
}

/// A provider id names a member of a record keyed by provider, never `__proto__`, which its
/// pattern refuses.
impl RecordKey for ProviderId {
    fn is_prototype_key(&self) -> bool {
        false
    }
}

/// The TypeScript module of the provider id.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/id",
    doc: "The open id a provider's driver answers to, checked against the registered drivers \
          wherever a request or a provider message brings one in.",
    definitions: &[Definition::read::<ProviderId>().checked()],
    constants: &[],
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{ProviderId, is_provider_id};

    #[rstest]
    #[case::a_word("claude")]
    #[case::digits_and_hyphens("gemini-cli2")]
    #[case::longest("a234567890123456789012345678901b")]
    #[case::one_too_long("a234567890123456789012345678901bc")]
    #[case::empty("")]
    #[case::leading_digit("2cli")]
    #[case::leading_hyphen("-cli")]
    #[case::upper_case("Codex")]
    #[case::space("gemini cli")]
    #[case::underscore("gemini_cli")]
    fn the_constant_check_agrees_with_the_pattern(#[case] id: &str) {
        assert_eq!(
            is_provider_id(id),
            ProviderId::new(id.to_owned()).is_some(),
            "{id}"
        );
    }
}
