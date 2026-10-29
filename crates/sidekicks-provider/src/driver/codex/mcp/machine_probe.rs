//! The machine probe: Codex starts the servers the daemon asks after in a throwaway conversation
//! at each root, one root at a time, and reports how each started and which tools it lists. The
//! conversation is ephemeral and lives on a connection of its own, so it unloads, and its servers
//! stop, once that connection drops; it runs on the person's own Codex folder, on a service whose
//! unload delay the daemon sets.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{
    McpServerBindingRef, McpServerName, McpServerStatus, McpToolName,
};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::driver::codex::app_server_protocol::{
    AskForApproval, ListMcpServerStatusParams, McpServerStatusDetail, SandboxMode,
    ThreadStartParams,
};
use crate::driver::codex::event_normalizer::CODEX_MCP_SERVER_STARTUP_STATUS_UPDATED_METHOD;
use crate::driver::codex::mcp::config::plugins::CodexPluginServer;
use crate::driver::codex::mcp::config::server_entry::ENABLED_MEMBER;
use crate::driver::codex::mcp::config::{CodexMcpConfigReading, CodexMcpRoot};
use crate::driver::codex::mcp::requirements::server_name_at;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::registry::personal_folder_read::PersonalFolderRead;
use crate::driver::codex::session::detached_conversation::{
    CodexDetachedFrame, CodexDetachedFrames,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::thread::settings::MCP_SERVERS_KEY;
use crate::driver::codex::thread::view::{THREAD_START_METHOD, read_thread};
use crate::driver::codex::tools::{
    normalize_codex_mcp_server_status_list, normalize_codex_mcp_server_status_notification,
};
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};
use crate::driver::mcp_server::read::{
    McpProbeReading, McpProbeStart, McpProbeTarget, McpServerDeclaration, McpServersReadRequest,
};
use crate::driver::mcp_server::status::{
    McpServerReading, McpServerStatusEmission, McpServerStatusIngestResult,
};

#[cfg(test)]
mod tests;

/// The request that reads one server's status and tools in a conversation.
const MCP_SERVER_STATUS_LIST_METHOD: &str = "mcpServerStatus/list";

/// How long Codex gives a server to start where its entry names no `startup_timeout_sec`.
const CODEX_DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// How long past the longest startup timeout the probe waits, so a server Codex may still start
/// never reads as starting.
const STARTUP_CEILING_MARGIN: Duration = Duration::from_secs(5);

/// The servers one throwaway conversation starts, and the folder it starts in.
pub(crate) struct CodexMcpProbeSite {
    /// The folder: an attached root's, or the person's home folder when none is attached.
    pub(crate) folder: PathBuf,
    /// The servers the probe reads.
    pub(crate) servers: Vec<CodexProbedServer>,
    /// The servers the person's config declares there that the probe does not read, switched off
    /// so they do not start.
    pub(crate) switched_off_names: Vec<McpServerName>,
}

/// One server the probe reads. It derives no `Debug`, since a sent entry holds credential values.
pub(crate) struct CodexProbedServer {
    /// The binding read.
    pub(crate) binding: McpServerBindingRef,
    /// How the conversation is told to start it.
    pub(crate) start: CodexProbedServerStart,
    /// How long Codex gives it to start.
    pub(crate) startup_timeout: Duration,
    /// Whether Codex's requirements keep it from starting, so no startup notice is waited for.
    pub(crate) is_kept_out: bool,
}

impl CodexProbedServer {
    fn server_name(&self) -> &McpServerName {
        self.binding.server_name()
    }
}

/// How the probe's conversation is told to start one server.
pub(crate) enum CodexProbedServerStart {
    /// Codex loads it by its own config at the root; nothing is sent.
    LoadedByProvider,
    /// Its entry in the person's config is off and is switched on by its name.
    SwitchedOnByName,
    /// Its entry, as Codex's config takes it, credential values included.
    Sent(Map<String, Value>),
}

