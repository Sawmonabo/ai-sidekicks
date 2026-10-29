use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{McpApprovalMode, McpServerBindingRef, McpServerName};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::plugin::PluginToken;

use super::{merge_requirements, parse_codex_mcp_requirements, read_codex_mcp_requirements};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::mcp::config::CodexMcpConfigReading;
use crate::driver::codex::mcp::config::server_entry::CodexServerTransport;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::mcp_server::read::{
    McpRootReading, McpServerDeclaration, McpServerPolicy, McpServerPolicyEntry,
    McpServerToolDefaults,
};

/// The attached project root.
const ROOT: &str = "/work/app";

fn server_name(name: &str) -> McpServerName {
    McpServerName::new(name.to_owned()).expect("a test server name is a name")
}

fn declared(binding: McpServerBindingRef, config: McpServerConfigView) -> McpServerDeclaration {
    McpServerDeclaration {
        binding,
        config,
        superseded_in: Vec::new(),
        disabled_in: Vec::new(),
        is_read_only: false,
        sign_in_client: None,
        is_switch_kept_by_daemon: false,
        tool_defaults: McpServerToolDefaults::with_approval_mode(McpApprovalMode::Auto),
        organization_managed: None,
    }
}

fn program(command: &str) -> McpServerConfigView {
    McpServerConfigView::Stdio {
        command: command.to_owned(),
        args: Some(vec!["serve".to_owned()]),
        env_var_names: None,
        enabled: None,
        required: None,
        startup_timeout_sec: None,
        tool_timeout_sec: None,
    }
}

fn started(command: &str) -> CodexServerTransport {
    CodexServerTransport::Command {
        command: command.to_owned(),
        args: vec!["serve".to_owned()],
    }
}

fn reached(url: &str) -> CodexServerTransport {
    CodexServerTransport::Url(url.to_owned())
}

fn attached_root() -> PlacedPath {
    PlacedPath {
        path: FilesystemPath::new(ROOT.to_owned()).expect("the root is a path"),
        place: None,
    }
}

fn root_reading(provider_loaded: Vec<McpServerBindingRef>) -> McpRootReading {
    McpRootReading {
        root: attached_root(),
        kept_out_server_names: Vec::new(),
        provider_loaded,
    }
}

fn reading_of(
    servers: Vec<(McpServerBindingRef, CodexServerTransport)>,
    provider_loaded: Vec<McpServerBindingRef>,
) -> CodexMcpConfigReading {
    CodexMcpConfigReading {
        declarations: servers
            .iter()
            .map(|(binding, transport)| {
                let config = match transport {
                    CodexServerTransport::Command { command, .. } => program(command),
                    CodexServerTransport::Url(url) => address(url),
                };
                declared(binding.clone(), config)
            })
            .collect(),
        roots: vec![root_reading(provider_loaded)],
        is_machine_managed: false,
        server_policy: McpServerPolicy::default(),
        transports: servers,
        home_kept_out_server_names: Vec::new(),
    }
}

fn user(name: &str) -> McpServerBindingRef {
    McpServerBindingRef::User {
        provider: DESCRIPTOR.provider_id(),
        server_name: server_name(name),
    }
}

fn plugin(plugin: &str, name: &str) -> McpServerBindingRef {
    McpServerBindingRef::Plugin {
        provider: DESCRIPTOR.provider_id(),
        scope_ref: PluginToken::new(plugin.to_owned()).expect("a plugin name"),
        server_name: server_name(name),
    }
}

fn parsed(text: &str) -> super::CodexMcpRequirements {
    parse_codex_mcp_requirements(toml::from_str(text).expect("the requirements are TOML"))
        .expect("the requirements are Codex's shape")
        .expect("the requirements set an allow list")
}

fn address(url: &str) -> McpServerConfigView {
    McpServerConfigView::Http {
        url: url.to_owned(),
        url_query_param_names: None,
        header_names: None,
        bearer_token_env_var: None,
        env_http_headers: None,
        oauth_scopes: None,
        oauth_resource: None,
        enabled: None,
        required: None,
        startup_timeout_sec: None,
        tool_timeout_sec: None,
    }
}

