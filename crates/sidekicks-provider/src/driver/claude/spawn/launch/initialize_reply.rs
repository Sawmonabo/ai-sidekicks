//! What an `initialize` reply declares about the process: the models it offers, their effort
//! levels and which run in auto mode, its output styles and the one it runs with, its fast mode,
//! and the commands it lists. The reply is untrusted, so each member is read leniently and a row
//! naming no value is skipped.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::driver::claude::session::transport::declarations::{
    ClaudeFastModeDeclaration, ClaudeInitializeDeclaration, ClaudeOfferedModel,
};
use crate::lenient_json::{LenientList, lenient_object, read_lenient};

#[derive(Default, Deserialize)]
struct InitializeReply {
    #[serde(default, deserialize_with = "read_lenient")]
    models: Option<LenientList<ModelRow>>,
    #[serde(default, deserialize_with = "read_lenient")]
    available_output_styles: Option<LenientList<String>>,
    #[serde(default, deserialize_with = "read_lenient")]
    output_style: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    fast_mode_state: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    fast_mode_disabled_reason: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    commands: Option<LenientList<CommandRow>>,
}

#[derive(Deserialize)]
struct ModelRow {
    #[serde(default, deserialize_with = "read_lenient")]
    value: Option<String>,
    #[serde(rename = "resolvedModel", default, deserialize_with = "read_lenient")]
    resolved_model: Option<String>,
    #[serde(rename = "displayName", default, deserialize_with = "read_lenient")]
    display_name: Option<String>,
    #[serde(
        rename = "supportsAutoMode",
        default,
        deserialize_with = "read_lenient"
    )]
    supports_auto_mode: Option<bool>,
    #[serde(flatten)]
    effort: ClaudeModelEffort,
}

/// A model row's effort axis, as the `initialize` reply and the model catalog both read it: the
/// two members are read leniently, and a level that is not text is skipped.
#[derive(Deserialize)]
pub(crate) struct ClaudeModelEffort {
    #[serde(rename = "supportsEffort", default, deserialize_with = "read_lenient")]
    supports_effort: Option<bool>,
    #[serde(
        rename = "supportedEffortLevels",
        default,
        deserialize_with = "read_lenient"
    )]
    supported_effort_levels: Option<LenientList<String>>,
}

impl ClaudeModelEffort {
    /// The levels the model takes, `None` when it has no effort axis: it says it takes no effort,
    /// or lists no level.
    pub(crate) fn into_levels(self) -> Option<Vec<String>> {
        self.supported_effort_levels
            .map(|levels| levels.0)
            .filter(|levels| self.supports_effort != Some(false) && !levels.is_empty())
    }
}

#[derive(Deserialize)]
struct CommandRow {
    #[serde(default, deserialize_with = "read_lenient")]
    name: Option<String>,
}

lenient_object!(ModelRow, CommandRow);

fn read_reply(reply: Option<&RawValue>) -> InitializeReply {
    reply
        .and_then(|reply| serde_json::from_str(reply.get()).ok())
        .unwrap_or_default()
}

fn non_empty(text: Option<String>) -> Option<String> {
    text.filter(|text| !text.is_empty())
}

/// What `reply` declares about the process's models, styles and fast mode.
pub(crate) fn read_claude_initialize_declaration(
    reply: Option<&RawValue>,
) -> ClaudeInitializeDeclaration {
    let reply = read_reply(reply);
    let mut models = Vec::new();
    let mut auto_mode_models = HashSet::new();
    for row in reply.models.map(|models| models.0).unwrap_or_default() {
        let Some(value) = non_empty(row.value) else {
            continue;
        };
        let resolved_model = non_empty(row.resolved_model);
        if row.supports_auto_mode == Some(true) {
            auto_mode_models.insert(value.clone());
            auto_mode_models.extend(resolved_model.clone());
        }
        models.push(ClaudeOfferedModel {
            value,
            resolved_model,
            display_name: non_empty(row.display_name),
            effort_levels: row.effort.into_levels(),
        });
    }
    ClaudeInitializeDeclaration {
        fast_mode: ClaudeFastModeDeclaration {
            fast_mode_state: non_empty(reply.fast_mode_state),
            fast_mode_disabled_reason: non_empty(reply.fast_mode_disabled_reason),
        },
        models,
        auto_mode_models,
        output_styles: reply
            .available_output_styles
            .map(|styles| styles.0)
            .unwrap_or_default(),
        output_style: non_empty(reply.output_style),
    }
}

/// The names of the commands `reply` lists.
pub(crate) fn read_claude_listed_commands(reply: Option<&RawValue>) -> HashSet<String> {
    read_reply(reply)
        .commands
        .map(|commands| commands.0)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|command| non_empty(command.name))
        .collect()
}
