//! The servers of the plugins installed in the daemon's plugin home for Codex, laid out as Codex
//! lays out its own home's plugins: `plugins/cache/<marketplace>/<plugin>/<version>/`, each
//! plugin's servers in the MCP file its manifest names, or written inline in the manifest, or, for
//! a plugin in the Agent Plugins format, in its own servers' file.

use std::cmp::Ordering;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};

use semver::Version;
use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::plugin::PluginToken;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::mcp::config::server_entry::{
    CodexServerTransport, ENABLED_MEMBER, read_codex_server_entry, read_codex_server_transport,
};
use crate::driver::mcp_server::read::McpServerDeclaration;
use crate::inbound_json::decode_inbound_json;

mod agent_format;

use agent_format::read_agent_format_servers;

// The folder of a Codex home that holds each installed plugin's versions.
const PLUGIN_CACHE_FOLDER: [&str; 2] = ["plugins", "cache"];
// The version folder a plugin installed from a local source keeps, which wins over any other.
const LOCAL_PLUGIN_VERSION: &str = "local";
// Where a plugin's manifest may sit under its folder, in the order Codex looks.
const MANIFEST_PATHS: [[&str; 2]; 3] = [
    [".codex-plugin", "plugin.json"],
    [".claude-plugin", "plugin.json"],
    [".cursor-plugin", "plugin.json"],
];
// The MCP file a plugin's folder holds where its manifest names none.
const DEFAULT_MCP_FILE: &str = ".mcp.json";
// The member of an MCP file, or of a manifest, holding the servers.
const MCP_SERVERS_MEMBER: &str = "mcpServers";
// The prefix a manifest's path to its MCP file starts with, relative to the plugin's folder.
const MANIFEST_PATH_PREFIX: &str = "./";
// The member of a plugin's server entry naming its transport, which Codex's config does not take.
const TRANSPORT_TYPE_MEMBER: &str = "type";
// The member of a server entry holding its sign-in client.
const OAUTH_MEMBER: &str = "oauth";
// The sign-in client's members a plugin's file may spell in camel case, and Codex's spelling.
const OAUTH_MEMBER_SPELLINGS: [(&str, &str); 4] = [
    ("callbackUrl", "callback_url"),
    ("callbackPort", "callback_port"),
    ("clientId", "client_id"),
    ("clientSecret", "client_secret"),
];
// The member of a stdio server's entry naming the folder it runs in.
const WORKING_FOLDER_MEMBER: &str = "cwd";

/// One server a plugin in the daemon's plugin home declares: its redacted declaration, and its entry
/// as the plugin's file writes it, credential values included, for the probe that sends it. It
/// derives no `Debug`, so nothing prints a value.
pub(crate) struct CodexPluginServer {
    /// The declaration, bound to its plugin and read-only.
    pub(crate) declaration: McpServerDeclaration,
    /// The key Codex's config names the plugin by: `<plugin>@<marketplace>`.
    pub(crate) plugin_key: String,
    /// The entry as the plugin's file writes it.
    entry: Map<String, Value>,
    /// The folder of the plugin's version Codex runs, which a relative working folder names.
    plugin_root: PathBuf,
}

impl CodexPluginServer {
    /// The transport its entry declares, as Codex compares it with its requirements.
    pub(crate) fn read_transport(&self) -> Option<CodexServerTransport> {
        read_codex_server_transport(&Value::Object(self.entry.clone()))
    }

    /// The entry as Codex's config takes it, as Codex reads its own plugins' entries: the
    /// transport's `type` dropped, the sign-in client's members in Codex's spelling, a relative
    /// working folder made absolute in the plugin's folder, and the server switched on.
    pub(crate) fn compose_codex_entry(&self) -> Map<String, Value> {
        let mut entry = self.entry.clone();
        entry.remove(TRANSPORT_TYPE_MEMBER);
        if let Some(Value::Object(mut oauth)) = entry.remove(OAUTH_MEMBER) {
            for (spelled, codex_spelling) in OAUTH_MEMBER_SPELLINGS {
                if let Some(value) = oauth.remove(spelled) {
                    oauth.entry(codex_spelling).or_insert(value);
                }
            }
            if !oauth.is_empty() {
                entry.insert(OAUTH_MEMBER.to_owned(), Value::Object(oauth));
            }
        }
        if let Some(Value::String(folder)) = entry.get(WORKING_FOLDER_MEMBER)
            && !Path::new(folder).is_absolute()
        {
            let folder = self.plugin_root.join(folder).display().to_string();
            entry.insert(WORKING_FOLDER_MEMBER.to_owned(), Value::String(folder));
        }
        entry.insert(ENABLED_MEMBER.to_owned(), Value::Bool(true));
        entry
    }
}

