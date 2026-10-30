use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::json;
use tempfile::TempDir;

use crate::driver::codex::mcp::read_codex_mcp_servers;
use crate::driver::codex::mcp::requirements::CodexRequirementsSources;
use crate::driver::codex::service::command_line::{
    CodexServiceCommandLineInput, compose_codex_service_arguments,
};
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::registry::personal_folder_read::PersonalFolderRead;
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome, home_socket_path};
use crate::driver::codex::service::supervisor::test_service::{
    TestCodexProgram, UnheardEvents, script_codex_service, test_codex_service_dependencies,
};
use crate::driver::codex::service::supervisor::{
    CodexService, CodexServiceDependencies, CodexServiceSocket,
};
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::mcp_server::read::{McpProbeScope, McpServersReadRequest};
use crate::runtime_binding::test_store::test_provider_account_id;

/// The switch every service the daemon starts carries.
const SHARED_UNLOAD: &str = "thread_unload_delay_secs=5";

/// The switch the probe's own service carries after it.
const IMMEDIATE_UNLOAD: &str = "thread_unload_delay_secs=0";

/// How long a read the test expects to settle runs before the test fails instead of hanging.
const READ_WAIT: Duration = Duration::from_secs(10);

/// A registry whose person's own folder holds a service of `kind` on a scripted connection, with
/// their shared dependencies; the folder and script live as long as the value.
struct FolderHolding {
    registry: CodexServiceRegistry,
    on_folder: Arc<CodexService>,
    dependencies: Arc<CodexServiceDependencies>,
    folder: TempDir,
    script: ScriptedService,
}

// The person's own folder holding a scripted service of `kind`. Must be called within a runtime.
fn hold_folder(kind: CodexServiceKind) -> FolderHolding {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        // No test here starts a service, so the program is never run.
        Arc::new(TestCodexProgram {
            program: folder.path().join("codex"),
            environment: Vec::new(),
        }),
        Arc::new(UnheardEvents),
    );
    let home = CodexServiceHome {
        codex_home: folder.path().join("home"),
        kind: CodexHomeKind::PersonalFolder,
    };
    let (on_folder, script) = script_codex_service(
        home.clone(),
        home_socket(&home.codex_home),
        kind,
        Arc::clone(&dependencies),
    );
    let registry =
        CodexServiceRegistry::new(Arc::new(OneHome(home.clone())), Arc::clone(&dependencies));
    registry
        .lock()
        .by_home
        .insert(home.codex_home, Arc::clone(&on_folder));
    FolderHolding {
        registry,
        on_folder,
        dependencies,
        folder,
        script,
    }
}

fn home_socket(codex_home: &Path) -> CodexServiceSocket {
    let socket = home_socket_path(codex_home);
    CodexServiceSocket {
        path: socket.clone(),
        home_socket: socket,
    }
}

// The arguments a launch of `service` runs with past the Codex command.
fn launch_arguments(service: &CodexService) -> Vec<String> {
    compose_codex_service_arguments(&CodexServiceCommandLineInput {
        listen_address: service.listen_address(service.socket_path()),
        additional_config_overrides: service.launch_config_overrides(),
    })
}

// Killed by the probe's own switch missing, written before the shared one (the earlier switch
// loses), or reaching the account and terminal services, whose sessions would unload during a
// quick redial.
#[tokio::test]
async fn only_the_probe_s_own_service_unloads_a_conversation_at_once() {
    let holding = hold_folder(CodexServiceKind::Joined);
    let (account, _account_script) = script_codex_service(
        CodexServiceHome {
            codex_home: holding.folder.path().join("account"),
            kind: CodexHomeKind::Account(test_provider_account_id()),
        },
        home_socket(&holding.folder.path().join("account")),
        CodexServiceKind::Account,
        Arc::clone(&holding.dependencies),
    );
    let (terminal, _terminal_script) = script_codex_service(
        CodexServiceHome {
            codex_home: holding.folder.path().join("terminal"),
            kind: CodexHomeKind::PersonalFolder,
        },
        home_socket(&holding.folder.path().join("terminal")),
        CodexServiceKind::Terminal,
        Arc::clone(&holding.dependencies),
    );
    let probe = holding
        .registry
        .personal_folder_service(PersonalFolderRead::Probe)
        .expect("the probe's service is made");

    let probe_arguments = launch_arguments(&probe.service);
    let position = |switch: &str| {
        probe_arguments
            .iter()
            .position(|argument| argument == switch)
    };

    for shared in [&account, &terminal] {
        let arguments = launch_arguments(shared);
        assert!(
            arguments.iter().any(|argument| argument == SHARED_UNLOAD),
            "{arguments:?}"
        );
        assert!(
            !arguments
                .iter()
                .any(|argument| argument == IMMEDIATE_UNLOAD),
            "{arguments:?}"
        );
    }
    let (Some(shared), Some(immediate)) = (position(SHARED_UNLOAD), position(IMMEDIATE_UNLOAD))
    else {
        panic!("the probe's service lacks a delay switch: {probe_arguments:?}");
    };
    assert!(shared < immediate, "{probe_arguments:?}");
}

