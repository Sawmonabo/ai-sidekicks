use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::mcp::server::McpServerStatus;
use tempfile::TempDir;
use tokio::time::Instant;

use crate::driver::claude::mcp::config::{
    ClaudeMcpConfigReading, ClaudeMcpConfigSources, ClaudePersonConfigFiles, read_claude_mcp_config,
};
use crate::driver::claude::mcp::machine_probe::{
    ClaudeMcpProbeSources, ClaudeProbePlan, plan_claude_probe, probe_claude_mcp_servers,
};
use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
use crate::driver::claude::session::scripted::starts::ScriptedStarts;
use crate::driver::mcp_server::read::{McpProbeReading, McpProbeTarget};
use crate::driver::mcp_server::status::McpServerReading;
use crate::runtime_binding::test_store::test_provider_account_id;

// One plugin installed with its one server `db`, as the daemon reads it: the test's home, the
// install root, the person's files, the config reading and the server's probe target.
struct InstalledPlugin {
    _home: TempDir,
    install: PathBuf,
    person: ClaudePersonConfigFiles,
    reading: ClaudeMcpConfigReading,
    target: McpProbeTarget,
}

// Installs a plugin with `manifest` where given and reads it as the daemon does.
async fn install_plugin(manifest: Option<Value>) -> InstalledPlugin {
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
    InstalledPlugin {
        _home: home,
        install,
        person,
        reading,
        target,
    }
}

// Probes `plugin`'s one server through `starts`, under a managed MCP file where
// `has_managed_mcp_file`, with the account's connectors switched on.
async fn probe_plugin(
    starts: &ScriptedStarts,
    plugin: &InstalledPlugin,
    has_managed_mcp_file: bool,
) -> McpProbeReading {
    let readings = probe_claude_mcp_servers(
        &ClaudeMcpProbeSources {
            starts,
            environment: vec![("ENABLE_CLAUDEAI_MCP_SERVERS".to_owned(), "true".to_owned())],
            provider_account_id: test_provider_account_id(),
            has_managed_mcp_file,
            person: &plugin.person,
            plugin_roots: &plugin.reading.plugin_roots,
            attached_roots: &[],
            organization_entries: &BTreeMap::new(),
        },
        std::slice::from_ref(&plugin.target),
    )
    .await
    .expect("the probe reads");
    let [reading] = <[McpProbeReading; 1]>::try_from(readings)
        .unwrap_or_else(|readings| panic!("one reading: {readings:?}"));
    reading
}

// What the process's `system/init` frame says of the plugin: nothing (no frame), its load error
// by the name Claude Code loads it under or by its folder for one that did not load at all, or a
// `failed` row for its server.
#[derive(Clone, Copy, Debug)]
enum InitFrame {
    Absent,
    LoadErrorByName,
    LoadErrorByFolder,
    FailedRow,
}

const SPAWN_ERROR: &str = "spawn ENOENT";

const LOAD_ERROR: &str = "lspServers.go: extensionToLanguage is required";

// A plugin's server is probed by loading its plugin from its install root with `--plugin-dir`,
// listed again in `initialize`, never sent with `mcp_set_servers` and never under
// `--strict-mcp-config`, with the account's connectors switched off, and reads as Claude Code's
// own load reports it under `plugin:<loaded name>:<server>`: the manifest's `name`, else the
// install folder's name. Where the `initialize` reply says the plugins loaded, the first list is
// Claude Code's whole one: a plugin whose manifest passes the daemon's top-level check but fails
// a deeper rule (an `lspServers` entry without `extensionToLanguage`) is still listed, and Claude
// Code, which loads none of it, reports no row, so it reads `failed` at the first ask, with the
// load error its `system/init` frame gives the plugin, by name or by folder, else the plain line
// where no frame came, while a row the frame lists for the server stands where no answer names it;
// a deployed managed MCP file starts no process and reads `failed` with
// Claude Code's notice; a refused start fails the server with its error. Killed by the server
// sent through the set, by the strict flag kept, by the folder not listed, by the connectors left
// on, by a missing row read `starting` or `connected`, by the plugin named by its id, by either
// form of the load error not matched, by its text dropped, by the frame's rows unread, by waiting
// past the first list, and by the managed file starting a process.
#[rstest]
#[case::loaded(Some(json!({ "name": "db-tools" })), "plugin:db-tools:db", InitFrame::Absent,
    false, true, McpServerStatus::Connected, None)]
#[case::loaded_without_a_manifest(
    None,
    "plugin:1.0.0:db",
    InitFrame::Absent,
    false,
    true,
    McpServerStatus::Connected,
    None
)]
#[case::refused_with_no_init_frame(
    Some(json!({ "name": "db-tools", "lspServers": { "go": { "command": "gopls" } } })),
    "notes",
    InitFrame::Absent,
    false,
    true,
    McpServerStatus::Failed,
    Some("Claude Code did not load the plugin.")
)]
#[case::refused_with_its_load_error_by_name(
    Some(json!({ "name": "db-tools", "lspServers": { "go": { "command": "gopls" } } })),
    "notes",
    InitFrame::LoadErrorByName,
    false,
    true,
    McpServerStatus::Failed,
    Some(LOAD_ERROR)
)]
#[case::refused_with_its_load_error_by_folder(
    Some(json!({ "name": "db-tools", "lspServers": { "go": { "command": "gopls" } } })),
    "notes",
    InitFrame::LoadErrorByFolder,
    false,
    true,
    McpServerStatus::Failed,
    Some(LOAD_ERROR)
)]
#[case::listed_failed_by_the_init_frame(
    Some(json!({ "name": "db-tools" })),
    "notes",
    InitFrame::FailedRow,
    false,
    true,
    McpServerStatus::Failed,
    Some(SPAWN_ERROR)
)]
#[case::under_a_managed_mcp_file(Some(json!({ "name": "db-tools" })), "plugin:db-tools:db",
    InitFrame::Absent, true, true, McpServerStatus::Failed, Some(
        "Your organization's managed MCP config has exclusive control over MCP servers in this \
         session."
    ))]
