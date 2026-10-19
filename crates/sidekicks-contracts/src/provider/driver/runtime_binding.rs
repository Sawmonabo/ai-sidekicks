//! The id of a runtime binding, one live session's leg on its provider.

use crate::provider::driver::length_limits::PROVIDER_BINDING_ID_MAX_LEN;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::branded_text;

branded_text! {
    /// The id of a runtime binding, one live session's leg on its provider: minted by the
    /// daemon's store, or by the driver for a leg it relaunched. Opaque to every client.
    pub struct RuntimeBindingId(1..=PROVIDER_BINDING_ID_MAX_LEN);
}

/// The TypeScript module of the runtime binding id.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/runtime-binding",
    doc: "The id of a runtime binding, one live session's leg on its provider.",
    definitions: &[Definition::read::<RuntimeBindingId>().checked()],
    constants: &[],
    method_tables: &[],
};
