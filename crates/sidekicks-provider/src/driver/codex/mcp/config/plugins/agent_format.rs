//! A plugin in the Agent Plugins format: a root `plugin.json` naming the format's schema, its
//! servers in the root `mcp.json` with that file's own schema, each typed `stdio` or
//! `streamable-http`. Each server is read into the entry Codex's config takes, as Codex normalizes
//! one: the plugin's folder and data folder filled in where an entry names them, a program and a
//! working folder kept inside the plugin's folder, and an address refused where Codex refuses it.

use std::collections::BTreeMap;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use serde_json::{Map, Value};
use url::Url;

use super::{PluginFileReadError, read_json_file};

// The manifest at the plugin's root, and the schema prefix that makes it this format's.
const MANIFEST_FILE: &str = "plugin.json";
const SCHEMA_PREFIX: &str = "https://agent-plugins.org/schemas/";
const MANIFEST_SCHEMA: &str = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
// The servers' file at the plugin's root and its schema.
const MCP_FILE: &str = "mcp.json";
const MCP_SCHEMA: &str = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
// The variables a server's arguments, environment and working folder name the plugin's folder and
// its data folder by, which Codex also sets in the program's environment.
const PLUGIN_ROOT_VARIABLE: &str = "PLUGIN_ROOT";
const PLUGIN_DATA_VARIABLE: &str = "PLUGIN_DATA";
// The folder in the plugin's folder Codex keeps the plugin's data in.
const PLUGIN_DATA_FOLDER: &str = ".plugin-data";
// The prefix of a path inside the plugin's folder.
const RELATIVE_PREFIX: &str = "./";
// Headers the client owns, which Codex drops from a server's entry.
const CLIENT_OWNED_HEADERS: [&str; 2] = ["authorization", "mcp-session-id"];

/// The servers of the plugin at `plugin_root`, by name, as entries of Codex's config, where its
/// root `plugin.json` names this format's schema; `None` where it has no such manifest and Codex
/// reads the plugin in its own format. A server Codex refuses is logged and skipped, and the data
/// folder its programs are given is made in the plugin's folder. Fails as a
/// file cannot be read or is not of the format's shape, or the manifest names a version of the
/// format Codex does not read.
pub(super) async fn read_agent_format_servers(
    plugin_root: &Path,
) -> Result<Option<Map<String, Value>>, PluginFileReadError> {
    let manifest_path = plugin_root.join(MANIFEST_FILE);
    // Codex takes no link and nothing but a file as the manifest, and then reads no manifest.
    match tokio::fs::symlink_metadata(&manifest_path).await {
        Ok(metadata) if !metadata.file_type().is_file() => return Ok(Some(Map::new())),
        Ok(_metadata) => {}
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(failure) => {
            return Err(PluginFileReadError::Unreadable {
                path: manifest_path,
                failure,
            });
        }
    }
    let Some(manifest) = read_json_file(&manifest_path).await? else {
        return Ok(None);
    };
    match manifest.get("$schema").and_then(Value::as_str) {
        Some(MANIFEST_SCHEMA) => {}
        Some(schema) if schema.starts_with(SCHEMA_PREFIX) => {
            return Err(PluginFileReadError::Malformed {
                path: manifest_path,
                failure: None,
            });
        }
        Some(_) | None => return Ok(None),
    }
    let mcp_path = plugin_root.join(MCP_FILE);
    match tokio::fs::symlink_metadata(&mcp_path).await {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_metadata) => {
            tracing::warn!(
                file = %mcp_path.display(),
                "an agent plugin's mcp file is not a file; it declares no servers"
            );
            return Ok(Some(Map::new()));
        }
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(Some(Map::new())),
        Err(failure) => {
            return Err(PluginFileReadError::Unreadable {
                path: mcp_path,
                failure,
            });
        }
    }
    let Some(file) = read_json_file(&mcp_path).await? else {
        return Ok(Some(Map::new()));
    };
    let file = AgentFormatMcpFile::deserialize(&file)
        .ok()
        .filter(|file| file.schema == MCP_SCHEMA)
        .ok_or(PluginFileReadError::Malformed {
            path: mcp_path,
            failure: None,
        })?;
    let folders = PluginFolders {
        root: plugin_root.to_path_buf(),
        data: plugin_root.join(PLUGIN_DATA_FOLDER),
    };
    let mut servers = Map::new();
    for (name, server) in file.mcp_servers {
        match AgentFormatServer::deserialize(&server)
            .map_err(|failure| failure.to_string())
            .and_then(|server| folders.compose_entry(server))
        {
            Ok(entry) => {
                servers.insert(name, Value::Object(entry));
            }
            Err(reason) => tracing::warn!(
                server = %name,
                plugin = %plugin_root.display(),
                reason = %reason,
                "codex skips an agent plugin's server; it is not declared"
            ),
        }
    }
    // Codex makes the data folder its programs are given, and drops them where it cannot.
    let has_programs = servers.values().any(|entry| entry.get("command").is_some());
    if has_programs && let Err(failure) = tokio::fs::create_dir_all(&folders.data).await {
        tracing::warn!(
            folder = %folders.data.display(),
            error = &failure as &(dyn std::error::Error + 'static),
            "an agent plugin's data folder cannot be made; codex skips its programs"
        );
        servers.retain(|_name, entry| entry.get("command").is_none());
    }
    Ok(Some(servers))
}

// The servers' file.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentFormatMcpFile {
    #[serde(rename = "$schema")]
    schema: String,
    mcp_servers: BTreeMap<String, Value>,
}

