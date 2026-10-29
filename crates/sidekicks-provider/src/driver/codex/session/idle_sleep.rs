//! A Codex session under the daemon's idle sleep: never slept. Its service is shared by every
//! session on the account and holds no process of the session's own, so a sleep would free
//! nothing; the driver reports no hold and answers every sleep and wake as awake.

use sidekicks_contracts::session::id::SessionId;

use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::contract::error::DriverError;
use crate::driver::idle_sleep::{IdleSleepHolds, SessionSleepState};

impl CodexDriver {
    /// The holds Codex keeps on `_session_id`: none, since its sessions are never slept.
    #[expect(
        clippy::unused_async,
        reason = "the driver interface awaits every idle-sleep answer"
    )]
    pub(crate) async fn idle_sleep_holds(
        &self,
        _session_id: SessionId,
    ) -> Result<IdleSleepHolds, DriverError> {
        Ok(IdleSleepHolds::default())
    }

    /// Leaves `_session_id` as it is and answers it awake: a Codex session is never slept.
    #[expect(
        clippy::unused_async,
        reason = "the driver interface awaits every idle-sleep answer"
    )]
    pub(crate) async fn sleep_session(
        &self,
        _session_id: SessionId,
    ) -> Result<SessionSleepState, DriverError> {
        Ok(SessionSleepState::Awake)
    }

    /// Answers `_session_id` awake, which a Codex session always is.
    #[expect(
        clippy::unused_async,
        reason = "the driver interface awaits every idle-sleep answer"
    )]
    pub(crate) async fn wake_session(
        &self,
        _session_id: SessionId,
    ) -> Result<SessionSleepState, DriverError> {
        Ok(SessionSleepState::Awake)
    }
}
