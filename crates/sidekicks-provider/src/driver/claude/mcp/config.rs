//! The read of the person's own Claude Code MCP config: the user and per-project servers in
//! `.claude.json`, each attached root's `.mcp.json`, the servers of the plugins in the daemon's
//! plugin home, the per-project names kept out of a root or switched off there, and the allow and
//! deny lists. Every credential-bearing value is dropped at the read: a declaration keeps names
//! only, and a remote address is held whole only in memory, for the duplicate match. The one read
//! that keeps values takes a single server's entry for the probe that sends it, which drops it
//! once sent.

mod entry;
mod plugin_manifest;
mod policy;

pub(crate) use self::entry::{ClaudeDeclaredEntry, ClaudeServerEntryReader};

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::{DeserializeOwned, IgnoredAny};
use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::plugin::PluginToken;
use sidekicks_platforms::PathRules;

use self::plugin_manifest::read_plugin_manifest_name;
use self::policy::read_server_policy;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::account_credentials::CUSTOM_SIGN_IN_HOST_VARIABLE;
use crate::driver::claude::session::ignored_settings::{
    ClaudeSettingsReadError, find_claude_setting, list_managed_settings_files,
};
use crate::driver::claude::session::rules::compose_claude_tool_server_name;
use crate::driver::claude::session::settings_file::{
    is_unreadable_path, read_claude_settings_file,
};
use crate::driver::mcp_server::address::{ServerAddressIdentity, read_server_address};
use crate::driver::mcp_server::read::McpServerPolicy;
use crate::inbound_json::decode_inbound_json;

// The settings key naming a project's `.mcp.json` servers its sessions refuse.
const DISABLED_MCPJSON_SERVERS_KEY: &str = "disabledMcpjsonServers";
// The variable that moves the person's Claude Code config folder, and their own config file
// there, holding the `user` and per-project servers, named `.claude<suffix>.json`.
const CONFIG_FOLDER_VARIABLE: &str = "CLAUDE_CONFIG_DIR";
const PERSON_CONFIG_FILE_STEM: &str = ".claude";
// The suffix the config file takes where Claude Code's sign-in moves to a custom host (`y2`,
// b:8908775).
const CUSTOM_SIGN_IN_CONFIG_SUFFIX: &str = "-custom-oauth";
// The legacy config file in the config folder, read in place of `.claude.json` where it holds
// anything.
const LEGACY_PERSON_CONFIG_FILE: &str = ".config.json";
// A project's or a plugin's file of servers.
const SERVERS_FILE: &str = ".mcp.json";

/// One attached project root and the folder its files are read at on this computer.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeMcpRoot {
    /// The root, with the distribution it is in; its path is the key `.claude.json` files the
    /// project under.
    pub(crate) root: PlacedPath,
    /// The folder the root's `.mcp.json` and settings files are read at.
    pub(crate) folder: PathBuf,
}

/// Where the person's own Claude Code config sits: `.claude.json` and `settings.json` in the
/// folder `CLAUDE_CONFIG_DIR` names where the person's environment sets it, as Claude Code reads
/// them, else `.claude.json` in the home folder and `settings.json` in its `.claude` folder; the
/// config file is `.claude-custom-oauth.json` where the environment sets
/// `CLAUDE_CODE_CUSTOM_OAUTH_URL`, and a non-empty legacy `.config.json` in that config folder is
/// read in place of either.
#[derive(Clone, Debug)]
pub(crate) struct ClaudePersonConfigFiles {
    /// The file of the `user` and per-project servers.
    pub(crate) person_config: PathBuf,
    /// The user settings file.
    pub(crate) user_settings: PathBuf,
}

