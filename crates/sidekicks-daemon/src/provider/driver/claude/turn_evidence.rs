//! What a Claude Code turn's settling `result` frame proves about how the turn ended.

use serde_json::Value;
use strum::VariantArray;

use crate::provider::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::provider::turn_evidence::{
    TurnEvidenceClass, TurnEvidenceClassification, UNRECOGNIZED_TURN_EVIDENCE,
    observed_turn_evidence,
};

// The members that move together on a real turn and are all zero on an intercepted one.
const CLAUDE_TURN_ACCOUNTING_MEMBERS: [&str; 3] =
    ["num_turns", "duration_api_ms", "total_cost_usd"];

/// Whether `value` is a number above zero; a parsed JSON number is always finite.
pub(crate) fn is_positive_finite_number(value: &Value) -> bool {
    value.as_f64().is_some_and(|number| number > 0.0)
}

/// Reads a settling `result` frame for typed evidence that a model turn happened. `num_turns`,
/// `duration_api_ms`, `total_cost_usd` and `modelUsage` move together on a real turn and are all
/// zero-valued on an intercepted one; the frame is untrusted provider output.
pub(crate) fn classify_claude_turn_evidence(terminal_frame: &Value) -> TurnEvidenceClassification {
    let Some(frame) = terminal_frame.as_object() else {
        return UNRECOGNIZED_TURN_EVIDENCE;
    };
    if frame.get("type").and_then(Value::as_str) != Some("result") {
        return UNRECOGNIZED_TURN_EVIDENCE;
    }
    let Some(subtype) = frame
        .get("subtype")
        .and_then(Value::as_str)
        .filter(|subtype| is_claude_result_subtype(subtype))
    else {
        return UNRECOGNIZED_TURN_EVIDENCE;
    };

    // Not read: `is_error` (false on an intercepted run, true on a refused real turn), the
    // `<synthetic>` model (an API-errored turn renders it too), and the `<local-command-stdout>`
    // wrapper or `is_meta`, whose shape set is open and would fail open.
    let mut observations = Vec::new();
    if CLAUDE_TURN_ACCOUNTING_MEMBERS
        .iter()
        .any(|member| frame.get(*member).is_some_and(is_positive_finite_number))
    {
        observations.push(TurnEvidenceClass::TurnAccounting);
    }
    if frame
        .get("modelUsage")
        .and_then(Value::as_object)
        .is_some_and(|usage| !usage.is_empty())
    {
        observations.push(TurnEvidenceClass::ModelOutput);
    }
    if is_claude_declared_failure_subtype(subtype) {
        observations.push(TurnEvidenceClass::DeclaredTurnFailure);
    }
    observed_turn_evidence(&observations)
}

// Whether the census names `result/<subtype>`, so a new subtype joins without a second edit.
fn is_claude_result_subtype(subtype: &str) -> bool {
    ClaudeWireFrameKind::VARIANTS.iter().any(|&kind| {
        let kind: &'static str = kind.into();
        kind.strip_prefix("result/") == Some(subtype)
    })
}

// Whether the subtype is a census `result/error_*` kind. `success` is none: a zero-turn command
// reply wears it too.
fn is_claude_declared_failure_subtype(subtype: &str) -> bool {
    subtype.starts_with("error_") && is_claude_result_subtype(subtype)
}
