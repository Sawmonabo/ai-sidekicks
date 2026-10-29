use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::plugin::PluginToken;
use sidekicks_contracts::wire::number::PositiveNumber;

use super::{CodexMcpConfigReading, CodexMcpRoot, read_codex_mcp_config_over};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::session::detached_conversation::CodexDetachedFrames;
use crate::driver::codex::transport::connection::CodexConnectionHandlers;
use crate::driver::codex::transport::connection::scripted_service::connect_scripted_service;
use crate::driver::mcp_server::read::{McpServerDeclaration, McpServerSignInClient};

/// The largest message the scripted connection takes, far above any a test sends.
const MESSAGE_LIMIT: usize = 1 << 20;

/// The person's home folder, read when no root is attached.
const HOME: &str = "/home/person";

/// The person's own Codex config file.
const USER_FILE: &str = "/home/person/.codex/config.toml";

/// The attached project root.
const ROOT: &str = "/work/app";

// The read over a scripted connection that answers each `config/read` in turn with `replies`,
// checking it asks for the layers at each root's folder, or at the home folder with no root.
async fn read_scripted(
    roots: &[CodexMcpRoot],
    plugin_home: &Path,
    replies: &[Value],
) -> CodexMcpConfigReading {
    let (events, _frames) = CodexDetachedFrames::new();
    let (connection, mut script) = connect_scripted_service(
        MESSAGE_LIMIT,
        CodexConnectionHandlers {
            events,
            responder: None,
        },
    );
    let folders: Vec<PathBuf> = if roots.is_empty() {
        vec![PathBuf::from(HOME)]
    } else {
        roots.iter().map(|root| root.folder.clone()).collect()
    };
    assert_eq!(folders.len(), replies.len(), "one reply per read");
    let answering = async {
        for (folder, reply) in folders.iter().zip(replies) {
            let request = script.next_sent().await;
            assert_eq!(request["method"], "config/read");
            assert_eq!(
                request["params"],
                json!({"cwd": folder.to_string_lossy(), "includeLayers": true})
            );
            script.answer(&request, reply);
        }
    };
    let (reading, ()) = tokio::join!(
        read_codex_mcp_config_over(&connection, Path::new(HOME), plugin_home, roots),
        answering
    );
    reading.expect("the scripted reads answer")
}

fn attached_root() -> CodexMcpRoot {
    CodexMcpRoot {
        root: placed(ROOT),
        folder: PathBuf::from(ROOT),
    }
}

fn placed(path: &str) -> PlacedPath {
    PlacedPath {
        path: FilesystemPath::new(path.to_owned()).expect("a test path is a path"),
        place: None,
    }
}

fn server_name(name: &str) -> McpServerName {
    McpServerName::new(name.to_owned()).expect("a test server name is a name")
}

fn user(name: &str) -> McpServerBindingRef {
    McpServerBindingRef::User {
        provider: DESCRIPTOR.provider_id(),
        server_name: server_name(name),
    }
}

fn project(name: &str) -> McpServerBindingRef {
    McpServerBindingRef::Project {
        provider: DESCRIPTOR.provider_id(),
        scope_ref: FilesystemPath::new(ROOT.to_owned()).expect("the root is a path"),
        place: None,
        server_name: server_name(name),
    }
}

fn managed(name: &str) -> McpServerBindingRef {
    McpServerBindingRef::Managed {
        provider: DESCRIPTOR.provider_id(),
        server_name: server_name(name),
    }
}

fn declaration<'reading>(
    reading: &'reading CodexMcpConfigReading,
    binding: &McpServerBindingRef,
) -> &'reading McpServerDeclaration {
    reading
        .declarations
        .iter()
        .find(|declaration| declaration.binding == *binding)
        .expect("the binding is declared")
}

fn user_layer(servers: Value) -> Value {
    json!({
        "name": {"type": "user", "file": USER_FILE, "profile": null},
        "version": "1",
        "config": {"mcp_servers": servers},
    })
}

fn project_layer(servers: Value) -> Value {
    json!({
        "name": {"type": "project", "dotCodexFolder": format!("{ROOT}/.codex")},
        "version": "1",
        "config": {"mcp_servers": servers},
    })
}

