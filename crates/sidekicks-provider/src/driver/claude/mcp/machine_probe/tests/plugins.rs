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
use crate::driver::contract::error::DriverError;
use crate::driver::mcp_server::read::{McpProbeReading, McpProbeTarget};
use crate::driver::mcp_server::status::McpServerReading;
use crate::runtime_binding::test_store::test_provider_account_id;

// Plugins installed with one server `db` each, as the daemon reads them: the test's home, the
// plugin home, each install root, the person's files, the config reading and each server's probe
// target, in the order installed.
struct InstalledPlugins {
    _home: TempDir,
    plugin_home: PathBuf,
    installs: Vec<PathBuf>,
    person: ClaudePersonConfigFiles,
    reading: ClaudeMcpConfigReading,
    targets: Vec<McpProbeTarget>,
}

// Installs each of `plugins`, an id with its install folder under the home and its manifest where
// given, each declaring `db` at a program in its root, and reads them as the daemon does.
async fn install_plugins(plugins: &[(&str, &str, Option<Value>)]) -> InstalledPlugins {
    let home = tempfile::tempdir().expect("a test home");
    let plugin_home = home.path().join("plugin-home");
    std::fs::create_dir_all(plugin_home.join("plugins")).expect("the plugin folder is made");
    let mut installed = serde_json::Map::new();
    let mut installs = Vec::new();
    for (plugin_id, folder, manifest) in plugins {
        let install = home.path().join("installs").join(folder);
        std::fs::create_dir_all(&install).expect("the install folder is made");
        std::fs::write(
            install.join(".mcp.json"),
            json!({ "mcpServers": { "db": {
                "command": "${CLAUDE_PLUGIN_ROOT}/servers/db",
                "args": ["--data", "${CLAUDE_PLUGIN_DATA}"]
            } } })
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
        installed.insert((*plugin_id).to_owned(), json!([{ "installPath": install }]));
        installs.push(install);
    }
    std::fs::write(
        plugin_home.join("plugins").join("installed_plugins.json"),
        json!({ "plugins": installed }).to_string(),
    )
    .expect("the plugin list is written");
    let person = ClaudePersonConfigFiles::resolve(&[], home.path()).await;
    let reading = read_claude_mcp_config(&ClaudeMcpConfigSources {
        person: &person,
        managed_settings_folder: None,
        plugin_home: &plugin_home,
        roots: &[],
    })
    .await
    .expect("the config reads");
    let targets = reading
        .plugin_servers
        .iter()
        .map(|server| match plan_claude_probe(&server.binding, &[]) {
            Some(ClaudeProbePlan::Probe(target)) => target,
            Some(ClaudeProbePlan::Withheld(_)) | None => panic!("a plugin binding is probed"),
        })
        .collect();
    InstalledPlugins {
        _home: home,
        plugin_home,
        installs,
        person,
        reading,
        targets,
    }
}

// Probes every server of `plugins` through `starts` in `environment`, under a managed MCP file
// where `has_managed_mcp_file`.
async fn probe_plugins(
    starts: &ScriptedStarts,
    plugins: &InstalledPlugins,
    environment: Vec<(String, String)>,
    has_managed_mcp_file: bool,
) -> Result<Vec<McpProbeReading>, DriverError> {
    probe_claude_mcp_servers(
        &ClaudeMcpProbeSources {
            starts,
            environment,
            provider_account_id: test_provider_account_id(),
            has_managed_mcp_file,
            person: &plugins.person,
            plugin_home: &plugins.plugin_home,
            plugin_roots: &plugins.reading.plugin_roots,
            attached_roots: &[],
            managed_mcp_servers: None,
            organization_entries: &BTreeMap::new(),
        },
        &plugins.targets,
    )
    .await
}

// What the process's `reload_plugins` answer says of the plugin: nothing (no answer), its row
// among the loaded plugins by its folder or by the name Claude Code loads it under, or a list
// naming it neither way.
#[derive(Clone, Copy, Debug)]
enum PluginReload {
    Absent,
    LoadedByFolder,
    LoadedByName,
    Unlisted,
}

// Where the probe runs: in plain mode, under a deployed managed MCP file, which connects no
// plugin's server, or in safe mode.
#[derive(Clone, Copy, Debug)]
enum ProbeMode {
    Plain,
    ManagedMcpFile,
    SafeMode,
}

const SERVER_NAME: &str = "plugin:db-tools:db";

// A plugin's server is probed in the one strict process that loads its plugin from its install
// root with `--plugin-dir-no-mcp`, which writes no `system/init` frame since it is sent no
// message: where the process's `reload_plugins` answer lists the plugin as loaded, by its folder
// or by the name Claude Code loads it under (the manifest's `name`, else the install folder's),
// the server is sent in the set as `plugin:<plugin>:<server>`, its plugin root and data folder
// filled, and reads as Claude Code reports it, with no wait; a plugin the answer leaves out, or
// no answer, contributes no server, which reads `failed` with the plain line; safe mode sends the
// server like any other and reads Claude Code's answer; a deployed managed MCP file starts no
// process and reads `failed` with Claude Code's notice. The set names no server but the plugin's.
// Killed by reading the plugins from a `system/init` frame, which the process never writes, so a
// loaded plugin reads unloaded, by a refused plugin's server sent, by an accepted one left out, by
// its placeholders unfilled, by the strict flag dropped, by `--plugin-dir` in place of
// `--plugin-dir-no-mcp`, by safe mode predicted as a failure, and by a managed MCP file starting a
// process.
#[rstest]
#[case::loaded(Some(json!({ "name": "db-tools" })), PluginReload::LoadedByFolder, ProbeMode::Plain,
    McpServerStatus::Connected, None)]
