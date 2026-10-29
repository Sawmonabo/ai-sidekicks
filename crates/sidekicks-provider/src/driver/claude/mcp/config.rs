//! The read of the person's own Claude Code MCP config: the user and per-project servers in
//! `.claude.json`, each attached root's `.mcp.json`, the servers of the plugins in the daemon's
//! plugin home, the per-project names kept out of a root or switched off there, and the allow and
//! deny lists. Every
//! credential-bearing value is dropped at the read: a declaration keeps names only, and a remote
//! address is held whole only in memory, for the duplicate match.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::{DeserializeOwned, IgnoredAny};
use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::plugin::PluginToken;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::ignored_settings::{
    ClaudeSettingsReadError, find_claude_setting, list_managed_settings_files,
};
use crate::driver::claude::session::settings_file::{
    is_unreadable_path, read_claude_settings_file,
};
use crate::driver::mcp_server::address::{ServerAddressIdentity, read_server_address};
use crate::driver::mcp_server::read::{McpServerPolicy, McpServerPolicyEntry};
use crate::inbound_json::decode_inbound_json;

// The settings key naming a project's `.mcp.json` servers its sessions refuse.
const DISABLED_MCPJSON_SERVERS_KEY: &str = "disabledMcpjsonServers";
// The settings keys of the allow and deny lists, and the managed switch that keeps only the
// managed allow list.
const ALLOWED_MCP_SERVERS_KEY: &str = "allowedMcpServers";
const DENIED_MCP_SERVERS_KEY: &str = "deniedMcpServers";
const ALLOW_MANAGED_MCP_SERVERS_ONLY_KEY: &str = "allowManagedMcpServersOnly";

/// One attached project root and the folder its files are read at on this computer.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeMcpRoot {
    /// The root, with the distribution it is in; its path is the key `.claude.json` files the
    /// project under.
    pub(crate) root: PlacedPath,
    /// The folder the root's `.mcp.json` and settings files are read at.
    pub(crate) folder: PathBuf,
}

/// Where the read finds the person's Claude Code config and the files beside it.
pub(crate) struct ClaudeMcpConfigSources<'sources> {
    /// The person's own home folder, holding `.claude.json` and `.claude/settings.json`.
    pub(crate) home: &'sources Path,
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
    /// `.claude.json`.
    pub(crate) kept_out_server_names: Vec<McpServerName>,
    /// The names Claude Code's own per-project switch turns off at the root.
    pub(crate) switched_off_server_names: Vec<McpServerName>,
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
    #[expect(
        dead_code,
        reason = "the Claude Code driver's MCP server read hands it on"
    )]
    pub(crate) server_policy: McpServerPolicy,
}

/// Reads the person's Claude Code MCP config from `sources`. A file that is absent, not the
/// daemon's to read or not JSON of the expected shape declares nothing; fails with the path and
/// the system's error on any other read failure.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude Code driver's MCP server read calls it"
    )
)]
pub(crate) async fn read_claude_mcp_config(
    sources: &ClaudeMcpConfigSources<'_>,
) -> Result<ClaudeMcpConfigReading, ClaudeSettingsReadError> {
    let provider = DESCRIPTOR.provider_id();
    let person_config: ClaudePersonConfigFile = read_json_file(&sources.home.join(".claude.json"))
        .await?
        .unwrap_or_default();
    let user_settings = read_settings(&sources.home.join(".claude").join("settings.json")).await?;
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
        let project_file: ClaudeMcpServersFile = read_json_file(&root.folder.join(".mcp.json"))
            .await?
            .unwrap_or_default();
        let settings_folder = root.folder.join(".claude");
        let project_settings = read_settings(&settings_folder.join("settings.json")).await?;
        let local_settings = read_settings(&settings_folder.join("settings.local.json")).await?;

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

/// A JSON file read into `File`: `None` where the daemon cannot read it or it does not parse as
/// `File`, the error on any other read failure.
pub(super) async fn read_json_file<File: DeserializeOwned>(
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
            })
        })
        .collect()
}

