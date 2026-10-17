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