// Killed by keeping any environment, header, query, user-name, password, bearer token or client
// secret value, by a derived `Debug` printing the address, and by reading a plugin's malformed file
// as the whole read's failure.
#[tokio::test]
async fn a_declaration_reads_names_only_and_no_value_reaches_debug() {
    let remote = json!({
        "url": "https://alice-userinfo:hunter2-password@mcp.example.com/mcp?token=query-secret",
        "http_headers": {"X-Api-Key": "header-secret"},
        "env_http_headers": {"X-Team": "TEAM_VARIABLE_SECRET"},
        "bearer_token": "bearer-secret",
        "bearer_token_env_var": "TOKEN_VARIABLE_SECRET",
        "oauth": {
            "client_id": "client-1",
            "client_secret": "client-secret",
            "callback_url": "http://127.0.0.1:5555/callback",
        },
    });
    let local = json!({
        "command": "local-server",
        "args": ["--serve"],
        "env": {"API_TOKEN": "env-secret"},
        "env_vars": ["HOME_PATH", {"name": "TEAM_ID", "source": "local"}],
    });
    let servers = json!({"remote": remote, "local": local});
    let reply = json!({
        "config": {"mcp_servers": servers},
        "origins": {},
        "layers": [user_layer(servers.clone())],
    });
    let plugin_home = tempfile::tempdir().expect("a scratch folder is made");
    let plugin = plugin_home.path().join("plugins/cache/market/tools/1.0.0");
    std::fs::create_dir_all(plugin.join(".codex-plugin")).expect("the plugin folder is made");
    std::fs::write(
        plugin.join(".codex-plugin/plugin.json"),
        json!({"name": "tools", "mcpServers": "./servers.json"}).to_string(),
    )
    .expect("the manifest is written");
    std::fs::write(
        plugin.join("servers.json"),
        json!({"mcpServers": {
            "search": {"command": "search-server", "env": {"SEARCH_KEY": "plugin-env-secret"}},
            "broken": 5,
        }})
        .to_string(),
    )
    .expect("the MCP file is written");
    let broken = plugin_home.path().join("plugins/cache/market/broken/local");
    std::fs::create_dir_all(broken.join(".codex-plugin")).expect("the plugin folder is made");
    std::fs::write(broken.join(".codex-plugin/plugin.json"), "{not json")
        .expect("the manifest is written");

    let reading = read_scripted(&[], plugin_home.path(), &[reply]).await;

    assert_eq!(
        declaration(&reading, &user("remote")).config,
        McpServerConfigView::Http {
            url: "https://mcp.example.com/mcp".to_owned(),
            url_query_param_names: Some(vec!["token".to_owned()]),
            header_names: Some(vec![
                "X-Api-Key".to_owned(),
                "X-Team".to_owned(),
                "Authorization".to_owned(),
            ]),
            bearer_token_env_var: None,
            env_http_headers: None,
            oauth_scopes: None,
            oauth_resource: None,
            enabled: None,
            required: None,
            startup_timeout_sec: None,
            tool_timeout_sec: None,
        }
    );
    assert_eq!(
        declaration(&reading, &user("remote")).sign_in_client,
        Some(McpServerSignInClient {
            client_id: Some("client-1".to_owned()),
            callback_url: Some("http://127.0.0.1:5555/callback".to_owned()),
        })
    );
    assert_eq!(
        declaration(&reading, &user("local")).config,
        McpServerConfigView::Stdio {
            command: "local-server".to_owned(),
            args: Some(vec!["--serve".to_owned()]),
            env_var_names: Some(vec![
                "API_TOKEN".to_owned(),
                "HOME_PATH".to_owned(),
                "TEAM_ID".to_owned(),
            ]),
            enabled: None,
            required: None,
            startup_timeout_sec: None,
            tool_timeout_sec: None,
        }
    );
    let search = declaration(
        &reading,
        &McpServerBindingRef::Plugin {
            provider: DESCRIPTOR.provider_id(),
            scope_ref: PluginToken::new("tools".to_owned()).expect("a plugin name"),
            server_name: server_name("search"),
        },
    );
    assert!(search.is_read_only);
    assert_eq!(
        reading.declarations.len(),
        3,
        "the malformed entry and file declare nothing"
    );
    let printed = format!("{reading:?}");
    for secret in [
        "alice-userinfo",
        "hunter2-password",
        "query-secret",
        "header-secret",
        "TEAM_VARIABLE_SECRET",
        "bearer-secret",
        "TOKEN_VARIABLE_SECRET",
        "client-secret",
        "env-secret",
        "plugin-env-secret",
    ] {
        assert!(!printed.contains(secret), "{secret} reached the reading");
    }
}

