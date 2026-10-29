//! The machine probe of Claude Code's MCP servers, for bindings no live session reads: one process
//! that keeps nothing per attached root in turn, under `--strict-mcp-config` unless an
//! administrator's MCP file is deployed, sent the probed servers with `mcp_set_servers`, each
//! declaration re-read from the person's config, its variables filled as Claude Code fills them on
//! load, and dropped once sent, then asked `mcp_status` until every server is past `pending` or
//! the ceiling passes, and closed. No turn is sent. An entry the set cannot carry whole, one that
//! fetches its headers or signs in itself, or one over a transport the set has no form for, is not
//! sent and reads `unknown`.
//! Budget: one such process of about 140 to 150 MB at a time, run only when a refresh asks for a
//! probe, each closed once its servers settle or its ceiling passes; nothing polls between probes.

mod variables;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::Value;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::{
    McpServerBindingRef, McpServerName, McpServerStatus, McpToolName,
};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tokio::time::Instant;

use self::variables::{ClaudePluginPlaceholders, expand_entry_variables};
use crate::driver::claude::mcp::config::{
    ClaudeDeclaredEntry, ClaudeMcpRootConfig, ClaudePersonConfigFiles, ClaudeServerEntryReader,
};
use crate::driver::claude::mcp::precedence::claude_reported_server_name;
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeMcpSetServersReply, ClaudeToolServerEntry,
};
use crate::driver::claude::session::transport::mcp_status::ClaudeMcpStatusReply;
use crate::driver::claude::spawn::launch::control_only::compose_claude_control_only_arguments;
use crate::driver::claude::spawn::launch::installed_build::ClaudeProcessStarts;
use crate::driver::claude::tools::normalize_claude_mcp_status_reply;
use crate::driver::contract::error::DriverError;
use crate::driver::mcp_server::read::{McpProbeReading, McpProbeStart, McpProbeTarget};
use crate::driver::mcp_server::status::{McpServerReading, bound_mcp_server_status_emission};

// The environment variable naming Claude Code's startup timeout for every MCP server, in
// milliseconds, and the timeout where it is unset.
const MCP_TIMEOUT_VARIABLE: &str = "MCP_TIMEOUT";
const DEFAULT_MCP_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
// How long past the servers' startup timeout the probe still waits, so a server Claude Code may
// still start is not read as `starting`.
const PROBE_CEILING_MARGIN: Duration = Duration::from_secs(5);
// How long the probe waits before asking `mcp_status` again while a server is pending.
const PROBE_STATUS_INTERVAL: Duration = Duration::from_secs(1);

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
    /// The attached project roots, in the order the probe goes through them.
    pub(crate) attached_roots: &'sources [PlacedPath],
    /// Each organization server of the account as `mcp_set_servers` takes it, by its name.
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
    /// The binding is sent with its declaration, since the probe's process loads none of the
    /// person's files.
    Probe(McpProbeTarget),
    /// The binding's reading without a process.
    Withheld(McpProbeReading),
}

