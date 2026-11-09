use std::fs;
use std::path::Path;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::place::PlacedPath;
use sidekicks_platforms::make_folder_link;

use super::{
    ClaudeMcpConfigReading, ClaudeMcpConfigSources, ClaudeMcpRoot, ClaudePersonConfigFiles,
    read_claude_mcp_config,
};
use crate::driver::claude::session::rules::{
    CLAUDE_SHARED_SETTINGS_FILE, CLAUDE_USER_SETTINGS_FILE, local_settings_path, settings_path,
};
use crate::driver::mcp_server::read::McpServerSignInSettings;

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
// project only, while the user and managed files keep it out of every project; and by the project's
// entry looked up at its root as given, a link, rather than at the folder the link resolves to.
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
    fs::create_dir_all(scratch.path().join("root-a-folder")).expect("the root's folder is made");
    make_folder_link(
        &scratch.path().join("root-a-folder"),
        &scratch.path().join("root-a"),
    )
    .expect("the root is a link to its folder");
    let roots = [
        attached_root(&scratch.path().join("root-a")),
        attached_root(&scratch.path().join("root-b")),
    ];
    let kept_out = json!({ "disabledMcpjsonServers": ["kept"] });
    let mut project_entry = json!({ "disabledMcpServers": ["off"] });
    let root_a = &roots[0].folder;
    match source {
        KeptOutSource::UserSettings => {
            write_json(
                &settings_path(&home, CLAUDE_SHARED_SETTINGS_FILE),
                &kept_out,
            );
        }
        KeptOutSource::ProjectSettings => {
            write_json(
                &settings_path(root_a, CLAUDE_SHARED_SETTINGS_FILE),
                &kept_out,
            );
        }
        KeptOutSource::ProjectLocalSettings => {
            write_json(&local_settings_path(root_a), &kept_out);
        }
        KeptOutSource::ManagedSettings => {
            write_json(&managed.join("managed-settings.json"), &kept_out);
        }
        KeptOutSource::ProjectEntry => {
            project_entry["disabledMcpjsonServers"] = json!(["kept"]);
        }
    }
    let project_key = fs::canonicalize(&roots[0].folder)
        .expect("the root resolves")
        .to_string_lossy()
        .into_owned();
    write_json(
        &home.join(".claude.json"),
        &json!({ "projects": { project_key: project_entry } }),
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

// Reads the `user` servers of a `.claude.json` holding `servers` in a fresh home.
async fn read_user_servers(servers: serde_json::Value) -> ClaudeMcpConfigReading {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let home = scratch.path().join("home");
    write_json(
        &home.join(".claude.json"),
        &json!({ "mcpServers": servers }),
    );
    read_claude_mcp_config(&ClaudeMcpConfigSources {
        person: &ClaudePersonConfigFiles::resolve(&[], &home).await,
        managed_settings_folder: None,
        plugin_home: &scratch.path().join("plugin-home"),
        roots: &[],
    })
    .await
    .expect("the config reads")
}

// A WebSocket server lists with its address and names too, and a remote entry's `oauth` members
// read as its sign-in settings and its view's scopes. Killed by keeping any value: a header, a
// bearer token, a query, userinfo or an environment value in the declaration or in the reading's
// `Debug`, the transient address and the metadata address included; by a WebSocket server left
// out; and by any of `clientId`, `callbackPort`, `scopes` or `authServerMetadataUrl` dropped.
#[tokio::test]
async fn a_declaration_reads_names_only_and_no_value_reaches_debug() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let home = scratch.path().join("home");
    write_json(
        &home.join(".claude.json"),
        &json!({ "mcpServers": {
            "remote": {
                "type": "http",
                "url": concat!(
                    "https://alice-userinfo:hunter2-password@Mcp.Example.com/mcp",
                    "?api_key=query-secret-value&team=a"
                ),
                "headers": {
                    "Authorization": "Bearer bearer-secret-token",
                    "X-Api-Key": "header-secret-value",
                },
                "oauth": {
                    "clientId": "owner-client",
                    "callbackPort": 8080,
                    "scopes": "read write",
                    "authServerMetadataUrl": "https://auth.example.test/meta?tenant=metadata-secret",
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
                oauth_scopes: Some(vec!["read".to_owned(), "write".to_owned()]),
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
    let settings: Vec<Option<&McpServerSignInSettings>> = reading
        .user_servers
        .iter()
        .map(|server| server.sign_in_settings.as_ref())
        .collect();
    assert_eq!(
        settings,
        [
            None,
            Some(&McpServerSignInSettings {
                client_id: Some("owner-client".to_owned()),
                callback_url: Some("http://localhost:8080/callback".to_owned()),
                callback_port: None,
                authorization_server_metadata_url: Some(
                    "https://auth.example.test/meta?tenant=metadata-secret".to_owned()
                ),
                asks_offline_access_where_listed: true,
            }),
            None,
        ]
    );
    let printed = format!("{reading:?}");
    for secret in [
        "metadata-secret",
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
        &config_folder.join(CLAUDE_USER_SETTINGS_FILE),
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

// The person's config file takes Claude Code's suffix for a custom sign-in host where the
// environment names one, and none where it names none or an empty one. Killed by the suffix
// never taken, and by it taken for an empty value.
#[rstest]
#[case::custom_host(Some("https://claude.fedstart.com"), ".claude-custom-oauth.json")]
#[case::empty_host(Some(""), ".claude.json")]
#[case::no_host(None, ".claude.json")]
#[tokio::test]
async fn the_person_config_file_takes_the_custom_sign_in_suffix(
    #[case] custom_host: Option<&str>,
    #[case] config_file: &str,
) {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let home = scratch.path().join("home");
    let environment: Vec<(String, String)> = custom_host
        .map(|host| ("CLAUDE_CODE_CUSTOM_OAUTH_URL".to_owned(), host.to_owned()))
        .into_iter()
        .collect();

    let person = ClaudePersonConfigFiles::resolve(&environment, &home).await;

    assert_eq!(person.person_config, home.join(config_file));
}

// A plugin with no manifest is named by its id and lists its `.mcp.json` servers, and so does one
// whose manifest Claude Code takes with a member it does not know, while one whose manifest is not
// JSON, does not read, or has a member Claude Code refuses lists none, as Claude Code refuses to
// load it; the plugin beside it still lists its servers. Killed by a manifest that does not read
// or is refused taken as an absent one, by a read error failing the whole read, by a refused
// member let through, and by a member the schema does not know refused.
#[rstest]
#[case::no_manifest(Manifest::Absent, &["other-server", "plugin-server"][..])]
#[case::unknown_member(
    Manifest::Text(r#"{ "name": "tools", "version": "1.0.0", "tagline": 7 }"#),
    &["other-server", "plugin-server"][..]
)]
#[case::corrupt_manifest(Manifest::Text("{ \"name\": "), &["other-server"][..])]
#[case::manifest_is_a_folder(Manifest::Folder, &["other-server"][..])]
#[case::manifest_not_an_object(Manifest::Text("[]"), &["other-server"][..])]
#[case::refused_member(
    Manifest::Text(r#"{ "name": "tools", "version": 3 }"#),
    &["other-server"][..]
)]
#[tokio::test]
async fn a_plugin_whose_manifest_does_not_read_lists_no_servers(
    #[case] manifest: Manifest,
    #[case] listed: &[&str],
) {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let plugin_home = scratch.path().join("plugin-home");
    let install = plugin_home.join("plugins").join("cache").join("tools");
    let other = plugin_home.join("plugins").join("cache").join("other");
    write_json(
        &plugin_home.join("plugins").join("installed_plugins.json"),
        &json!({ "plugins": {
            "tools@market": [{ "installPath": install }],
            "other@market": [{ "installPath": other }]
        } }),
    );
    write_json(
        &install.join(".mcp.json"),
        &json!({ "mcpServers": { "plugin-server": { "command": "plugin" } } }),
    );
    write_json(
        &other.join(".mcp.json"),
        &json!({ "mcpServers": { "other-server": { "command": "other" } } }),
    );
    let manifest_file = install.join(".claude-plugin").join("plugin.json");
    match manifest {
        Manifest::Absent => {}
        Manifest::Text(text) => {
            fs::create_dir_all(install.join(".claude-plugin"))
                .expect("the manifest folder is made");
            fs::write(&manifest_file, text).expect("the manifest is written");
        }
        Manifest::Folder => fs::create_dir_all(&manifest_file).expect("the folder is made"),
    }

    let reading = read_claude_mcp_config(&ClaudeMcpConfigSources {
        person: &ClaudePersonConfigFiles::resolve(&[], &scratch.path().join("home")).await,
        managed_settings_folder: None,
        plugin_home: &plugin_home,
        roots: &[],
    })
    .await
    .expect("the config reads");

    let mut names: Vec<&str> = reading
        .plugin_servers
        .iter()
        .map(|server| server.binding.server_name().as_str())
        .collect();
    names.sort_unstable();
    assert_eq!(names, listed);
}

// A plugin's manifest as a test plants it.
#[derive(Clone, Copy, Debug)]
enum Manifest {
    Absent,
    Text(&'static str),
    Folder,
}

// A callback port given alone reads as a callback with no client id, and an `oauth` member of the
// wrong shape still lists its server, its settings naming nothing. Killed by a callback built only
// beside a client id, and by an entry dropped for a malformed member.
#[rstest]
#[case::callback_alone(
    json!({"callbackPort": 8080}),
    Some("http://localhost:8080/callback")
)]
#[case::malformed(json!({"callbackPort": "8080"}), None)]
#[tokio::test]
async fn an_oauth_member_reads_each_setting_on_its_own(
    #[case] oauth: serde_json::Value,
    #[case] callback_url: Option<&str>,
) {
    let reading = read_user_servers(json!({
        "docs": { "type": "http", "url": "https://docs.example.test/mcp", "oauth": oauth },
    }))
    .await;

    let [server] = reading.user_servers.as_slice() else {
        panic!("the server lists: {:?}", reading.user_servers);
    };
    assert_eq!(
        server.sign_in_settings,
        Some(McpServerSignInSettings {
            client_id: None,
            callback_url: callback_url.map(str::to_owned),
            callback_port: None,
            authorization_server_metadata_url: None,
            asks_offline_access_where_listed: true,
        })
    );
}
