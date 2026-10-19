//! Claude Code's capability probe rules. Its one zero-turn channel is the control-request registry,
//! which answers an unknown subtype with `Unsupported control request subtype: <name>`.

use serde_json::Value;

use crate::provider::capability::probe::ProbeAdmissibilityConjunct::{
    DecisiveAtConsumptionGranularity, NonMutating, ZeroTurn,
};
use crate::provider::capability::probe::{
    CapabilityDetection, CapabilityProbeRules, ProbeAnswer, assert_admissible_detection,
};
use crate::provider::driver::capabilities::DriverCapabilityFlag;

/// The control request whose reply reports the fast-mode state before any turn.
const FAST_MODE_PROBE_NAME: &str = "initialize";

/// How the registry starts its refusal of a subtype it does not know.
const UNSUPPORTED_SUBTYPE_PREFIX: &str = "Unsupported control request subtype:";

/// Claude Code's rules for the capability read.
pub(super) const CAPABILITY_PROBE_RULES: CapabilityProbeRules = CapabilityProbeRules {
    detection: detection_of,
    negative_control: "zzq_nonexistent_subtype",
    // Replaces a live session's whole set of tool servers.
    prohibited_names: &["mcp_set_servers"],
    classify_reply,
};

const fn detection_of(flag: DriverCapabilityFlag) -> CapabilityDetection {
    match flag {
        // The reply reports `fast_mode_state` before any turn, on a connection that starts no
        // session; a reply without it withdraws the flag.
        DriverCapabilityFlag::OutputSpeed => CapabilityDetection::Probed {
            probe_names: &[FAST_MODE_PROBE_NAME],
        },
        // Using a tool server, compacting and listing commands can be decided only by spending a
        // turn or by reloading the process's skills, commands and plugins.
        DriverCapabilityFlag::Mcp
        | DriverCapabilityFlag::ContextCompaction
        | DriverCapabilityFlag::ProviderCommands => CapabilityDetection::Static {
            failing_conjuncts: &[ZeroTurn, NonMutating],
        },
        // The request that would decide it sets the session's model.
        DriverCapabilityFlag::ModelMutation => CapabilityDetection::Static {
            failing_conjuncts: &[NonMutating],
        },
        // Launch flags, output shapes and asks the provider raises are out of the registry's
        // sight.
        DriverCapabilityFlag::Resume
        | DriverCapabilityFlag::Steer
        | DriverCapabilityFlag::InteractiveRequests
        | DriverCapabilityFlag::ToolCalls
        | DriverCapabilityFlag::ReasoningStream
        | DriverCapabilityFlag::StructuredOutput
        | DriverCapabilityFlag::Rollback
        | DriverCapabilityFlag::SessionFork
        | DriverCapabilityFlag::SessionGoals
        | DriverCapabilityFlag::CallbackTools
        | DriverCapabilityFlag::Subagents => CapabilityDetection::Static {
            failing_conjuncts: &[DecisiveAtConsumptionGranularity],
        },
    }
}

assert_admissible_detection!(detection_of, CAPABILITY_PROBE_RULES.prohibited_names);

// A control response settles as `{subtype: "success", response}` or `{subtype: "error", error}`.
// The refusal names the subtype already; the probe's name matters only for the fast-mode probe,
// whose acceptance counts only when its reply carries the state.
fn classify_reply(reply: &Value, probe_name: &str) -> ProbeAnswer {
    let Some(reply) = reply.as_object() else {
        return ProbeAnswer::Unrecognized;
    };
    match reply.get("subtype").and_then(Value::as_str) {
        Some("success") => {
            let carries_state = reply
                .get("response")
                .and_then(Value::as_object)
                .and_then(|response| response.get("fast_mode_state"))
                .is_some_and(Value::is_string);
            if probe_name != FAST_MODE_PROBE_NAME || carries_state {
                ProbeAnswer::Accepted
            } else {
                ProbeAnswer::Unrecognized
            }
        }
        // An error without a string reason cannot be told from a refusal of the name.
        Some("error") => match reply.get("error").and_then(Value::as_str) {
            Some(error) if error.starts_with(UNSUPPORTED_SUBTYPE_PREFIX) => {
                ProbeAnswer::UnknownName
            }
            Some(_) => ProbeAnswer::Accepted,
            None => ProbeAnswer::Unrecognized,
        },
        Some(_) | None => ProbeAnswer::Unrecognized,
    }
}