/// The probe target of `declaration`: a plugin's server sent whole, since only the daemon's plugin
/// home declares it; an entry its own config switches off switched on by name; every other loaded
/// by Codex's own config. `None` for a connector, which Codex does not declare.
fn codex_probe_target(declaration: &McpServerDeclaration) -> Option<McpProbeTarget> {
    let start = match &declaration.binding {
        McpServerBindingRef::Connector { .. } => return None,
        McpServerBindingRef::Plugin { .. } => McpProbeStart::DeclarationSent,
        McpServerBindingRef::User { .. }
        | McpServerBindingRef::Project { .. }
        | McpServerBindingRef::Local { .. }
        | McpServerBindingRef::Managed { .. } => {
            let (McpServerConfigView::Stdio { enabled, .. }
            | McpServerConfigView::Http { enabled, .. }
            | McpServerConfigView::Sse { enabled, .. }) = &declaration.config;
            if *enabled == Some(false) {
                McpProbeStart::SwitchedOnByName
            } else {
                McpProbeStart::LoadedByProvider
            }
        }
    };
    Some(McpProbeTarget {
        binding: declaration.binding.clone(),
        start,
    })
}

/// The targets the probe of `request` starts among `declarations`: each declaration the scope
/// names, and each emulated `local` binding it names, switched on by name at its root from the
/// person's entry of the same name that is off by default, in place of that entry, which the
/// inventory then lists only as those bindings. A stored `local` binding with no such entry, or
/// one the config declares itself, is no emulated one.
pub(crate) fn codex_probe_targets(
    declarations: &[McpServerDeclaration],
    request: &McpServersReadRequest,
) -> Vec<McpProbeTarget> {
    let emulated_locals: Vec<&McpServerBindingRef> = request
        .emulated_local_bindings
        .iter()
        .filter(|local| {
            !declarations
                .iter()
                .any(|declaration| declaration.binding == **local)
        })
        .collect();
    let mut targets = Vec::new();
    for declaration in declarations {
        let Some(target) = codex_probe_target(declaration) else {
            continue;
        };
        let locals: Vec<&McpServerBindingRef> = match &target.binding {
            McpServerBindingRef::User {
                provider,
                server_name,
            } if target.start == McpProbeStart::SwitchedOnByName => emulated_locals
                .iter()
                .copied()
                .filter(|local| {
                    matches!(
                        local,
                        McpServerBindingRef::Local {
                            provider: local_provider,
                            server_name: local_name,
                            ..
                        } if local_provider == provider && local_name == server_name
                    )
                })
                .collect(),
            _ => Vec::new(),
        };
        if locals.is_empty() {
            if request.probe.contains(&target.binding) {
                targets.push(target);
            }
            continue;
        }
        targets.extend(
            locals
                .into_iter()
                .filter(|local| request.probe.contains(local))
                .map(|local| McpProbeTarget {
                    binding: local.clone(),
                    start: McpProbeStart::SwitchedOnByName,
                }),
        );
    }
    targets
}

