use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName, McpServerStatus};
use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, CAN_LINK_A_SOCKET, short_socket_folder};

use super::stand_in::{CRASH_WAIT, REQUEST_RECORD_NAME, stand_in_services, this_daemon};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::mcp::machine_probe::{
    CodexMcpProbeSite, CodexProbedServer, CodexProbedServerStart, probe_codex_mcp_servers,
};
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome};
use crate::driver::codex::service::supervisor::test_service::{
    PROBE_THREAD_ID, PROBE_TOOL_NAME, TestCodexProgram, UnheardEvents,
    test_codex_service_dependencies,
};
use crate::driver::mcp_server::status::McpServerReading;

/// The root's emulated server, a person's entry the probe switches on by name.
const LOCAL_SERVER: &str = "docs";

/// A second server, which the root's config loads on its own.
const PROJECT_SERVER: &str = "tracker";

fn server_name(name: &str) -> McpServerName {
    McpServerName::new(name.to_owned()).expect("a test server name is a name")
}

fn root_path(root: &Path) -> FilesystemPath {
    FilesystemPath::new(root.display().to_string()).expect("the root is a path")
}

// The requests the stand-in recorded with `method`.
fn recorded(record: &Path, method: &str) -> Vec<Value> {
    std::fs::read_to_string(record)
        .expect("the stand-in recorded its requests")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("a recorded request is JSON"))
        .filter(|request| request["method"] == method)
        .collect()
}