// Killed by probing on a joined service, whose unload delay the daemon does not set, by starting
// a second service where the terminal service answers, and by a config read, which starts no
// conversation, passing over the joined service there.
#[rstest]
#[case::a_probe_on_a_terminal_folder(CodexServiceKind::Terminal, PersonalFolderRead::Probe, false)]
#[case::a_probe_on_a_joined_folder(CodexServiceKind::Joined, PersonalFolderRead::Probe, true)]
#[case::a_config_read_on_a_joined_folder(
    CodexServiceKind::Joined,
    PersonalFolderRead::Config,
    false
)]
#[tokio::test]
async fn the_probe_gets_a_service_of_its_own_only_off_the_terminal_service(
    #[case] kind: CodexServiceKind,
    #[case] purpose: PersonalFolderRead,
    #[case] is_transient: bool,
) {
    let holding = hold_folder(kind);

    let probe = holding
        .registry
        .personal_folder_service(purpose)
        .expect("the read's service is chosen");

    assert_eq!(probe.is_transient, is_transient);
    assert_eq!(
        Arc::ptr_eq(&probe.service, &holding.on_folder),
        !is_transient
    );
    if is_transient {
        assert!(probe.service.kind().is_daemons_own());
        assert_ne!(probe.service.socket_path(), holding.on_folder.socket_path());
        let registered = holding.registry.services();
        assert!(
            registered.len() == 1 && Arc::ptr_eq(&registered[0], &holding.on_folder),
            "the probe's service took the folder"
        );
    }
}

// A refresh's read that finds no server to probe reads the config on the joined service there and
// takes no service of its own. Killed by the read taking a probe's service before it knows its
// targets, and by a probe taken with no target: either starts a transient service, whose start
// fails here since the test's program does not exist.
#[tokio::test]
async fn a_probing_read_with_no_target_takes_no_service_of_its_own() {
    let mut holding = hold_folder(CodexServiceKind::Joined);
    let request = McpServersReadRequest {
        attached_roots: Vec::new(),
        provider_account_ids: Vec::new(),
        is_refresh: true,
        probe: McpProbeScope::EveryBinding,
        emulated_local_bindings: Vec::new(),
    };
    // The scratch folder holds no requirements, and the host's own Codex policy is never read.
    let requirements = CodexRequirementsSources {
        managed_settings_folder: Some(holding.folder.path()),
        is_managed_preference_read: false,
    };
    let script = &mut holding.script;
    let answering = async {
        let config_read = script.next_sent().await;
        assert_eq!(config_read["method"], "config/read", "{config_read}");
        script.answer(
            &config_read,
            &json!({"config": {}, "origins": {}, "layers": []}),
        );
    };

    let (reading, ()) = tokio::time::timeout(READ_WAIT, async {
        tokio::join!(
            read_codex_mcp_servers(
                &holding.registry,
                holding.folder.path(),
                requirements,
                &request
            ),
            answering
        )
    })
    .await
    .expect("the read settles");

    let reading = reading.expect("the config read answers on the joined service");
    assert_eq!(reading.probe_readings, Vec::new());
    assert!(
        holding.registry.lock().transient.is_empty(),
        "the read took a service of its own"
    );
    let registered = holding.registry.services();
    assert!(
        registered.len() == 1 && Arc::ptr_eq(&registered[0], &holding.on_folder),
        "the read took the folder"
    );
}
