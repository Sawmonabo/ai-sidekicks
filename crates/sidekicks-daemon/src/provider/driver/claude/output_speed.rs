//! The Claude leg of the output-speed axis: the level a process is told with
//! `apply_flag_settings {fastMode}`, after every spawn and before a run that changes it. A level the
//! driver's table does not list runs at standard, and a refusal leaves the process on the level it
//! held; either way the declared state, not the request, says what the process runs at.

use serde_json::json;
use sidekicks_contracts::session::id::SessionId;

use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::session::errors::ClaudeSessionError;
use crate::provider::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::provider::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeFlagSettings,
};
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};

/// The level a carried `level` runs at: itself where the driver's table lists it, else standard.
pub(crate) fn resolve_claude_output_speed(level: &str) -> &'static str {
    DESCRIPTOR
        .output_speed_levels
        .and_then(|levels| levels.iter().copied().find(|listed| *listed == level))
        .unwrap_or(DESCRIPTOR.standard_output_speed)
}

/// Tells the process to run at `level` (see [`resolve_claude_output_speed`]) from its next run.
/// Answers the level the process now runs at, or `None` when Claude Code refused, which leaves it
/// on what it held and is recorded as a diagnostic. Fails when the request went unanswered or could
/// not be written.
#[expect(
    dead_code,
    reason = "the Claude driver's spawn and run start apply the output speed through it"
)]
pub(crate) async fn apply_claude_output_speed(
    channel: &dyn ClaudeProcessChannel,
    session_id: SessionId,
    level: &str,
) -> Result<Option<&'static str>, ClaudeSessionError> {
    let applied = resolve_claude_output_speed(level);
    let answer = channel
        .send_control_request(ClaudeControlRequest::ApplyFlagSettings {
            settings: ClaudeFlagSettings {
                fast_mode: Some(applied != DESCRIPTOR.standard_output_speed),
                ..ClaudeFlagSettings::default()
            },
        })
        .await;
    match answer {
        Ok(_) => Ok(Some(applied)),
        Err(ClaudeSessionError::ControlRequestRefused { .. }) => {
            emit_driver_diagnostic(&DriverDiagnosticRecord {
                provider: DESCRIPTOR.provider_id(),
                provider_account_id: None,
                kind: DriverDiagnosticKind::OutputSpeedApplyRefused,
                raw_wire_type: None,
                disposition_reason: "the provider refused the output-speed level; the process \
                                     keeps the level it held and the run's declared state \
                                     reports it"
                    .to_owned(),
                // The level is the driver's own word; the provider's error text is untrusted and
                // stays out.
                details: [
                    ("sessionId".to_owned(), json!(session_id)),
                    ("refusedLevel".to_owned(), json!(applied)),
                ]
                .into_iter()
                .collect(),
            });
            Ok(None)
        }
        Err(failure) => Err(failure),
    }
}
