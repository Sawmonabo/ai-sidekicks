use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::inventory::{
    McpManagedLayer, McpManagedLayerKind, McpOverrideOrigin,
};
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::plugin::PluginToken;
use sidekicks_contracts::wire::number::PositiveNumber;
use sidekicks_contracts::wire::record::Record;

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
// secret value, by a derived `Debug` printing the address, by leaving a bearer token's or a
// header's variable name out of its own slot, and by reading a plugin's malformed file as the whole
// read's failure.
#[tokio::test]
async fn a_declaration_reads_names_only_and_no_value_reaches_debug() {
    let remote = json!({
        "url": "https://alice-userinfo:hunter2-password@mcp.example.com/mcp?token=query-secret",
        "http_headers": {"X-Api-Key": "header-secret"},
        "env_http_headers": {"X-Team": "TEAM_VARIABLE"},
        "bearer_token": "bearer-secret",
        "bearer_token_env_var": "TOKEN_VARIABLE",
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
            bearer_token_env_var: Some("TOKEN_VARIABLE".to_owned()),
            env_http_headers: Record::new(BTreeMap::from([(
                "X-Team".to_owned(),
                "TEAM_VARIABLE".to_owned(),
            )])),
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
        "bearer-secret",
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

    let project_file = McpOverrideOrigin::Placed(placed(&format!("{ROOT}/.codex/config.toml")));
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
    assert_eq!(
        corp.superseded_in,
        vec![McpOverrideOrigin::Placed(placed(USER_FILE))]
    );
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

// Killed by naming no origin for an administrator's layer written in no file, and by naming it
// as another kind.
#[tokio::test]
async fn a_device_management_layer_is_named_where_it_overrides_the_persons_server() {
    let reply = json!({
        "config": {"mcp_servers": {"docs": {"command": "docs-server", "enabled": false}}},
        "origins": {},
        "layers": [
            {
                "name": {"type": "legacyManagedConfigTomlFromMdm"},
                "version": "1",
                "config": {"mcp_servers": {"docs": {"enabled": false, "tool_timeout_sec": 9}}},
            },
            user_layer(json!({"docs": {"command": "docs-server"}})),
        ],
    });
    let plugin_home = tempfile::tempdir().expect("a scratch folder is made");

    let reading = read_scripted(&[], plugin_home.path(), &[reply]).await;

    let device_management = McpOverrideOrigin::ManagedLayer(McpManagedLayer {
        managed_layer: McpManagedLayerKind::DeviceManagement,
    });
    let docs = declaration(&reading, &user("docs"));
    assert_eq!(docs.disabled_in, vec![device_management.clone()]);
    assert_eq!(docs.superseded_in, vec![device_management]);
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

fn plugin_binding(plugin: &str, name: &str) -> McpServerBindingRef {
    McpServerBindingRef::Plugin {
        provider: DESCRIPTOR.provider_id(),
        scope_ref: PluginToken::new(plugin.to_owned()).expect("a plugin name"),
        server_name: server_name(name),
    }
}

// Writes a plugin in Codex's own format under `plugin_home`, its servers inline in its manifest.
fn write_codex_plugin(plugin_home: &Path, marketplace: &str, plugin: &str, servers: &Value) {
    let folder = plugin_home.join(format!("plugins/cache/{marketplace}/{plugin}/1.0.0"));
    std::fs::create_dir_all(folder.join(".codex-plugin")).expect("the plugin folder is made");
    std::fs::write(
        folder.join(".codex-plugin/plugin.json"),
        json!({"name": plugin, "mcpServers": servers}).to_string(),
    )
    .expect("the manifest is written");
}

// A plugin switched off by its own key, by every plugin's default, or a plugin's server switched
// off under its plugin's table, is disabled in the file that switches it off, and a plugin a
// higher layer switches back on is not. Killed by the plugin's switch read by its name alone, by
// the default read over an explicit switch, by the server's own switch ignored, and by a lower
// layer read over a higher one.
#[tokio::test]
async fn a_plugin_the_config_switches_off_is_disabled_in_that_file() {
    let plugin_home = tempfile::tempdir().expect("a scratch folder is made");
    let one_server = |name: &str| json!({ name: {"command": format!("{name}-server")} });
    write_codex_plugin(plugin_home.path(), "market", "tools", &one_server("search"));
    write_codex_plugin(
        plugin_home.path(),
        "market",
        "helpers",
        &json!({"lookup": {"command": "lookup-server"}, "other": {"command": "other-server"}}),
    );
    write_codex_plugin(plugin_home.path(), "market", "extra", &one_server("notes"));
    write_codex_plugin(plugin_home.path(), "market", "kept", &one_server("pages"));
    let mut user = user_layer(json!({}));
    user["config"]["plugins"] = json!({
        "tools": {"enabled": true},
        "tools@market": {"enabled": false},
        "helpers@market": {"enabled": true, "mcp_servers": {"lookup": {"enabled": false}}},
        "kept@market": {"enabled": false},
    });
    let mut project = project_layer(json!({}));
    project["config"]["plugins"] = json!({
        "_default": {"enabled": false},
        "kept@market": {"enabled": true},
    });
    let reply = json!({"config": {}, "origins": {}, "layers": [project, user]});

    let reading = read_scripted(&[attached_root()], plugin_home.path(), &[reply]).await;

    let user_file = McpOverrideOrigin::Placed(placed(USER_FILE));
    let project_file = McpOverrideOrigin::Placed(placed(&format!("{ROOT}/.codex/config.toml")));
    let disabled_in = |plugin: &str, name: &str| {
        declaration(&reading, &plugin_binding(plugin, name))
            .disabled_in
            .clone()
    };
    assert_eq!(disabled_in("tools", "search"), [user_file.clone()]);
    assert_eq!(disabled_in("helpers", "lookup"), [user_file]);
    assert!(disabled_in("helpers", "other").is_empty());
    assert_eq!(disabled_in("extra", "notes"), [project_file]);
    assert!(disabled_in("kept", "pages").is_empty());
}

// A plugin whose root manifest names the Agent Plugins schema declares the servers of its own
// `mcp.json` as Codex normalizes them, and one whose root manifest names another schema is read
// in Codex's format. Killed by the format's manifest ignored, by a program or working folder left
// relative, by the plugin's folders left unfilled, by a client-owned header sent, and by a server
// Codex refuses declared.
#[tokio::test]
async fn an_agent_format_plugin_declares_its_servers_as_codex_reads_them() {
    let plugin_home = tempfile::tempdir().expect("a scratch folder is made");
    let agent = plugin_home.path().join("plugins/cache/market/agent/1.0.0");
    std::fs::create_dir_all(&agent).expect("the plugin folder is made");
    std::fs::write(
        agent.join("plugin.json"),
        json!({
            "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            "name": "agent",
            "mcpServers": {"ignored": {"command": "ignored-server"}},
        })
        .to_string(),
    )
    .expect("the manifest is written");
    std::fs::write(
        agent.join("mcp.json"),
        json!({
            "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
            "mcpServers": {
                "local": {
                    "type": "stdio",
                    "command": "./bin/server",
                    "args": ["--config", "${PLUGIN_ROOT}/config.json"],
                    "env": {"CACHE": "${PLUGIN_DATA}/cache"},
                    "cwd": "${PLUGIN_DATA}",
                },
                "remote": {
                    "type": "streamable-http",
                    "url": "https://mcp.example.com/mcp",
                    "headers": {"Authorization": "Bearer x", "X-Team": "core"},
                },
                "legacy": {"type": "sse", "url": "https://mcp.example.com/sse"},
                "plain": {"type": "streamable-http", "url": "http://mcp.example.com/mcp"},
                "climbing": {"type": "stdio", "command": "./../outside"},
            },
        })
        .to_string(),
    )
    .expect("the MCP file is written");
    let unrelated = plugin_home.path().join("plugins/cache/market/codex/1.0.0");
    std::fs::create_dir_all(unrelated.join(".codex-plugin")).expect("the plugin folder is made");
    std::fs::write(
        unrelated.join("plugin.json"),
        json!({"$schema": "https://example.com/other.json"}).to_string(),
    )
    .expect("the unrelated manifest is written");
    std::fs::write(
        unrelated.join(".codex-plugin/plugin.json"),
        json!({"name": "codex", "mcpServers": {"own": {"command": "own-server"}}}).to_string(),
    )
    .expect("the manifest is written");

    let servers = super::plugins::read_plugin_server_entries(plugin_home.path()).await;

    let names: Vec<(&str, &str)> = servers
        .iter()
        .map(|server| match &server.declaration.binding {
            McpServerBindingRef::Plugin {
                scope_ref,
                server_name,
                ..
            } => (scope_ref.as_str(), server_name.as_str()),
            _ => panic!("a plugin's server binds to its plugin"),
        })
        .collect();
    assert_eq!(
        names,
        [("agent", "local"), ("agent", "remote"), ("codex", "own")]
    );
    let root = agent.display().to_string();
    let data = agent.join(".plugin-data").display().to_string();
    assert_eq!(
        Value::Object(servers[0].compose_codex_entry()),
        json!({
            "command": format!("{root}/bin/server"),
            "args": ["--config", format!("{root}/config.json")],
            "env": {"CACHE": format!("{data}/cache"), "PLUGIN_ROOT": root, "PLUGIN_DATA": data},
            "cwd": data,
            "enabled": true,
        })
    );
    assert!(
        agent.join(".plugin-data").is_dir(),
        "the data folder is made"
    );
    assert_eq!(
        Value::Object(servers[1].compose_codex_entry()),
        json!({
            "url": "https://mcp.example.com/mcp",
            "http_headers": {"X-Team": "core"},
            "enabled": true,
        })
    );
}