/// The servers each plugin in `plugin_home` declares, read-only and bound to their plugin, with the
/// entries their files write. A malformed server entry is skipped, and a plugin whose files cannot
/// be read is logged and declares none.
pub(crate) async fn read_plugin_server_entries(plugin_home: &Path) -> Vec<CodexPluginServer> {
    let cache = PLUGIN_CACHE_FOLDER
        .iter()
        .fold(plugin_home.to_path_buf(), |folder, name| folder.join(name));
    let mut servers: Vec<CodexPluginServer> = Vec::new();
    for marketplace in list_folder_names(&cache).await {
        let marketplace_folder = cache.join(&marketplace);
        for plugin in list_folder_names(&marketplace_folder).await {
            let Ok(plugin_name) = PluginToken::new(plugin.clone()) else {
                continue;
            };
            let plugin_folder = marketplace_folder.join(&plugin);
            let Some(version) = pick_active_version(list_folder_names(&plugin_folder).await) else {
                continue;
            };
            let plugin_root = plugin_folder.join(version);
            let entries = match read_plugin_server_map(&plugin_root).await {
                Ok(entries) => entries,
                Err(error) => {
                    tracing::warn!(
                        plugin = %plugin,
                        marketplace = %marketplace,
                        error = &error as &(dyn Error + 'static),
                        "a codex plugin's mcp servers could not be read; it declares none"
                    );
                    continue;
                }
            };
            for (name, entry) in entries {
                let Ok(server_name) = McpServerName::new(name) else {
                    continue;
                };
                let (Some(declared), Value::Object(entry)) =
                    (read_codex_server_entry(&entry), entry)
                else {
                    continue;
                };
                let binding = McpServerBindingRef::Plugin {
                    provider: DESCRIPTOR.provider_id(),
                    scope_ref: plugin_name.clone(),
                    server_name,
                };
                if servers
                    .iter()
                    .any(|kept| kept.declaration.binding == binding)
                {
                    continue;
                }
                servers.push(CodexPluginServer {
                    declaration: McpServerDeclaration {
                        binding,
                        config: declared.config,
                        superseded_in: Vec::new(),
                        disabled_in: Vec::new(),
                        is_read_only: true,
                        sign_in_client: declared.sign_in_client,
                        is_switch_kept_by_daemon: true,
                        tool_defaults: declared.tool_defaults,
                        organization_managed: None,
                    },
                    plugin_key: format!("{plugin}@{marketplace}"),
                    entry,
                    plugin_root: plugin_root.clone(),
                });
            }
        }
    }
    servers
}

/// Why one plugin's servers could not be read.
#[derive(Debug, thiserror::Error)]
enum PluginFileReadError {
    /// A file could not be read.
    #[error("{} could not be read", path.display())]
    Unreadable {
        /// The file.
        path: PathBuf,
        /// The system's error.
        #[source]
        failure: io::Error,
    },
    /// A file is not JSON of the shape Codex reads.
    #[error("{} is not a plugin manifest or MCP file Codex reads", path.display())]
    Malformed {
        /// The file.
        path: PathBuf,
        /// The parse error, where the file is not JSON at all.
        #[source]
        failure: Option<serde_json::Error>,
    },
}

// The members of a plugin's manifest the read takes.
#[derive(Deserialize)]
struct CodexPluginManifest {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: Option<Value>,
}

// The servers of the plugin in `plugin_root`, by name: none where it has no manifest. A plugin in
// the Agent Plugins format is read in its own format first, as Codex reads it.
async fn read_plugin_server_map(
    plugin_root: &Path,
) -> Result<Map<String, Value>, PluginFileReadError> {
    if let Some(servers) = read_agent_format_servers(plugin_root).await? {
        return Ok(servers);
    }
    let mut manifest = None;
    for [folder, file] in MANIFEST_PATHS {
        let path = plugin_root.join(folder).join(file);
        if let Some(value) = read_json_file(&path).await? {
            manifest = Some((path, value));
            break;
        }
    }
    let Some((manifest_path, manifest)) = manifest else {
        return Ok(Map::new());
    };
    let manifest = CodexPluginManifest::deserialize(&manifest).map_err(|failure| {
        PluginFileReadError::Malformed {
            path: manifest_path.clone(),
            failure: Some(failure),
        }
    })?;
    let mcp_file = match manifest.mcp_servers {
        Some(inline @ Value::Object(_)) => {
            return read_server_map(inline).ok_or(PluginFileReadError::Malformed {
                path: manifest_path,
                failure: None,
            });
        }
        // Codex ignores a path that leaves the plugin's folder, and then reads the default file.
        Some(Value::String(path)) => resolve_manifest_path(plugin_root, &path)
            .unwrap_or_else(|| plugin_root.join(DEFAULT_MCP_FILE)),
        Some(_) | None => plugin_root.join(DEFAULT_MCP_FILE),
    };
    match read_json_file(&mcp_file).await? {
        Some(file) => read_server_map(file).ok_or(PluginFileReadError::Malformed {
            path: mcp_file,
            failure: None,
        }),
        None => Ok(Map::new()),
    }
}

// The servers of an MCP file: `{"mcpServers": {…}}`, or the map of servers itself.
fn read_server_map(file: Value) -> Option<Map<String, Value>> {
    let Value::Object(mut members) = file else {
        return None;
    };
    match members.remove(MCP_SERVERS_MEMBER) {
        Some(Value::Object(servers)) => Some(servers),
        Some(other) => {
            members.insert(MCP_SERVERS_MEMBER.to_owned(), other);
            Some(members)
        }
        None => Some(members),
    }
}

// The file a manifest's `./`-relative path names in `plugin_root`; `None` for a path Codex
// refuses: one without the prefix, one naming the folder itself, or one climbing out of it.
fn resolve_manifest_path(plugin_root: &Path, path: &str) -> Option<PathBuf> {
    let relative = path.strip_prefix(MANIFEST_PATH_PREFIX)?;
    if relative.is_empty() || relative.split(['/', '\\']).any(|part| part == "..") {
        return None;
    }
    Some(plugin_root.join(relative))
}

// The JSON in `path`; `None` where there is no such file.
async fn read_json_file(path: &Path) -> Result<Option<Value>, PluginFileReadError> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(failure) => {
            return Err(PluginFileReadError::Unreadable {
                path: path.to_path_buf(),
                failure,
            });
        }
    };
    serde_json::from_str(&decode_inbound_json(&bytes))
        .map(Some)
        .map_err(|failure| PluginFileReadError::Malformed {
            path: path.to_path_buf(),
            failure: Some(failure),
        })
}

