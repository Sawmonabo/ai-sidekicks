use std::fs;
use std::path::Path;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::place::PlacedPath;

use super::{
    ClaudeMcpConfigSources, ClaudeMcpRoot, ClaudePersonConfigFiles, read_claude_mcp_config,
};

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
        person: &ClaudePersonConfigFiles::resolve(&[], &home).await,
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
    assert_eq!(root_b.switched_off_server_names, [] as [McpServerName; 0]);
}

// A WebSocket server lists with its address and names too. Killed by keeping any value: a header,
// a bearer token, a query, userinfo or an environment value in the declaration or in the
// reading's `Debug`, the transient address included, and by a WebSocket server left out.
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
            "socket": {
                "type": "ws",
                "url": "wss://socket.example.com/mcp?ticket=socket-secret-value",
                "headers": { "X-Socket-Key": "socket-header-secret" },
            },
        } }),
    );

    let reading = read_claude_mcp_config(&ClaudeMcpConfigSources {
        person: &ClaudePersonConfigFiles::resolve(&[], &home).await,
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
                url: "https://Mcp.Example.com/mcp".to_owned(),
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
            &McpServerConfigView::Ws {
                url: "wss://socket.example.com/mcp".to_owned(),
                url_query_param_names: Some(vec!["ticket".to_owned()]),
                header_names: Some(vec!["X-Socket-Key".to_owned()]),
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
        "socket-secret-value",
        "socket-header-secret",
    ] {
        assert!(
            !printed.contains(secret),
            "{secret} reached the reading's Debug"
        );
    }
}

// Where the person's environment sets `CLAUDE_CONFIG_DIR`, their `.claude.json` and their user
// settings are read in that folder, as Claude Code reads them. Killed by either read from the
// home folder.
#[tokio::test]
async fn the_person_config_is_read_in_the_folder_claude_config_dir_names() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let home = scratch.path().join("home");
    let config_folder = scratch.path().join("claude-config");
    let root = attached_root(&scratch.path().join("root"));
    write_json(
        &home.join(".claude.json"),
        &json!({ "mcpServers": { "home-server": { "command": "home" } } }),
    );
    write_json(
        &config_folder.join(".claude.json"),
        &json!({ "mcpServers": { "moved-server": { "command": "moved" } } }),
    );
    write_json(
        &config_folder.join("settings.json"),
        &json!({ "disabledMcpjsonServers": ["kept"] }),
    );
    let environment = [(
        "CLAUDE_CONFIG_DIR".to_owned(),
        config_folder.to_string_lossy().into_owned(),
    )];

    let reading = read_claude_mcp_config(&ClaudeMcpConfigSources {
        person: &ClaudePersonConfigFiles::resolve(&environment, &home).await,
        managed_settings_folder: None,
        plugin_home: &scratch.path().join("plugin-home"),
        roots: std::slice::from_ref(&root),
    })
    .await
    .expect("the config reads");

    let names: Vec<&str> = reading
        .user_servers
        .iter()
        .map(|server| server.binding.server_name().as_str())
        .collect();
    assert_eq!(names, ["moved-server"]);
    assert_eq!(
        reading.roots[0].kept_out_server_names,
        [server_name("kept")]
    );
}

// A legacy `.config.json` in the config folder that holds anything is read in place of
// `.claude.json`, as Claude Code picks it, and an empty one is passed over. Killed by the legacy
// file never read, and by an empty one read in place of `.claude.json`.
#[rstest]
#[case::legacy_written(
    json!({ "mcpServers": { "legacy-server": { "command": "legacy" } } }).to_string(),
    "legacy-server"
)]
#[case::legacy_empty(String::new(), "home-server")]
#[tokio::test]
async fn a_legacy_config_that_holds_anything_is_read_in_place_of_claude_json(
    #[case] legacy_config: String,
    #[case] read_server: &str,
) {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let home = scratch.path().join("home");
    write_json(
        &home.join(".claude.json"),
        &json!({ "mcpServers": { "home-server": { "command": "home" } } }),
    );
    fs::create_dir_all(home.join(".claude")).expect("the config folder is made");
    fs::write(home.join(".claude").join(".config.json"), legacy_config)
        .expect("the legacy config is written");

    let reading = read_claude_mcp_config(&ClaudeMcpConfigSources {
        person: &ClaudePersonConfigFiles::resolve(&[], &home).await,
        managed_settings_folder: None,
        plugin_home: &scratch.path().join("plugin-home"),
        roots: &[],
    })
    .await
    .expect("the config reads");

    let names: Vec<&str> = reading
        .user_servers
        .iter()
        .map(|server| server.binding.server_name().as_str())
        .collect();
    assert_eq!(names, [read_server]);
}
