//! The governance mutations of a provider's MCP config: each mutation's two-phase receipt, the
//! settle of an intent whose provider leg may or may not have landed, and the checks a mutation
//! passes before anything is written.

pub(crate) mod preflight;
pub(crate) mod receipt_key;
pub(crate) mod receipts;
pub(crate) mod reconciler;
pub(crate) mod saved_answer;