/// The conversations the probe of `targets` starts: one per attached root holding a target, or
/// one at `home` when no root is attached. A project's or a root's own binding is probed at its
/// root, every other at the first. A target at a root that is not attached, or a plugin's server
/// no installed plugin declares, is logged and not probed.
pub(crate) fn plan_codex_mcp_probe(
    targets: &[McpProbeTarget],
    reading: &CodexMcpConfigReading,
    roots: &[CodexMcpRoot],
    home: &Path,
    plugin_servers: &[CodexPluginServer],
) -> Vec<CodexMcpProbeSite> {
    let places: Vec<(PathBuf, Option<&CodexMcpRoot>)> = if roots.is_empty() {
        vec![(home.to_path_buf(), None)]
    } else {
        roots
            .iter()
            .map(|root| (root.folder.clone(), Some(root)))
            .collect()
    };
    let mut servers_by_place: Vec<Vec<CodexProbedServer>> =
        places.iter().map(|_| Vec::new()).collect();
    for target in targets {
        let place_index = match &target.binding {
            McpServerBindingRef::Project {
                scope_ref, place, ..
            }
            | McpServerBindingRef::Local {
                scope_ref, place, ..
            } => places.iter().position(|(_, root)| {
                root.is_some_and(|root| root.root.path == *scope_ref && root.root.place == *place)
            }),
            McpServerBindingRef::User { .. }
            | McpServerBindingRef::Plugin { .. }
            | McpServerBindingRef::Connector { .. }
            | McpServerBindingRef::Managed { .. } => Some(0),
        };
        let Some(place_index) = place_index else {
            tracing::warn!(
                server = %target.binding.server_name().as_str(),
                "a codex probe target's root is not attached; it is not probed"
            );
            continue;
        };
        let plugin_server = plugin_servers
            .iter()
            .find(|server| server.declaration.binding == target.binding);
        let start = match target.start {
            McpProbeStart::LoadedByProvider => CodexProbedServerStart::LoadedByProvider,
            McpProbeStart::SwitchedOnByName => CodexProbedServerStart::SwitchedOnByName,
            McpProbeStart::DeclarationSent => {
                let Some(plugin_server) = plugin_server else {
                    tracing::warn!(
                        server = %target.binding.server_name().as_str(),
                        "no installed codex plugin declares a probe target; it is not probed"
                    );
                    continue;
                };
                CodexProbedServerStart::Sent(plugin_server.compose_codex_entry())
            }
        };
        let name = target.binding.server_name();
        let declared = plugin_server
            .map(|server| &server.declaration.config)
            .or_else(|| find_declared_config(reading, &target.binding));
        let root = places[place_index].1;
        servers_by_place[place_index].push(CodexProbedServer {
            binding: target.binding.clone(),
            start,
            startup_timeout: declared
                .and_then(read_startup_timeout)
                .unwrap_or(CODEX_DEFAULT_STARTUP_TIMEOUT),
            is_kept_out: is_kept_out(reading, root, name),
        });
    }
    places
        .into_iter()
        .zip(servers_by_place)
        .filter(|(_, servers)| !servers.is_empty())
        .map(|((folder, root), servers)| {
            let mut switched_off_names: Vec<McpServerName> = Vec::new();
            for declaration in &reading.declarations {
                if matches!(declaration.binding, McpServerBindingRef::Plugin { .. }) {
                    continue;
                }
                let Some(name) = server_name_at(&declaration.binding, root.map(|root| &root.root))
                else {
                    continue;
                };
                let is_probed = servers.iter().any(|server| server.server_name() == name);
                if !is_probed && !switched_off_names.contains(name) {
                    switched_off_names.push(name.clone());
                }
            }
            CodexMcpProbeSite {
                folder,
                servers,
                switched_off_names,
            }
        })
        .collect()
}

/// Probes each of `sites` in turn on the person's own Codex folder, each in a throwaway
/// conversation on a connection of its own, dropped once its servers are read. Fails as the
/// service there cannot be started or reached, or as Codex refuses a conversation or a read.
pub(crate) async fn probe_codex_mcp_servers(
    registry: &CodexServiceRegistry,
    sites: &[CodexMcpProbeSite],
) -> Result<Vec<McpProbeReading>, CodexError> {
    if sites.is_empty() {
        return Ok(Vec::new());
    }
    registry
        .read_on_personal_folder(PersonalFolderRead::Probe, |service| async move {
            let mut readings = Vec::new();
            for site in sites {
                let (events, frames) = CodexDetachedFrames::new();
                let connection = service.open_detached_connection(events).await?;
                readings.extend(probe_site(connection, frames, site).await?);
            }
            Ok(readings)
        })
        .await
}

