//! The projections the session log feeds: a set of rows each event writes in its own write, and
//! the fold a rebuild runs to write them again from the log, with why an event cannot be folded.

use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::{SessionEvent, SessionEventReadError};
use sidekicks_contracts::session::id::SessionId;

use crate::database::statement::WriteStatement;
use crate::database::writer::WriteError;
use crate::events::session::read::MalformedStoredEventError;

/// A set of rows derived from the session log, as a rebuild replaces them.
pub trait SessionProjection: Send + Sync {
    /// The projection's name in a rebuild's response.
    fn name(&self) -> &'static str;

    /// The event types its fold reads; a rebuild reads only types some projection names.
    fn event_types(&self) -> &[SessionEventType];

    /// The statements that delete the session's rows.
    fn clear_statements(&self, session_id: &SessionId) -> Vec<WriteStatement>;

    /// The statements that settle the session's rows once the fold has read its last event, run
    /// in the last page's write; none for a projection whose fold leaves nothing to settle.
    fn closing_statements(&self, _session_id: &SessionId) -> Vec<WriteStatement> {
        Vec::new()
    }

    /// A fresh fold for one rebuild of `session_id`.
    fn fold(&self, session_id: &SessionId) -> Box<dyn SessionProjectionFold>;
}

/// One projection's fold over one session's events, applied in sequence order.
pub trait SessionProjectionFold: Send {
    /// Pushes onto `statements` the statements that apply the event, read as its `envelope` and its
    /// typed `event`, to the rows. Fails with [`ProjectionContradiction`] when the event
    /// contradicts what the fold already applied.
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction>;
}

/// A fold's refusal of an event that contradicts what it already applied, in words a log line
/// carries.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ProjectionContradiction(pub String);

/// Why an event cannot be folded into rows the daemon can trust.
#[derive(Debug, thiserror::Error)]
pub enum ProjectionFailureCause {
    /// The stored row is not a well-formed event envelope.
    #[error("the stored event does not read as an event")]
    Unreadable(#[source] MalformedStoredEventError),
    /// The envelope does not read as its registered variant.
    #[error("the event does not read as its registered variant")]
    NotItsVariant(#[source] SessionEventReadError),
    /// A fold found the event contradicts what it already applied.
    #[error("the event contradicts the rows its log built before it")]
    Contradicted(#[source] ProjectionContradiction),
    /// A guard or a constraint refused the event's rows: a log the live rules would never have
    /// written.
    #[error("the event's rows break a rule the live writes keep")]
    RowsRefused(#[source] WriteError),
}

/// A session's events could not be folded into rows the daemon can trust: `sequence` is the first
/// event the fold could not take.
#[derive(Debug, thiserror::Error)]
#[error("event {sequence} of session {session_id} cannot be folded into rows the service trusts")]
pub struct ProjectionFailure {
    /// The session.
    pub session_id: SessionId,
    /// The event's sequence.
    pub sequence: i64,
    /// Why it could not be folded.
    #[source]
    pub cause: ProjectionFailureCause,
}
