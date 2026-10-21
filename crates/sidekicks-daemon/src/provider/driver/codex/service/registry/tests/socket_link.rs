use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_platforms::{
    RunningProgramPath, read_running_program_path, read_socket_link, replace_socket_link,
};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::OneHome;
use crate::provider::driver::codex::service::command_line::{
    CodexHookCommands, compose_daemon_hook_commands,
};
use crate::provider::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::provider::driver::codex::service::registry::{CodexServiceRegistry, home_socket_path};
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::service::supervisor::events::{
    CodexServiceEvents, CodexServiceRecoveryCause,
};
use crate::provider::driver::codex::service::supervisor::test_service::{
    TestCodexProgram, test_codex_service_dependencies,
};
use crate::provider::driver::contract::DaemonStopIntent;

/// The stand-in Codex service: this test program, run by the script the registry's services
/// start as Codex.
const APP_SERVER_STAND_IN: &str =
    "provider::driver::codex::service::registry::tests::socket_link::an_app_server_stand_in";

/// The address the stand-in listens on, as its `--listen` names it; only its script sets it.
const LISTEN_ADDRESS_NAME: &str = "SIDEKICKS_TEST_LISTEN_ADDRESS";

/// The Codex home the stand-in serves, as Codex reads it.
const CODEX_HOME_NAME: &str = "CODEX_HOME";

/// How long the test waits on a crash to be heard.
const CRASH_WAIT: Duration = Duration::from_secs(10);

// Listens as Codex does: on a real socket of its own, with the path it was given made a link to
// it, answering the daemon's start. Skips unless the planned-restart test's script started it.
#[tokio::test]
#[ignore = "run only as the planned-restart test's Codex service"]
async fn an_app_server_stand_in() {
    let Ok(address) = std::env::var(LISTEN_ADDRESS_NAME) else {
        return;
    };
    let codex_home = PathBuf::from(std::env::var(CODEX_HOME_NAME).expect("the home is named"));
    let link = match address.strip_prefix("unix://").expect("a socket address") {
        "" => home_socket_path(&codex_home),
        path => PathBuf::from(path),
    };
    std::fs::create_dir_all(link.parent().expect("the link has a folder"))
        .expect("the link's folder is made");
    let real_socket = codex_home.join(format!("real-{}.sock", std::process::id()));
    let listener = UnixListener::bind(&real_socket).expect("the real socket listens");
    replace_socket_link(&link, &real_socket).expect("the link names the real socket");
    let RunningProgramPath::OnDisk(program) =
        read_running_program_path().expect("the program reads")
    else {
        panic!("the test program was replaced");
    };
    let hooks = Arc::new(compose_daemon_hook_commands(&program).expect("the hooks compose"));
    while let Ok((stream, _address)) = listener.accept().await {
        tokio::spawn(serve(stream, Arc::clone(&hooks)));
    }
}