// Starts `site`'s conversation over `connection`, waits for its servers to start, reads each, and
// drops the connection, which unloads the conversation. Fails as a request fails.
async fn probe_site(
    connection: CodexAppServerConnection,
    mut frames: mpsc::UnboundedReceiver<CodexDetachedFrame>,
    site: &CodexMcpProbeSite,
) -> Result<Vec<McpProbeReading>, CodexError> {
    let reply = connection
        .request(
            THREAD_START_METHOD,
            &ThreadStartParams {
                cwd: Some(site.folder.to_string_lossy().into_owned()),
                ephemeral: Some(true),
                sandbox: Some(SandboxMode::ReadOnly),
                approval_policy: Some(AskForApproval::Never),
                config: Some(compose_probe_overrides(site)),
                ..ThreadStartParams::default()
            },
        )
        .await?;
    let thread_id = read_thread(&reply, THREAD_START_METHOD)?.id;
    let mut started = wait_for_startups(&mut frames, &thread_id, site).await;
    let mut readings = Vec::with_capacity(site.servers.len());
    for server in &site.servers {
        let startup = started.remove(server.server_name().as_str());
        readings.push(read_server(&connection, &thread_id, server, startup).await?);
    }
    Ok(readings)
}

// The conversation's config: every server it does not read switched off, and each it reads
// switched on by name or sent whole. One object under the server table, since a name may hold a
// dot.
fn compose_probe_overrides(site: &CodexMcpProbeSite) -> Map<String, Value> {
    let mut servers: Map<String, Value> = site
        .switched_off_names
        .iter()
        .map(|name| (name.as_str().to_owned(), json!({ ENABLED_MEMBER: false })))
        .collect();
    for server in &site.servers {
        let entry = match &server.start {
            CodexProbedServerStart::LoadedByProvider => continue,
            CodexProbedServerStart::SwitchedOnByName => json!({ ENABLED_MEMBER: true }),
            CodexProbedServerStart::Sent(entry) => Value::Object(entry.clone()),
        };
        servers.insert(server.server_name().as_str().to_owned(), entry);
    }
    Map::from_iter([(MCP_SERVERS_KEY.to_owned(), Value::Object(servers))])
}

// The startup notice each server `site` waits for gave on `thread_id` once it settled, by name:
// until every one settled, the connection dropped, or the longest startup timeout among them and
// a margin passed.
async fn wait_for_startups(
    frames: &mut mpsc::UnboundedReceiver<CodexDetachedFrame>,
    thread_id: &str,
    site: &CodexMcpProbeSite,
) -> HashMap<String, McpServerStatusEmission> {
    let waited = site.servers.iter().filter(|server| !server.is_kept_out);
    let mut pending: Vec<&str> = waited
        .clone()
        .map(|server| server.server_name().as_str())
        .collect();
    let mut settled = HashMap::new();
    let Some(longest) = waited.map(|server| server.startup_timeout).max() else {
        return settled;
    };
    let deadline = Instant::now() + longest + STARTUP_CEILING_MARGIN;
    while !pending.is_empty() {
        let Ok(Some((method, params))) = tokio::time::timeout_at(deadline, frames.recv()).await
        else {
            break;
        };
        if method != CODEX_MCP_SERVER_STARTUP_STATUS_UPDATED_METHOD {
            continue;
        }
        let Ok(notice) = serde_json::from_str::<Value>(params.get()) else {
            continue;
        };
        if notice.get("threadId").and_then(Value::as_str) != Some(thread_id) {
            continue;
        }
        let result = normalize_codex_mcp_server_status_notification(&notice);
        log_rejections(&result);
        for emission in result.emissions {
            let name = emission.server_name.as_str();
            if emission.reading == McpServerReading::Observed(McpServerStatus::Starting)
                || !pending.contains(&name)
            {
                continue;
            }
            pending.retain(|waiting| *waiting != name);
            settled.insert(name.to_owned(), emission);
        }
    }
    settled
}

