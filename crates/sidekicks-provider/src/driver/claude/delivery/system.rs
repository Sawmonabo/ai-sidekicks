//! What Claude Code's `system` frames say about a run, in the daemon's words: a model switch, the
//! refusal no other model took, a retried request, a warning, the coarse status, the worker's
//! shutdown reason and a helper's end; and the refusal an `assistant` message ends on. The frames
//! are untrusted, so each member is narrowed, and a frame that reads as nothing known reads as
//! `None`.

use serde_json::{Map, Value};
use sidekicks_contracts::event::usage::{
    AgentTurnReroutedPayload, ApiRetryErrorKind, ModelRerouteCause, ModelRerouteScope,
    UsageApiRequestRetriedPayload,
};
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::{
    PROVIDER_WIRE_HANDLE_MAX_LEN, PROVIDER_WIRE_TOKEN_MAX_LEN,
};
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::failure_cause::{RunFailureCause, RunRefusedOrigin};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::text_cut::cut_to_code_points;

use crate::driver::claude::DESCRIPTOR;
use crate::record_readers::{read_count, read_non_empty_string};
use crate::run::state_entry::{RunStateEntry, RunStateReport};

/// The `model_fallback` trigger that names a blocked model; any other names one unavailable.
const CLAUDE_MODEL_BLOCKED_TRIGGER: &str = "model_blocked";

/// Text as long as a provider's words may run.
pub(crate) type ClaudeProviderWords = FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>;

/// The provider's own words, cut to their cap; `None` for words that are blank or hold NUL.
pub(crate) fn read_provider_words(text: &str) -> Option<ClaudeProviderWords> {
    FreeFormText::new(cut_to_code_points(text, PROVIDER_FAILURE_DETAIL_MAX_LEN).to_owned()).ok()
}

// A member's words, cut to their cap.
fn read_words(frame: &Map<String, Value>, key: &str) -> Option<ClaudeProviderWords> {
    read_non_empty_string(frame, key).and_then(read_provider_words)
}

// A member as a bounded handle or label.
fn read_text<const MAX: usize>(frame: &Map<String, Value>, key: &str) -> Option<FreeFormText<MAX>> {
    read_non_empty_string(frame, key).and_then(|text| FreeFormText::new(text.to_owned()).ok())
}

/// The model switch one of Claude Code's three switch frames reports on `run_id`: a safety
/// fallback keeps its own scope (absent reads `session`), a failed primary holds for the turn and
/// a declined credits gate for the session.
pub(crate) fn read_claude_model_reroute(
    frame_kind: &str,
    frame: &Map<String, Value>,
    session_id: SessionId,
    run_id: RunId,
) -> Option<AgentTurnReroutedPayload> {
    let from_model = read_text(frame, "original_model")?;
    let to_model = read_text(frame, "fallback_model")?;
    let (scope, cause) = match frame_kind {
        "system/model_refusal_fallback" => (
            if frame.get("scope").and_then(Value::as_str) == Some("local") {
                ModelRerouteScope::Local
            } else {
                ModelRerouteScope::Session
            },
            ModelRerouteCause::Safety,
        ),
        "system/model_fallback" => (
            ModelRerouteScope::Turn,
            if frame.get("trigger").and_then(Value::as_str) == Some(CLAUDE_MODEL_BLOCKED_TRIGGER) {
                ModelRerouteCause::ModelBlocked
            } else {
                ModelRerouteCause::ModelUnavailable
            },
        ),
        "system/model_consent_fallback" => {
            (ModelRerouteScope::Session, ModelRerouteCause::OutOfCredits)
        }
        _ => return None,
    };
    let is_safety = cause == ModelRerouteCause::Safety;
    Some(AgentTurnReroutedPayload {
        session_id,
        run_id,
        agent_id: None,
        from_model,
        to_model,
        scope,
        sentence: read_words(frame, "content"),
        explanation: is_safety
            .then(|| read_words(frame, "api_refusal_explanation"))
            .flatten(),
        cause,
        safety_category: is_safety
            .then(|| read_text(frame, "api_refusal_category"))
            .flatten(),
        source_epoch: None,
        source_position: None,
    })
}

/// The refusal a `model_refusal_no_fallback` frame reports, as a failed run carries it.
pub(crate) fn read_claude_refusal_without_fallback(
    frame: &Map<String, Value>,
) -> Option<RunFailureCause> {
    Some(RunFailureCause::Refused {
        origin: RunRefusedOrigin::Provider,
        model: read_text(frame, "original_model")?,
        sentence: read_words(frame, "content"),
        explanation: read_words(frame, "api_refusal_explanation"),
        safety_category: read_text(frame, "api_refusal_category"),
    })
}

