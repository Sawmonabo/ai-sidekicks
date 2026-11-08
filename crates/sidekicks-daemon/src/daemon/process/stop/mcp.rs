//! The MCP steps of the daemon's stop, each run before the drivers.

use std::time::Duration;

use sidekicks_contracts::daemon::service_status::DaemonStopStep;

use crate::daemon::process::DaemonProcess;
use crate::daemon::process::stop::DaemonStopFailure;

/// Before the drivers, whose config reads the pass observes through: waits within `bound` for the
/// MCP binding edits' settle pass, which is dropped past it and runs again at the next start.
pub(super) async fn stop_mcp_settle(
    process: &mut DaemonProcess,
    bound: Duration,
) -> Option<DaemonStopFailure> {
    let mutations = process.mcp_mutations.take()?;
    process
        .stop_record
        .write_step(DaemonStopStep::McpSettle)
        .await;
    tokio::time::timeout(bound, mutations.stop())
        .await
        .is_err()
        .then_some(DaemonStopFailure::StartTaskRunning(
            "MCP binding edits' settle pass",
        ))
}
