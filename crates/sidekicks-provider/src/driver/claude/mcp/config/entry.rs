//! The read of single server entries as the person wrote them, values included, for a probe that
//! sends each and drops it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sidekicks_contracts::mcp::server::McpServerBindingRef;

use super::{ClaudePersonConfigFiles, SERVERS_FILE, read_json_file};
use crate::driver::claude::session::ignored_settings::ClaudeSettingsReadError;

/// Reads server entries for one probe, each file it needs read once however many entries it holds.
/// An entry it returns is a JSON value with its values included, never printed.
pub(crate) struct ClaudeServerEntryReader<'sources> {
    person: &'sources ClaudePersonConfigFiles,
    // Each file read so far, by its path; `None` for one absent or unreadable.
    files: HashMap<PathBuf, Option<Value>>,
}

impl<'sources> ClaudeServerEntryReader<'sources> {
    /// A reader of the person's files, holding nothing yet.
    pub(crate) fn new(person: &'sources ClaudePersonConfigFiles) -> Self {
        Self {
            person,
            files: HashMap::new(),
        }
    }

    /// `binding`'s entry: a `user` or `local` entry in `.claude.json`, or a `project` entry in the
    /// root's `.mcp.json`. `None` where the file or the entry is gone, and for a binding no config
    /// file of the person's declares; fails as the config read does.
    pub(crate) async fn read(
        &mut self,
        binding: &McpServerBindingRef,
    ) -> Result<Option<Value>, ClaudeSettingsReadError> {
        let person = self.person;
        match binding {
            McpServerBindingRef::User { server_name, .. } => Ok(entry_at(
                self.read_file(&person.person_config).await?,
                &["mcpServers", server_name.as_str()],
            )),
            McpServerBindingRef::Local {
                scope_ref,
                server_name,
                ..
            } => Ok(entry_at(
                self.read_file(&person.person_config).await?,
                &[
                    "projects",
                    scope_ref.as_str(),
                    "mcpServers",
                    server_name.as_str(),
                ],
            )),
            McpServerBindingRef::Project {
                scope_ref,
                server_name,
                ..
            } => Ok(entry_at(
                self.read_file(&Path::new(scope_ref.as_str()).join(SERVERS_FILE))
                    .await?,
                &["mcpServers", server_name.as_str()],
            )),
            McpServerBindingRef::Plugin { .. }
            | McpServerBindingRef::Connector { .. }
            | McpServerBindingRef::Managed { .. } => Ok(None),
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