// Killed by merging the two `docs` declarations by name, by reading the project's no-transport
// `tuned` entry as a binding, by a superseded user server naming no file, and by listing the
// person's own servers among what an account session loads.
#[tokio::test]
async fn each_layer_binds_its_own_declaration_and_a_higher_entry_supersedes_it() {
    let reply = json!({
        "config": {"mcp_servers": {
            "docs": {"url": "https://docs.example.com/mcp"},
            "tuned": {"command": "tuned-server", "startup_timeout_sec": 30},
        }},
        "origins": {},
        "layers": [
            project_layer(json!({
                "docs": {"url": "https://docs.example.com/mcp"},
                "tuned": {"startup_timeout_sec": 30},
            })),
            user_layer(json!({
                "docs": {"command": "docs-server"},
                "tuned": {"command": "tuned-server"},
            })),
        ],
    });
    let plugin_home = tempfile::tempdir().expect("a scratch folder is made");

    let reading = read_scripted(&[attached_root()], plugin_home.path(), &[reply]).await;

    let project_file = placed(&format!("{ROOT}/.codex/config.toml"));
    let project_docs = declaration(&reading, &project("docs"));
    assert!(matches!(
        project_docs.config,
        McpServerConfigView::Http { .. }
    ));
    assert!(project_docs.superseded_in.is_empty());
    assert_eq!(
        declaration(&reading, &user("docs")).superseded_in,
        vec![project_file.clone()]
    );
    let user_tuned = declaration(&reading, &user("tuned"));
    assert_eq!(user_tuned.superseded_in, vec![project_file]);
    assert!(user_tuned.disabled_in.is_empty());
    assert!(matches!(
        user_tuned.config,
        McpServerConfigView::Stdio { startup_timeout_sec: Some(timeout), .. }
            if timeout == PositiveNumber::new(30.0).expect("a positive number")
    ));
    assert!(
        !reading
            .declarations
            .iter()
            .any(|declared| declared.binding == project("tuned")),
        "an override binds nothing"
    );
    assert_eq!(reading.declarations.len(), 3);
    assert_eq!(reading.roots.len(), 1);
    assert_eq!(reading.roots[0].root, placed(ROOT));
    assert_eq!(reading.roots[0].provider_loaded, vec![project("docs")]);
    assert!(reading.roots[0].kept_out_server_names.is_empty());
    assert!(!reading.is_machine_managed);
}

// Killed by listing an MDM server as the person's own, by leaving it out, and by an override in the
// person's file naming no file.
#[tokio::test]
async fn an_administrator_server_reads_managed_and_names_the_file_that_overrides_it() {
    let reply = json!({
        "config": {"mcp_servers": {
            "corp": {"url": "https://corp.example.com/mcp", "tool_timeout_sec": 60},
        }},
        "origins": {},
        "layers": [
            user_layer(json!({"corp": {"tool_timeout_sec": 60}})),
            {
                "name": {"type": "mdm", "domain": "com.openai.codex", "key": "config_toml_base64"},
                "version": "1",
                "config": {"mcp_servers": {"corp": {"url": "https://corp.example.com/mcp"}}},
            },
        ],
    });
    let plugin_home = tempfile::tempdir().expect("a scratch folder is made");

    let reading = read_scripted(&[], plugin_home.path(), &[reply]).await;

    let corp = declaration(&reading, &managed("corp"));
    assert!(corp.is_read_only);
    assert_eq!(corp.superseded_in, vec![placed(USER_FILE)]);
    assert!(matches!(
        corp.config,
        McpServerConfigView::Http { tool_timeout_sec: Some(timeout), .. }
            if timeout == PositiveNumber::new(60.0).expect("a positive number")
    ));
    assert_eq!(
        reading.declarations.len(),
        1,
        "the person's override binds nothing"
    );
    assert!(reading.is_machine_managed);
    assert!(reading.roots.is_empty());
}

// Killed by reading a layer Codex ignores.
#[tokio::test]
async fn a_layer_codex_ignores_binds_nothing() {
    let mut ignored = project_layer(json!({"ghost": {"command": "ghost-server"}}));
    ignored["disabledReason"] = json!("the project is not trusted");
    let reply = json!({"config": {}, "origins": {}, "layers": [ignored]});
    let plugin_home = tempfile::tempdir().expect("a scratch folder is made");

    let reading = read_scripted(&[attached_root()], plugin_home.path(), &[reply]).await;

    assert!(reading.declarations.is_empty());
    assert!(reading.roots[0].provider_loaded.is_empty());
}
