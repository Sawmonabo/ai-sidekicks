//! The daemon's own session records: the directory row the sessions list and the session read
//! answer from, which the wire's `SessionRecord` does not carry whole (the owner the bootstrap
//! event names among them).

use sidekicks_contracts::agent::definition::AgentDefinitionId;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::session::directory::SessionActivity;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{SessionShape, SessionState};

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
