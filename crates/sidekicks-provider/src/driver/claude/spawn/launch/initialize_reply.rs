//! What an `initialize` reply declares about the process: the models it offers, their effort levels
//! and which run in auto mode, its output styles and the one it runs with, its fast mode, the
//! commands it lists, the agents it offers, and the memory stores it keeps. The reply is untrusted,
//! so each member is read leniently and a row naming no value is skipped.

use std::collections::HashSet;
use std::path::Path;

use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::free_form_string::FilesystemPath;

use crate::driver::claude::session::transport::declarations::{
    ClaudeFastModeDeclaration, ClaudeInitializeDeclaration, ClaudeOfferedModel,
};
use crate::driver::contract::known_names::ProviderAgent;
use crate::lenient_json::{LenientList, lenient_object, read_lenient};
use crate::record_readers::filter_non_empty;

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
    #[serde(default, deserialize_with = "read_lenient")]
    agents: Option<LenientList<AgentRow>>,
    #[serde(default, deserialize_with = "read_lenient")]
    memory_paths: Option<MemoryPaths>,
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
struct MemoryPaths {
    #[serde(default, deserialize_with = "read_lenient")]
    auto: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    team: Option<String>,
}

#[derive(Deserialize)]
struct CommandRow {
    #[serde(default, deserialize_with = "read_lenient")]
    name: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    description: Option<String>,
    #[serde(rename = "argumentHint", default, deserialize_with = "read_lenient")]
    argument_hint: Option<String>,
}

#[derive(Deserialize)]
struct AgentRow {
    #[serde(default, deserialize_with = "read_lenient")]
    name: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    description: Option<String>,
}

/// One command an `initialize` reply lists: its name, and its description and argument hint where
/// the reply gives non-empty ones.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeListedCommand {
    /// The name, without its `/`.
    pub(crate) name: String,
    /// What it does.
    pub(crate) description: Option<String>,
    /// What follows the name.
    pub(crate) argument_hint: Option<String>,
}

lenient_object!(ModelRow, MemoryPaths, CommandRow, AgentRow);

fn read_reply(reply: Option<&RawValue>) -> InitializeReply {
    reply
        .and_then(|reply| serde_json::from_str(reply.get()).ok())
        .unwrap_or_default()
}

/// What `reply` declares about the process's models, styles, fast mode, commands, agents and memory
/// stores.
pub(crate) fn read_claude_initialize_declaration(
    reply: Option<&RawValue>,
) -> ClaudeInitializeDeclaration {
    let reply = read_reply(reply);
    let mut models = Vec::new();
    let mut auto_mode_models = HashSet::new();
    for row in reply.models.map(|models| models.0).unwrap_or_default() {
        let Some(value) = filter_non_empty(row.value) else {
            continue;
        };
        let resolved_model = filter_non_empty(row.resolved_model);
        if row.supports_auto_mode == Some(true) {
            auto_mode_models.insert(value.clone());
            auto_mode_models.extend(resolved_model.clone());
        }
        models.push(ClaudeOfferedModel {
            value,
            resolved_model,
            display_name: filter_non_empty(row.display_name),
            effort_levels: row.effort.into_levels(),
        });
    }
    ClaudeInitializeDeclaration {
        fast_mode: ClaudeFastModeDeclaration {
            fast_mode_state: filter_non_empty(reply.fast_mode_state),
            fast_mode_disabled_reason: filter_non_empty(reply.fast_mode_disabled_reason),
        },
        models,
        auto_mode_models,
        output_styles: reply
            .available_output_styles
            .map(|styles| styles.0)
            .unwrap_or_default(),
        output_style: filter_non_empty(reply.output_style),
        commands: listed_command_rows(reply.commands)
            .into_iter()
            .map(|command| command.name)
            .collect(),
        agents: read_listed_agents(reply.agents),
        memory_stores: read_memory_stores(reply.memory_paths),
    }
}

// The agents a reply's `agents` member offers, in its order, a row naming no agent skipped and an
// empty description read as none.
fn read_listed_agents(agents: Option<LenientList<AgentRow>>) -> Vec<ProviderAgent> {
    agents
        .map(|agents| agents.0)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|agent| {
            Some(ProviderAgent {
                name: filter_non_empty(agent.name)?,
                description: filter_non_empty(agent.description),
            })
        })
        .collect()
}

// The auto-memory folder, then the team-memory folder, each kept only where it is an absolute path
// a filesystem path carries.
fn read_memory_stores(memory_paths: Option<MemoryPaths>) -> Vec<FilesystemPath> {
    memory_paths
        .into_iter()
        .flat_map(|paths| [paths.auto, paths.team])
        .flatten()
        .filter(|path| Path::new(path).is_absolute())
        .filter_map(|path| FilesystemPath::new(path).ok())
        .collect()
}

/// The commands `reply` lists, in its order, a row naming no command skipped.
pub(crate) fn read_claude_listed_command_rows(
    reply: Option<&RawValue>,
) -> Vec<ClaudeListedCommand> {
    listed_command_rows(read_reply(reply).commands)
}

// The commands a reply's `commands` member lists, in its order, a row naming no command skipped.
fn listed_command_rows(commands: Option<LenientList<CommandRow>>) -> Vec<ClaudeListedCommand> {
    commands
        .map(|commands| commands.0)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|command| {
            Some(ClaudeListedCommand {
                name: filter_non_empty(command.name)?,
                description: filter_non_empty(command.description),
                argument_hint: filter_non_empty(command.argument_hint),
            })
        })
        .collect()
}

/// The names of the commands `reply` lists.
pub(crate) fn read_claude_listed_commands(reply: Option<&RawValue>) -> HashSet<String> {
    read_claude_listed_command_rows(reply)
        .into_iter()
        .map(|command| command.name)
        .collect()
}
