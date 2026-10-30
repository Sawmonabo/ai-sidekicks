//! The machine probe of Claude Code's MCP servers, for bindings no live session reads, in
//! processes that keep nothing, each asked `mcp_status` until every server is past `pending` or
//! the ceiling passes, then closed. No turn is sent. The person's and the organization's servers
//! run in one process per attached root in turn, under `--strict-mcp-config` unless an
//! administrator's MCP file is deployed, sent with `mcp_set_servers`, each declaration re-read from
//! the person's config, its variables filled as Claude Code fills them on load, and dropped once
//! sent. An entry the set cannot carry whole, one that fetches its headers or signs in itself, or
//! one over a transport the set has no form for, is not sent and reads `unknown`, an
//! organization's server included. A plugin's servers run in one more process that loads each
//! probed plugin from its install root with `--plugin-dir`, so Claude Code's own plugin check
//! decides whether they load.
//! Budget: one such process of about 140 to 150 MB at a time, run only when a refresh asks for a
//! probe, each closed once its servers settle or its ceiling passes; nothing polls between probes.

mod plugin_load;
mod variables;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::{
    McpServerBindingRef, McpServerName, McpServerStatus, McpToolName,
};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_ipc::redaction::sanitize_failure_chain;
use tokio::sync::mpsc;
use tokio::time::Instant;

use self::plugin_load::{PluginLoadErrors, are_plugins_applied};
use self::variables::expand_entry_variables;
use crate::driver::claude::mcp::config::{
    ClaudeMcpRootConfig, ClaudePersonConfigFiles, ClaudePluginRoot, ClaudeServerEntryReader,
    is_kept_out_server,
};
use crate::driver::claude::mcp::connectors::list_fetch::CONNECTORS_SWITCH_VARIABLE;
use crate::driver::claude::mcp::precedence::claude_reported_server_name;
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeMcpSetServersReply, ClaudeToolServerEntry,
};
use crate::driver::claude::session::transport::mcp_status::ClaudeMcpStatusReply;
use crate::driver::claude::spawn::launch::control_only::{
    ClaudeShortProcessArrival, compose_claude_control_only_arguments,
};
use crate::driver::claude::spawn::launch::installed_build::ClaudeProcessStarts;
use crate::driver::claude::tools::normalize_claude_mcp_status_reply;
use crate::driver::contract::error::DriverError;
use crate::driver::mcp_server::read::{McpProbeReading, McpProbeStart, McpProbeTarget};
use crate::driver::mcp_server::status::{
    FAILURE_TEXT_MAX_CODE_POINTS, McpServerReading, McpServerStatusIngestResult,
    bound_mcp_server_status_emission,
};

// The environment variable naming Claude Code's startup timeout for every MCP server, in
// milliseconds, and the timeout where it is unset.
const MCP_TIMEOUT_VARIABLE: &str = "MCP_TIMEOUT";
const DEFAULT_MCP_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
// How long past the servers' startup timeout the probe still waits, so a server Claude Code may
// still start is not read as `starting`.
const PROBE_CEILING_MARGIN: Duration = Duration::from_secs(5);
// How long the probe waits before asking `mcp_status` again while a server is pending.
const PROBE_STATUS_INTERVAL: Duration = Duration::from_secs(1);
// The failure text of a plugin's server Claude Code reports nowhere, where its `system/init` frame
// names no load error of the plugin.
const PLUGIN_NOT_LOADED_TEXT: &str = "Claude Code did not load the plugin.";
// Claude Code's notice for a plugin's server under a deployed managed MCP file, which connects no
// plugin's server (`by`, b:43558897).
const MANAGED_MCP_FILE_TEXT: &str = concat!(
    "Your organization's managed MCP config has exclusive control over MCP servers in this ",
    "session."
);

/// How the probe's process starts: its environment, its whole command line, the folder it runs in
/// (the daemon's empty folder where `None`), the plugin folders its `initialize` lists and the
/// account it runs under.
pub(crate) struct ClaudeMcpProbeProcessRequest {
    /// The environment of a process on the account's home.
    pub(crate) environment: Vec<(String, String)>,
    /// The command line.
    pub(crate) arguments: Vec<String>,
    /// The folder it runs in; the daemon's empty folder where `None`.
    pub(crate) working_folder: Option<PathBuf>,
    /// The plugin folders the command line loads with `--plugin-dir`, listed again in its
    /// `initialize` so the reply says whether each loaded at launch; empty where it loads none.
    pub(crate) plugin_folders: Vec<PathBuf>,
    /// The account it runs under.
    pub(crate) provider_account_id: ProviderAccountId,
}

