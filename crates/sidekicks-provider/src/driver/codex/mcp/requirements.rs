//! The allow lists of MCP servers an administrator sets for Codex on this computer, in the system
//! `requirements.toml` and, on macOS, the requirements a device-management profile forces, merged
//! key by key with the profile's winning as Codex merges them: the top-level `[mcp_servers]` table,
//! where present, lets Codex start a server only when the table names it and its transport matches
//! the entry's identity, and a plugin's `[plugins."<plugin>@<marketplace>".mcp_servers]` table does
//! the same for that plugin's servers. Codex's `config/read` never carries them, so the driver reads
//! them itself, and like Codex refuses to go on when they cannot be read.

use std::collections::BTreeMap;
use std::io;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use regex::Regex;
use serde::Deserialize;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_platforms::read_managed_preference;

use crate::driver::codex::mcp::config::CodexMcpConfigReading;
use crate::driver::codex::mcp::config::server_entry::CodexServerTransport;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::mcp_server::read::McpServerPolicyEntry;

#[cfg(test)]
mod tests;

/// The file in Codex's administrator-managed settings folder that holds the requirements.
const REQUIREMENTS_FILE_NAME: &str = "requirements.toml";

/// The preferences of Codex on macOS, and the key a device-management profile forces Codex's
/// requirements under, as base64 of their TOML.
const MANAGED_PREFERENCE: (&str, &str) = ("com.openai.codex", "requirements_toml_base64");

/// The servers Codex's requirements allow, by name, each with the identity its transport must
/// have: the top-level list, where it is set, and each plugin's own list.
pub(crate) struct CodexMcpRequirements {
    servers: Option<BTreeMap<String, ServerIdentity>>,
    plugin_servers: BTreeMap<String, BTreeMap<String, ServerIdentity>>,
}

impl CodexMcpRequirements {
    /// Whether Codex starts the server `name` declared by `binding` with `transport`: a plugin's
    /// server where an empty top-level list does not refuse every plugin's and its plugin's list,
    /// where it sets one, names it with a matching identity; every other server where the
    /// top-level list, where it is set, does. A remote server's address is matched as written.
    pub(crate) fn allows(
        &self,
        binding: &McpServerBindingRef,
        transport: Option<&CodexServerTransport>,
    ) -> bool {
        let name = binding.server_name().as_str();
        let list = match binding {
            McpServerBindingRef::Plugin { scope_ref, .. } => {
                if self.servers.as_ref().is_some_and(BTreeMap::is_empty) {
                    return false;
                }
                // A plugin's key is `<plugin>@<marketplace>`; the binding names the plugin alone.
                let plugin = scope_ref.as_str();
                let mut lists = self.plugin_servers.iter().filter(|(key, _list)| {
                    key.rsplit_once('@')
                        .is_some_and(|(plugin_name, _marketplace)| plugin_name == plugin)
                });
                match lists.next() {
                    Some((_key, list)) => list,
                    None => return true,
                }
            }
            McpServerBindingRef::User { .. }
            | McpServerBindingRef::Project { .. }
            | McpServerBindingRef::Local { .. }
            | McpServerBindingRef::Connector { .. }
            | McpServerBindingRef::Managed { .. } => match &self.servers {
                Some(list) => list,
                None => return true,
            },
        };
        list.get(name)
            .zip(transport)
            .is_some_and(|(identity, transport)| identity.matches(transport))
    }

    /// Fills `reading` with the allow lists: its policy names each server the top-level list
    /// allows, each root and the person's home folder keep out every server declared for them that
    /// the lists refuse, and no root's provider-loaded set keeps a kept-out name.
    pub(crate) fn apply(&self, reading: &mut CodexMcpConfigReading) {
        if let Some(servers) = &self.servers {
            let allowed = servers
                .keys()
                .filter_map(|name| McpServerName::new(name.clone()).ok())
                .map(McpServerPolicyEntry::ServerName)
                .collect();
            reading.server_policy.allowed = Some(allowed);
        }
        let kept_out_at_roots: Vec<Vec<McpServerName>> = reading
            .roots
            .iter()
            .map(|root| self.find_kept_out(reading, Some(&root.root)))
            .collect();
        reading.home_kept_out_server_names = self.find_kept_out(reading, None);
        for (root, kept_out) in reading.roots.iter_mut().zip(kept_out_at_roots) {
            root.provider_loaded
                .retain(|binding| !kept_out.contains(binding.server_name()));
            root.kept_out_server_names = kept_out;
        }
    }