impl ClaudePersonConfigFiles {
    /// The person's files as a Claude Code process started in `environment` on `home` reads them:
    /// the config file as `y_` (b:8961710) picks it, a non-empty `.config.json` in the config
    /// folder (`Le`, b:8610329) over `Flr`'s (b:8961898) `.claude.json`, which takes `y2`'s
    /// suffix where `CLAUDE_CODE_CUSTOM_OAUTH_URL` holds anything.
    pub(crate) async fn resolve(environment: &[(String, String)], home: &Path) -> Self {
        let suffix = PathRules::NATIVE
            .environment_value(environment, CUSTOM_SIGN_IN_HOST_VARIABLE)
            .filter(|host| !host.is_empty())
            .map_or("", |_host| CUSTOM_SIGN_IN_CONFIG_SUFFIX);
        let person_config_file = format!("{PERSON_CONFIG_FILE_STEM}{suffix}.json");
        let (config_folder, person_config) = match PathRules::NATIVE
            .environment_value(environment, CONFIG_FOLDER_VARIABLE)
            .filter(|folder| !folder.is_empty())
        {
            Some(folder) => (
                Path::new(folder).to_path_buf(),
                Path::new(folder).join(&person_config_file),
            ),
            None => (home.join(".claude"), home.join(&person_config_file)),
        };
        let legacy_config = config_folder.join(LEGACY_PERSON_CONFIG_FILE);
        let is_legacy_read = tokio::fs::metadata(&legacy_config)
            .await
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0);
        Self {
            person_config: if is_legacy_read {
                legacy_config
            } else {
                person_config
            },
            user_settings: config_folder.join("settings.json"),
        }
    }
}

/// Where the read finds the person's Claude Code config and the files beside it.
pub(crate) struct ClaudeMcpConfigSources<'sources> {
    /// The person's own config files.
    pub(crate) person: &'sources ClaudePersonConfigFiles,
    /// The folder of the administrator's managed settings; `None` where the system has none.
    pub(crate) managed_settings_folder: Option<&'sources Path>,
    /// The daemon's plugin home for Claude Code, laid out as Claude Code lays out its own.
    pub(crate) plugin_home: &'sources Path,
    /// The attached project roots.
    pub(crate) roots: &'sources [ClaudeMcpRoot],
}

/// One server a Claude Code config declares: its binding, its declaration with every
/// credential-bearing value reduced to its name, and what Claude Code's duplicate match compares
/// it by, held only in memory.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeMcpServer {
    /// The binding.
    pub(crate) binding: McpServerBindingRef,
    /// The redacted declaration.
    pub(crate) config: McpServerConfigView,
    /// What it is matched by; `None` for an address that does not parse, which matches nothing.
    pub(crate) endpoint: Option<ClaudeMcpEndpoint>,
    /// Whether the account's organization manages a connector's sign-in, as the organization's
    /// connector list reads it; `None` for every other server and where the list was not read.
    pub(crate) organization_managed: Option<bool>,
}

/// What Claude Code compares a plugin's server or a connector by to find that it duplicates a
/// server ranked above it: its folded whole address, or its command and arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeMcpEndpoint {
    /// A remote server's folded address.
    Address(ServerAddressIdentity),
    /// A program's command and arguments.
    Command {
        /// The program.
        command: String,
        /// Its arguments.
        args: Vec<String>,
    },
}

/// What the read found at one attached root.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeMcpRootConfig {
    /// The root.
    pub(crate) root: PlacedPath,
    /// The `local` servers `.claude.json` files under the root.
    pub(crate) local_servers: Vec<ClaudeMcpServer>,
    /// The `project` servers of the root's `.mcp.json`.
    pub(crate) project_servers: Vec<ClaudeMcpServer>,
    /// The names of `.mcp.json` servers the root's sessions refuse: `disabledMcpjsonServers`
    /// across the user, project, project-local and managed settings and the root's entry in
    /// `.claude.json`. Every other `.mcp.json` server loads, approved or not, since every process
    /// the daemon starts runs non-interactively with the project settings source on.
    pub(crate) kept_out_server_names: Vec<McpServerName>,
    /// The names Claude Code's own per-project switch turns off at the root.
    pub(crate) switched_off_server_names: Vec<McpServerName>,
}

/// Whether `kept_out_server_names` names `server_name`, matched as Claude Code's `e4t`
/// (b:8799138) matches them: a `plugin:` name exactly, any other after the fold of each character
/// outside ASCII letters, digits, `_` and `-` to `_`, so `my server` keeps out `my_server`.
pub(crate) fn is_kept_out_server(
    kept_out_server_names: &[McpServerName],
    server_name: &McpServerName,
) -> bool {
    let server_name = server_name.as_str();
    kept_out_server_names.iter().any(|kept_out| {
        let kept_out = kept_out.as_str();
        if kept_out.starts_with("plugin:") || server_name.starts_with("plugin:") {
            kept_out == server_name
        } else {
            compose_claude_tool_server_name(kept_out)
                == compose_claude_tool_server_name(server_name)
        }
    })
}

