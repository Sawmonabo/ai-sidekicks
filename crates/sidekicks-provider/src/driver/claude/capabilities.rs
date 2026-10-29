//! Claude Code's capability declaration and its model catalog read: the flags the driver delivers,
//! narrowed by the zero-turn probe of the build the version reading describes, and the `models` of
//! a control-only process's `initialize` reply made into the picker's models.

use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_TOKEN_MAX_LEN;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use super::DESCRIPTOR;
use super::capability_probe::CAPABILITY_PROBE_RULES;
use super::session::model_figures::ClaudeModelFigures;
use super::session::transport::readings::{ClaudeModelCatalogReading, ClaudeModelContextRead};
use super::tools::claude_tool_metadata;
use crate::capability::probe::{CapabilityProbeExchange, read_provider_capabilities};
use crate::driver::capabilities::{DriverCapabilityFlag, DriverCapabilityFlags};
use crate::driver::contract::error::{DriverError, bound_failure_detail};
use crate::driver::contract::params_and_results::GetCapabilitiesResult;
use crate::driver::error_causes::{ModelCatalogUnreadable, UNSPECIFIED_PROVIDER_FAILURE_DETAIL};
use crate::record_readers::read_non_empty_string;
use crate::spawned_version::SpawnedProviderVersionReading;

/// The capability contract's version, which the writer compares to see a change; it moves
/// whenever the shape of what this driver declares changes.
const CLAUDE_CAPABILITY_CONTRACT_VERSION: &str = "4.0.0";

/// The reply the catalog is read from, as Claude Code's wire names it.
const CLAUDE_CATALOG_REPLY_NAME: &str = "Claude initialize";

/// The reserved `value` that points at whichever model is currently the default.
const CLAUDE_DEFAULT_MODEL_POINTER: &str = "default";

/// The suffix Claude Code puts on a model id for that model's 1M-token window.
const CLAUDE_LARGER_WINDOW_MARK: &str = "[1m]";

/// One catalog model text: an id, a name or an effort.
type CatalogText = FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>;

/// Whether the driver delivers `flag`; a flag added to the set is a compile error here until it is
/// decided, and the probe may still withdraw one.
///
/// Each is delivered: `--resume` and `--resume-session-at`; a steer is a user message the running
/// turn reads at its next step, one not yet read taken back with `cancel_async_message`; tool
/// permission and dialog requests are answered mid-turn; `--mcp-config` servers' tools are called;
/// each tool call is paired with its result; thinking streams; the model moves mid-session; a run
/// takes `--json-schema`; resume-at with `--fork-session` rolls back and forks; `/goal` sets and
/// clears a goal; the daemon's tools reach the model; the session's helper definitions ride
/// `initialize.agents`; compaction is the provider's own command; the command list is read; and
/// `initialize` declares the accelerated-output state.
const fn is_claude_flag_declared(flag: DriverCapabilityFlag) -> bool {
    match flag {
        DriverCapabilityFlag::Resume
        | DriverCapabilityFlag::Steer
        | DriverCapabilityFlag::InteractiveRequests
        | DriverCapabilityFlag::Mcp
        | DriverCapabilityFlag::ToolCalls
        | DriverCapabilityFlag::ReasoningStream
        | DriverCapabilityFlag::ModelMutation
        | DriverCapabilityFlag::StructuredOutput
        | DriverCapabilityFlag::Rollback
        | DriverCapabilityFlag::SessionFork
        | DriverCapabilityFlag::SessionGoals
        | DriverCapabilityFlag::CallbackTools
        | DriverCapabilityFlag::Subagents
        | DriverCapabilityFlag::ContextCompaction
        | DriverCapabilityFlag::ProviderCommands
        | DriverCapabilityFlag::OutputSpeed => true,
    }
}

