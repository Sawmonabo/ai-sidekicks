//! The MCP steps of the daemon's stop, each run before the drivers: the binding edits' settle
//! pass, then the server sign-ins.

use std::time::Duration;

use sidekicks_contracts::daemon::service_status::DaemonStopStep;

use crate::daemon::process::DaemonProcess;
use crate::daemon::process::stop::{DaemonStopFailure, wait_within};

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

/// Before the drivers, whose services a provider's flow runs on: closes the MCP server sign-ins
/// within `bound`, every attempt ending and its listener closing, every provider's flow and
/// revocation canceled, with no event.
pub(super) async fn stop_mcp_sign_ins(
    process: &mut DaemonProcess,
    bound: Duration,
) -> Option<DaemonStopFailure> {
    let sign_ins = process.mcp_sign_ins.take()?;
    process
        .stop_record
        .write_step(DaemonStopStep::McpSignIns)
        .await;
    wait_within(bound, "MCP server sign-ins", sign_ins.close())
        .await
        .err()
}