/// The probe's process once its `initialize` is answered: the process to send the probe's
/// requests on and close, the `initialize` reply, and what the process writes, in order.
pub(crate) struct ClaudeMcpProbeProcess {
    /// The process.
    pub(crate) channel: Arc<dyn ClaudeProcessChannel>,
    /// The `initialize` reply; `None` where it carried none.
    pub(crate) initialize: Option<Box<RawValue>>,
    /// What the process writes, its `system/init` frame among them.
    pub(crate) arrivals: mpsc::UnboundedReceiver<ClaudeShortProcessArrival>,
}

/// What the probe starts its processes from and re-reads each declaration from.
pub(crate) struct ClaudeMcpProbeSources<'sources> {
    /// Every process the driver starts.
    pub(crate) starts: &'sources dyn ClaudeProcessStarts,
    /// The environment of a process on the account's home.
    pub(crate) environment: Vec<(String, String)>,
    /// The account the processes run under.
    pub(crate) provider_account_id: ProviderAccountId,
    /// Whether an administrator's MCP file is deployed, under which `--strict-mcp-config` makes
    /// Claude Code exit at start.
    pub(crate) has_managed_mcp_file: bool,
    /// The person's own config files.
    pub(crate) person: &'sources ClaudePersonConfigFiles,
    /// Each plugin installed in the daemon's plugin home, with its install root.
    pub(crate) plugin_roots: &'sources [ClaudePluginRoot],
    /// The attached project roots, in the order the probe goes through them.
    pub(crate) attached_roots: &'sources [PlacedPath],
    /// Each organization server of the account as `mcp_set_servers` takes it, by its name; one
    /// with no entry here cannot be sent whole.
    pub(crate) organization_entries: &'sources BTreeMap<McpServerName, ClaudeToolServerEntry>,
}

// One process's worth of targets: the root it runs in, and each target with the name it is sent
// and reported under, every name once.
struct ProbeBatch<'targets> {
    root: Option<PlacedPath>,
    targets: Vec<(&'targets McpProbeTarget, String)>,
}

// What the probe read for one server: its reading, its scrubbed and bounded error text, its
// tools' names, and whether the set's reply failed it, which no later status changes.
struct ProbeStatus {
    reading: McpServerReading,
    failure_text: Option<String>,
    tool_names: Vec<McpToolName>,
    is_failed_by_set: bool,
}

/// What the probe does with one binding: starts it, or reads it with no process.
pub(crate) enum ClaudeProbePlan {
    /// The binding is probed: a plugin's server loaded with its plugin, any other sent with its
    /// declaration, since the probe's process loads none of the person's files.
    Probe(McpProbeTarget),
    /// The binding's reading without a process.
    Withheld(McpProbeReading),
}

/// What the probe does with `binding` at the roots `roots` reads: a `project` binding its root
/// keeps out, or a `project` or `local` binding switched off there, reads switched off unrun, as
/// Claude Code holds it back; every other binding is probed, a `project` one the folder never
/// approved included, since Claude Code loads it in every process the daemon starts, and a
/// plugin's server through its plugin's load. `None` for a connector, which its account's own
/// process reports.
pub(crate) fn plan_claude_probe(
    binding: &McpServerBindingRef,
    roots: &[ClaudeMcpRootConfig],
) -> Option<ClaudeProbePlan> {
    let at_root =
        |scope_ref: &FilesystemPath| roots.iter().find(|root| root.root.path == *scope_ref);
    let withheld = |reading| {
        Some(ClaudeProbePlan::Withheld(McpProbeReading {
            binding: binding.clone(),
            reading,
            failure_text: None,
            tool_names: Vec::new(),
        }))
    };
    match binding {
        McpServerBindingRef::Connector { .. } => return None,
        McpServerBindingRef::Project {
            scope_ref,
            server_name,
            ..
        } => {
            if at_root(scope_ref).is_some_and(|root| {
                is_kept_out_server(&root.kept_out_server_names, server_name)
                    || root.switched_off_server_names.contains(server_name)
            }) {
                return withheld(McpServerReading::SwitchedOff);
            }
        }
        McpServerBindingRef::Local {
            scope_ref,
            server_name,
            ..
        } => {
            if at_root(scope_ref)
                .is_some_and(|root| root.switched_off_server_names.contains(server_name))
            {
                return withheld(McpServerReading::SwitchedOff);
            }
        }
        McpServerBindingRef::Plugin { .. } => {
            return Some(ClaudeProbePlan::Probe(McpProbeTarget {
                binding: binding.clone(),
                start: McpProbeStart::LoadedByProvider,
            }));
        }
        McpServerBindingRef::User { .. } | McpServerBindingRef::Managed { .. } => {}
    }
    Some(ClaudeProbePlan::Probe(McpProbeTarget {
        binding: binding.clone(),
        start: McpProbeStart::DeclarationSent,
    }))
}