/// Reads the capabilities of the build `version` describes: probes that same build through
/// `exchange`, reports each flag the probe withdrew, and composes the driver's flags, tools and
/// the version it printed. Fails with [`DriverError::CapabilityProbe`] when the probe read fails.
pub(crate) async fn read_claude_capabilities(
    version: &SpawnedProviderVersionReading,
    exchange: &mut impl CapabilityProbeExchange,
) -> Result<GetCapabilitiesResult, DriverError> {
    read_provider_capabilities(
        &DESCRIPTOR,
        &CAPABILITY_PROBE_RULES,
        &DriverCapabilityFlags::from_fn(is_claude_flag_declared),
        CLAUDE_CAPABILITY_CONTRACT_VERSION,
        claude_tool_metadata(),
        version,
        exchange,
    )
    .await
}

/// Answers the model list from one control-only process's reading, started in
/// `spawn_environment`: the catalog, each row with the context window held for its model id at
/// that environment's endpoint, the one this reading's `get_context_usage` reported among them.
/// Fails as [`normalize_claude_model_catalog`] does; no stored list stands in for the provider's.
pub(crate) fn resolve_claude_model_catalog(
    reading: ClaudeModelCatalogReading,
    figures: &ClaudeModelFigures,
    spawn_environment: &[(String, String)],
) -> Result<Vec<ProviderModel>, DriverError> {
    let models =
        normalize_claude_model_catalog(reading.initialize.as_ref().map(|reply| reply.get()))?;
    figures.record_context_reads(
        spawn_environment,
        vec![ClaudeModelContextRead {
            requested_model: None,
            usage: reading.context_usage,
        }],
    );
    Ok(models
        .into_iter()
        .map(|model| ProviderModel {
            context_window: figures
                .context_window_of(spawn_environment, model.id.as_str())
                .and_then(SafeInt::new),
            ..model
        })
        .collect())
}

/// An `initialize` reply's catalog; every other member is left unread.
#[derive(Deserialize)]
struct InitializeReply {
    #[serde(default)]
    models: Option<Value>,
}

/// Reads the `models` of one `initialize` reply's JSON text into the picker's models, in the
/// provider's order, one per resolved model, a row naming the model beating the `default` pointer.
/// Fails with [`DriverError::ModelCatalogUnreadable`] for anything but `{ models: [...] }` whose
/// rows each name a `resolvedModel` and a `displayName`, carry a boolean `supportsFastMode` where
/// they carry one, and list only text effort levels, so a dropped model is never a parser failure.
pub(crate) fn normalize_claude_model_catalog(
    reply: Option<&str>,
) -> Result<Vec<ProviderModel>, DriverError> {
    let Some(InitializeReply { models }) = reply.and_then(|text| serde_json::from_str(text).ok())
    else {
        return Err(catalog_unreadable("the reply is not an object"));
    };
    let Some(Value::Array(rows)) = models else {
        return Err(catalog_unreadable("the reply has no `models` array"));
    };
    // In the provider's order, its recommended model first; each with whether the pointer gave it.
    let mut by_resolved_model: Vec<(ProviderModel, bool)> = Vec::with_capacity(rows.len());
    for row in &rows {
        let Some(row) = row.as_object() else {
            return Err(catalog_unreadable("a `models` entry is not an object"));
        };
        let (model, from_pointer) = read_catalog_row(row)?;
        // Keyed by `resolvedModel`, never `value`, which is often a short alias, since a model
        // switch is checked against this list.
        match by_resolved_model
            .iter_mut()
            .find(|(held, _)| held.id == model.id)
        {
            Some(held) if held.1 && !from_pointer => *held = (model, from_pointer),
            Some(_) => {}
            None => by_resolved_model.push((model, from_pointer)),
        }
    }
    Ok(by_resolved_model
        .into_iter()
        .map(|(model, _)| model)
        .collect())
}

