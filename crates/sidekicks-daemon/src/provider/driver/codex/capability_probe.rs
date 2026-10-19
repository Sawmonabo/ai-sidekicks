//! Codex's capability probe rules. Its one zero-turn channel is the client-request methods, which
//! the app-server's deserializer enumerates when it refuses a method it does not know.

use serde_json::Value;
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;

use crate::provider::capability::probe::ProbeAdmissibilityConjunct::{
    DecisiveAtConsumptionGranularity, NonMutating, ZeroTurn,
};
use crate::provider::capability::probe::{
    CapabilityDetection, CapabilityProbeRules, ProbeAnswer, assert_admissible_detection,
};
use crate::provider::driver::capabilities::DriverCapabilityFlag;

/// What starts the deserializer's refusal of an unknown method, before its quoted name.
const UNKNOWN_VARIANT_OPENING: &str = "unknown variant `";

/// What follows the refused name, before the quoted names the deserializer accepts.
const ACCEPTED_LIST_OPENING: &str = ", expected one of ";

/// Codex's rules for the capability read.
pub(super) const CAPABILITY_PROBE_RULES: CapabilityProbeRules = CapabilityProbeRules {
    detection: detection_of,
    negative_control: "zzq/nonexistent_method",
    // Each starts a turn or a thread.
    prohibited_names: &["turn/start", "thread/start"],
    classify_reply,
};

// A probed flag sends the exact methods its consumers call, each taking only the identity the
// driver already holds, so a method's acceptance decides the flag.
const fn detection_of(flag: DriverCapabilityFlag) -> CapabilityDetection {
    match flag {
        DriverCapabilityFlag::Steer => CapabilityDetection::Probed {
            probe_names: &["turn/steer"],
        },
        // The setter alone would report a build that cannot clear a goal as fully capable.
        DriverCapabilityFlag::SessionGoals => CapabilityDetection::Probed {
            probe_names: &["thread/goal/set", "thread/goal/clear"],
        },
        DriverCapabilityFlag::ContextCompaction => CapabilityDetection::Probed {
            probe_names: &["thread/compact/start"],
        },
        DriverCapabilityFlag::ProviderCommands => CapabilityDetection::Probed {
            probe_names: &["skills/list"],
        },
        // Using a tool server can be decided only by calling one, which spends a turn and does
        // the tool's work.
        DriverCapabilityFlag::Mcp => CapabilityDetection::Static {
            failing_conjuncts: &[ZeroTurn, NonMutating],
        },
        // Carried by the thread's lifecycle, by turn parameters a method's acceptance does not
        // prove, or by frames the provider sends, none of which the method list shows; output
        // speed's tiers are free-form words no read can decide.
        DriverCapabilityFlag::Resume
        | DriverCapabilityFlag::InteractiveRequests
        | DriverCapabilityFlag::ToolCalls
        | DriverCapabilityFlag::ReasoningStream
        | DriverCapabilityFlag::ModelMutation
        | DriverCapabilityFlag::StructuredOutput
        | DriverCapabilityFlag::Rollback
        | DriverCapabilityFlag::SessionFork
        | DriverCapabilityFlag::CallbackTools
        | DriverCapabilityFlag::Subagents
        | DriverCapabilityFlag::OutputSpeed => CapabilityDetection::Static {
            failing_conjuncts: &[DecisiveAtConsumptionGranularity],
        },
    }
}

assert_admissible_detection!(detection_of, CAPABILITY_PROBE_RULES.prohibited_names);

// Invalid-request refuses the probe's name only when the deserializer's message names it as the
// refused method and leaves it out of the accepted list; every unclear reply reads as accepted,
// since a wrong refusal turns a capability off.
fn classify_reply(reply: &Value, probe_name: &str) -> ProbeAnswer {
    let Some(reply) = reply.as_object() else {
        return ProbeAnswer::Unrecognized;
    };
    if reply.contains_key("result") {
        return ProbeAnswer::Accepted;
    }
    let Some(error) = reply.get("error").and_then(Value::as_object) else {
        return ProbeAnswer::Unrecognized;
    };
    let Some(code) = error.get("code").filter(|code| code.is_number()) else {
        return ProbeAnswer::Unrecognized;
    };
    let code = code.as_i64();
    // A build that answers method-not-found for a name it lacks is read as refusing it.
    if code == Some(i64::from(JsonRpcErrorCode::MethodNotFound.code())) {
        return ProbeAnswer::UnknownName;
    }
    // Invalid-request also answers a known method whose empty payload does not read, so the code
    // alone decides nothing.
    if code != Some(i64::from(JsonRpcErrorCode::InvalidRequest.code())) {
        return ProbeAnswer::Accepted;
    }
    let refuses_probe = error
        .get("message")
        .and_then(Value::as_str)
        .and_then(read_unknown_variant)
        .is_some_and(|(refused, accepted_list)| {
            refused == probe_name && !quoted_names(accepted_list).any(|name| name == probe_name)
        });
    if refuses_probe {
        ProbeAnswer::UnknownName
    } else {
        ProbeAnswer::Accepted
    }
}

// The refused name and the text of the accepted list in the first unknown-variant refusal
// `message` holds.
fn read_unknown_variant(message: &str) -> Option<(&str, &str)> {
    message
        .match_indices(UNKNOWN_VARIANT_OPENING)
        .find_map(|(start, opening)| {
            let (refused, rest) = message[start + opening.len()..].split_once('`')?;
            let accepted_list = rest.strip_prefix(ACCEPTED_LIST_OPENING)?;
            (!accepted_list.is_empty()).then_some((refused, accepted_list))
        })
}

// Every name between a pair of backticks in `text`.
fn quoted_names(text: &str) -> impl Iterator<Item = &str> {
    let mut pieces = text.split('`').skip(1);
    std::iter::from_fn(move || {
        let name = pieces.next()?;
        pieces.next()?;
        Some(name)
    })
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;

    use super::classify_reply;
    use crate::provider::capability::probe::ProbeAnswer;

    #[rstest]
    #[case::method_not_found(-32_601, "Method not found", ProbeAnswer::UnknownName)]
    #[case::refused_and_not_listed(
        -32_600,
        "Invalid request: unknown variant `thread/goal/set`, expected one of `turn/start`, \
         `thread/start`",
        ProbeAnswer::UnknownName
    )]
    #[case::refused_but_listed(
        -32_600,
        "Invalid request: unknown variant `thread/goal/set`, expected one of `turn/start`, \
         `thread/goal/set`",
        ProbeAnswer::Accepted
    )]
    #[case::another_name_refused(
        -32_600,
        "Invalid request: unknown variant `thread/goal/clear`, expected one of `turn/start`",
        ProbeAnswer::Accepted
    )]
    fn an_error_withdraws_only_when_it_refuses_the_probed_name(
        #[case] code: i64,
        #[case] message: &str,
        #[case] answer: ProbeAnswer,
    ) {
        let reply = json!({ "error": { "code": code, "message": message } });
        assert_eq!(classify_reply(&reply, "thread/goal/set"), answer);
    }
}