/// Probes `targets` through `sources`: a plugin's server in the plugins' own process, and every
/// other binding in one process per attached root in turn, a `project` or `local` binding at its
/// own root and the rest at the first attached root. An organization's server is sent as its
/// managed settings declare it, and every other declaration is re-read from the person's config,
/// each file once. A target sent with its declaration whose entry is gone, or a plugin's server
/// whose plugin is gone, gets no reading; one whose entry the set cannot carry whole, an
/// organization's server with no sendable entry among them, reads `unknown` unsent; one the status
/// never names reads `starting` with no tools. Fails as the config read or a sent server's start
/// or request does, the process then closed.
pub(crate) async fn probe_claude_mcp_servers(
    sources: &ClaudeMcpProbeSources<'_>,
    targets: &[McpProbeTarget],
) -> Result<Vec<McpProbeReading>, DriverError> {
    let ceiling = probe_ceiling(&sources.environment);
    let (plugin_targets, sent_targets): (Vec<&McpProbeTarget>, Vec<&McpProbeTarget>) = targets
        .iter()
        .partition(|target| target.start == McpProbeStart::LoadedByProvider);
    let mut entries = ClaudeServerEntryReader::new(sources.person);
    let mut readings = Vec::with_capacity(targets.len());
    for batch in batch_targets(sources.attached_roots, &sent_targets) {
        let mut servers = BTreeMap::new();
        let mut asked: Vec<(&McpProbeTarget, String)> = Vec::new();
        for (target, name) in batch.targets {
            let sent = match &target.binding {
                McpServerBindingRef::Managed { server_name, .. } => Some(
                    sources
                        .organization_entries
                        .get(server_name)
                        .cloned()
                        .map_or(SentEntry::Unsendable, |entry| {
                            SentEntry::Sent(expand_entry_variables(entry, &sources.environment))
                        }),
                ),
                binding @ (McpServerBindingRef::User { .. }
                | McpServerBindingRef::Project { .. }
                | McpServerBindingRef::Local { .. }
                | McpServerBindingRef::Plugin { .. }
                | McpServerBindingRef::Connector { .. }) => entries
                    .read(binding)
                    .await
                    .map_err(|error| DriverError::Internal(Box::new(error)))?
                    .map(|entry| match compose_tool_server_entry(entry) {
                        Some(entry) => {
                            SentEntry::Sent(expand_entry_variables(entry, &sources.environment))
                        }
                        None => SentEntry::Unsendable,
                    }),
            };
            match sent {
                None => continue,
                Some(SentEntry::Unsendable) => {
                    readings.push(McpProbeReading {
                        binding: target.binding.clone(),
                        reading: McpServerReading::Observed(McpServerStatus::Unknown),
                        failure_text: None,
                        tool_names: Vec::new(),
                    });
                    continue;
                }
                Some(SentEntry::Sent(entry)) => {
                    servers.insert(name.clone(), entry);
                }
            }
            asked.push((target, name));
        }
        if asked.is_empty() {
            continue;
        }
        let mut arguments = compose_claude_control_only_arguments(None);
        if !sources.has_managed_mcp_file {
            arguments.push("--strict-mcp-config".to_owned());
        }
        let names: Vec<&str> = asked.iter().map(|(_target, name)| name.as_str()).collect();
        let mut statuses = run_probe_process(
            sources,
            ProbeProcess {
                arguments,
                environment: sources.environment.clone(),
                working_folder: batch.root.map(|root| PathBuf::from(root.path.as_str())),
                servers,
                plugin_folders: Vec::new(),
                plugin_servers: Vec::new(),
            },
            &names,
            ceiling,
        )
        .await?;
        readings.extend(
            asked
                .into_iter()
                .map(|(target, name)| read_target(target, statuses.remove(&name))),
        );
    }
    readings.extend(probe_claude_plugins(sources, &plugin_targets, ceiling).await);
    Ok(readings)
}

