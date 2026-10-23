//! What a Claude Code turn's settling `result` frame proves about how the turn ended.

use std::str::FromStr;

use serde_json::Value;

use crate::provider::driver::claude::event_normalizer::{
    ClaudeWireFrameKind, compose_claude_wire_frame_kind,
};
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
    let frame_type = frame
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(subtype) = frame.get("subtype").and_then(Value::as_str) else {
        return UNRECOGNIZED_TURN_EVIDENCE;
    };
    // Only a `result` the census lists is read; one of an unlisted subtype proves nothing.
    if !ClaudeWireFrameKind::from_str(&compose_claude_wire_frame_kind(frame_type, Some(subtype)))
        .is_ok_and(|kind| kind.is_result())
    {
        return UNRECOGNIZED_TURN_EVIDENCE;
    }

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
    // `success` is no declared failure: a zero-turn command reply wears it too.
    if subtype.starts_with("error_") {
        observations.push(TurnEvidenceClass::DeclaredTurnFailure);
    }
    observed_turn_evidence(&observations)
}