/// The person's Claude Code MCP config as the read found it.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeMcpConfigReading {
    /// The `user` servers.
    pub(crate) user_servers: Vec<ClaudeMcpServer>,
    /// The servers of the plugins installed in the daemon's plugin home.
    pub(crate) plugin_servers: Vec<ClaudeMcpServer>,
    /// What the read found at each attached root, in the order the roots were given.
    pub(crate) roots: Vec<ClaudeMcpRootConfig>,
    /// The allow and deny lists of the user and managed settings.
    pub(crate) server_policy: McpServerPolicy,
}

/// Reads the person's Claude Code MCP config from `sources`. A file that is absent, not the
/// daemon's to read or not JSON of the expected shape declares nothing; fails with the path and
/// the system's error on any other read failure.
pub(crate) async fn read_claude_mcp_config(
    sources: &ClaudeMcpConfigSources<'_>,
) -> Result<ClaudeMcpConfigReading, ClaudeSettingsReadError> {
    let provider = DESCRIPTOR.provider_id();
    let person_config: ClaudePersonConfigFile = read_json_file(&sources.person.person_config)
        .await?
        .unwrap_or_default();
    let user_settings = read_settings(&sources.person.user_settings).await?;
    let managed_settings = match sources.managed_settings_folder {
        Some(folder) => read_managed_settings(folder).await?,
        None => Vec::new(),
    };
    let person_wide_kept_out: Vec<McpServerName> = user_settings
        .iter()
        .chain(&managed_settings)
        .flat_map(|settings| read_setting_names(settings, DISABLED_MCPJSON_SERVERS_KEY))
        .collect();

    let user_servers = read_servers(&person_config.mcp_servers, |server_name| {
        McpServerBindingRef::User {
            provider: provider.clone(),
            server_name,
        }
    });
    let projects = person_config.projects.read();
    let mut roots = Vec::with_capacity(sources.roots.len());
    for root in sources.roots {
        let project_entry = projects
            .and_then(|projects| projects.get(root.root.path.as_str()))
            .and_then(Tolerated::read);
        let project_file: ClaudeMcpServersFile = read_json_file(&root.folder.join(SERVERS_FILE))
            .await?
            .unwrap_or_default();
        let settings_folder = root.folder.join(".claude");
        let project_settings = read_settings(&settings_folder.join("settings.json")).await?;
        let local_settings = read_settings(&settings_folder.join("settings.local.json")).await?;

        // Claude Code's approval of a `.mcp.json` server (`Xat`, b:21860974) rejects one the
        // merged settings' `disabledMcpjsonServers` name (`jpt`, b:21860565; `pr`, b:10053459),
        // and otherwise approves it by the settings (`wFn`, b:21860204) or leaves it pending. A
        // pending one is approved `non_interactive` when the process is not interactive (`ye`,
        // b:8571908) and the project settings source is on (`Qt`, b:9221918). Every process the
        // daemon starts runs `-p` and passes no `--setting-sources`, so every source is on
        // (`Jt`, b:8540453): a server loads unless it is rejected, whatever trust or approval
        // the folder holds.
        let mut kept_out_server_names = person_wide_kept_out.clone();
        for name in project_settings
            .iter()
            .chain(&local_settings)
            .flat_map(|settings| read_setting_names(settings, DISABLED_MCPJSON_SERVERS_KEY))
            .chain(
                project_entry
                    .into_iter()
                    .flat_map(|entry| read_names(&entry.disabled_mcpjson_servers)),
            )
        {
            if !kept_out_server_names.contains(&name) {
                kept_out_server_names.push(name);
            }
        }
        let rooted = |scope_is_local: bool| {
            let provider = provider.clone();
            move |server_name| {
                let scope_ref = root.root.path.clone();
                let place = root.root.place.clone();
                if scope_is_local {
                    McpServerBindingRef::Local {
                        provider: provider.clone(),
                        scope_ref,
                        place,
                        server_name,
                    }
                } else {
                    McpServerBindingRef::Project {
                        provider: provider.clone(),
                        scope_ref,
                        place,
                        server_name,
                    }
                }
            }
        };
        roots.push(ClaudeMcpRootConfig {
            root: root.root.clone(),
            local_servers: project_entry
                .map(|entry| read_servers(&entry.mcp_servers, rooted(true)))
                .unwrap_or_default(),
            project_servers: read_servers(&project_file.mcp_servers, rooted(false)),
            kept_out_server_names,
            switched_off_server_names: project_entry
                .map(|entry| read_names(&entry.disabled_mcp_servers))
                .unwrap_or_default(),
        });
    }

    Ok(ClaudeMcpConfigReading {
        user_servers,
        plugin_servers: read_plugin_servers(sources.plugin_home).await?,
        roots,
        server_policy: read_server_policy(user_settings.as_ref(), &managed_settings),
    })
}