#[case::loaded_without_a_manifest_by_its_folder_name(
    None,
    PluginReload::LoadedByName,
    ProbeMode::Plain,
    McpServerStatus::Connected,
    None
)]
#[case::refused_with_no_answer(
    Some(json!({ "name": "db-tools" })),
    PluginReload::Absent,
    ProbeMode::Plain,
    McpServerStatus::Failed,
    Some("Claude Code did not load the plugin.")
)]
#[case::refused_unlisted(
    Some(json!({ "name": "db-tools" })),
    PluginReload::Unlisted,
    ProbeMode::Plain,
    McpServerStatus::Failed,
    Some("Claude Code did not load the plugin.")
)]
#[case::under_a_managed_mcp_file(Some(json!({ "name": "db-tools" })), PluginReload::Absent,
    ProbeMode::ManagedMcpFile, McpServerStatus::Failed, Some(
        "Your organization's managed MCP config has exclusive control over MCP servers in this \
         session."
    ))]
#[case::under_safe_mode(Some(json!({ "name": "db-tools" })), PluginReload::LoadedByFolder,
    ProbeMode::SafeMode, McpServerStatus::Connected, None)]
#[tokio::test(start_paused = true)]
async fn a_plugin_server_is_sent_only_where_claude_code_loads_its_plugin(
    #[case] manifest: Option<Value>,
    #[case] plugin_reload: PluginReload,
    #[case] mode: ProbeMode,
    #[case] status: McpServerStatus,
    #[case] failure_text: Option<&str>,
) {
    let is_loaded = matches!(
        plugin_reload,
        PluginReload::LoadedByFolder | PluginReload::LoadedByName
    );
    let plugins = install_plugins(&[("db-tools@team.market", "db-tools/1.0.0", manifest)]).await;
    let install = &plugins.installs[0];
    let install_path = install.to_string_lossy().into_owned();
    let loaded = match plugin_reload {
        PluginReload::Absent => None,
        PluginReload::LoadedByFolder => {
            Some(json!([{ "name": "db-tools", "path": install_path, "source": "db-tools@inline" }]))
        }
        PluginReload::LoadedByName => {
            Some(json!([{ "name": "1.0.0", "path": "/elsewhere/1.0.0", "source": "1.0.0@inline" }]))
        }
        PluginReload::Unlisted => {
            Some(json!([{ "name": "other", "path": "/elsewhere/other", "source": "other@inline" }]))
        }
    };
    let starts = ScriptedStarts::default();
    let channel = Arc::new(ScriptedChannel::default());
    if let Some(loaded) = loaded {
        channel.answer(
            "reload_plugins",
            ScriptedAnswer::Reply(json!({ "plugins": loaded, "error_count": 0 })),
        );
    }
    channel.answer(
        "mcp_status",
        ScriptedAnswer::Reply(
            json!({ "mcpServers": [{ "name": SERVER_NAME, "status": "connected" }] }),
        ),
    );
    starts.script_mcp_probe(Arc::clone(&channel));
    let environment = match mode {
        ProbeMode::Plain | ProbeMode::ManagedMcpFile => Vec::new(),
        ProbeMode::SafeMode => vec![("CLAUDE_CODE_SAFE_MODE".to_owned(), "1".to_owned())],
    };

    let started = Instant::now();
    let readings = probe_plugins(
        &starts,
        &plugins,
        environment,
        matches!(mode, ProbeMode::ManagedMcpFile),
    )
    .await
    .expect("the probe reads");

    let [db] = <[McpProbeReading; 1]>::try_from(readings)
        .unwrap_or_else(|readings| panic!("one reading: {readings:?}"));
    assert_eq!(db.reading, McpServerReading::Observed(status));
    assert_eq!(db.failure_text.as_deref(), failure_text);
    assert_eq!(started.elapsed(), Duration::ZERO);
    let process_starts = starts.take_mcp_probe_starts();
    if matches!(mode, ProbeMode::ManagedMcpFile) {
        assert!(process_starts.is_empty());
        return;
    }
    let [process] = process_starts.as_slice() else {
        panic!("one probe process starts");
    };
    let plugin_dir = ["--plugin-dir-no-mcp".to_owned(), install_path.clone()];
    assert!(
        process
            .arguments
            .windows(2)
            .any(|pair| pair == plugin_dir.as_slice()),
        "{:?}",
        process.arguments
    );
    assert!(
        process
            .arguments
            .iter()
            .any(|argument| argument == "--strict-mcp-config")
    );
    assert!(
        !process
            .arguments
            .iter()
            .any(|argument| argument == "--plugin-dir")
    );
    let set: Vec<Value> = channel
        .control_requests()
        .into_iter()
        .filter(|request| request["subtype"] == "mcp_set_servers")
        .collect();
    if !is_loaded {
        assert!(set.is_empty(), "{set:?}");
        return;
    }
    let [set] = set.as_slice() else {
        panic!("one set is sent: {set:?}");
    };
    let data_folder = plugins
        .plugin_home
        .join("plugins")
        .join("data")
        .join("db-tools-team-market");
    assert_eq!(
        set["servers"],
        json!({ "plugin:db-tools:db": {
            "type": "stdio",
            "command": format!("{install_path}/servers/db"),
            "args": ["--data", data_folder],
            "env": { "CLAUDE_PLUGIN_ROOT": install_path, "CLAUDE_PLUGIN_DATA": data_folder },
        } })
    );
}