// One server of the servers' file. Its values may carry credentials and are never printed.
#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum AgentFormatServer {
    #[serde(rename = "stdio")]
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        cwd: Option<String>,
    },
    #[serde(rename = "streamable-http")]
    StreamableHttp {
        url: String,
        headers: Option<BTreeMap<String, String>>,
    },
    #[serde(rename = "sse")]
    Sse {},
}

// The plugin's folder and its data folder, which a server's entry names.
struct PluginFolders {
    root: PathBuf,
    data: PathBuf,
}

impl PluginFolders {
    // `server` as the entry Codex's config takes; the reason Codex refuses it otherwise.
    fn compose_entry(&self, server: AgentFormatServer) -> Result<Map<String, Value>, String> {
        let mut entry = Map::new();
        match server {
            AgentFormatServer::Stdio {
                command,
                args,
                env,
                cwd,
            } => {
                let command = match command.strip_prefix(RELATIVE_PREFIX) {
                    Some(relative) => self.contain(&self.root, relative)?,
                    None if is_bare_name(&command) => command,
                    None => return Err("the program is neither a name nor in the plugin".into()),
                };
                if env.contains_key(PLUGIN_ROOT_VARIABLE) || env.contains_key(PLUGIN_DATA_VARIABLE)
                {
                    return Err("the environment sets the plugin's own folders".into());
                }
                let cwd = match cwd {
                    None => self.root.display().to_string(),
                    Some(cwd) => self.resolve_working_folder(&cwd)?,
                };
                let mut env: Map<String, Value> = env
                    .into_iter()
                    .map(|(name, value)| (name, Value::String(self.expand(&value))))
                    .collect();
                env.insert(
                    PLUGIN_ROOT_VARIABLE.to_owned(),
                    Value::String(self.root.display().to_string()),
                );
                env.insert(
                    PLUGIN_DATA_VARIABLE.to_owned(),
                    Value::String(self.data.display().to_string()),
                );
                entry.insert("command".to_owned(), Value::String(command));
                entry.insert(
                    "args".to_owned(),
                    args.iter()
                        .map(|argument| Value::String(self.expand(argument)))
                        .collect(),
                );
                entry.insert("env".to_owned(), Value::Object(env));
                entry.insert("cwd".to_owned(), Value::String(cwd));
            }
            AgentFormatServer::StreamableHttp { url, headers } => {
                check_address(&url)?;
                entry.insert("url".to_owned(), Value::String(url));
                let headers: Map<String, Value> = headers
                    .into_iter()
                    .flatten()
                    .filter(|(name, _value)| {
                        !CLIENT_OWNED_HEADERS
                            .iter()
                            .any(|owned| name.eq_ignore_ascii_case(owned))
                    })
                    .map(|(name, value)| (name, Value::String(value)))
                    .collect();
                if !headers.is_empty() {
                    entry.insert("http_headers".to_owned(), Value::Object(headers));
                }
            }
            AgentFormatServer::Sse {} => {
                return Err("the legacy SSE transport is not one Codex reads".into());
            }
        }
        Ok(entry)
    }

    // `value` with the plugin's folder and data folder filled in where it names them.
    fn expand(&self, value: &str) -> String {
        value
            .replace(
                &format!("${{{PLUGIN_ROOT_VARIABLE}}}"),
                &self.root.display().to_string(),
            )
            .replace(
                &format!("${{{PLUGIN_DATA_VARIABLE}}}"),
                &self.data.display().to_string(),
            )
    }

    // A working folder `./…`, `${PLUGIN_ROOT}[/…]` or `${PLUGIN_DATA}[/…]`, kept inside its folder.
    fn resolve_working_folder(&self, cwd: &str) -> Result<String, String> {
        if let Some(relative) = cwd.strip_prefix(RELATIVE_PREFIX) {
            return self.contain(&self.root, relative);
        }
        for (variable, folder) in [
            (PLUGIN_ROOT_VARIABLE, &self.root),
            (PLUGIN_DATA_VARIABLE, &self.data),
        ] {
            let Some(rest) = cwd.strip_prefix(&format!("${{{variable}}}")) else {
                continue;
            };
            if rest.is_empty() {
                return Ok(folder.display().to_string());
            }
            if let Some(relative) = rest.strip_prefix('/') {
                return self.contain(folder, relative);
            }
        }
        Err("the working folder is not in the plugin's folders".into())
    }

    // `relative` in `folder`, refused where it climbs out of it or is absolute.
    fn contain(&self, folder: &Path, relative: &str) -> Result<String, String> {
        let path = Path::new(relative);
        if path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
        {
            return Err("a path leaves the plugin's folder".into());
        }
        Ok(folder.join(path).display().to_string())
    }
}

// Whether `command` is a program's name alone, found on the search path.
fn is_bare_name(command: &str) -> bool {
    !command.is_empty() && !command.contains(['/', '\\'])
}

// Refuses an address Codex refuses: one not absolute `http` or `https`, one carrying a user name,
// password or fragment, and plain `http` to anything but the loopback.
fn check_address(address: &str) -> Result<(), String> {
    let url = Url::parse(address).map_err(|_failure| "the address is not absolute".to_owned())?;
    let is_loopback = match url.host() {
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    match url.scheme() {
        "https" => {}
        "http" if is_loopback => {}
        _ => return Err("the address is neither https nor http to the loopback".into()),
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("the address carries a user name, password or fragment".into());
    }
    Ok(())
}