// A value the read takes when it has the shape it expects, and skips otherwise, so one malformed
// entry leaves the rest of the file read.
#[derive(Deserialize)]
#[serde(untagged)]
enum Tolerated<T> {
    Read(T),
    Skipped(IgnoredAny),
}

impl<T> Default for Tolerated<T> {
    fn default() -> Self {
        Self::Skipped(IgnoredAny)
    }
}

impl<T> Tolerated<T> {
    fn read(&self) -> Option<&T> {
        match self {
            Self::Read(value) => Some(value),
            Self::Skipped(_) => None,
        }
    }
}

// A file's `mcpServers` map, by server name.
type ClaudeServerMap = Tolerated<BTreeMap<String, Tolerated<ClaudeServerEntry>>>;

// A list of server names.
type ClaudeNameList = Tolerated<Vec<Tolerated<String>>>;

// The parts of `.claude.json` the read takes; Claude Code keeps much else there.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudePersonConfigFile {
    #[serde(default)]
    mcp_servers: ClaudeServerMap,
    #[serde(default)]
    projects: Tolerated<BTreeMap<String, Tolerated<ClaudeProjectEntry>>>,
}

// One project's entry in `.claude.json`, keyed by its root.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[expect(
    clippy::struct_field_names,
    reason = "the fields name the file's own members"
)]
struct ClaudeProjectEntry {
    #[serde(default)]
    mcp_servers: ClaudeServerMap,
    #[serde(default)]
    disabled_mcp_servers: ClaudeNameList,
    #[serde(default)]
    disabled_mcpjson_servers: ClaudeNameList,
}

// A file holding servers under `mcpServers`: a project's or a plugin's `.mcp.json`, or a plugin's
// manifest.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeMcpServersFile {
    #[serde(default)]
    mcp_servers: ClaudeServerMap,
}

// One server entry. Environment and header values are skipped as they are read, so no value
// outlives the parse; the address is held only until it is stripped and folded. It derives no
// `Debug`, so nothing prints the address.
#[derive(Deserialize)]
#[expect(
    clippy::zero_sized_map_values,
    reason = "only the keys are read; each value is skipped unread so none outlives the parse"
)]
struct ClaudeServerEntry {
    #[serde(rename = "type", default)]
    transport: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    env: Option<BTreeMap<String, IgnoredAny>>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: Option<BTreeMap<String, IgnoredAny>>,
}

// The plugin home's list of installed plugins, by plugin id (`<name>@<marketplace>`).
#[derive(Default, Deserialize)]
struct ClaudeInstalledPluginsFile {
    #[serde(default)]
    plugins: Tolerated<BTreeMap<String, Tolerated<Vec<Tolerated<ClaudeInstalledPlugin>>>>>,
}

// One install of a plugin.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeInstalledPlugin {
    install_path: PathBuf,
}

// A JSON file read into `File`: `None` where the daemon cannot read it or it does not parse as
// `File`, the error on any other read failure.
async fn read_json_file<File: DeserializeOwned>(
    path: &Path,
) -> Result<Option<File>, ClaudeSettingsReadError> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(failure) if is_unreadable_path(&failure) => return Ok(None),
        Err(failure) => {
            return Err(ClaudeSettingsReadError {
                path: path.to_path_buf(),
                failure,
            });
        }
    };
    Ok(serde_json::from_str(&decode_inbound_json(&bytes)).ok())
}

async fn read_settings(path: &Path) -> Result<Option<Map<String, Value>>, ClaudeSettingsReadError> {
    read_claude_settings_file(path)
        .await
        .map_err(|failure| ClaudeSettingsReadError {
            path: path.to_path_buf(),
            failure,
        })
}

