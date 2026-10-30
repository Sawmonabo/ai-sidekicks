use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::{
    McpServerBindingRef, McpServerName, McpServerStatus, McpToolName,
};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_platforms::Spawner;
use tempfile::TempDir;
use tokio::runtime::Handle;
use tokio::time::Instant;

use super::{ClaudeMcpProbeSources, ClaudeProbePlan, plan_claude_probe, probe_claude_mcp_servers};
use crate::command_search::ProviderCommandSearch;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::mcp::config::{
    ClaudeMcpConfigSources, ClaudeMcpRoot, ClaudePersonConfigFiles, read_claude_mcp_config,
};
use crate::driver::claude::mcp::organization::read_claude_organization_servers;
use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
use crate::driver::claude::session::scripted::starts::ScriptedStarts;
use crate::driver::claude::session::transport::control::ClaudeToolServerEntry;
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
    let binding = McpServerBindingRef::User {
        provider: DESCRIPTOR.provider_id(),
        server_name: McpServerName::new(name.to_owned()).expect("a server name"),
    };
    match plan_claude_probe(&binding, &[]) {
        Some(ClaudeProbePlan::Probe(target)) => target,
        Some(ClaudeProbePlan::Withheld(_)) | None => panic!("a user binding is probed"),
    }
}

// Probes `targets` declared in `home`, or among `organization_entries`, with no root attached,
// through `starts`.
async fn probe(
    starts: &dyn ClaudeProcessStarts,
    home: &Path,
    environment: Vec<(String, String)>,
    has_managed_mcp_file: bool,
    targets: &[McpProbeTarget],
    organization_entries: &BTreeMap<McpServerName, ClaudeToolServerEntry>,
) -> Result<Vec<McpProbeReading>, DriverError> {
    probe_claude_mcp_servers(
        &ClaudeMcpProbeSources {
            starts,
            environment,
            provider_account_id: test_provider_account_id(),
            has_managed_mcp_file,
            person: &ClaudePersonConfigFiles::resolve(&[], home).await,
            plugin_roots: &[],
            attached_roots: &[],
            organization_entries,
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
        &BTreeMap::new(),
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
        &BTreeMap::new(),
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

// The sent entry carries each `${VAR}` filled from the probe's environment, a set value even
// when empty before its default, and a variable with neither left as written; a credential
// variable reaches a program's environment but reads empty, its default ignored, in a remote
// server's address and headers. Killed by the entry sent unexpanded, by a default taken over a
// set empty value, by an unset variable sent empty, and by the blanking dropped or applied to the
// program too.
#[tokio::test]
async fn a_sent_entry_carries_its_variables_filled_and_no_credential_reaches_a_remote_server() {
    let home = home_declaring(&json!({
        "tracker": {
            "type": "http",
            "url": "https://${TRACKER_HOST}/mcp?key=${ANTHROPIC_API_KEY}",
            "headers": {
                "Authorization": "Bearer ${TRACKER_TOKEN}",
                "X-Npm": "${NPM_TOKEN:-npm-fallback}",
                "X-Region": "${TRACKER_REGION:-eu}",
                "X-Team": "${TRACKER_TEAM:-core}",
                "X-Unset": "${TRACKER_UNSET}"
            }
        },
        "builder": {
            "command": "builder",
            "env": { "NPM_TOKEN": "${NPM_TOKEN}", "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}" }
        }
    }));
    let starts = ScriptedStarts::default();
    let channel = Arc::new(ScriptedChannel::default());
    channel.answer(
        "mcp_status",
        ScriptedAnswer::Reply(json!({"mcpServers": [
            {"name": "tracker", "status": "connected"},
            {"name": "builder", "status": "connected"}
        ]})),
    );
    starts.script_mcp_probe(Arc::clone(&channel));
    let environment = [
        ("TRACKER_HOST", "mcp.example.com"),
        ("TRACKER_TOKEN", "variable-token"),
        ("TRACKER_TEAM", "platform"),
        ("TRACKER_REGION", ""),
        ("NPM_TOKEN", "npm-secret-token"),
        ("ANTHROPIC_API_KEY", "anthropic-secret-key"),
    ]
    .map(|(name, value)| (name.to_owned(), value.to_owned()))
    .to_vec();

    probe(
        &starts,
        home.path(),
        environment,
        false,
        &[user_target("tracker"), user_target("builder")],
        &BTreeMap::new(),
    )
    .await
    .expect("the probe reads");

    let servers = &channel.control_requests()[0]["servers"];
    assert_eq!(
        servers["tracker"],
        json!({
            "type": "http",
            "url": "https://mcp.example.com/mcp?key=",
            "headers": {
                "Authorization": "Bearer variable-token",
                "X-Npm": "",
                "X-Region": "",
                "X-Team": "platform",
                "X-Unset": "${TRACKER_UNSET}"
            }
        })
    );
    assert_eq!(
        servers["builder"]["env"],
        json!({ "NPM_TOKEN": "npm-secret-token", "ANTHROPIC_API_KEY": "anthropic-secret-key" })
    );
}

// An entry that fetches its headers from a program or signs in itself is not sent, since the set
// cannot carry either, nor one over a WebSocket, which the set has no form for, and each reads
// `unknown`, an organization's `managedMcpServers` entry that signs in as the person's own, while
// the organization's other entries are sent whole. Killed by either sent cut down, the
// organization's included, by an organization entry left out of the set read nothing, by a
// WebSocket entry sent or read otherwise, and by an organization entry left unsent or sent
// without its headers.
#[tokio::test]
async fn an_entry_the_set_cannot_carry_whole_reads_unknown_unsent() {
    let home = home_declaring(&json!({
        "helper": {
            "type": "http",
            "url": "https://helper.example.com/mcp",
            "headersHelper": "./print-headers.sh"
        },
        "signed": {
            "type": "http",
            "url": "https://signed.example.com/mcp",
            "oauth": { "clientId": "client" }
        },
        "socket": { "type": "ws", "url": "wss://socket.example.com/mcp" },
        "plain": { "command": "plain-server" }
    }));
    let starts = ScriptedStarts::default();
    let channel = Arc::new(ScriptedChannel::default());
    channel.answer(
        "mcp_status",
        ScriptedAnswer::Reply(json!({"mcpServers": [
            {"name": "plain", "status": "connected"},
            {"name": "org-remote", "status": "connected"},
            {"name": "org-events", "status": "connected"}
        ]})),
    );
    starts.script_mcp_probe(Arc::clone(&channel));
    let organization = read_claude_organization_servers(
        &[],
        Some(&json!({ "managedMcpServers": {
            "org-remote": {
                "type": "http",
                "url": "https://org-remote.example.com/mcp?key=org-secret",
                "headers": { "Authorization": "Bearer org-token" }
            },
            "org-signed": {
                "type": "sse",
                "url": "https://org-signed.example.com/sse",
                "oauth": { "clientId": "client" }
            },
            "org-events": { "type": "sse", "url": "https://org-events.example.com/sse" }
        } })),
    );
    let mut targets = vec![
        user_target("helper"),
        user_target("signed"),
        user_target("socket"),
        user_target("plain"),
    ];
    for server in &organization.servers {
        match plan_claude_probe(&server.binding, &[]) {
            Some(ClaudeProbePlan::Probe(target)) => targets.push(target),
            Some(ClaudeProbePlan::Withheld(_)) | None => panic!("an organization server is probed"),
        }
    }

    let readings = probe(
        &starts,
        home.path(),
        Vec::new(),
        false,
        &targets,
        &organization.entries,
    )
    .await
    .expect("the probe reads");

    let sent = &channel.control_requests()[0]["servers"];
    assert_eq!(
        sent.as_object().map(serde_json::Map::len),
        Some(3),
        "{sent}"
    );
    assert!(sent.get("plain").is_some(), "{sent}");
    assert_eq!(
        sent["org-remote"],
        json!({
            "type": "http",
            "url": "https://org-remote.example.com/mcp?key=org-secret",
            "headers": { "Authorization": "Bearer org-token" }
        })
    );
    assert_eq!(
        sent["org-events"],
        json!({ "type": "sse", "url": "https://org-events.example.com/sse" })
    );
    for name in ["helper", "signed", "socket", "org-signed"] {
        let reading = readings
            .iter()
            .find(|reading| reading.binding.server_name().as_str() == name)
            .expect("the unsent entry has a reading");
        assert_eq!(
            reading.reading,
            McpServerReading::Observed(McpServerStatus::Unknown),
            "{name}"
        );
    }
}

// A plugin's server is probed by loading its plugin from its install root with `--plugin-dir`,
// never sent with `mcp_set_servers` and never under `--strict-mcp-config`, with the account's
// connectors switched off, and reads as Claude Code's own load reports it under
// `plugin:<loaded name>:<server>`: the manifest's `name`, else the install folder's name. A plugin
// whose manifest passes the daemon's top-level check but fails a deeper rule (an `lspServers`
// entry without `extensionToLanguage`) is still listed, and Claude Code, which loads none of it,
// reports no row, so it reads `failed`; a deployed managed MCP file starts no process and reads
// `failed` with Claude Code's notice; a refused start fails the server with its error. Killed by
// the server sent through the set, by the strict flag kept, by the connectors left on, by a
// missing row read `starting` or `connected`, by the plugin named by its id, and by the managed
// file starting a process.
#[rstest]
#[case::loaded(Some(json!({ "name": "db-tools" })), "plugin:db-tools:db", false, true,
    McpServerStatus::Connected, None)]
#[case::loaded_without_a_manifest(
    None,
    "plugin:1.0.0:db",
    false,
    true,
    McpServerStatus::Connected,
    None
)]
#[case::refused_by_a_deeper_rule(
    Some(json!({ "name": "db-tools", "lspServers": { "go": { "command": "gopls" } } })),
    "notes",
    false,
    true,
    McpServerStatus::Failed,
    Some("Claude Code did not load the plugin.")
)]
#[case::under_a_managed_mcp_file(Some(json!({ "name": "db-tools" })), "plugin:db-tools:db", true,
    true, McpServerStatus::Failed, Some(
        "Your organization's managed MCP config has exclusive control over MCP servers in this \
         session."
    ))]
