//! The machine probe of Claude Code's MCP servers, for bindings no live session reads, in
//! processes that keep nothing, one per attached root in turn, each sent its servers with
//! `mcp_set_servers` and asked `mcp_status` until every server is past `pending` or the ceiling
//! passes, then closed. No turn is sent. Each process runs under `--strict-mcp-config` unless an
//! administrator's MCP file is deployed, and loads each probed plugin from its install root with
//! `--plugin-dir-no-mcp`, so Claude Code's own plugin check decides whether it loads while the
//! daemon sends its servers. Each declaration is re-read from the person's config or the plugin's
//! files, its variables filled as Claude Code fills them on load, and dropped once sent. An entry
//! the set cannot carry whole, one that fetches its headers or signs in itself, or one over a
//! transport the set has no form for, is not sent and reads `unknown`, an organization's server
//! included.
//! Budget: one such process of about 140 to 150 MB at a time, run only when a refresh asks for a
//! probe, each closed once its servers settle or its ceiling passes; nothing polls between probes.

mod plugin_load;
pub(crate) mod sent_entry;
mod variables;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::{
    McpServerBindingRef, McpServerName, McpServerStatus, McpToolName,
};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tokio::sync::mpsc;
use tokio::time::Instant;

use self::plugin_load::{PluginLoad, PluginLoadReport};
use self::sent_entry::{SentEntry, compose_sent_entry};
use self::variables::expand_entry_variables;
use crate::driver::claude::mcp::config::{
    ClaudeMcpRootConfig, ClaudePersonConfigFiles, ClaudePluginRoot, ClaudeServerEntryReader,
    is_kept_out_server,
};
use crate::driver::claude::mcp::precedence::claude_reported_server_name;
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::process::ClaudeStreamFrame;
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
    McpServerReading, McpServerStatusIngestResult, bound_mcp_server_status_emission,
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
// The failure text of a plugin's server whose plugin Claude Code did not load, where no load
// error names it or no `system/init` frame came.
const PLUGIN_NOT_LOADED_TEXT: &str = "Claude Code did not load the plugin.";
// The failure text of a server the probe sent that no status answer named by the ceiling.
const SERVER_NOT_REPORTED_TEXT: &str = "Claude Code did not report the server.";
// Claude Code's notice where a deployed managed MCP file connects no plugin's server (`Nl`,
// b:43558700).
const MANAGED_MCP_FILE_TEXT: &str = concat!(
    "Your organization's managed MCP config has exclusive control over MCP servers in this ",
    "session."
);

/// How the probe's process starts: its environment, its whole command line, the folder it runs in
/// (the daemon's empty folder where `None`) and the account it runs under.
pub(crate) struct ClaudeMcpProbeProcessRequest {
    /// The environment of a process on the account's home.
    pub(crate) environment: Vec<(String, String)>,
    /// The command line.
    pub(crate) arguments: Vec<String>,
    /// The folder it runs in; the daemon's empty folder where `None`.
    pub(crate) working_folder: Option<PathBuf>,
    /// The account it runs under.
    pub(crate) provider_account_id: ProviderAccountId,
}

/// The probe's process once its `initialize` is answered: the process to send the probe's
/// requests on and close, and what the process writes, in order.
pub(crate) struct ClaudeMcpProbeProcess {
    /// The process.
    pub(crate) channel: Arc<dyn ClaudeProcessChannel>,
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
    /// The daemon's plugin home for Claude Code.
    pub(crate) plugin_home: &'sources Path,
    /// Each plugin installed in the daemon's plugin home, with its install root.
    pub(crate) plugin_roots: &'sources [ClaudePluginRoot],
    /// The attached project roots, in the order the probe goes through them.
    pub(crate) attached_roots: &'sources [PlacedPath],
    /// Each organization server of the account as `mcp_set_servers` takes it, by its name; one
    /// with no entry here cannot be sent whole.
    pub(crate) organization_entries: &'sources BTreeMap<McpServerName, ClaudeToolServerEntry>,
}

// One process's worth of targets: the root it runs in, each target with the name it is sent and
// reported under, every name once, and the plugins its targets come from, no two loaded under one
// name.
struct ProbeBatch<'targets> {
    root: Option<PlacedPath>,
    targets: Vec<(&'targets McpProbeTarget, String)>,
    plugins: Vec<&'targets ClaudePluginRoot>,
}

// What the probe read for one server: its reading, its scrubbed and bounded error text, its
// tools' names, and whether it was read before the status answers (the set's errors or its
// plugin's refusal), which no later status changes.
struct ProbeStatus {
    reading: McpServerReading,
    failure_text: Option<String>,
    tool_names: Vec<McpToolName>,
    is_final: bool,
}

