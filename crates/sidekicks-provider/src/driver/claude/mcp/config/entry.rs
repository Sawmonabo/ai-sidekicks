//! The read of single server entries as the person wrote them, values included, for a probe that
//! sends each and drops it.

use std::path::{Path, PathBuf};

use serde_json::Value;
use sidekicks_contracts::mcp::server::McpServerBindingRef;

use super::{
    ClaudePersonConfigFiles, InstalledPluginRoot, SERVERS_FILE, plugin_server_files,
    read_installed_plugin_roots, read_json_file,
};
use crate::driver::claude::session::ignored_settings::ClaudeSettingsReadError;

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
    /// Its data folder: `plugins/data/<id>` in the plugin home, each character of the id outside
    /// letters, digits, `-` and `_` written `-`.
    pub(crate) data: PathBuf,
}

/// Reads server entries for one probe, each file it needs read once however many entries it holds.
pub(crate) struct ClaudeServerEntryReader<'sources> {
    person: &'sources ClaudePersonConfigFiles,
    plugin_home: &'sources Path,
    person_config: Option<Option<Value>>,
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
            person_config: None,
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
        match binding {
            McpServerBindingRef::User { server_name, .. } => Ok(declared(entry_at(
                self.person_config().await?,
                &["mcpServers", server_name.as_str()],
            ))),
            McpServerBindingRef::Local {
                scope_ref,
                server_name,
                ..
            } => Ok(declared(entry_at(
                self.person_config().await?,
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
                read_json_file(&Path::new(scope_ref.as_str()).join(SERVERS_FILE))
                    .await?
                    .as_ref(),
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
                let plugins = self.plugins.as_deref().unwrap_or_default();
                for plugin in plugins.iter().filter(|plugin| plugin.name == *scope_ref) {
                    for file in plugin_server_files(&plugin.root) {
                        let file: Option<Value> = read_json_file(&file).await?;
                        if let Some(entry) =
                            entry_at(file.as_ref(), &["mcpServers", server_name.as_str()])
                        {
                            return Ok(Some(ClaudeDeclaredEntry {
                                entry,
                                plugin_folders: Some(ClaudePluginFolders {
                                    root: plugin.root.clone(),
                                    data: plugin_data_folder(self.plugin_home, &plugin.id),
                                }),
                            }));
                        }
                    }
                }
                Ok(None)
            }
            McpServerBindingRef::Connector { .. } | McpServerBindingRef::Managed { .. } => Ok(None),
        }
    }

    // The person's `.claude.json`, read on first use.
    async fn person_config(&mut self) -> Result<Option<&Value>, ClaudeSettingsReadError> {
        if self.person_config.is_none() {
            self.person_config = Some(read_json_file(&self.person.person_config).await?);
        }
        Ok(self.person_config.as_ref().and_then(Option::as_ref))
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

// The data folder Claude Code keeps for the plugin `plugin_id` in `plugin_home`.
fn plugin_data_folder(plugin_home: &Path, plugin_id: &str) -> PathBuf {
    let folder_name: String = plugin_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect();
    plugin_home.join("plugins").join("data").join(folder_name)
}