    // The names of the servers declared for a session at `root`, or at the person's home folder
    // where `root` is `None`, that the lists refuse.
    fn find_kept_out(
        &self,
        reading: &CodexMcpConfigReading,
        root: Option<&PlacedPath>,
    ) -> Vec<McpServerName> {
        let mut kept_out: Vec<McpServerName> = Vec::new();
        for declaration in &reading.declarations {
            let Some(name) = server_name_at(&declaration.binding, root) else {
                continue;
            };
            let transport = reading
                .transports
                .iter()
                .find(|(binding, _transport)| *binding == declaration.binding)
                .map(|(_binding, transport)| transport);
            if !kept_out.contains(name) && !self.allows(&declaration.binding, transport) {
                kept_out.push(name.clone());
            }
        }
        kept_out
    }
}

/// Reads Codex's requirements from `requirements.toml` in `managed_settings_folder` and from the
/// requirements a device-management profile forces, the profile's winning key by key; `None`
/// where neither sets an allow list of servers. A file that is absent or not the daemon's to read
/// declares none. Fails with [`CodexError::MachinePolicyUnreadable`] where the file cannot
/// otherwise be read, where the profile's value is not base64 of UTF-8 text, and where either is
/// not requirements of the shape Codex reads, since Codex refuses to start on any of them.
pub(crate) async fn read_codex_mcp_requirements(
    managed_settings_folder: Option<&Path>,
) -> Result<Option<CodexMcpRequirements>, CodexError> {
    let mut layers = Vec::new();
    if let Some(folder) = managed_settings_folder {
        let path = folder.join(REQUIREMENTS_FILE_NAME);
        match tokio::fs::read_to_string(&path).await {
            Ok(text) => layers.push((path.display().to_string(), text)),
            Err(failure)
                if matches!(
                    failure.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                ) => {}
            Err(failure) => {
                return Err(unreadable(
                    &path.display().to_string(),
                    &failure.to_string(),
                ));
            }
        }
    }
    let (application_id, key) = MANAGED_PREFERENCE;
    let source = format!("the managed preference {application_id}:{key}");
    let forced = read_managed_preference(application_id, key)
        .map_err(|failure| unreadable(&source, &failure.to_string()))?;
    if let Some(encoded) = forced {
        let decoded = STANDARD
            .decode(encoded.trim())
            .map_err(|failure| failure.to_string())
            .and_then(|bytes| String::from_utf8(bytes).map_err(|failure| failure.to_string()))
            .map_err(|failure| unreadable(&source, &failure))?;
        layers.push((source, decoded));
    }
    let mut merged = toml::Table::new();
    for (source, text) in layers {
        let layer: toml::Table =
            toml::from_str(&text).map_err(|failure| unreadable(&source, &failure.to_string()))?;
        merge_requirements(&mut merged, layer);
    }
    parse_codex_mcp_requirements(merged).map_err(|failure| unreadable("the requirements", &failure))
}

// The machine policy's failure at `source`.
fn unreadable(source: &str, failure: &str) -> CodexError {
    CodexError::MachinePolicyUnreadable {
        detail: format!("{source}: {failure}"),
    }
}

// Merges `overlay` into `base`, a table key by key and any other value replaced, as Codex merges
// its requirements' layers, the overlay winning.
fn merge_requirements(base: &mut toml::Table, overlay: toml::Table) {
    for (key, value) in overlay {
        match (base.get_mut(&key), value) {
            (Some(toml::Value::Table(kept)), toml::Value::Table(overlay)) => {
                merge_requirements(kept, overlay);
            }
            (_, value) => {
                base.insert(key, value);
            }
        }
    }
}

// The allow lists of the merged requirements `table`; `None` where it sets none. Fails as it is not
// requirements of Codex's shape or an entry's pattern is not one Codex compiles.
fn parse_codex_mcp_requirements(
    table: toml::Table,
) -> Result<Option<CodexMcpRequirements>, String> {
    let file: RequirementsFile = toml::Value::Table(table)
        .try_into()
        .map_err(|failure: toml::de::Error| failure.to_string())?;
    let servers = file.mcp_servers.map(compile_list).transpose()?;
    let plugin_servers = file
        .plugins
        .into_iter()
        .flatten()
        .filter_map(|(key, plugin)| plugin.mcp_servers.map(|list| (key, list)))
        .map(|(key, list)| Ok((key, compile_list(list)?)))
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    if servers.is_none() && plugin_servers.is_empty() {
        return Ok(None);
    }
    Ok(Some(CodexMcpRequirements {
        servers,
        plugin_servers,
    }))
}

fn compile_list(
    entries: BTreeMap<String, RequirementEntry>,
) -> Result<BTreeMap<String, ServerIdentity>, String> {
    entries
        .into_iter()
        .map(|(name, entry)| Ok((name, ServerIdentity::compile(entry.identity)?)))
        .collect()
}