/// The refusal an `assistant` frame's message ends on (`stop_reason` `refusal`), with the model
/// that refused and its check's category and explanation; Claude Code sends it whether or not a
/// `model_refusal_no_fallback` frame follows.
pub(crate) fn read_claude_assistant_refusal(frame: &Map<String, Value>) -> Option<RunFailureCause> {
    let message = frame.get("message")?.as_object()?;
    if message.get("stop_reason").and_then(Value::as_str) != Some("refusal") {
        return None;
    }
    let model = read_text::<PROVIDER_WIRE_HANDLE_MAX_LEN>(message, "model")?;
    let empty = Map::new();
    let details = message
        .get("stop_details")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    Some(RunFailureCause::Refused {
        origin: RunRefusedOrigin::Provider,
        model,
        sentence: None,
        explanation: read_words(details, "explanation"),
        safety_category: read_text(details, "category"),
    })
}

/// The words of an `informational` frame Claude Code sent at level `warning`.
pub(crate) fn read_claude_warning(frame: &Map<String, Value>) -> Option<ClaudeProviderWords> {
    (frame.get("level").and_then(Value::as_str) == Some("warning"))
        .then(|| read_words(frame, "content"))
        .flatten()
}

/// The coarse status a `status` frame reports (`compacting`, `requesting`); its `null`, which
/// says a status is over, names none.
pub(crate) fn read_claude_provider_status(
    frame: &Map<String, Value>,
) -> Option<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>> {
    read_text(frame, "status")
}

/// The retry an `api_retry` frame announces on `run_id`: why, the wait before it in milliseconds
/// and which attempt it is. An `error` the vocabulary lacks, or none, reads as unknown.
pub(crate) fn read_claude_api_retry(
    frame: &Map<String, Value>,
    session_id: SessionId,
    run_id: RunId,
) -> UsageApiRequestRetriedPayload {
    let error_kind = match frame.get("error").and_then(Value::as_str) {
        Some("authentication_failed") => ApiRetryErrorKind::AuthenticationFailed,
        Some("oauth_org_not_allowed") => ApiRetryErrorKind::OauthOrgNotAllowed,
        Some("billing_error") => ApiRetryErrorKind::BillingError,
        Some("rate_limit") => ApiRetryErrorKind::RateLimit,
        Some("overloaded") => ApiRetryErrorKind::Overloaded,
        Some("invalid_request") => ApiRetryErrorKind::InvalidRequest,
        Some("model_not_found") => ApiRetryErrorKind::ModelNotFound,
        Some("server_error") => ApiRetryErrorKind::ServerError,
        Some("max_output_tokens") => ApiRetryErrorKind::MaxOutputTokens,
        Some("account_on_hold") => ApiRetryErrorKind::AccountOnHold,
        Some("verification_required") => ApiRetryErrorKind::VerificationRequired,
        Some("cloud_credential_error") => ApiRetryErrorKind::CloudCredentialError,
        Some(_) | None => ApiRetryErrorKind::Unknown,
    };
    UsageApiRequestRetriedPayload {
        session_id,
        run_id: Some(run_id),
        provider: DESCRIPTOR.provider_id(),
        error_kind,
        retry_delay_ms: read_count(frame, "retry_delay_ms").and_then(SafeInt::new),
        attempt: read_count(frame, "attempt").and_then(SafeInt::new),
        source_epoch: None,
        source_position: None,
    }
}

/// The reason a `worker_shutting_down` frame gives, where it gives one.
pub(crate) fn read_claude_worker_shutdown_reason(
    frame: &Map<String, Value>,
) -> Option<ClaudeProviderWords> {
    read_words(frame, "reason")
}

/// The move a helper's child run makes on its `task_notification`: `completed` and `failed`
/// end it as such, `stopped` stops it; any other status reads as `None`.
pub(crate) fn read_claude_helper_end(
    frame: &Map<String, Value>,
    child_run_id: RunId,
) -> Option<RunStateReport> {
    let entry = match frame.get("status").and_then(Value::as_str)? {
        "completed" => RunStateEntry::Completed {
            intended_close: None,
        },
        "failed" => RunStateEntry::Failed {
            intended_close: None,
            failure_cause: None,
            provider_failure_detail: read_words(frame, "summary"),
            process_exit: None,
        },
        "stopped" => RunStateEntry::Stopped {
            intended_close: None,
            trigger: None,
        },
        _ => return None,
    };
    let is_failed = matches!(entry, RunStateEntry::Failed { .. });
    Some(RunStateReport {
        failure_category: is_failed.then_some(RunFailureCategory::ProviderFailure),
        ..RunStateReport::new(child_run_id, entry)
    })
}
