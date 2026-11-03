//! The caller a provider's hook starts: the daemon's own program, run by a hook command from the
//! shell of a provider service the daemon holds a connection to. Such a caller descends from that
//! service, which the agent-descendant check refuses, so it is told apart by its whole chain, each
//! link pinned.

use std::io;

use sidekicks_platforms::{
    ParentProcess, PinnedProcess, RunningProgramPath, read_running_program_path,
};

use crate::caller_process::contract::CallerProcessReader;
use crate::caller_process::provider_services::ProviderServiceProcesses;

/// Whether `caller` runs the daemon's own program at its install path, started by a provider's
/// hook: its parent is one process running neither the daemon's program (as the command wrapper
/// does) nor the service's own program (as a child the service runs its commands through does),
/// and that parent's parent is a provider service `provider_services` holds. A link that ended, a
/// program replaced since the daemon started, or any other chain answers no. Fails when the system
/// refuses a read.
pub(crate) async fn is_provider_hook_caller(
    reader: &dyn CallerProcessReader,
    provider_services: &ProviderServiceProcesses,
    caller: PinnedProcess,
) -> io::Result<bool> {
    if !provider_services.is_holding_any() {
        return Ok(false);
    }
    let ParentProcess::Pinned(parent) = reader.read_parent_process(caller.clone()).await? else {
        return Ok(false);
    };
    let ParentProcess::Pinned(service) = reader.read_parent_process(parent.clone()).await? else {
        return Ok(false);
    };
    if !provider_services.has(service.id()) {
        return Ok(false);
    }
    // The read resolves the program's links on disk, so it runs on the blocking pool.
    let daemon_program = tokio::task::spawn_blocking(read_running_program_path)
        .await
        .map_err(io::Error::other)??;
    let RunningProgramPath::OnDisk(daemon_program) = daemon_program else {
        return Ok(false);
    };
    if reader.read_program_path(caller).await?.as_ref() != Some(&daemon_program) {
        return Ok(false);
    }
    let Some(parent_program) = reader.read_program_path(parent).await? else {
        return Ok(false);
    };
    let Some(service_program) = reader.read_program_path(service).await? else {
        return Ok(false);
    };
    Ok(parent_program != daemon_program && parent_program != service_program)
}