/// The name `binding` declares a server by where a session at `root`, or at the person's home
/// folder where `root` is `None`, loads it: every binding but a project's or a root's own at
/// another root, and a connector, which Codex's config does not hold.
pub(super) fn server_name_at<'binding>(
    binding: &'binding McpServerBindingRef,
    root: Option<&PlacedPath>,
) -> Option<&'binding McpServerName> {
    match binding {
        McpServerBindingRef::User { server_name, .. }
        | McpServerBindingRef::Managed { server_name, .. }
        | McpServerBindingRef::Plugin { server_name, .. } => Some(server_name),
        McpServerBindingRef::Project {
            scope_ref,
            place,
            server_name,
            ..
        }
        | McpServerBindingRef::Local {
            scope_ref,
            place,
            server_name,
            ..
        } => root
            .is_some_and(|root| *scope_ref == root.path && *place == root.place)
            .then_some(server_name),
        McpServerBindingRef::Connector { .. } => None,
    }
}

// The members of Codex's requirements file the read takes.
#[derive(Deserialize)]
struct RequirementsFile {
    #[serde(default)]
    mcp_servers: Option<BTreeMap<String, RequirementEntry>>,
    #[serde(default)]
    plugins: Option<BTreeMap<String, PluginRequirements>>,
}

// One plugin's requirements the read takes: the allow list of its servers.
#[derive(Deserialize)]
struct PluginRequirements {
    #[serde(default)]
    mcp_servers: Option<BTreeMap<String, RequirementEntry>>,
}

// One allowed server's entry.
#[derive(Deserialize)]
struct RequirementEntry {
    identity: IdentityEntry,
}

// What an allowed server's transport must be: a program, exactly or by its arguments, or an
// address, exactly or by a pattern.
#[derive(Deserialize)]
#[serde(untagged)]
enum IdentityEntry {
    Command { command: CommandEntry },
    Url { url: ValueEntry },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CommandEntry {
    Program(String),
    Matcher {
        executable: String,
        args: Vec<ValueMatcherEntry>,
    },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ValueEntry {
    Exact(String),
    Matcher(ValueMatcherEntry),
}

#[derive(Deserialize)]
#[serde(tag = "match", rename_all = "snake_case", deny_unknown_fields)]
enum ValueMatcherEntry {
    Exact { value: String },
    Prefix { value: String },
    Regex { expression: String },
}

// An allowed server's identity, its patterns compiled.
enum ServerIdentity {
    // A program by its path alone, whatever its arguments.
    Program(String),
    // A program and each of its arguments, which must be as many as the matchers.
    Command {
        executable: String,
        args: Vec<ValueMatcher>,
    },
    // An address.
    Url(ValueMatcher),
}

impl ServerIdentity {
    fn compile(entry: IdentityEntry) -> Result<Self, String> {
        Ok(match entry {
            IdentityEntry::Command {
                command: CommandEntry::Program(program),
            } => Self::Program(program),
            IdentityEntry::Command {
                command: CommandEntry::Matcher { executable, args },
            } => Self::Command {
                executable,
                args: args
                    .into_iter()
                    .map(ValueMatcher::compile)
                    .collect::<Result<_, _>>()?,
            },
            IdentityEntry::Url {
                url: ValueEntry::Exact(url),
            } => Self::Url(ValueMatcher::Exact(url)),
            IdentityEntry::Url {
                url: ValueEntry::Matcher(matcher),
            } => Self::Url(ValueMatcher::compile(matcher)?),
        })
    }

    fn matches(&self, transport: &CodexServerTransport) -> bool {
        match (self, transport) {
            (Self::Program(program), CodexServerTransport::Command { command, .. }) => {
                command == program
            }
            (
                Self::Command { executable, args },
                CodexServerTransport::Command {
                    command,
                    args: declared,
                },
            ) => {
                command == executable
                    && args.len() == declared.len()
                    && args
                        .iter()
                        .zip(declared)
                        .all(|(matcher, argument)| matcher.matches(argument))
            }
            (Self::Url(matcher), CodexServerTransport::Url(url)) => matcher.matches(url),
            _ => false,
        }
    }
}

// One value's matcher, a pattern matched against the whole value as Codex matches it.
enum ValueMatcher {
    Exact(String),
    Prefix(String),
    Pattern(Regex),
}

impl ValueMatcher {
    fn compile(entry: ValueMatcherEntry) -> Result<Self, String> {
        Ok(match entry {
            ValueMatcherEntry::Exact { value } => Self::Exact(value),
            ValueMatcherEntry::Prefix { value } => Self::Prefix(value),
            ValueMatcherEntry::Regex { expression } => Self::Pattern(
                Regex::new(&format!(r"\A(?:{expression})\z"))
                    .map_err(|failure| format!("pattern `{expression}`: {failure}"))?,
            ),
        })
    }

    fn matches(&self, value: &str) -> bool {
        match self {
            Self::Exact(exact) => value == exact,
            Self::Prefix(prefix) => value.starts_with(prefix.as_str()),
            Self::Pattern(pattern) => pattern.is_match(value),
        }
    }
}
