use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{
    McpApprovalMode, McpServerBindingRef, McpServerName, McpServerStatus,
};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::plugin::PluginToken;
use tokio::time::Instant;

use super::{
    CodexMcpProbeSite, CodexProbedServer, CodexProbedServerStart, codex_probe_targets,
    compose_probe_overrides, plan_codex_mcp_probe, probe_site,
};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::mcp::config::{CodexLoadedServer, CodexMcpConfigReading, CodexMcpRoot};
use crate::driver::codex::session::detached_conversation::CodexDetachedFrames;
use crate::driver::codex::transport::connection::CodexConnectionHandlers;
use crate::driver::codex::transport::connection::scripted_service::connect_scripted_service;
use crate::driver::mcp_server::read::{
    McpProbeScope, McpProbeStart, McpProbeTarget, McpRootReading, McpServerDeclaration,
    McpServerPolicy, McpServerToolDefaults, McpServersReadRequest,
};
use crate::driver::mcp_server::status::McpServerReading;

/// The largest message the scripted connection takes, far above any a test sends.
const MESSAGE_LIMIT: usize = 1 << 20;

/// The conversation the scripted service opens.
const THREAD: &str = "probe-thread";

fn user(name: &str) -> McpServerBindingRef {
    McpServerBindingRef::User {
        provider: DESCRIPTOR.provider_id(),
        server_name: McpServerName::new(name.to_owned()).expect("a test server name is a name"),
    }
}

fn probed(name: &str, startup_seconds: u64) -> CodexProbedServer {
    CodexProbedServer {
        binding: user(name),
        start: CodexProbedServerStart::LoadedByProvider,
        startup_timeout: Duration::from_secs(startup_seconds),
        is_kept_out: false,
    }
}

// One `mcpServerStatus/list` reply: the server in `runtime_status`.
fn listed(name: &Value, runtime_status: &str) -> Value {
    json!({"data": [{
        "name": name,
        "authStatus": "unsupported",
        "runtimeStatus": runtime_status,
        "tools": {},
        "resources": [],
        "resourceTemplates": [],
    }], "nextCursor": null})
}

// Killed by waiting past the longest startup timeout plus the margin, by a fixed ceiling in place
// of one from the servers' timeouts, by reading an unsettled server as anything but its list's
// status, by dropping a startup failure's text, and by leaving on a plugin of the person's own,
// by its key or by the default every other takes.
#[tokio::test(start_paused = true)]
async fn a_server_unsettled_at_the_ceiling_reads_its_listed_status() {
    let (events, frames) = CodexDetachedFrames::new();
    let (connection, mut script) = connect_scripted_service(
        MESSAGE_LIMIT,
        CodexConnectionHandlers {
            events,
            responder: None,
        },
    );
    let site = CodexMcpProbeSite {
        folder: PathBuf::from("/work/app"),
        servers: vec![probed("broken", 7), probed("slow", 12)],
        switched_off_names: vec![McpServerName::new("idle".to_owned()).expect("a name")],
        switched_off_plugin_keys: vec!["notes@market".to_owned()],
    };
    let began = Instant::now();
    let answering = async {
        let start = script.next_sent().await;
        assert_eq!(start["method"], "thread/start");
        assert_eq!(start["params"]["ephemeral"], json!(true));
        assert_eq!(
            start["params"]["config"]["mcp_servers"],
            json!({"idle": {"enabled": false}})
        );
        assert_eq!(
            start["params"]["config"]["plugins"],
            json!({"_default": {"enabled": false}, "notes@market": {"enabled": false}})
        );
        script.answer(
            &start,
            &json!({"thread": {"id": THREAD, "sessionId": "session-1"}}),
        );
        script.send(
            &json!({"jsonrpc": "2.0", "method": "mcpServer/startupStatus/updated",
            "params": {"threadId": THREAD, "name": "broken", "status": "failed",
                "error": "handshake refused"}}),
        );
        let mut waited = Vec::new();
        for _ in 0..2 {
            let list = script.next_sent().await;
            assert_eq!(list["method"], "mcpServerStatus/list");
            assert_eq!(list["params"]["threadId"], THREAD);
            waited.push(began.elapsed());
            let status = if list["params"]["serverName"] == "slow" {
                "starting"
            } else {
                "failed"
            };
            script.answer(&list, &listed(&list["params"]["serverName"], status));
        }
        waited
    };

    let (readings, waited) = tokio::join!(probe_site(connection, frames, &site), answering);

    // The longer of the two timeouts, 12 s, and the 5 s margin.
    let ceiling = Duration::from_secs(17);
    assert!(
        waited
            .iter()
            .all(|elapsed| *elapsed >= ceiling && *elapsed < ceiling + Duration::from_secs(1)),
        "{waited:?}"
    );
    let readings = readings.expect("the probe reads");
    let [broken, slow] = readings.as_slice() else {
        panic!("one reading per server");
    };
    assert_eq!(
        broken.reading,
        McpServerReading::Observed(McpServerStatus::Failed)
    );
    assert_eq!(broken.failure_text.as_deref(), Some("handshake refused"));
    assert_eq!(
        slow.reading,
        McpServerReading::Observed(McpServerStatus::Starting)
    );
    assert_eq!(slow.failure_text, None);
}