// Each managed settings file in the order Claude Code applies them; fails on the first file or
// folder that could not be read, which may have kept a server out.
async fn read_managed_settings(
    folder: &Path,
) -> Result<Vec<Map<String, Value>>, ClaudeSettingsReadError> {
    let mut failures = Vec::new();
    let files = list_managed_settings_files(folder, &mut failures).await;
    if let Some(failure) = failures.into_iter().next() {
        return Err(failure);
    }
    let mut settings = Vec::with_capacity(files.len());
    for file in files {
        settings.extend(read_settings(&file).await?);
    }
    Ok(settings)
}

fn read_setting_names(settings: &Map<String, Value>, key: &str) -> Vec<McpServerName> {
    find_claude_setting(settings, &[key])
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|name| McpServerName::new(name.as_str()?.to_owned()).ok())
        .collect()
}

fn read_names(list: &ClaudeNameList) -> Vec<McpServerName> {
    list.read()
        .into_iter()
        .flatten()
        .filter_map(|name| McpServerName::new(name.read()?.clone()).ok())
        .collect()
}

// The servers of one map, each bound by `bind`; an entry with a name the wire cannot carry or a
// shape no transport reads is skipped.
fn read_servers(
    servers: &ClaudeServerMap,
    bind: impl Fn(McpServerName) -> McpServerBindingRef,
) -> Vec<ClaudeMcpServer> {
    servers
        .read()
        .into_iter()
        .flatten()
        .filter_map(|(name, entry)| {
            let server_name = McpServerName::new(name.clone()).ok()?;
            let (config, endpoint) = read_server_entry(entry.read()?)?;
            Some(ClaudeMcpServer {
                binding: bind(server_name),
                config,
                endpoint,
                organization_managed: None,
            })
        })
        .collect()
}

// The redacted declaration of one entry and its endpoint; `None` for a transport the declaration
// view has no form for.
#[expect(
    clippy::zero_sized_map_values,
    reason = "only the keys are read; each value is skipped unread so none outlives the parse"
)]
fn read_server_entry(
    entry: &ClaudeServerEntry,
) -> Option<(McpServerConfigView, Option<ClaudeMcpEndpoint>)> {
    let names = |map: &Option<BTreeMap<String, IgnoredAny>>| {
        map.as_ref().map(|map| map.keys().cloned().collect())
    };
    match entry.transport.as_deref() {
        None | Some("stdio") => {
            let command = entry.command.clone()?;
            let endpoint = ClaudeMcpEndpoint::Command {
                command: command.clone(),
                args: entry.args.clone().unwrap_or_default(),
            };
            let config = McpServerConfigView::Stdio {
                command,
                args: entry.args.clone(),
                env_var_names: names(&entry.env),
                enabled: None,
                required: None,
                startup_timeout_sec: None,
                tool_timeout_sec: None,
            };
            Some((config, Some(endpoint)))
        }
        Some(transport @ ("http" | "sse" | "ws")) => {
            let address = read_server_address(entry.url.as_deref()?);
            let url = address.stripped_url;
            let url_query_param_names =
                (!address.query_param_names.is_empty()).then_some(address.query_param_names);
            let header_names = names(&entry.headers);
            let config = if transport == "ws" {
                McpServerConfigView::Ws {
                    url,
                    url_query_param_names,
                    header_names,
                }
            } else if transport == "http" {
                McpServerConfigView::Http {
                    url,
                    url_query_param_names,
                    header_names,
                    bearer_token_env_var: None,
                    env_http_headers: None,
                    oauth_scopes: None,
                    oauth_resource: None,
                    enabled: None,
                    required: None,
                    startup_timeout_sec: None,
                    tool_timeout_sec: None,
                }
            } else {
                McpServerConfigView::Sse {
                    url,
                    url_query_param_names,
                    header_names,
                    bearer_token_env_var: None,
                    env_http_headers: None,
                    oauth_scopes: None,
                    oauth_resource: None,
                    enabled: None,
                    required: None,
                    startup_timeout_sec: None,
                    tool_timeout_sec: None,
                }
            };
            Some((config, address.identity.map(ClaudeMcpEndpoint::Address)))
        }
        Some(_) => None,
    }
}

