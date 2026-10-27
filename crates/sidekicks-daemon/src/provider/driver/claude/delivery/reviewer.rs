//! The blocks Claude Code's own reviewer makes at Reviewed, captured once per tool call, and the
//! sentence the person's `Allow once` sends. A block reaches the daemon up to three ways: the
//! `PermissionDenied` hook, which carries the classifier's block with its input, the
//! `permission_denied` frame's words, and the turn result's `permission_denials`. The first report
//! of a call is the one handed to the approval pipeline, on the run whose rows the blocked call
//! carries; a later one is dropped.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::claude::DESCRIPTOR;
use crate::claude::delivery::system::read_provider_words;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::port::registration::PortRegistration;
use crate::port::reviewer_denial::{ProviderReviewerDenial, ReviewerDenialPort};
use crate::record_readers::read_non_empty_string;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;

/// The action as Claude Code's `PermissionDenied` hook received it, kept with the block so an
/// `Allow once` still names it after a restart.
#[derive(Serialize)]
#[expect(
    clippy::struct_field_names,
    reason = "the members carry the names Claude Code's hook sends"
)]
struct ClaudeProviderDenial<'input> {
    tool_name: &'input str,
    tool_input: &'input Value,
    tool_use_id: &'input str,
}

/// One block report off the wire, before it is captured.
#[derive(Debug)]
pub(crate) struct ClaudeBlockReport {
    /// The blocked tool call.
    pub(crate) tool_call_id: String,
    /// The reviewer's words, made safe to show; `None` where Claude Code sent none.
    pub(crate) reason: Option<String>,
    /// Whether the block carries the classifier's verdict, which an `Allow once` overrides.
    pub(crate) is_overridable: bool,
    /// The action as Claude Code recorded it.
    pub(crate) provider_denial: Box<RawValue>,
}

/// The block a `PermissionDenied` hook callback's `input` reports: the classifier's own, with the
/// call's exact input and reason; `None` for a callback that names no call.
pub(crate) fn read_claude_hook_denial(input: &Map<String, Value>) -> Option<ClaudeBlockReport> {
    let tool_name = read_non_empty_string(input, "tool_name")?;
    let tool_call_id = read_non_empty_string(input, "tool_use_id")?;
    Some(ClaudeBlockReport {
        tool_call_id: tool_call_id.to_owned(),
        reason: read_reason(read_non_empty_string(input, "reason")),
        is_overridable: true,
        provider_denial: compose_provider_denial(
            tool_name,
            input.get("tool_input").unwrap_or(&Value::Null),
            tool_call_id,
        ),
    })
}

/// The blocks a turn's `result` lists in `permission_denials`; none carries a classifier verdict,
/// so none is overridable. `failed_call_words` holds the words Claude Code sent the model for
/// each call, which give a block its reason.
fn read_claude_result_denials(
    frame: &Value,
    failed_call_words: &HashMap<String, String>,
) -> Vec<ClaudeBlockReport> {
    let Some(denials) = frame.get("permission_denials").and_then(Value::as_array) else {
        return Vec::new();
    };
    denials
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|denial| {
            let tool_name = read_non_empty_string(denial, "tool_name")?;
            let tool_call_id = read_non_empty_string(denial, "tool_use_id")?;
            Some(ClaudeBlockReport {
                tool_call_id: tool_call_id.to_owned(),
                reason: read_reason(failed_call_words.get(tool_call_id).map(String::as_str)),
                is_overridable: false,
                provider_denial: compose_provider_denial(
                    tool_name,
                    denial.get("tool_input").unwrap_or(&Value::Null),
                    tool_call_id,
                ),
            })
        })
        .collect()
}