// Killed by a list without `serverName` (every server of the conversation started again), by a
// conversation that is not ephemeral or does not switch the root's own server on by name, by more
// than one conversation per root, and by a probe service never retired once the read settled.
#[tokio::test(flavor = "multi_thread")]
async fn the_probe_reads_each_server_once_and_retires_its_own_service() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let record = folder.path().join("requests");
    let root = folder.path().join("app");
    std::fs::create_dir_all(&root).expect("the root is made");
    let services = stand_in_services(folder.path(), |mut program| {
        program
            .environment
            .push((REQUEST_RECORD_NAME.to_owned(), record.display().to_string()));
        Arc::new(program)
    });
    let registry = this_daemon(&services);
    let provider = DESCRIPTOR.provider_id();
    let local = McpServerBindingRef::Local {
        provider: provider.clone(),
        scope_ref: root_path(&root),
        place: None,
        server_name: server_name(LOCAL_SERVER),
    };
    let project = McpServerBindingRef::Project {
        provider,
        scope_ref: root_path(&root),
        place: None,
        server_name: server_name(PROJECT_SERVER),
    };
    let site = CodexMcpProbeSite {
        folder: root.clone(),
        servers: vec![
            CodexProbedServer {
                binding: local.clone(),
                start: CodexProbedServerStart::SwitchedOnByName,
                startup_timeout: Duration::from_secs(1),
                is_kept_out: false,
            },
            CodexProbedServer {
                binding: project.clone(),
                start: CodexProbedServerStart::LoadedByProvider,
                startup_timeout: Duration::from_secs(1),
                is_kept_out: false,
            },
        ],
        switched_off_names: Vec::new(),
    };

    let readings = probe_codex_mcp_servers(&registry, std::slice::from_ref(&site))
        .await
        .expect("the probe reads");

    let [started] = recorded(&record, "thread/start")
        .try_into()
        .expect("one conversation per root");
    let params = &started["params"];
    assert_eq!(params["ephemeral"], json!(true), "{params}");
    assert_eq!(params["cwd"], json!(root.display().to_string()), "{params}");
    assert_eq!(
        params["config"]["mcp_servers"],
        json!({LOCAL_SERVER: {"enabled": true}}),
        "{params}"
    );
    let lists = recorded(&record, "mcpServerStatus/list");
    let listed: Vec<&Value> = lists
        .iter()
        .map(|request| &request["params"]["serverName"])
        .collect();
    assert_eq!(listed, [LOCAL_SERVER, PROJECT_SERVER], "{lists:?}");
    for request in &lists {
        assert_eq!(request["params"]["threadId"], PROBE_THREAD_ID, "{request}");
        assert_eq!(request["params"]["detail"], "toolsAndAuthOnly", "{request}");
    }
    let [local_reading, project_reading] = readings.as_slice() else {
        panic!("one reading per probed server");
    };
    assert_eq!(local_reading.binding, local);
    assert_eq!(
        local_reading.reading,
        McpServerReading::Observed(McpServerStatus::Connected)
    );
    assert_eq!(project_reading.binding, project);
    for reading in &readings {
        let tools: Vec<&str> = reading
            .tool_names
            .iter()
            .map(|name| name.as_str())
            .collect();
        assert_eq!(tools, [PROBE_TOOL_NAME]);
    }
    // The retire waits until the service is free on the driver's tasks, so its end is watched.
    let retired = tokio::time::timeout(CRASH_WAIT, async {
        while !registry.lock().transient.is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(retired.is_ok(), "the probe's own service was not retired");
}

// The live probe: on the downloaded Codex build `SIDEKICKS_TEST_CODEX_PROGRAM` names, a person's
// server switched off in their config is switched on by name in one ephemeral conversation, which
// tries to start it and reports the failure of a program that does not exist, and the probe's own
// service is retired once the read settles. Killed by a conversation that never starts the server
// (it reads starting at the ceiling) and by a service left running.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a downloaded Codex release"]
async fn a_live_probe_starts_a_switched_off_server_in_an_ephemeral_conversation() {
    let program = std::env::var_os("SIDEKICKS_TEST_CODEX_PROGRAM")
        .expect("SIDEKICKS_TEST_CODEX_PROGRAM names the downloaded Codex program");
    let folder = short_socket_folder().expect("a scratch folder is made");
    let codex_home = folder.path().join("home");
    std::fs::create_dir_all(&codex_home).expect("the home is made");
    std::fs::write(
        codex_home.join("config.toml"),
        format!(
            "[mcp_servers.{LOCAL_SERVER}]\ncommand = \"{}\"\nenabled = false\n\
             startup_timeout_sec = 5\n",
            folder.path().join("absent-mcp-server").display()
        ),
    )
    .expect("the config is written");
    let environment = ["HOME", "PATH"]
        .into_iter()
        .filter_map(|name| Some((name.to_owned(), std::env::var(name).ok()?)))
        .collect();
    let home = CodexServiceHome {
        codex_home,
        kind: CodexHomeKind::PersonalFolder,
    };
    let registry = CodexServiceRegistry::new(
        Arc::new(OneHome(home)),
        test_codex_service_dependencies(
            folder.path(),
            Arc::new(TestCodexProgram {
                program: PathBuf::from(program),
                environment,
            }),
            Arc::new(UnheardEvents),
        ),
    );
    let local = McpServerBindingRef::Local {
        provider: DESCRIPTOR.provider_id(),
        scope_ref: root_path(folder.path()),
        place: None,
        server_name: server_name(LOCAL_SERVER),
    };
    let site = CodexMcpProbeSite {
        folder: folder.path().to_path_buf(),
        servers: vec![CodexProbedServer {
            binding: local.clone(),
            start: CodexProbedServerStart::SwitchedOnByName,
            startup_timeout: Duration::from_secs(5),
            is_kept_out: false,
        }],
        switched_off_names: Vec::new(),
    };

    let readings = probe_codex_mcp_servers(&registry, std::slice::from_ref(&site))
        .await
        .expect("the probe reads");

    let [reading] = readings.as_slice() else {
        panic!("one reading");
    };
    assert_eq!(reading.binding, local);
    assert_eq!(
        reading.reading,
        McpServerReading::Observed(McpServerStatus::Failed)
    );
    assert!(
        reading.failure_text.is_some(),
        "the startup's error is kept"
    );
    let retired = tokio::time::timeout(CRASH_WAIT, async {
        while !registry.lock().transient.is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(retired.is_ok(), "the probe's own service was not retired");
}
