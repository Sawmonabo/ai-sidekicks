//! `daemon.crashReport.list`: the crash reports this machine keeps, newest first, read from the
//! crash reports folder alone; the dumps they were built from never leave the machine.

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::daemon::status::{DaemonCrashReportList, DaemonCrashReportListResponse};
use sidekicks_contracts::method_descriptor::EmptyPayload;

use crate::daemon::crash::reports::read_crash_reports;
use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};

/// Registers `daemon.crashReport.list` over the data folder `data_folder`. Fails the start when
/// the method is already registered.
#[expect(
    dead_code,
    reason = "the daemon's start registers the crash report list"
)]
pub(crate) fn register_crash_methods(
    registry: &mut MethodRegistryBuilder,
    data_folder: PathBuf,
) -> Result<(), RegistrationError> {
    let data_folder = Arc::new(data_folder);
    registry.register::<DaemonCrashReportList, _>(
        move |_: EmptyPayload, _context: HandlerContext| {
            let data_folder = Arc::clone(&data_folder);
            async move {
                let reports = tokio::task::spawn_blocking(move || read_crash_reports(&data_folder))
                    .await
                    .map_err(|failure| HandlerError::Internal(Box::new(failure)))?
                    .map_err(|failure| HandlerError::Internal(Box::new(failure)))?;
                Ok(DaemonCrashReportListResponse { reports })
            }
            .boxed()
        },
    )
}