#[case::start_refused(Some(json!({ "name": "db-tools" })), "plugin:db-tools:db", false, false,
    McpServerStatus::Failed, Some(
        "the provider driver failed: the Claude Code process could not be started: no probe \
         scripted"
    ))]
#[tokio::test]
async fn a_plugin_server_reads_as_claude_codes_own_load_of_its_plugin(
    #[case] manifest: Option<Value>,
    #[case] reported_name: &str,
    #[case] has_managed_mcp_file: bool,
    #[case] is_start_scripted: bool,
    #[case] status: McpServerStatus,
    #[case] failure_text: Option<&str>,
) {
    let home = tempfile::tempdir().expect("a test home");
    let plugin_home = home.path().join("plugin-home");
    let install = home.path().join("installs").join("db-tools").join("1.0.0");
    std::fs::create_dir_all(plugin_home.join("plugins")).expect("the plugin folder is made");
    std::fs::create_dir_all(&install).expect("the install folder is made");
    std::fs::write(
        plugin_home.join("plugins").join("installed_plugins.json"),
        json!({ "plugins": { "db-tools@team.market": [{ "installPath": install }] } }).to_string(),
    )
    .expect("the plugin list is written");
    std::fs::write(
        install.join(".mcp.json"),
        json!({ "mcpServers": { "db": { "command": "${CLAUDE_PLUGIN_ROOT}/servers/db" } } })
            .to_string(),
    )
    .expect("the plugin's servers are written");
    if let Some(manifest) = manifest {
        std::fs::create_dir_all(install.join(".claude-plugin"))
            .expect("the manifest folder is made");
        std::fs::write(
            install.join(".claude-plugin").join("plugin.json"),
            manifest.to_string(),
        )
        .expect("the manifest is written");
    }
    let person = ClaudePersonConfigFiles::resolve(&[], home.path()).await;
    let reading = read_claude_mcp_config(&ClaudeMcpConfigSources {
        person: &person,
        managed_settings_folder: None,
        plugin_home: &plugin_home,
        roots: &[],
    })
    .await
    .expect("the config reads");
    let [server] = reading.plugin_servers.as_slice() else {
        panic!(
            "the plugin's one server is listed: {:?}",
            reading.plugin_servers
        );
    };
    let Some(ClaudeProbePlan::Probe(target)) = plan_claude_probe(&server.binding, &[]) else {
        panic!("a plugin binding is probed");
    };
    let starts = ScriptedStarts::default();
    let channel = Arc::new(ScriptedChannel::default());
    channel.answer(
        "mcp_status",
        ScriptedAnswer::Reply(
            json!({"mcpServers": [{"name": reported_name, "status": "connected"}]}),
        ),
    );
    if is_start_scripted {
        starts.script_mcp_probe(Arc::clone(&channel));
    }

    let readings = probe_claude_mcp_servers(
        &ClaudeMcpProbeSources {
            starts: &starts,
            environment: vec![("ENABLE_CLAUDEAI_MCP_SERVERS".to_owned(), "true".to_owned())],
            provider_account_id: test_provider_account_id(),
            has_managed_mcp_file,
            person: &person,
            plugin_roots: &reading.plugin_roots,
            attached_roots: &[],
            organization_entries: &BTreeMap::new(),
        },
        &[target],
    )
    .await
    .expect("the probe reads");

    let [db] = readings.as_slice() else {
        panic!("one reading: {readings:?}");
    };
    assert_eq!(db.reading, McpServerReading::Observed(status));
    assert_eq!(db.failure_text.as_deref(), failure_text);
    let process_starts = starts.take_mcp_probe_starts();
    if has_managed_mcp_file {
        assert!(process_starts.is_empty());
        return;
    }
    let [process] = process_starts.as_slice() else {
        panic!("one probe process starts");
    };
    let plugin_dir = [
        "--plugin-dir".to_owned(),
        install.to_string_lossy().into_owned(),
    ];
    assert!(
        process
            .arguments
            .windows(2)
            .any(|pair| pair == plugin_dir.as_slice()),
        "{:?}",
        process.arguments
    );
    assert!(
        !process
            .arguments
            .iter()
            .any(|argument| argument == "--strict-mcp-config")
    );
    assert_eq!(
        process
            .environment
            .iter()
            .rev()
            .find(|(name, _value)| name == "ENABLE_CLAUDEAI_MCP_SERVERS")
            .map(|(_name, value)| value.as_str()),
        Some("false")
    );
    assert!(
        channel
            .control_requests()
            .iter()
            .all(|request| request["subtype"] != "mcp_set_servers")
    );
}