fn attached_root(path: &str) -> CodexMcpRoot {
    CodexMcpRoot {
        root: PlacedPath {
            path: FilesystemPath::new(path.to_owned()).expect("the root is a path"),
            place: None,
        },
        folder: PathBuf::from(path),
    }
}

// A stored `local` binding served from the person's entry of its name, off by default, is probed
// at its own root, switched on by name, in place of that entry, under every binding and under a
// scope naming it. Killed by the emulated binding left unprobed (its row stays `unknown`), by it
// probed at the first root, and by the person's entry probed beside it.
#[test]
fn an_emulated_local_binding_is_probed_at_its_root_in_place_of_the_persons_entry() {
    let roots = [attached_root("/work/first"), attached_root("/work/app")];
    let local = McpServerBindingRef::Local {
        provider: DESCRIPTOR.provider_id(),
        scope_ref: roots[1].root.path.clone(),
        place: None,
        server_name: McpServerName::new("docs".to_owned()).expect("a name"),
    };
    let reading = CodexMcpConfigReading {
        declarations: vec![McpServerDeclaration {
            binding: user("docs"),
            config: McpServerConfigView::Stdio {
                command: "docs-mcp".to_owned(),
                args: None,
                env_var_names: None,
                enabled: Some(false),
                required: None,
                startup_timeout_sec: None,
                tool_timeout_sec: None,
            },
            superseded_in: Vec::new(),
            disabled_in: Vec::new(),
            is_read_only: false,
            sign_in_client: None,
            is_switch_kept_by_daemon: false,
            tool_defaults: McpServerToolDefaults::with_approval_mode(McpApprovalMode::Auto),
            organization_managed: None,
        }],
        roots: roots
            .iter()
            .map(|root| McpRootReading {
                root: root.root.clone(),
                kept_out_server_names: Vec::new(),
                provider_loaded: Vec::new(),
            })
            .collect(),
        is_machine_managed: false,
        server_policy: McpServerPolicy::default(),
        transports: Vec::new(),
        plugin_keys: Vec::new(),
        home_kept_out_server_names: Vec::new(),
        refused_when_sent: Vec::new(),
        loaded_servers: Vec::new(),
        person_plugin_keys: Vec::new(),
    };

    for probe in [
        McpProbeScope::EveryBinding,
        McpProbeScope::Bindings(vec![local.clone()]),
    ] {
        let request = McpServersReadRequest {
            attached_roots: roots.iter().map(|root| root.root.clone()).collect(),
            provider_account_ids: Vec::new(),
            is_refresh: true,
            probe,
            emulated_local_bindings: vec![local.clone()],
        };

        let targets = codex_probe_targets(&reading.declarations, &request);
        let sites =
            plan_codex_mcp_probe(&targets, &reading, &roots, Path::new("/home/person"), &[]);

        assert_eq!(
            targets,
            [McpProbeTarget {
                binding: local.clone(),
                start: McpProbeStart::SwitchedOnByName,
            }]
        );
        let [site] = sites.as_slice() else {
            panic!("one conversation");
        };
        assert_eq!(site.folder, roots[1].folder);
        let [server] = site.servers.as_slice() else {
            panic!("one server");
        };
        assert_eq!(server.binding, local);
        assert_eq!(
            compose_probe_overrides(site)["mcp_servers"],
            json!({"docs": {"enabled": true}})
        );
    }
}

fn declared(binding: McpServerBindingRef, enabled: Option<bool>) -> McpServerDeclaration {
    McpServerDeclaration {
        binding,
        config: McpServerConfigView::Stdio {
            command: "server".to_owned(),
            args: None,
            env_var_names: None,
            enabled,
            required: None,
            startup_timeout_sec: None,
            tool_timeout_sec: None,
        },
        superseded_in: Vec::new(),
        disabled_in: Vec::new(),
        is_read_only: false,
        sign_in_client: None,
        is_switch_kept_by_daemon: false,
        tool_defaults: McpServerToolDefaults::with_approval_mode(McpApprovalMode::Auto),
        organization_managed: None,
    }
}

fn project_at(root: &CodexMcpRoot, name: &str) -> McpServerBindingRef {
    McpServerBindingRef::Project {
        provider: DESCRIPTOR.provider_id(),
        scope_ref: root.root.path.clone(),
        place: None,
        server_name: McpServerName::new(name.to_owned()).expect("a name"),
    }
}

