//! The driver every provider implements, its registry and the shared turn machinery.

pub(crate) mod attachments;
pub(crate) mod callback_tool;
pub(crate) mod contract;
pub(crate) mod diagnostics;
pub(crate) mod mcp_server_status;
pub(crate) mod plan_record;
mod providers;
pub(crate) mod question_answers;
pub(crate) mod reorder_buffer;
pub(crate) mod rewind;
pub(crate) mod run_control;
pub(crate) mod session_control;
pub(crate) mod streamed_text;
pub(crate) mod unified_diff;