// A project server that `disabledMcpjsonServers` names in the project's own or its local
// settings is never sent to the probe and reads switched off, a name written `my server` keeping
// out `my_server` as Claude Code's name fold does, while one no settings approve, in a folder
// never trusted, is sent, as Claude Code loads it in a process that is not interactive. Killed by
// an unapproved server withheld, by either rejected server sent, and by names matched unfolded.
#[tokio::test]
async fn a_project_server_is_withheld_only_where_its_settings_reject_it() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let home = scratch.path().join("home");
    let folder = scratch.path().join("project");
    std::fs::create_dir_all(folder.join(".claude")).expect("the project's settings folder");
    std::fs::create_dir_all(&home).expect("the home folder");
    std::fs::write(
        folder.join(".mcp.json"),
        json!({ "mcpServers": {
            "rejected": { "command": "./scripts/setup.sh" },
            "refused": { "command": "./scripts/refused.sh" },
            "my_server": { "command": "./scripts/mine.sh" },
            "pending": { "command": "pending-server" }
        } })
        .to_string(),
    )
    .expect("the project's servers are written");
    std::fs::write(
        folder.join(".claude").join("settings.local.json"),
        json!({ "disabledMcpjsonServers": ["rejected", "my server"] }).to_string(),
    )
    .expect("the project's local settings are written");
    std::fs::write(
        folder.join(".claude").join("settings.json"),
        json!({ "disabledMcpjsonServers": ["refused"] }).to_string(),
    )
    .expect("the project's settings are written");
    let root = PlacedPath {
        path: FilesystemPath::new(folder.to_string_lossy().into_owned()).expect("a root path"),
        place: None,
    };
    let person = ClaudePersonConfigFiles::resolve(&[], &home).await;
    let plugin_home = scratch.path().join("plugin-home");
    let reading = read_claude_mcp_config(&ClaudeMcpConfigSources {
        person: &person,
        managed_settings_folder: None,
        plugin_home: &plugin_home,
        roots: &[ClaudeMcpRoot {
            root: root.clone(),
            folder: folder.clone(),
        }],
    })
    .await
    .expect("the config reads");
    let mut targets = Vec::new();
    let mut withheld = Vec::new();
    for server in &reading.roots[0].project_servers {
        match plan_claude_probe(&server.binding, &reading.roots) {
            Some(ClaudeProbePlan::Probe(target)) => targets.push(target),
            Some(ClaudeProbePlan::Withheld(reading)) => withheld.push(reading),
            None => panic!("a project binding is planned"),
        }
    }
    let starts = ScriptedStarts::default();
    let channel = Arc::new(ScriptedChannel::default());
    channel.answer(
        "mcp_status",
        ScriptedAnswer::Reply(json!({"mcpServers": [{"name": "pending", "status": "connected"}]})),
    );
    starts.script_mcp_probe(Arc::clone(&channel));

    let probed = probe_claude_mcp_servers(
        &ClaudeMcpProbeSources {
            starts: &starts,
            environment: Vec::new(),
            provider_account_id: test_provider_account_id(),
            has_managed_mcp_file: false,
            person: &person,
            plugin_roots: &[],
            attached_roots: std::slice::from_ref(&root),
            organization_entries: &BTreeMap::new(),
        },
        &targets,
    )
    .await
    .expect("the probe reads");

    let sent = &channel.control_requests()[0]["servers"];
    assert_eq!(
        sent.as_object()
            .map(|servers| servers.keys().map(String::as_str).collect::<Vec<_>>()),
        Some(vec!["pending"]),
        "{sent}"
    );
    let reading_of = |name: &str| {
        withheld
            .iter()
            .find(|reading| reading.binding.server_name().as_str() == name)
            .map(|reading| reading.reading)
    };
    assert_eq!(reading_of("rejected"), Some(McpServerReading::SwitchedOff));
    assert_eq!(reading_of("refused"), Some(McpServerReading::SwitchedOff));
    assert_eq!(reading_of("my_server"), Some(McpServerReading::SwitchedOff));
    assert_eq!(reading_of("pending"), None);
    assert_eq!(
        probed
            .iter()
            .map(|reading| (reading.binding.server_name().as_str(), reading.reading))
            .collect::<Vec<_>>(),
        [(
            "pending",
            McpServerReading::Observed(McpServerStatus::Connected)
        )]
    );
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
        ScriptedAnswer::Reply(json!({ "mcpServers": [{ "name": "notes", "status": "pending" }] })),
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
        &BTreeMap::new(),
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
    assert_eq!(readings[0].tool_names, [] as [McpToolName; 0]);
}

// A real Claude Code, its home signed in, probed for a reachable MCP server and one nothing
// listens at, each declared as a `user` server in a scratch config, the reachable one with
// headers naming a set variable and a defaulted one: the reachable one reads connected with
// its tools, the other failed, both before the ceiling.
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
    // Headers naming variables, which the sent entry carries filled.
    let home = home_declaring(&json!({
        "reachable": {
            "type": "http",
            "url": server_url,
            "headers": {
                "X-Probe-Run": "${SIDEKICKS_PROBE_RUN}",
                "X-Probe-Region": "${SIDEKICKS_PROBE_REGION:-eu}"
            }
        },
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
    environment.push(("SIDEKICKS_PROBE_RUN".to_owned(), "real-process".to_owned()));
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
        &BTreeMap::new(),
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
    assert_ne!(reachable.tool_names, [] as [McpToolName; 0]);
    assert_eq!(
        unreachable.reading,
        McpServerReading::Observed(McpServerStatus::Failed)
    );
}
