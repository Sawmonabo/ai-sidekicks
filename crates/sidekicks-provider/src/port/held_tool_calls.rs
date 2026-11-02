//! How a driver reads the tool calls a session still holds in the background from its log, so a
//! resumed or closed session and the start after a restart know which calls to follow or settle.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::event::declared_variants::ToolCallEndCause;
use sidekicks_contracts::event::envelope::EventOccurredAt;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

/// The most held calls one session's read answers.
pub const HELD_TOOL_CALLS_READ_MAX: usize = 1024;

/// A tool call its provider moved to the background, as the session's log holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldToolCall {
    /// The run the call belongs to.
    pub run_id: RunId,
    /// The provider's id of the call.
    pub tool_call_id: ToolCallId,
    /// The tool's name.
    pub tool_name: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// The provider's id of the background task the call became.
    pub task_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// Whether the task outlives a restart of the background service.
    pub survives_restart: bool,
    /// When the call's opening was stored, for its duration; `None` when no opening reads.
    pub invoked_at: Option<EventOccurredAt>,
    /// Why the daemon settled the call with no result; `None` while the call is open.
    pub end_cause: Option<ToolCallEndCause>,
}

/// The session logs' held calls, registered through a `PortRegistration`.
pub trait HeldToolCallReads: Send + Sync {
    /// `session_id`'s held calls, newest first and at most [`HELD_TOOL_CALLS_READ_MAX`]: each
    /// call moved to the background with no close after it, and each whose last close ended it
    /// with no result and names why. Fails when the log cannot be read.
    fn read_held_tool_calls(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Vec<HeldToolCall>, Box<dyn Error + Send + Sync>>>;
}