// Probes the plugin servers `targets` names in one process that loads each of their plugins from
// its install root with `--plugin-dir`, as Claude Code loads one, so its own plugin check decides
// what loads. `--strict-mcp-config` would connect no plugin's server, so it is left off, and the
// account's claude.ai connectors are switched off. A server Claude Code reports nowhere reads
// `failed` with its plugin's load error; under a deployed managed MCP file no plugin's server
// loads, so each reads `failed` with Claude Code's notice and no process starts. A start or a
// request that fails fails each server with its scrubbed error. A server whose plugin is gone gets
// no reading.
async fn probe_claude_plugins(
    sources: &ClaudeMcpProbeSources<'_>,
    targets: &[&McpProbeTarget],
    ceiling: Duration,
) -> Vec<McpProbeReading> {
    let mut plugin_folders: Vec<&Path> = Vec::new();
    let mut asked: Vec<(&McpProbeTarget, String)> = Vec::new();
    let mut plugin_servers: Vec<(String, &ClaudePluginRoot)> = Vec::new();
    for target in targets {
        let McpServerBindingRef::Plugin {
            scope_ref,
            server_name,
            ..
        } = &target.binding
        else {
            continue;
        };
        let Some(plugin) = sources
            .plugin_roots
            .iter()
            .find(|plugin| plugin.name == *scope_ref)
        else {
            continue;
        };
        if !plugin_folders.contains(&plugin.root.as_path()) {
            plugin_folders.push(&plugin.root);
        }
        let name = format!("plugin:{}:{}", plugin.loaded_name, server_name.as_str());
        if asked
            .iter()
            .all(|(_target, asked_name)| *asked_name != name)
        {
            plugin_servers.push((name.clone(), plugin));
            asked.push((target, name));
        }
    }
    if asked.is_empty() {
        return Vec::new();
    }
    let names: Vec<&str> = asked.iter().map(|(_target, name)| name.as_str()).collect();
    let statuses = if sources.has_managed_mcp_file {
        Err(MANAGED_MCP_FILE_TEXT.to_owned())
    } else {
        let mut arguments = compose_claude_control_only_arguments(None);
        for folder in &plugin_folders {
            arguments.push("--plugin-dir".to_owned());
            arguments.push(folder.to_string_lossy().into_owned());
        }
        let mut environment = sources.environment.clone();
        environment.push((CONNECTORS_SWITCH_VARIABLE.to_owned(), "false".to_owned()));
        run_probe_process(
            sources,
            ProbeProcess {
                arguments,
                environment,
                working_folder: None,
                servers: BTreeMap::new(),
                plugin_folders: plugin_folders
                    .iter()
                    .map(|folder| folder.to_path_buf())
                    .collect(),
                plugin_servers,
            },
            &names,
            ceiling,
        )
        .await
        .map_err(|error| sanitize_failure_chain(&error, FAILURE_TEXT_MAX_CODE_POINTS))
    };
    match statuses {
        Ok(mut statuses) => asked
            .into_iter()
            .map(|(target, name)| read_target(target, statuses.remove(&name)))
            .collect(),
        Err(failure_text) => asked
            .into_iter()
            .map(|(target, _name)| McpProbeReading {
                binding: target.binding.clone(),
                reading: McpServerReading::Observed(McpServerStatus::Failed),
                failure_text: Some(failure_text.clone()),
                tool_names: Vec::new(),
            })
            .collect(),
    }
}