// One catalog row as a model, with whether it is the `default` pointer's row.
fn read_catalog_row(row: &Map<String, Value>) -> Result<(ProviderModel, bool), DriverError> {
    let Some(id) = read_catalog_text(row, "resolvedModel") else {
        return Err(catalog_unreadable(
            "a `models` entry has no `resolvedModel`",
        ));
    };
    let Some(name) = read_catalog_text(row, "displayName") else {
        return Err(catalog_unreadable(&format!(
            "model {:?} has no `displayName`",
            id.as_str()
        )));
    };
    let fast = match row.get("supportsFastMode") {
        None => false,
        Some(Value::Bool(fast)) => *fast,
        Some(_) => {
            return Err(catalog_unreadable(&format!(
                "model {:?} has an unreadable `supportsFastMode`",
                id.as_str()
            )));
        }
    };
    // Copied, never defaulted: absent means the model has no effort selection.
    let effort_levels = match row.get("supportedEffortLevels") {
        Some(Value::Array(levels))
            if row.get("supportsEffort") != Some(&Value::Bool(false)) && !levels.is_empty() =>
        {
            let levels = levels
                .iter()
                .map(|level| {
                    level
                        .as_str()
                        .and_then(|level| CatalogText::new(level.to_owned()).ok())
                })
                .collect::<Option<Vec<_>>>();
            let Some(levels) = levels else {
                return Err(catalog_unreadable(&format!(
                    "model {:?} has an effort level that is not text",
                    id.as_str()
                )));
            };
            Some(levels)
        }
        _ => None,
    };
    let from_pointer =
        row.get("value").and_then(Value::as_str) == Some(CLAUDE_DEFAULT_MODEL_POINTER);
    let model = ProviderModel {
        // Read from the id alone, never the name, which is display text.
        larger_window: id.as_str().ends_with(CLAUDE_LARGER_WINDOW_MARK),
        id,
        name,
        capabilities: Vec::new(),
        effort_levels,
        output_speed_levels: None,
        fast,
        context_window: None,
    };
    Ok((model, from_pointer))
}

// The non-empty string at `key` that a catalog text holds; `None` for anything else.
fn read_catalog_text(source: &Map<String, Value>, key: &str) -> Option<CatalogText> {
    read_non_empty_string(source, key).and_then(|text| CatalogText::new(text.to_owned()).ok())
}

// The whole catalog's fault, naming the row in `detail`, which is bounded since a model id is
// the provider's own text.
fn catalog_unreadable(detail: &str) -> DriverError {
    DriverError::from(ModelCatalogUnreadable {
        provider: DESCRIPTOR.provider_id(),
        reply_name: CLAUDE_CATALOG_REPLY_NAME,
        detail: bound_failure_detail(detail, UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone()),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::normalize_claude_model_catalog;
    use crate::driver::contract::error::DriverError;

    // Killed by reading a non-boolean `supportsFastMode` as `false`, or by keeping the `default`
    // pointer's row over the row that names the model.
    #[test]
    fn the_catalog_refuses_an_unreadable_fast_mode_and_prefers_a_named_row() {
        let catalog = json!({ "models": [
            { "value": "default", "resolvedModel": "claude-opus-5", "displayName": "Default" },
            { "value": "opus", "resolvedModel": "claude-opus-5", "displayName": "Opus",
              "supportsFastMode": true, "supportedEffortLevels": ["low", "high"] },
            { "value": "opus[1m]", "resolvedModel": "claude-opus-5[1m]", "displayName": "Opus 1M",
              "supportsEffort": false, "supportedEffortLevels": ["low"] },
        ]})
        .to_string();

        let models = normalize_claude_model_catalog(Some(&catalog)).expect("the catalog reads");

        let read: Vec<_> = models
            .iter()
            .map(|model| {
                (
                    model.id.as_str(),
                    model.name.as_str(),
                    model.fast,
                    model.larger_window,
                    model.effort_levels.as_ref().map(Vec::len),
                )
            })
            .collect();
        assert_eq!(
            read,
            [
                ("claude-opus-5", "Opus", true, false, Some(2)),
                ("claude-opus-5[1m]", "Opus 1M", false, true, None),
            ]
        );

        let unreadable = json!({ "models": [
            { "resolvedModel": "claude-opus-5", "displayName": "Opus", "supportsFastMode": "yes" },
        ]})
        .to_string();
        assert!(matches!(
            normalize_claude_model_catalog(Some(&unreadable)),
            Err(DriverError::ModelCatalogUnreadable(_))
        ));
    }
}