// Answers one connection's requests as far as a start needs: the version, the daemon's hooks as
// trusted, and no loaded conversation.
async fn serve(stream: UnixStream, hooks: Arc<CodexHookCommands>) {
    // A probe that only connects ends before the upgrade.
    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    while let Some(Ok(message)) = socket.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let request: Value = serde_json::from_str(&text).expect("the daemon sends JSON");
        if request.get("id").is_none() {
            continue;
        }
        let result = match request["method"].as_str() {
            Some("initialize") => json!({"userAgent": "ai-sidekicks-daemon/0.130.0 (test)"}),
            Some("hooks/list") => json!({"data": [{"hooks": [
                listed_hook("preToolUse", &hooks.pre_tool_use),
                listed_hook("postToolUse", &hooks.post_tool_use),
            ]}]}),
            Some("thread/loaded/list") => json!({"data": []}),
            _ => json!({}),
        };
        let reply = json!({"id": request["id"], "result": result});
        if socket
            .send(Message::Text(reply.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    }
}

fn listed_hook(event_name: &str, command: &str) -> Value {
    json!({"source": "sessionFlags", "eventName": event_name, "command": command,
        "key": event_name, "currentHash": "hash", "trustStatus": "trusted"})
}

// Tells the test each time a service's process ends on its own.
struct ExitsHeard(mpsc::UnboundedSender<()>);

impl CodexServiceEvents for ExitsHeard {
    fn process_exited(&self, _service: &Arc<CodexService>, _exit: Option<&ProcessExit>) {
        let _heard = self.0.send(());
    }

    fn recovered(&self, _service: &Arc<CodexService>, _cause: CodexServiceRecoveryCause) {}

    fn crash_loop(&self, _service: &Arc<CodexService>) {}

    fn planned_restart_requested(&self, _service: &Arc<CodexService>) {}
}

// The script the services start as Codex: it hands the stand-in the address its `--listen` names.
fn write_stand_in_script(folder: &Path) -> PathBuf {
    let program = std::env::current_exe().expect("the test program names itself");
    let script = folder.join("codex");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = --listen ]; then \
             {LISTEN_ADDRESS_NAME}=\"$2\"; export {LISTEN_ADDRESS_NAME}; fi\n  shift\ndone\n\
             exec '{}' --exact {APP_SERVER_STAND_IN} --include-ignored >/dev/null 2>&1\n",
            program.display()
        ),
    )
    .expect("the script is written");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
        .expect("the script runs");
    script
}

// Fails when a planned restart leaves the home's socket on the first service, when the first's
// stop clears the link the second now holds, or when a crash leaves the link naming the socket
// its ended process listened on.
#[tokio::test(flavor = "multi_thread")]
async fn the_home_socket_follows_the_service_that_holds_it() {
    // The home's socket path must fit the system's bound on socket paths.
    let folder = tempfile::tempdir_in("/tmp").expect("a scratch folder is made");
    let codex_home = folder.path().join("home");
    std::fs::create_dir_all(&codex_home).expect("the home is made");
    let (exits, mut exits_heard) = mpsc::unbounded_channel();
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::new(TestCodexProgram {
            program: write_stand_in_script(folder.path()),
            environment: vec![(CODEX_HOME_NAME.to_owned(), codex_home.display().to_string())],
        }),
        Arc::new(ExitsHeard(exits)),
    );
    let startup_timeout = dependencies.startup_timeout;
    let registry = CodexServiceRegistry::new(
        Arc::new(OneHome(CodexServiceHome {
            codex_home: codex_home.clone(),
            provider_account_id: None,
            kind: CodexHomeKind::PersonalFolder {
                is_terminal_reach_on: true,
            },
        })),
        dependencies,
    );
    let home_socket = home_socket_path(&codex_home);
    let first = registry.service_for(None).await.expect("the home resolves");
    first
        .ensure_started(startup_timeout)
        .await
        .expect("the first service starts");

    let second = registry.replace(&first).await.expect("the second starts");
    let first_socket = first.physical_socket();
    let second_socket = second.physical_socket();
    let after_restart = read_socket_link(&home_socket).expect("the link reads");
    registry.retire(&first).await;
    let after_retire = read_socket_link(&home_socket).expect("the link reads");
    let second_process = second.process_id().expect("the second runs a process");
    let killed = std::process::Command::new("/bin/kill")
        .args(["-KILL", &second_process.to_string()])
        .status()
        .expect("kill runs");
    let crash_heard = tokio::time::timeout(CRASH_WAIT, exits_heard.recv()).await;
    let is_link_left = std::fs::symlink_metadata(&home_socket).is_ok();
    registry.shutdown(DaemonStopIntent::Stop).await;

    assert!(second_socket.is_some());
    assert_ne!(second_socket, first_socket);
    assert_eq!(after_restart, second_socket);
    assert_eq!(after_retire, second_socket);
    assert!(killed.success());
    assert!(
        matches!(crash_heard, Ok(Some(()))),
        "the crash was not heard"
    );
    assert!(
        !is_link_left,
        "the link still names the ended process's socket"
    );
}
