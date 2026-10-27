//! The output-speed state a provider declares, read into the contract's held shape the same way on
//! every driver (bounded by the contract and never by a vocabulary, absent when the bounds refuse),
//! and the per-run report of the state each run runs at.

use std::sync::Arc;

use serde_json::{Value, json};
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};

/// One declaration as the provider made it: the state as the wire sent it, which may be any JSON
/// value, and its reason, `None` if it gave none.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DeclaredOutputSpeed {
    /// The provider that declared it.
    pub(crate) provider: ProviderId,
    /// The session whose binding declared it.
    pub(crate) session_id: SessionId,
    /// The declared level, unread.
    pub(crate) declared: Value,
    /// The provider's explanation, if it gave one.
    pub(crate) reason: Option<String>,
}

/// The held state for one declaration, its level carried verbatim so a level no vocabulary lists
/// is kept rather than coerced. A declaration the contract's bounds refuse reads as `None`, with an
/// `output_speed_state_rejected` diagnostic naming the failing field and lengths, never the values.
pub(crate) fn read_declared_output_speed(
    declaration: DeclaredOutputSpeed,
) -> Option<ProviderOutputSpeedState> {
    let DeclaredOutputSpeed {
        provider,
        session_id,
        declared,
        reason,
    } = declaration;
    // Lengths count code points, the unit the caps count.
    let lengths = RejectedLengths {
        declared: declared.as_str().map(|text| text.chars().count()),
        reason: reason.as_ref().map(|text| text.chars().count()),
    };
    let declared = match declared {
        Value::String(text) => FreeFormText::new(text).ok(),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_) => {
            None
        }
    };
    let Some(declared) = declared else {
        report_rejected_state(provider, &session_id, "declared", lengths);
        return None;
    };
    let Ok(reason) = reason.map(FreeFormText::new).transpose() else {
        report_rejected_state(provider, &session_id, "reason", lengths);
        return None;
    };
    Some(ProviderOutputSpeedState { declared, reason })
}

/// The code-point lengths a rejected declaration reports in place of its values.
#[derive(Clone, Copy)]
struct RejectedLengths {
    declared: Option<usize>,
    reason: Option<usize>,
}

fn report_rejected_state(
    provider: ProviderId,
    session_id: &SessionId,
    rejected_field: &str,
    lengths: RejectedLengths,
) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider,
        provider_account_id: None,
        kind: DriverDiagnosticKind::OutputSpeedStateRejected,
        raw_wire_type: None,
        disposition_reason: "the provider declared an output-speed state the contract's own \
                             bounds refuse; this binding reads as having no observation until it \
                             declares another"
            .to_owned(),
        details: [
            ("sessionId", json!(session_id)),
            ("rejectedField", json!(rejected_field)),
            ("declaredLength", json!(lengths.declared)),
            ("reasonLength", json!(lengths.reason)),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect(),
    });
}

/// Receives, once per run, the declared output-speed state that run runs at, read once the run's
/// carrier has settled; the run engine compares it with the level the run carried.
pub(crate) type RunOutputSpeedSettledListener =
    Arc<dyn Fn(SessionId, RunId, ProviderOutputSpeedState) + Send + Sync>;
