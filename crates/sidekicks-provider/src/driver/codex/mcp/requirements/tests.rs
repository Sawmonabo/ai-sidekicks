use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{McpApprovalMode, McpServerBindingRef, McpServerName};
use sidekicks_contracts::place::PlacedPath;

use super::read_codex_mcp_requirements;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::mcp::config::CodexMcpConfigReading;
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
// kept-out names, by a named server whose transport the entry does not match left in, and by a
// project server of another root counted at this one.
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
    let provider = DESCRIPTOR.provider_id();
    let root = PlacedPath {
        path: FilesystemPath::new(ROOT.to_owned()).expect("the root is a path"),
        place: None,
    };
    let project_at = |path: &str, name: &str| McpServerBindingRef::Project {
        provider: provider.clone(),
        scope_ref: FilesystemPath::new(path.to_owned()).expect("a path"),
        place: None,
        server_name: server_name(name),
    };
    let user = |name: &str| McpServerBindingRef::User {
        provider: provider.clone(),
        server_name: server_name(name),
    };
    let mut reading = CodexMcpConfigReading {
        declarations: vec![
            declared(user("docs"), program("docs-mcp")),
            declared(user("notes"), program("notes-mcp")),
            declared(user("remote"), address("https://mcp.example.com/v2")),
            declared(project_at(ROOT, "tracker"), program("tracker-mcp")),
            declared(project_at("/work/other", "elsewhere"), program("x")),
        ],
        roots: vec![McpRootReading {
            root,
            kept_out_server_names: Vec::new(),
            provider_loaded: Vec::new(),
        }],
        is_machine_managed: false,
        server_policy: McpServerPolicy::default(),
    };

    read_codex_mcp_requirements(Some(folder.path()))
        .await
        .expect("the file sets an allow list")
        .apply(&mut reading);

    assert_eq!(
        reading.server_policy.allowed,
        Some(vec![
            McpServerPolicyEntry::ServerName(server_name("docs")),
            McpServerPolicyEntry::ServerName(server_name("remote")),
        ])
    );
    assert!(reading.server_policy.denied.is_empty());
    assert_eq!(
        reading.roots[0].kept_out_server_names,
        [
            server_name("notes"),
            server_name("remote"),
            server_name("tracker")
        ]
    );
}
