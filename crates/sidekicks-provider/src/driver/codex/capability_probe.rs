//! Codex's capability probe: its rules and its exchange. Its one zero-turn channel is the
//! client-request methods, which the app-server's deserializer enumerates when it refuses a method
//! it does not know, asked on a connection of the probe's own that starts no conversation.

use std::error::Error;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::{Map, Value, json};
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;

use crate::capability::probe::ProbeAdmissibilityConjunct::{
    DecisiveAtConsumptionGranularity, NonMutating, ZeroTurn,
};
use crate::capability::probe::{
    CapabilityDetection, CapabilityProbeExchange, CapabilityProbeRules, ProbeAnswer,
    assert_admissible_detection,
};
use crate::driver::capabilities::DriverCapabilityFlag;
use crate::driver::codex::capabilities::read_codex_capabilities;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::connection_events::DetachedConnectionEvents;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::thread::view::TURN_START_METHOD;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::contract::{DriverError, GetCapabilitiesResult};

/// What starts the deserializer's refusal of an unknown method, before its quoted name.
const UNKNOWN_VARIANT_OPENING: &str = "unknown variant `";

/// What follows the refused name, before the quoted names the deserializer accepts.
const ACCEPTED_LIST_OPENING: &str = ", expected one of ";

/// Codex's rules for the capability read.
pub(super) const CAPABILITY_PROBE_RULES: CapabilityProbeRules = CapabilityProbeRules {
    detection: detection_of,
    negative_control: "zzq/nonexistent_method",
    // Each starts a turn or a thread.
    prohibited_names: &[TURN_START_METHOD, "thread/start"],
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

/// Starts `service` if it has not started and reads its build's capabilities, probed on a
/// connection of the probe's own, which is closed as it is let go. Fails with the start's or the
/// dial's error, when the service reported no build, and as the capability read does.
pub(crate) async fn probe_codex_service_capabilities(
    service: &CodexService,
) -> Result<GetCapabilitiesResult, DriverError> {
    let connection = service
        .open_detached_connection(Arc::new(DetachedConnectionEvents))
        .await?;
    let version = service
        .version_reading()
        .ok_or_else(|| CodexError::Transport {
            detail: "The Codex service reported no build at its start.".to_owned(),
            cause: None,
        })?;
    read_codex_capabilities(
        &version,
        &mut CodexCapabilityProbeExchange {
            connection: &connection,
        },
    )
    .await
}

/// One probe sent on a connection that started no conversation, its reply in the shape the probe's
/// classifier reads: `{ result }`, or `{ error: { code, message } }` for the service's refusal.
struct CodexCapabilityProbeExchange<'connection> {
    connection: &'connection CodexAppServerConnection,
}

impl CapabilityProbeExchange for CodexCapabilityProbeExchange<'_> {
    fn exchange(
        &mut self,
        probe_name: &'static str,
    ) -> BoxFuture<'_, Result<Value, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            match self.connection.request(probe_name, &Map::new()).await {
                Ok(result) => Ok(json!({ "result": serde_json::from_str::<Value>(result.get())? })),
                Err(CodexError::ProviderRequest { code, message, .. }) => {
                    Ok(json!({ "error": { "code": code, "message": message } }))
                }
                Err(error) => Err(error.into()),
            }
        })
    }
}

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

    use super::{CodexCapabilityProbeExchange, classify_reply};
    use crate::capability::probe::{CapabilityProbeExchange, ProbeAnswer};
    use crate::driver::codex::service::supervisor::test_service;

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

    // The service's refusal of a probed name is a reply the classifier reads, never a failed
    // exchange, which would fail the whole capability read. Killed by raising the refusal.
    #[tokio::test(start_paused = true)]
    async fn a_refusal_reaches_the_classifier_as_the_codex_reply() {
        let mut scripted = test_service::start_scripted_codex_service();
        let connection = scripted.service.connection().expect("the service is up");
        let mut exchange = CodexCapabilityProbeExchange {
            connection: &connection,
        };
        let reply = {
            let exchange = exchange.exchange("thread/goal/set");
            tokio::pin!(exchange);
            let sent = tokio::select! {
                sent = scripted.script.next_sent() => sent,
                _ = &mut exchange => panic!("the probe answered before the service did"),
            };
            assert_eq!(sent["method"], "thread/goal/set");
            scripted.script.send(&json!({
                "jsonrpc": "2.0",
                "id": sent["id"],
                "error": {
                    "code": -32_600,
                    "message": "Invalid request: unknown variant `thread/goal/set`, expected one \
                                of `turn/start`",
                },
            }));
            exchange.await.expect("a refusal is a reply")
        };
        assert_eq!(
            classify_reply(&reply, "thread/goal/set"),
            ProbeAnswer::UnknownName
        );
    }
}
