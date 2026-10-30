//! The read of single server entries as the person wrote them, values included, for a probe that
//! sends each and drops it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sidekicks_contracts::mcp::server::McpServerBindingRef;

use super::{
    ClaudePersonConfigFiles, InstalledPluginRoot, SERVERS_FILE, read_installed_plugin_roots,
    read_json_file,
};
use crate::driver::claude::session::ignored_settings::ClaudeSettingsReadError;

// The built-in marketplace that installs plugins from npm packages.
const NPM_MARKETPLACE: &str = "npm";

/// One server's entry as the person wrote it, values included, and, for a plugin's server, the
/// plugin's install root and data folder. It derives no `Debug`, so nothing prints a value.
pub(crate) struct ClaudeDeclaredEntry {
    /// The entry.
    pub(crate) entry: Value,
    /// The plugin's install root and data folder, for a plugin's server.
    pub(crate) plugin_folders: Option<ClaudePluginFolders>,
}

/// A plugin's install root and the data folder Claude Code keeps for it.
pub(crate) struct ClaudePluginFolders {
    /// The plugin's install root.
    pub(crate) root: PathBuf,
    /// Its data folder: `plugins/data/<folder>` in the plugin home, the folder named from the
    /// plugin's id as Claude Code names it.
    pub(crate) data: PathBuf,
}

/// Reads server entries for one probe, each file it needs read once however many entries it holds.
pub(crate) struct ClaudeServerEntryReader<'sources> {
    person: &'sources ClaudePersonConfigFiles,
    plugin_home: &'sources Path,
    // Each file read so far, by its path; `None` for one absent or unreadable.
    files: HashMap<PathBuf, Option<Value>>,
    plugins: Option<Vec<InstalledPluginRoot>>,
}

impl<'sources> ClaudeServerEntryReader<'sources> {
    /// A reader of the person's files and the plugins in `plugin_home`, holding nothing yet.
    pub(crate) fn new(
        person: &'sources ClaudePersonConfigFiles,
        plugin_home: &'sources Path,
    ) -> Self {
        Self {
            person,
            plugin_home,
            files: HashMap::new(),
            plugins: None,
        }
    }

    /// `binding`'s entry: a `user` or `local` entry in `.claude.json`, a `project` entry in the
    /// root's `.mcp.json`, or a plugin's entry with its folders. `None` where the file or the
    /// entry is gone, and for a binding no config file declares; fails as the config read does.
    pub(crate) async fn read(
        &mut self,
        binding: &McpServerBindingRef,
    ) -> Result<Option<ClaudeDeclaredEntry>, ClaudeSettingsReadError> {
        let declared = |entry: Option<Value>| {
            entry.map(|entry| ClaudeDeclaredEntry {
                entry,
                plugin_folders: None,
            })
        };
        let person = self.person;
        match binding {
            McpServerBindingRef::User { server_name, .. } => Ok(declared(entry_at(
                self.read_file(&person.person_config).await?,
                &["mcpServers", server_name.as_str()],
            ))),
            McpServerBindingRef::Local {
                scope_ref,
                server_name,
                ..
            } => Ok(declared(entry_at(
                self.read_file(&person.person_config).await?,
                &[
                    "projects",
                    scope_ref.as_str(),
                    "mcpServers",
                    server_name.as_str(),
                ],
            ))),
            McpServerBindingRef::Project {
                scope_ref,
                server_name,
                ..
            } => Ok(declared(entry_at(
                self.read_file(&Path::new(scope_ref.as_str()).join(SERVERS_FILE))
                    .await?,
                &["mcpServers", server_name.as_str()],
            ))),
            McpServerBindingRef::Plugin {
                scope_ref,
                server_name,
                ..
            } => {
                if self.plugins.is_none() {
                    self.plugins = Some(read_installed_plugin_roots(self.plugin_home).await?);
                }
                let keys = ["mcpServers", server_name.as_str()];
                // Each plugin of the name, with the entry its manifest declares inline.
                let plugins: Vec<(PathBuf, String, Option<Value>)> = self
                    .plugins
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .filter(|plugin| plugin.name == *scope_ref)
                    .map(|plugin| {
                        let inline = entry_at(plugin.manifest.as_ref(), &keys);
                        (plugin.root.clone(), plugin.id.clone(), inline)
                    })
                    .collect();
                for (root, id, inline) in plugins {
                    let in_servers_file =
                        entry_at(self.read_file(&root.join(SERVERS_FILE)).await?, &keys);
                    if let Some(entry) = in_servers_file.or(inline) {
                        return Ok(Some(ClaudeDeclaredEntry {
                            entry,
                            plugin_folders: Some(ClaudePluginFolders {
                                data: plugin_data_folder(self.plugin_home, &id),
                                root,
                            }),
                        }));
                    }
                }
                Ok(None)
            }
            McpServerBindingRef::Connector { .. } | McpServerBindingRef::Managed { .. } => Ok(None),
        }
    }

    // The JSON file at `path`, read on its first use in this probe.
    async fn read_file(&mut self, path: &Path) -> Result<Option<&Value>, ClaudeSettingsReadError> {
        if !self.files.contains_key(path) {
            let file = read_json_file(path).await?;
            self.files.insert(path.to_path_buf(), file);
        }
        Ok(self.files.get(path).and_then(Option::as_ref))
    }
}

// The value at `keys` in `file`, copied.
fn entry_at(file: Option<&Value>, keys: &[&str]) -> Option<Value> {
    let mut entry = file?;
    for key in keys {
        entry = entry.get(*key)?;
    }
    Some(entry.clone())
}

// The data folder Claude Code keeps for the plugin `plugin_id` in `plugin_home`, named for it: a
// plugin of the built-in npm marketplace by its package name with each character outside
// lowercase letters, digits and `-` escaped, then `-npm`; any other plugin by its id with each
// character outside letters, digits, `-` and `_` written `-`.
fn plugin_data_folder(plugin_home: &Path, plugin_id: &str) -> PathBuf {
    let folder_name = match npm_package_name(plugin_id) {
        Some(package_name) => format!(
            "{}-{NPM_MARKETPLACE}",
            escape_npm_package_name(package_name)
        ),
        None => plugin_id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                    character
                } else {
                    '-'
                }
            })
            .collect(),
    };
    plugin_home.join("plugins").join("data").join(folder_name)
}

// The package name of a plugin id from the built-in npm marketplace, `<package>@npm` with a package
// name npm accepts: no `..`, and `[a-z0-9][a-z0-9-._]*`, optionally scoped as `@<scope>/` of the
// same form; `None` for any other id.
fn npm_package_name(plugin_id: &str) -> Option<&str> {
    let package_name = plugin_id.strip_suffix(NPM_MARKETPLACE)?.strip_suffix('@')?;
    let is_name_part = |part: &str| {
        let mut characters = part.chars();
        characters
            .next()
            .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
            && characters.all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || matches!(character, '-' | '.' | '_')
            })
    };
    let is_valid = match package_name.strip_prefix('@') {
        Some(scoped) => scoped
            .split_once('/')
            .is_some_and(|(scope, name)| is_name_part(scope) && is_name_part(name)),
        None => is_name_part(package_name),
    };
    (is_valid && !package_name.contains("..")).then_some(package_name)
}

// A package name with each character outside lowercase letters, digits and `-` written `_` and its
// two hex digits; a checked package name holds ASCII alone.
fn escape_npm_package_name(package_name: &str) -> String {
    package_name
        .chars()
        .map(|character| {
            if character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-' {
                character.to_string()
            } else {
                format!("_{:02x}", u32::from(character))
            }
        })
        .collect()
}