/// What the probe does with one binding: starts it, or reads it with no process.
pub(crate) enum ClaudeProbePlan {
    /// The binding is sent with its declaration, since the probe's process loads none of the
    /// person's files and none of a plugin's servers.
    Probe(McpProbeTarget),
    /// The binding's reading without a process.
    Withheld(McpProbeReading),
}

/// What the probe does with `binding` at the roots `roots` reads: a `project` binding its root
/// keeps out, or a `project` or `local` binding switched off there, reads switched off unrun, as
/// Claude Code holds it back; every other binding is probed, a `project` one the folder never
/// approved included, since Claude Code loads it in every process the daemon starts. `None` for a
/// connector, which its account's own process reports.
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
        McpServerBindingRef::User { .. }
        | McpServerBindingRef::Plugin { .. }
        | McpServerBindingRef::Managed { .. } => {}
    }
    Some(ClaudeProbePlan::Probe(McpProbeTarget {
        binding: binding.clone(),
        start: McpProbeStart::DeclarationSent,
    }))
}

/// Probes `targets` through `sources`, one process per attached root in turn: a `project` or
/// `local` binding at its own root, every other binding at the first attached root, and plugins
/// Claude Code loads under one name in processes of their own. An organization's server is sent as
/// its managed settings declare it, and every other declaration is re-read from the person's
/// config or its plugin's files, each file once. A plugin's server is sent only where Claude Code
/// loaded its plugin, and reads `failed` with Claude Code's own words otherwise, or with Claude
/// Code's notice, unsent, where a deployed managed MCP file connects no plugin's server. A target
/// whose entry or plugin is gone gets no reading; one whose entry the
/// set cannot carry whole, an organization's server with no sendable entry among them, reads
/// `unknown` unsent; a sent one no status answer names by the ceiling reads `failed`. Fails as the
/// config read, a start or a request does, the process then closed.
pub(crate) async fn probe_claude_mcp_servers(
    sources: &ClaudeMcpProbeSources<'_>,
    targets: &[McpProbeTarget],
) -> Result<Vec<McpProbeReading>, DriverError> {
    let ceiling = probe_ceiling(&sources.environment);
    let mut entries = ClaudeServerEntryReader::new(sources.person, sources.plugin_home);
    let mut readings = Vec::with_capacity(targets.len());
    for batch in batch_targets(sources.attached_roots, sources.plugin_roots, targets) {
        let mut servers = BTreeMap::new();
        let mut plugin_servers: Vec<ProbePluginServer<'_>> = Vec::new();
        let mut asked: Vec<(&McpProbeTarget, String)> = Vec::new();
        for (target, name) in batch.targets {
            let sent = match &target.binding {
                McpServerBindingRef::Managed { server_name, .. } => Some((
                    sources
                        .organization_entries
                        .get(server_name)
                        .cloned()
                        .map_or(SentEntry::Unsendable, |entry| {
                            SentEntry::Sent(expand_entry_variables(
                                entry,
                                &sources.environment,
                                None,
                            ))
                        }),
                    None,
                )),
                binding @ (McpServerBindingRef::User { .. }
                | McpServerBindingRef::Project { .. }
                | McpServerBindingRef::Local { .. }
                | McpServerBindingRef::Plugin { .. }
                | McpServerBindingRef::Connector { .. }) => {
                    let Some(declared) = entries
                        .read(binding)
                        .await
                        .map_err(|error| DriverError::Internal(Box::new(error)))?
                    else {
                        continue;
                    };
                    let plugin = match &declared.plugin_folders {
                        Some(folders) => {
                            let Some(plugin) = sources
                                .plugin_roots
                                .iter()
                                .find(|plugin| plugin.root == folders.root)
                            else {
                                continue;
                            };
                            if sources.has_managed_mcp_file {
                                readings.push(McpProbeReading {
                                    binding: target.binding.clone(),
                                    reading: McpServerReading::Observed(McpServerStatus::Failed),
                                    failure_text: Some(MANAGED_MCP_FILE_TEXT.to_owned()),
                                    tool_names: Vec::new(),
                                });
                                continue;
                            }
                            Some(plugin)
                        }
                        None => None,
                    };
                    Some((
                        compose_sent_entry(declared, &sources.environment, batch.root.as_ref()),
                        plugin,
                    ))
                }
            };
            match sent {
                None => continue,
                Some((SentEntry::Unsendable, _plugin)) => {
                    readings.push(McpProbeReading {
                        binding: target.binding.clone(),
                        reading: McpServerReading::Observed(McpServerStatus::Unknown),
                        failure_text: None,
                        tool_names: Vec::new(),
                    });
                    continue;
                }
                Some((SentEntry::Sent(entry), None)) => {
                    servers.insert(name.clone(), entry);
                }
                Some((SentEntry::Sent(entry), Some(plugin))) => {
                    plugin_servers.push(ProbePluginServer {
                        name: name.clone(),
                        plugin,
                        entry,
                    });
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
        let mut plugin_folders: Vec<&Path> = Vec::new();
        for server in &plugin_servers {
            if !plugin_folders.contains(&server.plugin.root.as_path()) {
                plugin_folders.push(&server.plugin.root);
            }
        }
        for folder in plugin_folders {
            arguments.push("--plugin-dir-no-mcp".to_owned());
            arguments.push(folder.to_string_lossy().into_owned());
        }
        let names: Vec<&str> = asked.iter().map(|(_target, name)| name.as_str()).collect();
        let mut statuses = run_probe_process(
            sources,
            ProbeProcess {
                arguments,
                working_folder: batch.root.map(|root| PathBuf::from(root.path.as_str())),
                servers,
                plugin_servers,
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
    Ok(readings)
}

// A plugin's server the probe sends where Claude Code loads its plugin: the name it is sent and
// reported under, its plugin, and its entry as sent.
struct ProbePluginServer<'plugins> {
    name: String,
    plugin: &'plugins ClaudePluginRoot,
    entry: ClaudeToolServerEntry,
}

// How one probe process starts and what it is sent: its command line, the folder it runs in (the
// daemon's empty folder where `None`), the servers sent with `mcp_set_servers` (none sent where
// empty) and the plugins' servers, sent with them where their plugin loads.
struct ProbeProcess<'plugins> {
    arguments: Vec<String>,
    working_folder: Option<PathBuf>,
    servers: BTreeMap<String, ClaudeToolServerEntry>,
    plugin_servers: Vec<ProbePluginServer<'plugins>>,
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
            environment: sources.environment.clone(),
            arguments: process.arguments,
            working_folder: process.working_folder,
            provider_account_id: sources.provider_account_id.clone(),
        })
        .await?;
    let read = read_probe_statuses(
        &mut probe,
        process.servers,
        process.plugin_servers,
        names,
        ceiling,
    )
    .await;
    probe.channel.close().await;
    Ok(read?)
}

// `target`'s reading from what the probe read of it; one nothing named, where no answer carried a
// list, reads `starting` with no tools.
fn read_target(target: &McpProbeTarget, status: Option<ProbeStatus>) -> McpProbeReading {
    let status = status.unwrap_or(ProbeStatus {
        reading: McpServerReading::Observed(McpServerStatus::Starting),
        failure_text: None,
        tool_names: Vec::new(),
        is_final: false,
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
// name in two scopes is probed in a process of its own, and so are plugins Claude Code loads under
// one name, whose load errors would otherwise name either.
fn batch_targets<'targets>(
    attached_roots: &[PlacedPath],
    plugin_roots: &'targets [ClaudePluginRoot],
    targets: &'targets [McpProbeTarget],
) -> Vec<ProbeBatch<'targets>> {
    let first_root = attached_roots.first().cloned().or_else(|| {
        targets
            .iter()
            .find_map(|target| target_root(&target.binding))
    });
    let mut batches: Vec<ProbeBatch<'targets>> = Vec::new();
    for target in targets {
        let root = target_root(&target.binding).or_else(|| first_root.clone());
        let name = claude_reported_server_name(&target.binding);
        let plugin = match &target.binding {
            McpServerBindingRef::Plugin { scope_ref, .. } => {
                plugin_roots.iter().find(|plugin| plugin.name == *scope_ref)
            }
            McpServerBindingRef::User { .. }
            | McpServerBindingRef::Project { .. }
            | McpServerBindingRef::Local { .. }
            | McpServerBindingRef::Connector { .. }
            | McpServerBindingRef::Managed { .. } => None,
        };
        let fits = |batch: &ProbeBatch<'_>| {
            batch.root == root
                && batch.targets.iter().all(|(_target, sent)| *sent != name)
                && plugin.is_none_or(|plugin| {
                    batch.plugins.iter().all(|held| {
                        held.root == plugin.root || held.loaded_name != plugin.loaded_name
                    })
                })
        };
        let index = batches.iter().position(fits).unwrap_or_else(|| {
            batches.push(ProbeBatch {
                root,
                targets: Vec::new(),
                plugins: Vec::new(),
            });
            batches.len() - 1
        });
        let batch = &mut batches[index];
        batch.targets.push((target, name));
        if let Some(plugin) = plugin
            && batch.plugins.iter().all(|held| held.root != plugin.root)
        {
            batch.plugins.push(plugin);
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

// Reads what becomes of each of `names` on `probe`. Where it probes plugins' servers it first
// waits, within `ceiling`, for the process's `system/init` frame: a server whose plugin the frame
// lists as loaded joins `servers`, and the rest read `failed` with their plugin's load error, else
// the plain line. Then `servers` are sent: one the set's reply names in its errors reads `failed`
// with that text, and the rest are asked `mcp_status` until each is past `pending` or `ceiling`
// passes from the send, a row of a `system/init` frame written after the send standing for a
// server no answer has named yet. A sent server no answer names by then reads `failed`. Fails as a
// request does.
async fn read_probe_statuses(
    probe: &mut ClaudeMcpProbeProcess,
    mut servers: BTreeMap<String, ClaudeToolServerEntry>,
    plugin_servers: Vec<ProbePluginServer<'_>>,
    names: &[&str],
    ceiling: Duration,
) -> Result<BTreeMap<String, ProbeStatus>, ClaudeSessionError> {
    let mut statuses: BTreeMap<String, ProbeStatus> = BTreeMap::new();
    if !plugin_servers.is_empty() {
        let report = wait_for_init_frame(&mut probe.arrivals, Instant::now() + ceiling)
            .await
            .map(|frame| PluginLoadReport::read(&frame.text));
        for server in plugin_servers {
            let message = match report.as_ref().map(|report| report.load_of(server.plugin)) {
                Some(PluginLoad::Accepted) => {
                    servers.insert(server.name, server.entry);
                    continue;
                }
                Some(PluginLoad::Refused(message)) => message,
                None => None,
            };
            let failure_text = message
                .and_then(|message| {
                    bound_failure_text(&server.name, &Value::String(message.to_owned()))
                })
                .unwrap_or_else(|| PLUGIN_NOT_LOADED_TEXT.to_owned());
            statuses.insert(server.name, failed_status(failure_text));
        }
    }
    let sent_names: Vec<String> = servers.keys().cloned().collect();
    let deadline = Instant::now() + ceiling;
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
                    is_final: true,
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
                && let Some(rows) = &handshake.mcp_servers
            {
                record_init_rows(rows, names, &mut statuses);
            }
        }
        has_listed |= record_status_reply(&reply, names, &mut statuses);
        let now = Instant::now();
        if is_settled(&statuses) || now >= deadline {
            break;
        }
        tokio::time::sleep_until((now + PROBE_STATUS_INTERVAL).min(deadline)).await;
    }
    if has_listed {
        for name in sent_names {
            statuses
                .entry(name)
                .or_insert_with(|| failed_status(SERVER_NOT_REPORTED_TEXT.to_owned()));
        }
    }
    Ok(statuses)
}

// The first `system/init` frame `arrivals` carries before `deadline`; `None` where the process
// ends or the deadline passes first.
async fn wait_for_init_frame(
    arrivals: &mut mpsc::UnboundedReceiver<ClaudeShortProcessArrival>,
    deadline: Instant,
) -> Option<Box<ClaudeStreamFrame>> {
    loop {
        match tokio::time::timeout_at(deadline, arrivals.recv()).await {
            Ok(Some(ClaudeShortProcessArrival::Frame(frame)))
                if frame.observation.handshake.is_some() =>
            {
                return Some(frame);
            }
            Ok(Some(_other)) => {}
            Ok(None) | Err(_) => return None,
        }
    }
}

// A server read `failed` before the status answers, with `failure_text`, which no later answer
// changes.
fn failed_status(failure_text: String) -> ProbeStatus {
    ProbeStatus {
        reading: McpServerReading::Observed(McpServerStatus::Failed),
        failure_text: Some(failure_text),
        tool_names: Vec::new(),
        is_final: true,
    }
}

// Records each row of an `mcp_status` answer for one of `names` through the one status mapping,
// with its tools; a reading read before the status answers is kept. Whether the answer carries a
// list; one with none changes nothing.
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
        let is_final = statuses.get(name).is_some_and(|status| status.is_final);
        if !names.contains(&name) || is_final {
            continue;
        }
        statuses.insert(
            name.to_owned(),
            ProbeStatus {
                reading: emission.reading,
                failure_text: emission.failure_text,
                tool_names: emission.tool_names.unwrap_or_default(),
                is_final: false,
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
                is_final: false,
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