// How one probe process starts and what it is sent: its command line, its environment, the
// folder it runs in (the daemon's empty folder where `None`), the servers sent with
// `mcp_set_servers` (none sent where empty), the plugin folders it loads, and each plugin server
// it probes by its reported name with its plugin, where one Claude Code reports nowhere reads
// `failed` rather than `starting`.
struct ProbeProcess<'plugins> {
    arguments: Vec<String>,
    environment: Vec<(String, String)>,
    working_folder: Option<PathBuf>,
    servers: BTreeMap<String, ClaudeToolServerEntry>,
    plugin_folders: Vec<PathBuf>,
    plugin_servers: Vec<(String, &'plugins ClaudePluginRoot)>,
}

// Starts `process` under `sources`' account, reads what becomes of each of `names` within
// `ceiling`, and closes it. Fails as the start or a request does.
async fn run_probe_process(
    sources: &ClaudeMcpProbeSources<'_>,
    process: ProbeProcess<'_>,
    names: &[&str],
    ceiling: Duration,
) -> Result<BTreeMap<String, ProbeStatus>, DriverError> {
    let mut probe = sources
        .starts
        .start_mcp_probe(ClaudeMcpProbeProcessRequest {
            environment: process.environment,
            arguments: process.arguments,
            working_folder: process.working_folder,
            plugin_folders: process.plugin_folders,
            provider_account_id: sources.provider_account_id.clone(),
        })
        .await?;
    let read = read_probe_statuses(
        &mut probe,
        process.servers,
        names,
        &process.plugin_servers,
        ceiling,
    )
    .await;
    probe.channel.close().await;
    Ok(read?)
}

// `target`'s reading from what the probe read of it; one the status never named reads `starting`
// with no tools.
fn read_target(target: &McpProbeTarget, status: Option<ProbeStatus>) -> McpProbeReading {
    let status = status.unwrap_or(ProbeStatus {
        reading: McpServerReading::Observed(McpServerStatus::Starting),
        failure_text: None,
        tool_names: Vec::new(),
        is_failed_by_set: false,
    });
    McpProbeReading {
        binding: target.binding.clone(),
        reading: status.reading,
        failure_text: status.failure_text,
        tool_names: status.tool_names,
    }
}

/// How long the probe waits for its servers: Claude Code's one startup timeout, which every server
/// shares, read from `environment` (`MCP_TIMEOUT`, in milliseconds, 30 s where unset), plus 5 s.
pub(crate) fn probe_ceiling(environment: &[(String, String)]) -> Duration {
    let startup_timeout = environment
        .iter()
        .rev()
        .find(|(name, _value)| name == MCP_TIMEOUT_VARIABLE)
        .and_then(|(_name, value)| value.trim().parse::<u64>().ok())
        .filter(|milliseconds| *milliseconds > 0)
        .map_or(DEFAULT_MCP_STARTUP_TIMEOUT, Duration::from_millis);
    startup_timeout + PROBE_CEILING_MARGIN
}

// The targets in batches, one root per batch and each name once in a batch, so a server of one
// name in two scopes is probed in a process of its own.
fn batch_targets<'targets>(
    attached_roots: &[PlacedPath],
    targets: &[&'targets McpProbeTarget],
) -> Vec<ProbeBatch<'targets>> {
    let first_root = attached_roots.first().cloned().or_else(|| {
        targets
            .iter()
            .find_map(|target| target_root(&target.binding))
    });
    let mut batches: Vec<ProbeBatch<'targets>> = Vec::new();
    for &target in targets {
        let root = target_root(&target.binding).or_else(|| first_root.clone());
        let name = claude_reported_server_name(&target.binding);
        match batches.iter_mut().find(|batch| {
            batch.root == root && batch.targets.iter().all(|(_target, sent)| *sent != name)
        }) {
            Some(batch) => batch.targets.push((target, name)),
            None => batches.push(ProbeBatch {
                root,
                targets: vec![(target, name)],
            }),
        }
    }
    batches
}

// The root a `project` or `local` binding is declared at.
fn target_root(binding: &McpServerBindingRef) -> Option<PlacedPath> {
    match binding {
        McpServerBindingRef::Project {
            scope_ref, place, ..
        }
        | McpServerBindingRef::Local {
            scope_ref, place, ..
        } => Some(PlacedPath {
            path: scope_ref.clone(),
            place: place.clone(),
        }),
        McpServerBindingRef::User { .. }
        | McpServerBindingRef::Plugin { .. }
        | McpServerBindingRef::Connector { .. }
        | McpServerBindingRef::Managed { .. } => None,
    }
}

