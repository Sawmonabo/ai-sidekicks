//! The machine probe of Claude Code's MCP servers, for bindings no live session reads: one process
//! that keeps nothing per attached root in turn, under `--strict-mcp-config` unless an
//! administrator's MCP file is deployed, sent the probed servers with `mcp_set_servers`, each
//! declaration re-read from the person's config and dropped once sent, then asked `mcp_status`
//! until every server is past `pending` or the ceiling passes, and closed. No turn is sent.
//! Budget: one such process of about 140 to 150 MB at a time, run only when a refresh asks for a
//! probe, each closed once its servers settle or its ceiling passes; nothing polls between probes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use sidekicks_contracts::mcp::server::{
    McpServerBindingRef, McpServerName, McpServerStatus, McpToolName,
};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tokio::time::Instant;

use crate::driver::claude::mcp::config::read_claude_mcp_server_entry;
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
    /// The person's own home folder, holding `.claude.json`.
    pub(crate) home: &'sources Path,
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

/// The probe target of `binding`, sent with its declaration, since the probe's process loads none
/// of the person's files; `None` for a connector, which its account's own process reports.
pub(crate) fn claude_probe_target(binding: &McpServerBindingRef) -> Option<McpProbeTarget> {
    match binding {
        McpServerBindingRef::Connector { .. } => None,
        McpServerBindingRef::User { .. }
        | McpServerBindingRef::Project { .. }
        | McpServerBindingRef::Local { .. }
        | McpServerBindingRef::Plugin { .. }
        | McpServerBindingRef::Managed { .. } => Some(McpProbeTarget {
            binding: binding.clone(),
            start: McpProbeStart::DeclarationSent,
        }),
    }
}