/// What the probe does with `binding` at the roots `roots` reads: a `project` binding its root
/// keeps out, or a `project` or `local` binding switched off there, reads switched off, and a
/// `project` binding never approved there reads `unknown`, neither run; every other binding is
/// probed. `None` for a connector, which its account's own process reports.
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
            if let Some(root) = at_root(scope_ref) {
                if root.kept_out_server_names.contains(server_name)
                    || root.switched_off_server_names.contains(server_name)
                {
                    return withheld(McpServerReading::SwitchedOff);
                }
                if root.unapproved_server_names.contains(server_name) {
                    return withheld(McpServerReading::Observed(McpServerStatus::Unknown));
                }
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
/// `local` binding at its own root, every other binding at the first attached root. An
/// organization's server is sent as its managed settings declare it, and every other declaration
/// is re-read from the person's config, each file once. A target sent with its declaration whose
/// entry is gone gets no reading; one whose entry the set cannot carry whole reads `unknown`
/// unsent; one the status never names reads `starting` with no tools. Fails as the config read, a
/// start or a request does, the process then closed.
pub(crate) async fn probe_claude_mcp_servers(
    sources: &ClaudeMcpProbeSources<'_>,
    targets: &[McpProbeTarget],
) -> Result<Vec<McpProbeReading>, DriverError> {
    let ceiling = probe_ceiling(&sources.environment);
    let mut entries = ClaudeServerEntryReader::new(sources.person, sources.plugin_home);
    let mut readings = Vec::with_capacity(targets.len());
    for batch in batch_targets(sources.attached_roots, targets) {
        let mut servers = BTreeMap::new();
        let mut asked: Vec<(&McpProbeTarget, String)> = Vec::new();
        for (target, name) in batch.targets {
            if target.start != McpProbeStart::LoadedByProvider {
                let sent = match &target.binding {
                    McpServerBindingRef::Managed { server_name, .. } => sources
                        .organization_entries
                        .get(server_name)
                        .cloned()
                        .map(|entry| expand_entry_variables(entry, &sources.environment, None))
                        .map(SentEntry::Sent),
                    binding @ (McpServerBindingRef::User { .. }
                    | McpServerBindingRef::Project { .. }
                    | McpServerBindingRef::Local { .. }
                    | McpServerBindingRef::Plugin { .. }
                    | McpServerBindingRef::Connector { .. }) => entries
                        .read(binding)
                        .await
                        .map_err(|error| DriverError::Internal(Box::new(error)))?
                        .map(|declared| {
                            compose_sent_entry(declared, &sources.environment, batch.root.as_ref())
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
        let channel = sources
            .starts
            .start_mcp_probe(ClaudeMcpProbeProcessRequest {
                environment: sources.environment.clone(),
                arguments,
                working_folder: batch.root.map(|root| PathBuf::from(root.path.as_str())),
                provider_account_id: sources.provider_account_id.clone(),
            })
            .await?;
        let names: Vec<&str> = asked.iter().map(|(_target, name)| name.as_str()).collect();
        let read = read_probe_statuses(&*channel, servers, &names, ceiling).await;
        channel.close().await;
        let mut statuses = read?;
        readings.extend(asked.into_iter().map(|(target, name)| {
            let status = statuses.remove(&name).unwrap_or(ProbeStatus {
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
        }));
    }
    Ok(readings)
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

// A declared entry as the probe sends it, a plugin's placeholders and every variable filled, or
// unsendable where the set cannot carry it whole.
fn compose_sent_entry(
    declared: ClaudeDeclaredEntry,
    environment: &[(String, String)],
    root: Option<&PlacedPath>,
) -> SentEntry {
    let placeholders = declared
        .plugin_folders
        .map(|folders| ClaudePluginPlaceholders {
            root: folders.root.to_string_lossy().into_owned(),
            data: folders.data.to_string_lossy().into_owned(),
            project: root.map(|root| root.path.as_str().to_owned()),
        });
    match compose_tool_server_entry(declared.entry) {
        Some(entry) => SentEntry::Sent(expand_entry_variables(
            entry,
            environment,
            placeholders.as_ref(),
        )),
        None => SentEntry::Unsendable,
    }
}

// A declared entry as `mcp_set_servers` takes it; `None` for an entry of another shape, a
// transport the set has no form for, or one that fetches its headers or signs in itself.
fn compose_tool_server_entry(entry: Value) -> Option<ClaudeToolServerEntry> {
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

// Sends `servers` on `channel` and reads what becomes of each of `names`: a server the set's reply
// names in its errors reads `failed` with that text, and the rest are asked `mcp_status` until
// each is past `pending` or `ceiling` passes. Fails as a request does.
async fn read_probe_statuses(
    channel: &dyn ClaudeProcessChannel,
    servers: BTreeMap<String, ClaudeToolServerEntry>,
    names: &[&str],
    ceiling: Duration,
) -> Result<BTreeMap<String, ProbeStatus>, ClaudeSessionError> {
    let deadline = Instant::now() + ceiling;
    let mut statuses: BTreeMap<String, ProbeStatus> = BTreeMap::new();
    if !servers.is_empty() {
        let answer = channel
            .send_control_request(ClaudeControlRequest::McpSetServers { servers })
            .await?;
        let reply = ClaudeMcpSetServersReply::read(answer.response.as_deref());
        for (name, error) in reply.errors.into_iter().flatten() {
            if !names.contains(&name.as_str()) {
                continue;
            }
            let reading = McpServerReading::Observed(McpServerStatus::Failed);
            let failure_text = bound_mcp_server_status_emission(
                &Value::String(name.clone()),
                reading,
                &error,
                None,
            )
            .ok()
            .and_then(|emission| emission.failure_text);
            statuses.insert(
                name,
                ProbeStatus {
                    reading,
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
    while !is_settled(&statuses) {
        let answer = channel
            .send_control_request(ClaudeControlRequest::McpStatus {})
            .await?;
        let reply = ClaudeMcpStatusReply::read(answer.response.as_deref());
        record_status_reply(&reply, names, &mut statuses);
        let now = Instant::now();
        if is_settled(&statuses) || now >= deadline {
            break;
        }
        tokio::time::sleep_until((now + PROBE_STATUS_INTERVAL).min(deadline)).await;
    }
    Ok(statuses)
}

// Records each row of an `mcp_status` answer for one of `names` through the one status mapping,
// with its tools; a reading the set's errors gave is kept, and an answer with no list changes
// nothing.
fn record_status_reply(
    reply: &ClaudeMcpStatusReply,
    names: &[&str],
    statuses: &mut BTreeMap<String, ProbeStatus>,
) {
    let Some(read) = normalize_claude_mcp_status_reply(reply) else {
        return;
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
}

#[cfg(test)]
mod tests;