// Under a deployed managed MCP file, a plugin's server whose plugin left the installed list after
// the config read gets no reading and starts no process. Killed by the managed file's notice read
// before the plugin is found.
#[tokio::test]
async fn a_gone_plugins_server_gets_no_reading_under_a_managed_mcp_file() {
    let mut plugins = install_plugins(&[(
        "db-tools@team.market",
        "db-tools/1.0.0",
        Some(json!({ "name": "db-tools" })),
    )])
    .await;
    plugins.reading.plugin_roots.clear();
    let starts = ScriptedStarts::default();

    let readings = probe_plugins(&starts, &plugins, Vec::new(), true)
        .await
        .expect("the probe reads");

    assert!(readings.is_empty(), "{readings:?}");
    assert!(starts.take_mcp_probe_starts().is_empty());
}

// Two plugins without a manifest whose install folders share a name load under one name, so each
// is probed in a process of its own, and both servers read as their own process reports them.
// Killed by the two loaded in one process, where the second's server would go unread.
#[tokio::test(start_paused = true)]
async fn plugins_loaded_under_one_name_are_probed_apart() {
    let plugins = install_plugins(&[
        ("a@team.market", "a/1.0.0", None),
        ("b@team.market", "b/1.0.0", None),
    ])
    .await;
    let starts = ScriptedStarts::default();
    for (plugin, install) in ["a", "b"].into_iter().zip(&plugins.installs) {
        let channel = Arc::new(ScriptedChannel::default());
        channel.answer(
            "mcp_status",
            ScriptedAnswer::Reply(json!({ "mcpServers": [
                { "name": format!("plugin:{plugin}:db"), "status": "connected" }
            ] })),
        );
        channel.answer(
            "reload_plugins",
            ScriptedAnswer::Reply(json!({
                "plugins": [{ "name": "1.0.0", "path": install, "source": "1.0.0@inline" }],
                "error_count": 0,
            })),
        );
        starts.script_mcp_probe(channel);
    }

    let readings = probe_plugins(&starts, &plugins, Vec::new(), false)
        .await
        .expect("the probe reads");

    assert_eq!(readings.len(), 2);
    assert!(
        readings.iter().all(
            |reading| reading.reading == McpServerReading::Observed(McpServerStatus::Connected)
        ),
        "{readings:?}"
    );
    let process_starts = starts.take_mcp_probe_starts();
    assert_eq!(process_starts.len(), 2);
    for (process, install) in process_starts.iter().zip(&plugins.installs) {
        let folders: Vec<&String> = process
            .arguments
            .windows(2)
            .filter(|pair| pair[0] == "--plugin-dir-no-mcp")
            .map(|pair| &pair[1])
            .collect();
        assert_eq!(folders, [&install.to_string_lossy().into_owned()]);
    }
}