/// The sentence an `Allow once` sends Claude Code, the one its own Recently denied list sends,
/// naming the action as `Tool(<command, path or input>)`; `None` for a denial the daemon never
/// kept in this shape.
pub(crate) fn compose_claude_override_sentence(provider_denial: &RawValue) -> Option<String> {
    let denial: Map<String, Value> = serde_json::from_str(provider_denial.get()).ok()?;
    let tool_name = read_non_empty_string(&denial, "tool_name")?;
    let target = denial
        .get("tool_input")
        .and_then(Value::as_object)
        .map(|input| {
            ["command", "file_path", "notebook_path"]
                .into_iter()
                .find_map(|member| read_non_empty_string(input, member))
                .map_or_else(|| Value::Object(input.clone()).to_string(), str::to_owned)
        });
    let action = match target {
        Some(target) => format!("{tool_name}({target})"),
        None => tool_name.to_owned(),
    };
    Some(format!(
        "Permission granted for: {action}. You may now retry this command if you would like."
    ))
}

// The reviewer's words, made safe to show; none where Claude Code sent none, so the row reads
// `Blocked` alone.
fn read_reason(reason: Option<&str>) -> Option<String> {
    reason
        .and_then(read_provider_words)
        .map(FreeFormText::into_string)
}

fn compose_provider_denial(
    tool_name: &str,
    tool_input: &Value,
    tool_use_id: &str,
) -> Box<RawValue> {
    serde_json::value::to_raw_value(&ClaudeProviderDenial {
        tool_name,
        tool_input,
        tool_use_id,
    })
    .expect("a denial of strings and JSON always serializes")
}

/// Captures each block once per session and tool call and hands it to the approval pipeline.
pub(crate) struct ClaudeReviewerCapture {
    denials: Arc<PortRegistration<Arc<dyn ReviewerDenialPort>>>,
    captured_by_session: Mutex<HashMap<SessionId, HashSet<String>>>,
}

impl ClaudeReviewerCapture {
    /// A capture handing blocks to `denials` once it is registered.
    pub(crate) fn new(denials: Arc<PortRegistration<Arc<dyn ReviewerDenialPort>>>) -> Self {
        Self {
            denials,
            captured_by_session: Mutex::new(HashMap::new()),
        }
    }

    /// Hands a block of `run_id` to the approval pipeline unless one was captured for its call.
    /// With no pipeline registered the block is still marked captured, since nothing could answer
    /// it later; a failed hand-off is recorded.
    pub(crate) fn capture(&self, session_id: SessionId, run_id: RunId, report: ClaudeBlockReport) {
        if !self
            .lock()
            .entry(session_id)
            .or_default()
            .insert(report.tool_call_id.clone())
        {
            return;
        }
        let Some(port) = self.denials.port().cloned() else {
            return;
        };
        let denial = ProviderReviewerDenial {
            session_id,
            run_id,
            tool_call_id: Some(report.tool_call_id),
            reason: report.reason,
            is_overridable: report.is_overridable,
            provider_denial: report.provider_denial,
        };
        tokio::spawn(async move {
            if let Err(error) = port.take_denial(denial).await {
                report_hand_off_failure(session_id, error.as_ref());
            }
        });
    }

    /// Captures the blocks a turn's `result` lists that no earlier report named, on `run_id`.
    pub(crate) fn capture_result_denials(
        &self,
        session_id: SessionId,
        run_id: RunId,
        frame: &Value,
        failed_call_words: &HashMap<String, String>,
    ) {
        for report in read_claude_result_denials(frame, failed_call_words) {
            self.capture(session_id, run_id, report);
        }
    }

    /// Forgets a closed session's captured calls.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        self.lock().remove(&session_id);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, HashSet<String>>> {
        lock(&self.captured_by_session)
    }
}

fn report_hand_off_failure(session_id: SessionId, error: &(dyn std::error::Error + 'static)) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: None,
        kind: DriverDiagnosticKind::DeliveryDispatchFailed,
        raw_wire_type: None,
        disposition_reason: describe_error(error),
        details: Map::from_iter([
            ("deliveryKind".to_owned(), Value::from("reviewerDenial")),
            ("sessionId".to_owned(), Value::from(session_id.to_string())),
        ]),
    });
}