#[case::start_refused(Some(json!({ "name": "db-tools" })), "plugin:db-tools:db",
    InitFrame::Absent, false, false, McpServerStatus::Failed, Some(
        "the provider driver failed: the Claude Code process could not be started: no probe \
         scripted"
    ))]
#[tokio::test(start_paused = true)]
async fn a_plugin_server_reads_as_claude_codes_own_load_of_its_plugin(
    #[case] manifest: Option<Value>,
    #[case] reported_name: &str,
    #[case] init_frame: InitFrame,
    #[case] has_managed_mcp_file: bool,
    #[case] is_start_scripted: bool,
    #[case] status: McpServerStatus,
    #[case] failure_text: Option<&str>,
) {
    let plugin = install_plugin(manifest).await;
    let install_path = plugin.install.to_string_lossy().into_owned();
    let init = |rows: Value, errors: Value| {
        vec![json!({
            "type": "system",
            "subtype": "init",
            "mcp_servers": rows,
            "plugin_errors": errors,
        })]
    };
    let frames = match init_frame {
        InitFrame::Absent => Vec::new(),
        InitFrame::LoadErrorByName => init(
            json!([]),
            json!([{
                "plugin": "db-tools@inline",
                "type": "manifest-validation-error",
                "message": LOAD_ERROR,
            }]),
        ),
        InitFrame::LoadErrorByFolder => init(
            json!([]),
            json!([{
                "plugin": "inline[0]",
                "type": "manifest-validation-error",
                "message": LOAD_ERROR,
                "path": install_path,
            }]),
        ),
        InitFrame::FailedRow => init(
            json!([{ "name": "plugin:db-tools:db", "status": "failed", "error": SPAWN_ERROR }]),
            json!([]),
        ),
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
        starts.script_mcp_probe(
            Arc::clone(&channel),
            json!({ "plugins_applied": true }),
            frames,
        );
    }

    let started = Instant::now();
    let db = probe_plugin(&starts, &plugin, has_managed_mcp_file).await;

    assert_eq!(db.reading, McpServerReading::Observed(status));
    assert_eq!(db.failure_text.as_deref(), failure_text);
    assert_eq!(started.elapsed(), Duration::ZERO);
    let process_starts = starts.take_mcp_probe_starts();
    if has_managed_mcp_file {
        assert!(process_starts.is_empty());
        return;
    }
    let [process] = process_starts.as_slice() else {
        panic!("one probe process starts");
    };
    let plugin_dir = ["--plugin-dir".to_owned(), install_path];
    assert!(
        process
            .arguments
            .windows(2)
            .any(|pair| pair == plugin_dir.as_slice()),
        "{:?}",
        process.arguments
    );
    assert_eq!(
        process.plugin_folders,
        std::slice::from_ref(&plugin.install)
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

// Where the `initialize` reply does not say the plugins loaded, a first list without a plugin's
// server is not Claude Code's whole one: the probe asks again, and a server that shows on the
// second answer reads as that row says, while one that never shows reads `failed` only once the
// ceiling passes. Killed by trusting the first list.
#[rstest]
#[case::shows_on_the_second_answer(true, McpServerStatus::Connected, 1)]
#[case::never_shows(false, McpServerStatus::Failed, 35)]
#[tokio::test(start_paused = true)]
async fn a_plugin_server_not_yet_applied_is_asked_for_again(
    #[case] does_show: bool,
    #[case] status: McpServerStatus,
    #[case] elapsed_seconds: u64,
) {
    let plugin = install_plugin(Some(json!({ "name": "db-tools" }))).await;
    let starts = ScriptedStarts::default();
    let channel = Arc::new(ScriptedChannel::default());
    channel.answer(
        "mcp_status",
        ScriptedAnswer::Reply(json!({ "mcpServers": [] })),
    );
    let second = if does_show {
        json!({ "mcpServers": [{ "name": "plugin:db-tools:db", "status": "connected" }] })
    } else {
        json!({ "mcpServers": [] })
    };
    channel.answer("mcp_status", ScriptedAnswer::Reply(second));
    starts.script_mcp_probe(
        Arc::clone(&channel),
        json!({ "plugins_applied": false }),
        Vec::new(),
    );

    let started = Instant::now();
    let db = probe_plugin(&starts, &plugin, false).await;

    assert_eq!(db.reading, McpServerReading::Observed(status));
    assert_eq!(started.elapsed(), Duration::from_secs(elapsed_seconds));
}