// What the probe does with one declared entry: sends it, its variables filled, or reads it
// `unknown` unsent.
enum SentEntry {
    Sent(ClaudeToolServerEntry),
    Unsendable,
}

// One server's entry as the person wrote it, values included, with whether it fetches its headers
// from a program or signs in itself, which the set cannot carry. It derives no `Debug`, so
// nothing prints a value.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeDeclaredServer {
    #[serde(rename = "type", default)]
    transport: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    headers_helper: Option<IgnoredAny>,
    #[serde(default)]
    oauth: Option<IgnoredAny>,
}

/// A declared entry as `mcp_set_servers` takes it, values included; `None` for an entry of another
/// shape, a transport the set has no form for, or one that fetches its headers or signs in itself.
pub(crate) fn compose_tool_server_entry(entry: Value) -> Option<ClaudeToolServerEntry> {
    let declared: ClaudeDeclaredServer = serde_json::from_value(entry).ok()?;
    if declared.headers_helper.is_some() || declared.oauth.is_some() {
        return None;
    }
    match declared.transport.as_deref() {
        None | Some("stdio") => Some(ClaudeToolServerEntry::Stdio {
            command: declared.command?,
            args: declared.args,
            env: declared.env,
        }),
        Some("http") => Some(ClaudeToolServerEntry::Http {
            url: declared.url?,
            headers: declared.headers,
        }),
        Some("sse") => Some(ClaudeToolServerEntry::Sse {
            url: declared.url?,
            headers: declared.headers,
        }),
        Some(_) => None,
    }
}

// Sends `servers` on `probe` and reads what becomes of each of `names`: a server the set's reply
// names in its errors reads `failed` with that text, and the rest are asked `mcp_status` until
// each is past `pending` or `ceiling` passes, a row of the process's `system/init` frame standing
// for a server no answer has named yet. Each of `plugin_servers` reported nowhere reads `failed`
// once a list is taken as Claude Code's whole one: the first list where the `initialize` reply
// says every plugin loaded, else the last list before `ceiling` passes, since a plugin's servers
// may still be registering. Fails as a request does.
async fn read_probe_statuses(
    probe: &mut ClaudeMcpProbeProcess,
    servers: BTreeMap<String, ClaudeToolServerEntry>,
    names: &[&str],
    plugin_servers: &[(String, &ClaudePluginRoot)],
    ceiling: Duration,
) -> Result<BTreeMap<String, ProbeStatus>, ClaudeSessionError> {
    let deadline = Instant::now() + ceiling;
    let mut statuses: BTreeMap<String, ProbeStatus> = BTreeMap::new();
    if !servers.is_empty() {
        let answer = probe
            .channel
            .send_control_request(ClaudeControlRequest::McpSetServers { servers })
            .await?;
        let reply = ClaudeMcpSetServersReply::read(answer.response.as_deref());
        for (name, error) in reply.errors.into_iter().flatten() {
            if !names.contains(&name.as_str()) {
                continue;
            }
            let failure_text = bound_failure_text(&name, &error);
            statuses.insert(
                name,
                ProbeStatus {
                    reading: McpServerReading::Observed(McpServerStatus::Failed),
                    failure_text,
                    tool_names: Vec::new(),
                    is_failed_by_set: true,
                },
            );
        }
    }
    let is_settled = |statuses: &BTreeMap<String, ProbeStatus>| {
        names.iter().all(|name| {
            statuses.get(*name).is_some_and(|status| {
                status.reading != McpServerReading::Observed(McpServerStatus::Starting)
            })
        })
    };
    let is_plugin_list_whole = are_plugins_applied(probe.initialize.as_deref());
    let mut plugin_load_errors: Option<PluginLoadErrors> = None;
    let mut has_listed = false;
    while !is_settled(&statuses) {
        let answer = probe
            .channel
            .send_control_request(ClaudeControlRequest::McpStatus {})
            .await?;
        let reply = ClaudeMcpStatusReply::read(answer.response.as_deref());
        // Every frame the process wrote before this answer has arrived by now.
        while let Ok(arrival) = probe.arrivals.try_recv() {
            if let ClaudeShortProcessArrival::Frame(frame) = arrival
                && let Some(handshake) = &frame.observation.handshake
            {
                if let Some(rows) = &handshake.mcp_servers {
                    record_init_rows(rows, names, &mut statuses);
                }
                plugin_load_errors = Some(PluginLoadErrors::read(&frame.text));
            }
        }
        has_listed |= record_status_reply(&reply, names, &mut statuses);
        let now = Instant::now();
        if has_listed && (is_plugin_list_whole || now >= deadline) {
            fail_unreported_plugin_servers(
                plugin_servers,
                plugin_load_errors.as_ref(),
                &mut statuses,
            );
        }
        if is_settled(&statuses) || now >= deadline {
            break;
        }
        tokio::time::sleep_until((now + PROBE_STATUS_INTERVAL).min(deadline)).await;
    }
    Ok(statuses)
}