// Killed by the policy left empty, by a server the list does not name left out of the root's
// kept-out names, by a named server whose transport the entry does not match left in, by a
// project server of another root counted at this one, and by a kept-out server left in the
// root's provider-loaded set.
#[tokio::test]
async fn the_allow_list_keeps_every_other_server_out_of_the_root() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    std::fs::write(
        folder.path().join("requirements.toml"),
        r#"
allowed_approval_policies = ["never"]

[mcp_servers.docs.identity]
command = { executable = "docs-mcp", args = [{ match = "regex", expression = "ser.e" }] }

[mcp_servers.remote.identity]
url = "https://mcp.example.com/v1"
"#,
    )
    .expect("the requirements are written");
    let project_at = |path: &str, name: &str| McpServerBindingRef::Project {
        provider: DESCRIPTOR.provider_id(),
        scope_ref: FilesystemPath::new(path.to_owned()).expect("a path"),
        place: None,
        server_name: server_name(name),
    };
    let mut reading = reading_of(
        vec![
            (user("docs"), started("docs-mcp")),
            (user("notes"), started("notes-mcp")),
            (user("remote"), reached("https://mcp.example.com/v2")),
            (project_at(ROOT, "tracker"), started("tracker-mcp")),
            (project_at("/work/other", "elsewhere"), started("x")),
        ],
        vec![user("docs"), user("notes")],
    );

    read_codex_mcp_requirements(Some(folder.path()))
        .await
        .expect("the requirements are read")
        .expect("the file sets an allow list")
        .apply(&mut reading);

    assert_eq!(
        reading.server_policy.allowed,
        Some(vec![
            McpServerPolicyEntry::ServerName(server_name("docs")),
            McpServerPolicyEntry::ServerName(server_name("remote")),
        ])
    );
    assert_eq!(
        reading.server_policy.denied,
        [] as [McpServerPolicyEntry; 0]
    );
    assert_eq!(
        reading.roots[0].kept_out_server_names,
        [
            server_name("notes"),
            server_name("remote"),
            server_name("tracker")
        ]
    );
    assert_eq!(reading.roots[0].provider_loaded, [user("docs")]);
    assert_eq!(
        reading.home_kept_out_server_names,
        [server_name("notes"), server_name("remote")]
    );
}

// A plugin's list, keyed `<plugin>@<marketplace>`, bounds that plugin's servers alone, a plugin
// with no list keeps its servers, and an empty top-level list refuses every plugin's. Killed by
// the plugin's key matched whole, by a plugin with no list refused, and by the empty top-level
// list ignored for plugins.
#[test]
fn a_plugin_list_bounds_its_own_plugins_servers() {
    let requirements = parsed(
        r#"
[plugins."tools@market".mcp_servers.search.identity]
url = { match = "prefix", value = "https://search.example.com/" }
"#,
    );
    let search = reached("https://search.example.com/v1");
    assert!(requirements.allows(&plugin("tools", "search"), Some(&search)));
    assert!(!requirements.allows(&plugin("tools", "other"), Some(&search)));
    assert!(!requirements.allows(
        &plugin("tools", "search"),
        Some(&reached("https://elsewhere.example.com/"))
    ));
    assert!(requirements.allows(&plugin("helpers", "search"), Some(&search)));
    assert!(requirements.allows(&user("anything"), Some(&started("anything"))));

    let refusing = parsed(
        r"
[mcp_servers]
",
    );
    assert!(!refusing.allows(&plugin("helpers", "search"), Some(&search)));
}

// A remote server's address is matched as written, so an entry naming the address without its
// query does not allow it. Killed by the address stripped before the match.
#[test]
fn a_remote_address_is_matched_as_written() {
    let requirements = parsed(
        r#"
[mcp_servers.remote.identity]
url = "https://mcp.example.com/v1"
"#,
    );
    assert!(requirements.allows(
        &user("remote"),
        Some(&reached("https://mcp.example.com/v1"))
    ));
    assert!(!requirements.allows(
        &user("remote"),
        Some(&reached("https://mcp.example.com/v1?team=core"))
    ));
}

// The device-management layer wins over the file key by key: a server only the file names stays
// allowed and one both name takes the profile's identity. Killed by a layer replacing the whole
// table and by the file winning.
#[test]
fn the_forced_requirements_win_over_the_file_key_by_key() {
    let mut merged = toml::Table::new();
    merge_requirements(
        &mut merged,
        toml::from_str(
            r#"
[mcp_servers.docs.identity]
command = "docs-mcp"
[mcp_servers.remote.identity]
url = "https://old.example.com/"
"#,
        )
        .expect("the file is TOML"),
    );
    merge_requirements(
        &mut merged,
        toml::from_str(
            r#"
[mcp_servers.remote.identity]
url = "https://new.example.com/"
"#,
        )
        .expect("the profile's requirements are TOML"),
    );
    let requirements = parse_codex_mcp_requirements(merged)
        .expect("the merge is Codex's shape")
        .expect("the merge sets an allow list");

    assert!(requirements.allows(&user("docs"), Some(&started("docs-mcp"))));
    assert!(requirements.allows(&user("remote"), Some(&reached("https://new.example.com/"))));
    assert!(!requirements.allows(&user("remote"), Some(&reached("https://old.example.com/"))));
}

// Requirements Codex cannot read stop the read as they stop Codex: a file that is not TOML, an
// entry of another shape and a pattern that does not compile. Killed by any of them read as no
// requirements.
#[tokio::test]
async fn unreadable_requirements_fail_the_read() {
    for text in [
        "[mcp_servers.docs",
        "[mcp_servers.docs]\nidentity = 3\n",
        "[mcp_servers.docs.identity]\nurl = { match = \"regex\", expression = \"(\" }\n",
    ] {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        std::fs::write(folder.path().join("requirements.toml"), text)
            .expect("the requirements are written");

        let read = read_codex_mcp_requirements(Some(folder.path())).await;

        assert!(
            matches!(read, Err(CodexError::MachinePolicyUnreadable { .. })),
            "{text:?} is read as requirements"
        );
    }
}
