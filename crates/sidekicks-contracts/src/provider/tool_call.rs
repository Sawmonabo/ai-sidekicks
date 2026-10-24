//! The id a provider gives one tool call, which its activity rows, approvals and child runs share.

use crate::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::branded_free_form_text;

branded_free_form_text! {
    /// A provider's id of one tool call.
    pub struct ToolCallId(PROVIDER_WIRE_HANDLE_MAX_LEN);
}

/// The TypeScript module of a provider's tool call id.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/tool-call",
    doc: "The id a provider gives one tool call, which its activity rows, approvals and child \
          runs share.",
    definitions: &[Definition::read::<ToolCallId>()],
    constants: &[],
    method_tables: &[],
};