// The redacted declaration of one entry and its endpoint; `None` for a transport the declaration
// view has no form for.
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
        Some(transport @ ("http" | "sse")) => {
            let address = read_server_address(entry.url.as_deref()?);
            let url = address.stripped_url;
            let url_query_param_names =
                (!address.query_param_names.is_empty()).then_some(address.query_param_names);
            let header_names = names(&entry.headers);
            let config = if transport == "http" {
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
    let installed: ClaudeInstalledPluginsFile =
        read_json_file(&plugin_home.join("plugins").join("installed_plugins.json"))
            .await?
            .unwrap_or_default();
    let mut servers: Vec<ClaudeMcpServer> = Vec::new();
    for (plugin_id, installs) in installed.plugins.read().into_iter().flatten() {
        // A binding names the plugin by its name, the id's part before the marketplace.
        let name = plugin_id
            .rsplit_once('@')
            .map_or(plugin_id.as_str(), |(name, _)| name);
        let Ok(plugin_name) = PluginToken::new(name.to_owned()) else {
            continue;
        };
        let Some(install) = installs
            .read()
            .and_then(|installs| installs.iter().find_map(Tolerated::read))
        else {
            continue;
        };
        let root = &install.install_path;
        let server_files = [
            root.join(".mcp.json"),
            root.join(".claude-plugin").join("plugin.json"),
        ];
        for file in server_files {
            let Some(file) = read_json_file::<ClaudeMcpServersFile>(&file).await? else {
                continue;
            };
            let read = read_servers(&file.mcp_servers, |server_name| {
                McpServerBindingRef::Plugin {
                    provider: DESCRIPTOR.provider_id(),
                    scope_ref: plugin_name.clone(),
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

// The allow and deny lists Claude Code merges: the deny list from every file, the allow list from
// every file unless a managed file keeps only the managed one. An allow list no file sets is
// absent; one a file sets empty lets nothing load.
fn read_server_policy(
    user_settings: Option<&Map<String, Value>>,
    managed_settings: &[Map<String, Value>],
) -> McpServerPolicy {
    let is_managed_allow_list_only = managed_settings.iter().any(|settings| {
        find_claude_setting(settings, &[ALLOW_MANAGED_MCP_SERVERS_ONLY_KEY])
            == Some(&Value::Bool(true))
    });
    let every_file: Vec<&Map<String, Value>> =
        user_settings.into_iter().chain(managed_settings).collect();
    let allow_files: Vec<&Map<String, Value>> = if is_managed_allow_list_only {
        managed_settings.iter().collect()
    } else {
        every_file.clone()
    };
    let mut allowed: Option<Vec<McpServerPolicyEntry>> = None;
    for settings in allow_files {
        if let Some(entries) =
            find_claude_setting(settings, &[ALLOWED_MCP_SERVERS_KEY]).and_then(Value::as_array)
        {
            allowed
                .get_or_insert_with(Vec::new)
                .extend(entries.iter().filter_map(read_policy_entry));
        }
    }
    let denied = every_file
        .into_iter()
        .filter_map(|settings| {
            find_claude_setting(settings, &[DENIED_MCP_SERVERS_KEY]).and_then(Value::as_array)
        })
        .flatten()
        .filter_map(read_policy_entry)
        .collect();
    McpServerPolicy { allowed, denied }
}

// One allow or deny entry: `{"serverName": …}`, `{"serverCommand": […]}` or `{"serverUrl": …}`,
// an address pattern stripped as an address is.
fn read_policy_entry(entry: &Value) -> Option<McpServerPolicyEntry> {
    if let Some(name) = entry.get("serverName").and_then(Value::as_str) {
        return McpServerName::new(name.to_owned())
            .ok()
            .map(McpServerPolicyEntry::ServerName);
    }
    if let Some(command) = entry.get("serverCommand").and_then(Value::as_array) {
        return command
            .iter()
            .map(|part| part.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .map(McpServerPolicyEntry::Command);
    }
    let pattern = entry.get("serverUrl").and_then(Value::as_str)?;
    Some(McpServerPolicyEntry::AddressPattern(
        read_server_address(pattern).stripped_url,
    ))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::mcp::server::McpServerName;
    use sidekicks_contracts::mcp::server::config::McpServerConfigView;
    use sidekicks_contracts::place::PlacedPath;

    use super::{ClaudeMcpConfigSources, ClaudeMcpRoot, read_claude_mcp_config};

    // A root at `folder`, read in place.
    fn attached_root(folder: &Path) -> ClaudeMcpRoot {
        ClaudeMcpRoot {
            root: PlacedPath {
                path: FilesystemPath::new(folder.to_string_lossy().into_owned())
                    .expect("a scratch folder is a path the wire carries"),
                place: None,
            },
            folder: folder.to_path_buf(),
        }
    }

    fn write_json(file: &Path, value: &serde_json::Value) {
        fs::create_dir_all(file.parent().expect("a file sits in a folder"))
            .expect("the file's folder is made");
        fs::write(file, value.to_string()).expect("the file is written");
    }

    fn server_name(name: &str) -> McpServerName {
        McpServerName::new(name.to_owned()).expect("a server name")
    }

    // The file a `disabledMcpjsonServers` entry is written to.
    #[derive(Clone, Copy, Debug)]
    enum KeptOutSource {
        UserSettings,
        ProjectSettings,
        ProjectLocalSettings,
        ManagedSettings,
        ProjectEntry,
    }

    // Killed by one keep-out set for every root: a project's own files keep a server out of that
    // project only, while the user and managed files keep it out of every project.
    #[rstest]
    #[case::user_settings(KeptOutSource::UserSettings, true)]
    #[case::project_settings(KeptOutSource::ProjectSettings, false)]
    #[case::project_local_settings(KeptOutSource::ProjectLocalSettings, false)]
    #[case::managed_settings(KeptOutSource::ManagedSettings, true)]
    #[case::project_entry(KeptOutSource::ProjectEntry, false)]
    #[tokio::test]
    async fn a_kept_out_name_reaches_only_the_roots_its_file_covers(
        #[case] source: KeptOutSource,
        #[case] is_kept_out_of_other_root: bool,
    ) {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let home = scratch.path().join("home");
        let managed = scratch.path().join("managed");
        let roots = [
            attached_root(&scratch.path().join("root-a")),
            attached_root(&scratch.path().join("root-b")),
        ];
        let kept_out = json!({ "disabledMcpjsonServers": ["kept"] });
        let mut project_entry = json!({ "disabledMcpServers": ["off"] });
        let root_a = &roots[0].folder;
        match source {
            KeptOutSource::UserSettings => {
                write_json(&home.join(".claude").join("settings.json"), &kept_out);
            }
            KeptOutSource::ProjectSettings => {
                write_json(&root_a.join(".claude").join("settings.json"), &kept_out);
            }
            KeptOutSource::ProjectLocalSettings => {
                write_json(
                    &root_a.join(".claude").join("settings.local.json"),
                    &kept_out,
                );
            }
            KeptOutSource::ManagedSettings => {
                write_json(&managed.join("managed-settings.json"), &kept_out);
            }
            KeptOutSource::ProjectEntry => {
                project_entry["disabledMcpjsonServers"] = json!(["kept"]);
            }
        }
        write_json(
            &home.join(".claude.json"),
            &json!({ "projects": { roots[0].root.path.as_str(): project_entry } }),
        );

        let reading = read_claude_mcp_config(&ClaudeMcpConfigSources {
            home: &home,
            managed_settings_folder: Some(&managed),
            plugin_home: &scratch.path().join("plugin-home"),
            roots: &roots,
        })
        .await
        .expect("the config reads");

        let (root_a, root_b) = (&reading.roots[0], &reading.roots[1]);
        assert_eq!(root_a.kept_out_server_names, [server_name("kept")]);
        assert_eq!(
            root_b.kept_out_server_names.contains(&server_name("kept")),
            is_kept_out_of_other_root,
            "{source:?}"
        );
        assert_eq!(root_a.switched_off_server_names, [server_name("off")]);
        assert!(root_b.switched_off_server_names.is_empty());
    }

    // Killed by keeping any value: a header, a bearer token, a query, userinfo or an environment
    // value in the declaration or in the reading's `Debug`, the transient address included.
    #[tokio::test]
    async fn a_declaration_reads_names_only_and_no_value_reaches_debug() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let home = scratch.path().join("home");
        write_json(
            &home.join(".claude.json"),
            &json!({ "mcpServers": {
                "remote": {
                    "type": "http",
                    "url": "https://alice-userinfo:hunter2-password@Mcp.Example.com/mcp?api_key=query-secret-value&team=a",
                    "headers": {
                        "Authorization": "Bearer bearer-secret-token",
                        "X-Api-Key": "header-secret-value",
                    },
                },
                "program": {
                    "command": "server",
                    "args": ["--port", "8080"],
                    "env": { "API_TOKEN": "env-secret-value" },
                },
            } }),
        );

        let reading = read_claude_mcp_config(&ClaudeMcpConfigSources {
            home: &home,
            managed_settings_folder: None,
            plugin_home: &scratch.path().join("plugin-home"),
            roots: &[],
        })
        .await
        .expect("the config reads");

        let configs: Vec<&McpServerConfigView> = reading
            .user_servers
            .iter()
            .map(|server| &server.config)
            .collect();
        assert_eq!(
            configs,
            [
                &McpServerConfigView::Stdio {
                    command: "server".to_owned(),
                    args: Some(vec!["--port".to_owned(), "8080".to_owned()]),
                    env_var_names: Some(vec!["API_TOKEN".to_owned()]),
                    enabled: None,
                    required: None,
                    startup_timeout_sec: None,
                    tool_timeout_sec: None,
                },
                &McpServerConfigView::Http {
                    url: "https://mcp.example.com/mcp".to_owned(),
                    url_query_param_names: Some(vec!["api_key".to_owned(), "team".to_owned()]),
                    header_names: Some(vec!["Authorization".to_owned(), "X-Api-Key".to_owned()]),
                    bearer_token_env_var: None,
                    env_http_headers: None,
                    oauth_scopes: None,
                    oauth_resource: None,
                    enabled: None,
                    required: None,
                    startup_timeout_sec: None,
                    tool_timeout_sec: None,
                },
            ]
        );
        let printed = format!("{reading:?}");
        for secret in [
            "alice-userinfo",
            "hunter2-password",
            "query-secret-value",
            "bearer-secret-token",
            "header-secret-value",
            "env-secret-value",
        ] {
            assert!(
                !printed.contains(secret),
                "{secret} reached the reading's Debug"
            );
        }
    }
}
