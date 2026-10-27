//! `daemon.appDiagnostic.record`: what the desktop app records about itself becomes one line of
//! the service log, so it is kept, and expires, with the service's own lines.

use futures::FutureExt as _;
use sidekicks_contracts::daemon::app_diagnostic::{AppDiagnosticRecord, DaemonAppDiagnosticRecord};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};

/// Registers `daemon.appDiagnostic.record`, writing each record to the service log as one line of
/// JSON. Fails the start when the method is already registered.
pub(crate) fn register_app_diagnostic_methods(
    registry: &mut MethodRegistryBuilder,
) -> Result<(), RegistrationError> {
    registry.register::<DaemonAppDiagnosticRecord, _>(
        |record: AppDiagnosticRecord, _context: HandlerContext| {
            async move {
                let line = serde_json::to_string(&record)
                    .map_err(|error| HandlerError::Internal(Box::new(error)))?;
                tracing::info!(record = %line, "App diagnostic");
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )
}