// The names of the folders in `folder`, sorted; none where it cannot be listed, which is logged
// unless it is absent.
async fn list_folder_names(folder: &Path) -> Vec<String> {
    let listed = async {
        let mut entries = tokio::fs::read_dir(folder).await?;
        let mut names = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            if entry.file_type().await?.is_dir()
                && let Ok(name) = entry.file_name().into_string()
            {
                names.push(name);
            }
        }
        Ok::<_, io::Error>(names)
    }
    .await;
    match listed {
        Ok(mut names) => {
            names.sort();
            names
        }
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(failure) => {
            tracing::warn!(
                folder = %folder.display(),
                error = &failure as &(dyn Error + 'static),
                "a codex plugin folder could not be listed; its plugins declare no servers"
            );
            Vec::new()
        }
    }
}

// The version Codex runs of a plugin with these version folders: `local` where it is one, else the
// highest, by semantic version where both read as one and by name otherwise.
fn pick_active_version(versions: Vec<String>) -> Option<String> {
    let mut versions: Vec<String> = versions
        .into_iter()
        .filter(|version| is_version_folder_name(version))
        .collect();
    if versions
        .iter()
        .any(|version| version == LOCAL_PLUGIN_VERSION)
    {
        return Some(LOCAL_PLUGIN_VERSION.to_owned());
    }
    versions.sort_by(|left, right| compare_plugin_versions(left, right));
    versions.pop()
}

fn is_version_folder_name(version: &str) -> bool {
    !matches!(version, "." | "..")
        && version.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '+')
        })
}

fn compare_plugin_versions(left: &str, right: &str) -> Ordering {
    match (Version::parse(left), Version::parse(right)) {
        (Ok(left), Ok(right)) => left.cmp(&right),
        _ => left.cmp(right),
    }
}
