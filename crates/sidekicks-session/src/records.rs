//! The daemon's own session records: a stored event row as its columns hold it, and the directory
//! row the sessions list and the session read answer from, which the wire's `SessionRecord` does
//! not carry whole (the owner the bootstrap event names among them).

use serde_json::{Map, Value};
use sidekicks_contracts::agent::definition::AgentDefinitionId;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::session::directory::SessionActivity;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{SessionShape, SessionState};

/// One `session_events` row with its columns as stored, the content column left out. `sequence`,
/// not `monotonic_ns`, is the order key.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StoredEvent {
    /// The event's id.
    pub(crate) id: String,
    /// The session the event belongs to.
    pub(crate) session_id: String,
    /// The event's place in its session's log.
    pub(crate) sequence: i64,
    /// When it occurred, RFC 3339 UTC to the millisecond.
    pub(crate) occurred_at: String,
    /// Nanoseconds since the daemon's start when it was appended.
    pub(crate) monotonic_ns: i64,
    /// The event's category.
    pub(crate) category: String,
    /// The event's type.
    pub(crate) event_type: String,
    /// Who acted, `None` for a system event.
    pub(crate) actor: Option<String>,
    /// The payload's members.
    pub(crate) payload: Map<String, Value>,
    /// The id that ties this event to others of one operation.
    pub(crate) correlation_id: Option<String>,
    /// The id of what caused this event.
    pub(crate) causation_id: Option<String>,
    /// The producer's `"MAJOR.MINOR"` envelope version.
    pub(crate) version: String,
}

/// The event-derived columns of a session's `sessions` row, exactly as a rebuild from the log
/// produces them. Times are RFC 3339 UTC with milliseconds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionDirectoryRow {
    /// The session.
    pub(crate) session_id: SessionId,
    /// What the session is bound to.
    pub(crate) shape: SessionShape,
    /// Where it is in its lifecycle.
    pub(crate) state: SessionState,
    /// Its name, `None` while it is unnamed.
    pub(crate) name: Option<String>,
    /// The opening of the first user message, `None` before one.
    pub(crate) first_message_preview: Option<String>,
    /// The branch it works on.
    pub(crate) branch: Option<String>,
    /// When it was pinned, `None` while it is not; pinned sessions sort by it.
    pub(crate) pinned_at: Option<String>,
    /// When it was muted, `None` while it is not.
    pub(crate) muted_at: Option<String>,
    /// The agent definition a scratch session tries.
    pub(crate) scratch_for_definition_id: Option<AgentDefinitionId>,
    /// The session it was started from.
    pub(crate) parent_session_id: Option<SessionId>,
    /// Where it runs, written at creation and never changed; `None` on macOS and Linux.
    pub(crate) place: Option<Place>,
    /// How its most recent run to end its working time left it: `done`, `failed` or `idle`, the
    /// three activities a run's end can leave.
    pub(crate) last_run_outcome: SessionActivity,
    /// When it was created.
    pub(crate) created_at: String,
    /// When its row last changed.
    pub(crate) updated_at: String,
    /// When it was last active.
    pub(crate) last_activity_at: String,
}

/// The projector's view of one session: its directory row, the last sequence folded into it and
/// its owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DaemonSessionRecord {
    /// The session's directory row.
    pub(crate) directory_row: SessionDirectoryRow,
    /// The last sequence the row folds in.
    pub(crate) as_of_sequence: i64,
    /// The session's owner, read off the `session.created` envelope's `actor`; `None` when a
    /// system-emitted bootstrap named nobody.
    pub(crate) owner_actor: Option<String>,
}