// A person's server is probed where it is the one loaded, starting as that place's own merge has
// it: `docs`, which the first root's project re-declares, at the second root, loaded by Codex;
// `notes`, which the first root's project switches off, at the first root, switched on by name;
// `pages`, which every root re-declares, at the person's home folder. Killed by probing a server
// at the first root whatever it loads there, by deciding its start from another place's merge,
// and by never probing at the home folder once a root is attached.
#[test]
fn a_persons_server_is_probed_where_it_is_loaded_as_that_place_merges_it() {
    let roots = [attached_root("/work/first"), attached_root("/work/second")];
    let loaded = |root: &CodexMcpRoot, binding: McpServerBindingRef, is_switched_on: bool| {
        CodexLoadedServer {
            root: Some(root.root.clone()),
            binding,
            is_switched_on,
        }
    };
    let reading = CodexMcpConfigReading {
        declarations: vec![
            declared(user("docs"), None),
            declared(user("notes"), None),
            declared(user("pages"), Some(false)),
            declared(project_at(&roots[0], "docs"), None),
            declared(project_at(&roots[0], "pages"), None),
            declared(project_at(&roots[1], "pages"), None),
        ],
        roots: roots
            .iter()
            .map(|root| McpRootReading {
                root: root.root.clone(),
                kept_out_server_names: Vec::new(),
                provider_loaded: Vec::new(),
            })
            .collect(),
        is_machine_managed: false,
        server_policy: McpServerPolicy::default(),
        transports: Vec::new(),
        plugin_keys: Vec::new(),
        home_kept_out_server_names: Vec::new(),
        refused_when_sent: Vec::new(),
        loaded_servers: vec![
            loaded(&roots[0], project_at(&roots[0], "docs"), true),
            loaded(&roots[0], user("notes"), false),
            loaded(&roots[0], project_at(&roots[0], "pages"), true),
            loaded(&roots[1], user("docs"), true),
            loaded(&roots[1], user("notes"), true),
            loaded(&roots[1], project_at(&roots[1], "pages"), true),
        ],
        person_plugin_keys: Vec::new(),
    };
    let request = McpServersReadRequest {
        attached_roots: roots.iter().map(|root| root.root.clone()).collect(),
        provider_account_ids: Vec::new(),
        is_refresh: true,
        probe: McpProbeScope::Bindings(vec![user("docs"), user("notes"), user("pages")]),
        emulated_local_bindings: Vec::new(),
    };

    let targets = codex_probe_targets(&reading.declarations, &request);
    let sites = plan_codex_mcp_probe(&targets, &reading, &roots, Path::new("/home/person"), &[]);

    let planned: Vec<(PathBuf, Vec<(McpServerBindingRef, bool)>)> = sites
        .iter()
        .map(|site| {
            let servers = site
                .servers
                .iter()
                .map(|server| {
                    let is_switched_on_by_name =
                        matches!(server.start, CodexProbedServerStart::SwitchedOnByName);
                    (server.binding.clone(), is_switched_on_by_name)
                })
                .collect();
            (site.folder.clone(), servers)
        })
        .collect();
    assert_eq!(
        planned,
        [
            (roots[0].folder.clone(), vec![(user("notes"), true)]),
            (roots[1].folder.clone(), vec![(user("docs"), false)]),
            (PathBuf::from("/home/person"), vec![(user("pages"), true)]),
        ]
    );
}

// A plugin's server the requirements refuse as the probe would send it is never sent, never
// waited for and never listed: it reads switched off at once. Killed by sending the refused entry,
// by waiting the ceiling for it, and by asking Codex its status.
#[tokio::test(start_paused = true)]
async fn a_refused_plugin_server_is_not_sent_and_reads_switched_off_at_once() {
    let (events, frames) = CodexDetachedFrames::new();
    let (connection, mut script) = connect_scripted_service(
        MESSAGE_LIMIT,
        CodexConnectionHandlers {
            events,
            responder: None,
        },
    );
    let refused = McpServerBindingRef::Plugin {
        provider: DESCRIPTOR.provider_id(),
        scope_ref: PluginToken::new("tools".to_owned()).expect("a plugin name"),
        server_name: McpServerName::new("search".to_owned()).expect("a name"),
    };
    let site = CodexMcpProbeSite {
        folder: PathBuf::from("/work/app"),
        servers: vec![CodexProbedServer {
            binding: refused.clone(),
            start: CodexProbedServerStart::Sent(serde_json::Map::from_iter([(
                "command".to_owned(),
                json!("search-server"),
            )])),
            startup_timeout: Duration::from_secs(30),
            is_kept_out: true,
        }],
        switched_off_names: Vec::new(),
        switched_off_plugin_keys: Vec::new(),
    };
    let began = Instant::now();
    let answering = async {
        let start = script.next_sent().await;
        assert_eq!(start["method"], "thread/start");
        assert_eq!(start["params"]["config"]["mcp_servers"], json!({}));
        script.answer(
            &start,
            &json!({"thread": {"id": THREAD, "sessionId": "session-1"}}),
        );
    };

    let (readings, ()) = tokio::join!(probe_site(connection, frames, &site), answering);

    assert!(began.elapsed() < Duration::from_secs(1), "the probe waited");
    let readings = readings.expect("the probe reads without a list");
    let [reading] = readings.as_slice() else {
        panic!("one reading");
    };
    assert_eq!(reading.binding, refused);
    assert_eq!(reading.reading, McpServerReading::SwitchedOff);
}
