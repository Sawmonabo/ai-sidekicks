//! Where the run engine reads the posture a session's open process runs at, for the runs its
//! provider starts inside that process.

use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::session::id::SessionId;

/// The posture each open session's process runs at now, its level moves included.
pub trait SessionPostureSource: Send + Sync {
    /// The posture the session's open process runs at; `None` when no process of it is open.
    fn opened_execution_posture(&self, session_id: &SessionId) -> Option<ExecutionPosture>;
}