// Records each row of an `mcp_status` answer for one of `names` through the one status mapping,
// with its tools; a reading the set's errors gave is kept. Whether the answer carries a list; one
// with none changes nothing.
fn record_status_reply(
    reply: &ClaudeMcpStatusReply,
    names: &[&str],
    statuses: &mut BTreeMap<String, ProbeStatus>,
) -> bool {
    let Some(read) = normalize_claude_mcp_status_reply(reply) else {
        return false;
    };
    for rejection in &read.rejections {
        tracing::warn!(
            reason = %rejection.reason,
            "a row of the MCP server probe's status answer was refused"
        );
    }
    for emission in read.emissions {
        let name = emission.server_name.as_str();
        let is_failed_by_set = statuses
            .get(name)
            .is_some_and(|status| status.is_failed_by_set);
        if !names.contains(&name) || is_failed_by_set {
            continue;
        }
        statuses.insert(
            name.to_owned(),
            ProbeStatus {
                reading: emission.reading,
                failure_text: emission.failure_text,
                tool_names: emission.tool_names.unwrap_or_default(),
                is_failed_by_set: false,
            },
        );
    }
    true
}

// Records each row of the `system/init` frame's server list for one of `names` that nothing has
// read yet; the list names no tools, so a status answer's row always stands over it.
fn record_init_rows(
    rows: &McpServerStatusIngestResult,
    names: &[&str],
    statuses: &mut BTreeMap<String, ProbeStatus>,
) {
    for emission in &rows.emissions {
        let name = emission.server_name.as_str();
        if !names.contains(&name) || statuses.contains_key(name) {
            continue;
        }
        statuses.insert(
            name.to_owned(),
            ProbeStatus {
                reading: emission.reading,
                failure_text: emission.failure_text.clone(),
                tool_names: Vec::new(),
                is_failed_by_set: false,
            },
        );
    }
}

// Reads each of `plugin_servers` nothing has reported as `failed`, with its plugin's load error
// from the `system/init` frame, scrubbed, where the frame names one, else the plain line.
fn fail_unreported_plugin_servers(
    plugin_servers: &[(String, &ClaudePluginRoot)],
    plugin_load_errors: Option<&PluginLoadErrors>,
    statuses: &mut BTreeMap<String, ProbeStatus>,
) {
    for (name, plugin) in plugin_servers {
        if statuses.contains_key(name) {
            continue;
        }
        let failure_text = plugin_load_errors
            .and_then(|errors| errors.message_for(plugin))
            .and_then(|message| bound_failure_text(name, &Value::String(message.to_owned())))
            .unwrap_or_else(|| PLUGIN_NOT_LOADED_TEXT.to_owned());
        statuses.insert(
            name.clone(),
            ProbeStatus {
                reading: McpServerReading::Observed(McpServerStatus::Failed),
                failure_text: Some(failure_text),
                tool_names: Vec::new(),
                is_failed_by_set: false,
            },
        );
    }
}

// Claude Code's `error` for the server `name`, scrubbed and bounded as a status row's is; `None`
// where it has no text.
fn bound_failure_text(name: &str, error: &Value) -> Option<String> {
    bound_mcp_server_status_emission(
        &Value::String(name.to_owned()),
        McpServerReading::Observed(McpServerStatus::Failed),
        error,
        None,
    )
    .ok()
    .and_then(|emission| emission.failure_text)
}

#[cfg(test)]
mod tests;
