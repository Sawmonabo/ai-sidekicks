//! What a Codex service tells the session's recovery about the conversations on it: its process
//! ended, it is back and they need resuming, it stays down, or it asks for a planned restart; and
//! what it tells the account's usage: its rate-limit readings changed.

use std::sync::Arc;

use sidekicks_contracts::run::control::ProcessExit;

use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;

/// Why a service's conversations need resuming.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexServiceRecoveryCause {
    /// The service's process ended and a new one runs: every running turn on it ended.
    Crash,
    /// The connection came back to the same process: its turns ran on.
    Reconnect,
    /// The person restarted a service the crash loop left down: every running turn on it ended,
    /// and each session it brings back is told.
    PersonRestart,
}

/// What one service tells the session's recovery, called from the service's runner, never under
/// its locks.
pub(crate) trait CodexServiceEvents: Send + Sync {
    /// The process ended on its own; every running turn on it ended with it. `exit` is how it
    /// ended, `None` for a lasting service a former daemon started, whose end no wait reads.
    fn process_exited(&self, service: &Arc<CodexService>, exit: Option<&ProcessExit>);

    /// The service runs again, or its connection does; every conversation it held needs resuming.
    fn recovered(&self, service: &Arc<CodexService>, cause: CodexServiceRecoveryCause);

    /// The crash window filled, so the service stays down until the person restarts it;
    /// `start_failure` is the failure of the restart that filled it, where a failed restart did.
    fn crash_loop(&self, service: &Arc<CodexService>, start_failure: Option<Arc<CodexError>>);

    /// The account's rate-limit readings changed on a push from the service.
    fn rate_limits_observed(&self, service: &Arc<CodexService>);

    /// The terminal service asks for a second service on the program as it is now, its
    /// conversations moved and the first stopped once no terminal session is inside it.
    fn planned_restart_requested(&self, service: &Arc<CodexService>);
}