/// Probes `targets` through `sources`, one process per attached root in turn: a `project` or
/// `local` binding at its own root, every other binding at the first attached root. An
/// organization's server is sent as its managed settings declare it, and every other declaration
/// is re-read from the person's config. A target sent with its declaration whose entry is gone, or
/// that nothing declares in a form the set takes, gets no reading; one the status never names
/// reads `starting` with no tools. Fails as the config read, a start or a request does, the
/// process then closed.
pub(crate) async fn probe_claude_mcp_servers(
    sources: &ClaudeMcpProbeSources<'_>,
    targets: &[McpProbeTarget],
) -> Result<Vec<McpProbeReading>, DriverError> {
    let ceiling = probe_ceiling(&sources.environment);
    let mut readings = Vec::with_capacity(targets.len());
    for batch in batch_targets(sources.attached_roots, targets) {
        let mut servers = BTreeMap::new();
        let mut asked: Vec<(&McpProbeTarget, String)> = Vec::new();
        for (target, name) in batch.targets {
            if target.start != McpProbeStart::LoadedByProvider {
                let entry = match &target.binding {
                    McpServerBindingRef::Managed { server_name, .. } => {
                        sources.organization_entries.get(server_name).cloned()
                    }
                    binding => {
                        read_claude_mcp_server_entry(sources.home, sources.plugin_home, binding)
                            .await
                            .map_err(|error| DriverError::Internal(Box::new(error)))?
                            .and_then(compose_tool_server_entry)
                    }
                };
                let Some(entry) = entry else {
                    continue;
                };
                servers.insert(name.clone(), entry);
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

// How long the probe waits for its servers: Claude Code's one startup timeout, which every server
// shares, plus the margin.
fn probe_ceiling(environment: &[(String, String)]) -> Duration {
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

// One server's entry as the person wrote it, values included. It derives no `Debug`, so nothing
// prints a value.
#[derive(Deserialize)]
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
}

// A declared entry as `mcp_set_servers` takes it; `None` for an entry of another shape or a
// transport the set has no form for.
fn compose_tool_server_entry(entry: Value) -> Option<ClaudeToolServerEntry> {
    let declared: ClaudeDeclaredServer = serde_json::from_value(entry).ok()?;
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
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;

    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName, McpServerStatus};
    use sidekicks_platforms::Spawner;
    use tempfile::TempDir;
    use tokio::runtime::Handle;
    use tokio::time::Instant;

    use super::{ClaudeMcpProbeSources, claude_probe_target, probe_claude_mcp_servers};
    use crate::command_search::ProviderCommandSearch;
    use crate::driver::claude::DESCRIPTOR;
    use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
    use crate::driver::claude::session::scripted::starts::ScriptedStarts;
    use crate::driver::claude::spawn::launch::ClaudeProcessLauncher;
    use crate::driver::claude::spawn::launch::installed_build::{
        ClaudeInstalledBuild, ClaudeProcessStarts,
    };
    use crate::driver::contract::error::DriverError;
    use crate::driver::mcp_server::read::{McpProbeReading, McpProbeTarget};
    use crate::driver::mcp_server::status::McpServerReading;
    use crate::process_registry::ProviderProcessRegistry;
    use crate::runtime_binding::test_store::test_provider_account_id;

    // A home whose `.claude.json` declares each of `servers` as a `user` server.
    fn home_declaring(servers: &Value) -> TempDir {
        let home = tempfile::tempdir().expect("a test home");
        std::fs::write(
            home.path().join(".claude.json"),
            json!({ "mcpServers": servers }).to_string(),
        )
        .expect("the config is written");
        home
    }

    // The `user` server `name`, as the composition targets it.
    fn user_target(name: &str) -> McpProbeTarget {
        claude_probe_target(&McpServerBindingRef::User {
            provider: DESCRIPTOR.provider_id(),
            server_name: McpServerName::new(name.to_owned()).expect("a server name"),
        })
        .expect("a user binding is probed")
    }

    // Probes `targets` declared in `home` with no root attached, through `starts`.
    async fn probe(
        starts: &dyn ClaudeProcessStarts,
        home: &Path,
        environment: Vec<(String, String)>,
        has_managed_mcp_file: bool,
        targets: &[McpProbeTarget],
    ) -> Result<Vec<McpProbeReading>, DriverError> {
        probe_claude_mcp_servers(
            &ClaudeMcpProbeSources {
                starts,
                environment,
                provider_account_id: test_provider_account_id(),
                has_managed_mcp_file,
                home,
                plugin_home: &home.join("plugin-home"),
                attached_roots: &[],
                organization_entries: &BTreeMap::new(),
            },
            targets,
        )
        .await
    }

    // The probe's process loads none of the person's files through `--strict-mcp-config`, except
    // where an administrator's MCP file is deployed, under which that flag makes Claude Code exit
    // at start. Killed by the flag passed under a managed file, and by the flag dropped elsewhere.
    #[rstest]
    #[case::managed_file(true, false)]
    #[case::no_managed_file(false, true)]
    #[tokio::test]
    async fn the_probe_is_strict_only_where_no_managed_mcp_file_is_deployed(
        #[case] has_managed_mcp_file: bool,
        #[case] is_strict: bool,
    ) {
        let home = home_declaring(&json!({ "notes": { "command": "notes-server" } }));
        let starts = ScriptedStarts::default();
        let channel = Arc::new(ScriptedChannel::default());
        channel.answer(
            "mcp_status",
            ScriptedAnswer::Reply(
                json!({ "mcpServers": [{ "name": "notes", "status": "connected" }] }),
            ),
        );
        starts.script_mcp_probe(Arc::clone(&channel));

        let readings = probe(
            &starts,
            home.path(),
            Vec::new(),
            has_managed_mcp_file,
            &[user_target("notes")],
        )
        .await
        .expect("the probe reads");

        let [start] = starts
            .take_mcp_probe_starts()
            .try_into()
            .unwrap_or_else(|starts: Vec<_>| panic!("one probe process, not {}", starts.len()));
        assert_eq!(
            start
                .arguments
                .iter()
                .any(|argument| argument == "--strict-mcp-config"),
            is_strict
        );
        assert_eq!(
            readings[0].reading,
            McpServerReading::Observed(McpServerStatus::Connected)
        );
    }

    // A server the set's reply names in its errors reads `failed` with the error text, its
    // credentials scrubbed, while the declaration went out whole so the server could start.
    // Killed by the errors leg dropped (the server reads `starting`) and by the raw text kept.
    #[tokio::test]
    async fn a_set_error_reads_failed_with_its_credentials_scrubbed() {
        let home = home_declaring(&json!({
            "tracker": {
                "type": "http",
                "url": "https://mcp.example.com/mcp",
                "headers": { "Authorization": "Bearer config-header-secret" }
            }
        }));
        let starts = ScriptedStarts::default();
        let channel = Arc::new(ScriptedChannel::default());
        channel.answer(
            "mcp_set_servers",
            ScriptedAnswer::Reply(json!({
                "added": [],
                "removed": [],
                "errors": {
                    "tracker": "SSE error: Authorization: Bearer error-bearer-secret at \
                                https://alice:hunter2-userinfo@mcp.example.com/sse"
                }
            })),
        );
        starts.script_mcp_probe(Arc::clone(&channel));

        let readings = probe(
            &starts,
            home.path(),
            Vec::new(),
            false,
            &[user_target("tracker")],
        )
        .await
        .expect("the probe reads");

        let requests = channel.control_requests();
        assert_eq!(requests[0]["subtype"], "mcp_set_servers");
        assert_eq!(
            requests[0]["servers"]["tracker"],
            json!({
                "type": "http",
                "url": "https://mcp.example.com/mcp",
                "headers": { "Authorization": "Bearer config-header-secret" }
            })
        );
        let [reading] = readings.as_slice() else {
            panic!("one reading: {readings:?}");
        };
        assert_eq!(
            reading.reading,
            McpServerReading::Observed(McpServerStatus::Failed)
        );
        let text = reading
            .failure_text
            .as_deref()
            .expect("the error text is kept");
        assert!(text.contains("Authorization: ***"), "{text}");
        for secret in [
            "error-bearer-secret",
            "hunter2-userinfo",
            "config-header-secret",
        ] {
            assert!(
                !format!("{readings:?}").contains(secret),
                "{secret} is kept"
            );
        }
    }

    // A server still `pending` when the ceiling passes reads `starting`, the ceiling being Claude
    // Code's startup timeout (`MCP_TIMEOUT`, 30 s unset) plus 5 s, with `mcp_status` asked once a
    // second until then. Killed by waiting past the ceiling and by a fixed ceiling.
    #[rstest]
    #[case::unset(None, 35)]
    #[case::two_seconds(Some("2000"), 7)]
    #[tokio::test(start_paused = true)]
    async fn a_server_pending_at_the_ceiling_reads_starting(
        #[case] mcp_timeout: Option<&str>,
        #[case] ceiling_seconds: u64,
    ) {
        let home = home_declaring(&json!({ "notes": { "command": "notes-server" } }));
        let starts = ScriptedStarts::default();
        let channel = Arc::new(ScriptedChannel::default());
        channel.answer(
            "mcp_status",
            ScriptedAnswer::Reply(
                json!({ "mcpServers": [{ "name": "notes", "status": "pending" }] }),
            ),
        );
        starts.script_mcp_probe(Arc::clone(&channel));
        let environment = mcp_timeout
            .map(|timeout| vec![("MCP_TIMEOUT".to_owned(), timeout.to_owned())])
            .unwrap_or_default();

        let started = Instant::now();
        let readings = probe(
            &starts,
            home.path(),
            environment,
            false,
            &[user_target("notes")],
        )
        .await
        .expect("the probe reads");

        assert_eq!(started.elapsed(), Duration::from_secs(ceiling_seconds));
        let status_reads = channel
            .control_requests()
            .iter()
            .filter(|request| request["subtype"] == "mcp_status")
            .count();
        assert_eq!(
            u64::try_from(status_reads).expect("a small count"),
            ceiling_seconds + 1
        );
        assert_eq!(
            readings[0].reading,
            McpServerReading::Observed(McpServerStatus::Starting)
        );
        assert!(readings[0].tool_names.is_empty());
    }

    // A real Claude Code, its home signed in, probed for a reachable MCP server and one nothing
    // listens at, each declared as a `user` server in a scratch config: the reachable one reads
    // connected with its tools, the other failed, both before the ceiling.
    #[tokio::test]
    #[ignore = "needs an installed Claude Code, a signed-in home and a reachable MCP server"]
    async fn a_real_claude_code_probe_reads_a_sent_server_connected_with_its_tools() {
        let program = PathBuf::from(
            std::env::var_os("SIDEKICKS_TEST_CLAUDE_PROGRAM")
                .expect("SIDEKICKS_TEST_CLAUDE_PROGRAM names the installed Claude Code program"),
        );
        let claude_home = std::env::var("SIDEKICKS_TEST_CLAUDE_HOME")
            .expect("SIDEKICKS_TEST_CLAUDE_HOME names a signed-in Claude Code home");
        let server_url = std::env::var("SIDEKICKS_TEST_CLAUDE_ORGANIZATION_SERVER")
            .expect("SIDEKICKS_TEST_CLAUDE_ORGANIZATION_SERVER names a reachable MCP server");
        let home = home_declaring(&json!({
            "reachable": { "type": "http", "url": server_url },
            "unreachable": { "type": "http", "url": "http://127.0.0.1:9/mcp" }
        }));
        let spawner = Spawner::new(Handle::current()).expect("a spawner");
        let starts = ClaudeInstalledBuild::new(
            Arc::new(ClaudeProcessLauncher::new(
                spawner.clone(),
                Arc::new(ProviderProcessRegistry::default()),
                home.path(),
            )),
            Arc::new(ProviderCommandSearch::new(spawner)),
            home.path().to_path_buf(),
        );
        let program_folder = program.parent().expect("the program sits in a folder");
        let mut environment: Vec<(String, String)> = std::env::vars()
            .filter(|(name, _value)| name != "CLAUDE_CONFIG_DIR" && name != "PATH")
            .collect();
        environment.push(("CLAUDE_CONFIG_DIR".to_owned(), claude_home));
        environment.push((
            "PATH".to_owned(),
            program_folder.to_string_lossy().into_owned(),
        ));

        let readings = probe(
            &starts,
            home.path(),
            environment,
            false,
            &[user_target("reachable"), user_target("unreachable")],
        )
        .await
        .expect("the probe reads");

        let [reachable, unreachable] = readings.as_slice() else {
            panic!("two readings: {readings:?}");
        };
        assert_eq!(
            reachable.reading,
            McpServerReading::Observed(McpServerStatus::Connected)
        );
        assert!(!reachable.tool_names.is_empty());
        assert_eq!(
            unreachable.reading,
            McpServerReading::Observed(McpServerStatus::Failed)
        );
    }
}