// The servers of each plugin `installed_plugins.json` lists in the plugin home: those of the
// plugin's root `.mcp.json`, then those its manifest declares inline, a name taken once.
async fn read_plugin_servers(
    plugin_home: &Path,
) -> Result<Vec<ClaudeMcpServer>, ClaudeSettingsReadError> {
    let mut servers: Vec<ClaudeMcpServer> = Vec::new();
    for plugin in read_installed_plugin_roots(plugin_home).await? {
        let servers_file: Option<ClaudeMcpServersFile> =
            read_json_file(&plugin.root.join(SERVERS_FILE)).await?;
        let inline = plugin
            .manifest
            .as_ref()
            .and_then(|manifest| ClaudeMcpServersFile::deserialize(manifest).ok());
        for file in [servers_file, inline].into_iter().flatten() {
            let read = read_servers(&file.mcp_servers, |server_name| {
                McpServerBindingRef::Plugin {
                    provider: DESCRIPTOR.provider_id(),
                    scope_ref: plugin.name.clone(),
                    server_name,
                }
            });
            for server in read {
                if !servers.iter().any(|kept| kept.binding == server.binding) {
                    servers.push(server);
                }
            }
        }
    }
    Ok(servers)
}

// One plugin `installed_plugins.json` lists: its name, its whole id, the root of its first
// install and its manifest, values included, parsed once for the read; `None` where it has none.
struct InstalledPluginRoot {
    name: PluginToken,
    id: String,
    root: PathBuf,
    manifest: Option<Value>,
}

// Each plugin `installed_plugins.json` lists in the plugin home, named as Claude Code names it
// in its servers' `plugin:<name>:<server>`: by its manifest's `name` (`$le`, b:22533235), else,
// where it has no manifest, by its id's part before the marketplace (`VJ`, b:22522351; `On`,
// b:9256803), which for a built-in npm marketplace id such as `@team/db.tools@npm` is the scoped
// package name. A plugin whose manifest Claude Code cannot read, reads as no JSON or refuses is
// left out, logged at debug with its file, as `VJ` refuses to load it (b:22523400 to
// b:22524200); only an absent manifest, or a folder on its path that is a file, reads as none.
async fn read_installed_plugin_roots(
    plugin_home: &Path,
) -> Result<Vec<InstalledPluginRoot>, ClaudeSettingsReadError> {
    let installed: ClaudeInstalledPluginsFile =
        read_json_file(&plugin_home.join("plugins").join("installed_plugins.json"))
            .await?
            .unwrap_or_default();
    let mut plugins = Vec::new();
    for (plugin_id, installs) in installed.plugins.read().into_iter().flatten() {
        let Some(install) = installs
            .read()
            .and_then(|installs| installs.iter().find_map(Tolerated::read))
        else {
            continue;
        };
        let manifest_file = install
            .install_path
            .join(".claude-plugin")
            .join("plugin.json");
        let manifest = match tokio::fs::read(&manifest_file).await {
            Ok(bytes) => match serde_json::from_str::<Value>(&decode_inbound_json(&bytes)) {
                Ok(manifest) => Some(manifest),
                Err(error) => {
                    tracing::debug!(
                        category = ?error.classify(),
                        file = %manifest_file.display(),
                        "a plugin is left out: its manifest is not JSON"
                    );
                    continue;
                }
            },
            Err(failure)
                if matches!(
                    failure.kind(),
                    ErrorKind::NotFound | ErrorKind::NotADirectory
                ) =>
            {
                None
            }
            Err(failure) => {
                tracing::debug!(
                    error = &failure as &(dyn std::error::Error + 'static),
                    file = %manifest_file.display(),
                    "a plugin is left out: its manifest could not be read"
                );
                continue;
            }
        };
        let name = match &manifest {
            Some(manifest) => match read_plugin_manifest_name(manifest) {
                Ok(name) => name.to_owned(),
                Err(member) => {
                    tracing::debug!(
                        member,
                        file = %manifest_file.display(),
                        "a plugin is left out: Claude Code refuses its manifest"
                    );
                    continue;
                }
            },
            None => plugin_id
                .rsplit_once('@')
                .map_or(plugin_id.as_str(), |(name, _)| name)
                .to_owned(),
        };
        let Ok(name) = PluginToken::new(name) else {
            continue;
        };
        plugins.push(InstalledPluginRoot {
            name,
            id: plugin_id.clone(),
            root: install.install_path.clone(),
            manifest,
        });
    }
    Ok(plugins)
}

#[cfg(test)]
mod tests;
