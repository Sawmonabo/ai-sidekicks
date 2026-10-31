//! Where a driver reports what the working line reads about a run's current turn: the tokens
//! received so far and the agent's own task list, each the latest reading, folded from frames the
//! provider already sends. A reading made before the publisher is registered is dropped.

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::{TurnTasksUpdate, TurnUsageUpdate};

/// The turn readings' intake, registered through a `PortRegistration`. It keeps only the latest
/// reading of each run and never blocks or fails back into the provider's stream.
pub trait TurnReadingPublisher: Send + Sync {
    /// The tokens `update`'s turn has received so far, cumulative within the turn.
    fn publish_turn_usage(&self, session_id: SessionId, update: TurnUsageUpdate);

    /// `update`'s turn's whole task list, sent whole on every change; an empty list once the turn
    /// is interrupted.
    fn publish_turn_tasks(&self, session_id: SessionId, update: TurnTasksUpdate);
}