// `server`'s reading: its startup notice's where it settled, else its status list's, with the
// tools the list names. Fails as the list request fails.
async fn read_server(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    server: &CodexProbedServer,
    startup: Option<McpServerStatusEmission>,
) -> Result<McpProbeReading, CodexError> {
    let name = server.server_name();
    let reply = connection
        .request(
            MCP_SERVER_STATUS_LIST_METHOD,
            &ListMcpServerStatusParams {
                thread_id: Some(thread_id.to_owned()),
                server_name: Some(name.as_str().to_owned()),
                detail: Some(McpServerStatusDetail::ToolsAndAuthOnly),
                ..ListMcpServerStatusParams::default()
            },
        )
        .await?;
    let rows = read_codex_object::<StatusListReply>(reply.get())
        .map(|reply| reply.data)
        .unwrap_or_default();
    let listed = normalize_codex_mcp_server_status_list(&rows);
    log_rejections(&listed);
    let (reading, failure_text) = match startup {
        Some(emission) => (emission.reading, emission.failure_text),
        None => match listed
            .emissions
            .into_iter()
            .find(|emission| emission.server_name == *name)
        {
            Some(emission) => (emission.reading, None),
            None => {
                tracing::warn!(
                    server = %name.as_str(),
                    "codex listed no status for a probed mcp server; its status is unknown"
                );
                (McpServerReading::Observed(McpServerStatus::Unknown), None)
            }
        },
    };
    let tool_names = rows
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row.get("name").and_then(Value::as_str) == Some(name.as_str()))
        .filter_map(|row| row.get("tools").and_then(Value::as_object))
        .flat_map(Map::values)
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .filter_map(|tool_name| McpToolName::new(tool_name.to_owned()).ok())
        .collect();
    Ok(McpProbeReading {
        binding: server.binding.clone(),
        reading,
        failure_text,
        tool_names,
    })
}

// `mcpServerStatus/list`'s reply: its rows.
#[derive(Deserialize)]
struct StatusListReply {
    #[serde(default)]
    data: Value,
}

fn log_rejections(result: &McpServerStatusIngestResult) {
    for rejection in &result.rejections {
        tracing::warn!(
            reason = %rejection.reason,
            "a codex mcp server status from the probe was refused"
        );
    }
}

// The declaration `binding` reads its config from: its own, or for a root's own binding the
// person's entry of the same name it switches on.
fn find_declared_config<'reading>(
    reading: &'reading CodexMcpConfigReading,
    binding: &McpServerBindingRef,
) -> Option<&'reading McpServerConfigView> {
    let name = binding.server_name();
    reading
        .declarations
        .iter()
        .find(|declaration| declaration.binding == *binding)
        .or_else(|| {
            reading.declarations.iter().find(|declaration| {
                matches!(
                    &declaration.binding,
                    McpServerBindingRef::User { server_name, .. } if server_name == name
                )
            })
        })
        .map(|declaration| &declaration.config)
}

fn read_startup_timeout(config: &McpServerConfigView) -> Option<Duration> {
    let (McpServerConfigView::Stdio {
        startup_timeout_sec,
        ..
    }
    | McpServerConfigView::Http {
        startup_timeout_sec,
        ..
    }
    | McpServerConfigView::Sse {
        startup_timeout_sec,
        ..
    }) = config;
    Duration::try_from_secs_f64((*startup_timeout_sec)?.get()).ok()
}

// Whether Codex's requirements keep `name` from starting at `root`, or at the person's home folder
// where `root` is `None`, as the reading keeps it out there.
fn is_kept_out(
    reading: &CodexMcpConfigReading,
    root: Option<&CodexMcpRoot>,
    name: &McpServerName,
) -> bool {
    match root {
        Some(root) => reading
            .roots
            .iter()
            .find(|read| read.root == root.root)
            .is_some_and(|read| read.kept_out_server_names.contains(name)),
        None => reading.home_kept_out_server_names.contains(name),
    }
}
