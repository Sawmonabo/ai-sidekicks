//! Where a driver reports the status line under a running tool call: the provider's own words for
//! its progress, one line per call, kept live and never stored. A status published before the
//! publisher is registered is dropped.

use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::tool_call_status::TOOL_CALL_STATUS_MAX_LEN;
use sidekicks_contracts::wire::text::FreeFormText;

/// The tool calls' status lines' intake, registered through a `PortRegistration`. It keeps only
/// each call's newest line and never blocks or fails back into the provider's stream.
pub trait ToolCallStatusPublisher: Send + Sync {
    /// `tool_call_id`'s newest status line, in place of the one held.
    fn publish_tool_call_status(
        &self,
        session_id: SessionId,
        tool_call_id: ToolCallId,
        status: FreeFormText<TOOL_CALL_STATUS_MAX_LEN>,
    );

    /// Clears `tool_call_id`'s status line, for a call that closed; a call with no status changes
    /// nothing.
    fn clear_tool_call_status(&self, session_id: SessionId, tool_call_id: ToolCallId);
}
