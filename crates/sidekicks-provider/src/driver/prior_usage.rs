//! The usage a resumed conversation already emitted, which its metering is based on, read the same
//! way by every driver.

use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::port::usage_sink::UsageSink;
use crate::usage_delta_accountant::UsageAxisCounts;

/// The daemon's own emitted sum for `thread_id`, a session's conversation or a helper's, on
/// `session_id` of `provider`, through `usage`: the base a resumed conversation or a copy of it
/// meters from. An unregistered usage record or a failed read is reported as a diagnostic and
/// answers zero, so the first reading counts what came before again.
pub(crate) async fn read_prior_emitted(
    usage: &PortRegistration<Arc<dyn UsageSink>>,
    provider: ProviderId,
    session_id: SessionId,
    thread_id: &str,
) -> UsageAxisCounts {
    let failure = match usage.require_port() {
        Ok(sink) => match sink
            .read_prior_emitted(session_id, thread_id.to_owned())
            .await
        {
            Ok(counts) => return counts,
            Err(error) => describe_error(error.as_ref()),
        },
        Err(error) => describe_error(&error),
    };
    let mut details = Map::new();
    details.insert("sessionId".to_owned(), Value::from(session_id.to_string()));
    details.insert("threadId".to_owned(), Value::from(thread_id));
    details.insert("failure".to_owned(), Value::from(failure));
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider,
        provider_account_id: None,
        kind: DriverDiagnosticKind::UsageResumeBaseUnavailable,
        raw_wire_type: None,
        disposition_reason: "the daemon's own emitted usage sum could not be read, so the resumed \
                             conversation meters from zero and its first reading counts what \
                             came before again"
            .to_owned(),
        details,
    });
    UsageAxisCounts::default()
}
