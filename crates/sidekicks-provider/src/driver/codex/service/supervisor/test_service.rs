//! What a test's Codex services run on: their shared dependencies, a program a test names, a
//! listener's answers as a Codex service gives them, and a service whose connection a test
//! scripts, a service of the daemon's own kind published as up and holding a connection on a
//! `ScriptedService`, its frames and asks routed as a dialed one's are.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::{SinkExt as _, StreamExt as _};
use interprocess::local_socket::tokio::Listener;
use serde_json::{Value, json};
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_ipc::caller_process::provider_services::ProviderServiceProcesses;
use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, ProgramStart, Spawner, StandInAnswer, StandInProgram,
    bind_socket_listener, write_stand_in_program,
};
use tempfile::TempDir;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::task::TaskTracker;

use crate::driver::codex::lifecycle::CODEX_SERVICE_STARTUP_TIMEOUT;
use crate::driver::codex::service::command_line::{
    TerminalServiceHooks, read_terminal_service_hooks,
};
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::supervisor::drain::LastingServiceDrains;
use crate::driver::codex::service::supervisor::events::{
    CodexServiceEvents, CodexServiceRecoveryCause,
};
use crate::driver::codex::service::supervisor::transition::CodexServiceAvailability;
use crate::driver::codex::service::supervisor::{
    CodexProgramResolver, CodexService, CodexServiceDependencies, CodexServiceSocket,
};
use crate::driver::codex::session::conversation_release::CodexConversationRelease;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::codex::transport::connection::scripted_service::{
    ScriptedService, connect_scripted_service,
};
use crate::driver::contract::DriverError;
use crate::process_identity::ProviderProcessIdentity;
use crate::process_registry::ProviderProcessRegistry;
use crate::spawned_version::{
    ResolvedProviderExecutable, SpawnedProviderVersionReading, parse_cli_version_report,
};

/// Whether the test services' daemon runs the hook mode a hook command starts: the tests' program
/// runs none, so a terminal service starts, and is answered, with no hooks.
const TEST_DISPATCHES_HOOK_MODE: bool = false;

/// The largest message the scripted service takes, far above any a test sends.
const SCRIPTED_MESSAGE_LIMIT: usize = 1 << 20;

/// The scripted connection's ticket, which routes its frames.
const SCRIPTED_DIAL: u64 = 1;

/// A service on a scripted connection, the folder its home names, and the script.
pub(crate) struct ScriptedCodexService {
    /// The service.
    pub(crate) service: Arc<CodexService>,
    /// What its connection sent, and what the service sends it.
    pub(crate) script: ScriptedService,
    /// What the service runs on, the conversations its sessions moved off among them.
    pub(crate) dependencies: Arc<CodexServiceDependencies>,
    _folder: TempDir,
}

impl ScriptedCodexService {
    /// Publishes the service reconnecting, its connection set aside until [`Self::publish_up`]
    /// hands it back.
    pub(crate) fn publish_reconnecting(&self) -> Option<Arc<CodexAppServerConnection>> {
        let connection = self.service.lock_live().connection.take();
        self.service
            .availability
            .send_replace(CodexServiceAvailability::Reconnecting);
        connection
    }

    /// Records `raw` as the version the running service reported at its connect.
    pub(crate) fn report_version(&self, raw: &str) {
        self.service.lock_live().version = Some(SpawnedProviderVersionReading {
            resolved_executable_path: PathBuf::from("/opt/codex/bin/codex"),
            report: parse_cli_version_report(raw),
        });
    }

    /// Records `process_id` as the process the daemon started for the service, its spawn
    /// sequence drawn now as a pin draws it.
    pub(crate) fn report_process(&self, process_id: u32) {
        self.service.lock_live().process = Some(ProviderProcessIdentity {
            process_id,
            spawn_sequence: self.dependencies.processes.mint_spawn_sequence(),
        });
    }

    /// The next request the service's connection sent, which must be `method`.
    pub(crate) async fn next_request(&mut self, method: &str) -> Value {
        let request = self.script.next_sent().await;
        assert_eq!(request["method"], method, "{request}");
        request
    }

    /// Publishes the service up again on `connection`.
    pub(crate) fn publish_up(&self, connection: Option<Arc<CodexAppServerConnection>>) {
        self.service.lock_live().connection = connection;
        self.service
            .availability
            .send_replace(CodexServiceAvailability::Up);
    }
}

/// The dependencies a test's services share: their data and logs under `folder`, the build
/// `program` resolves, and `events` told what happens to them. Must be called within a runtime.
pub(crate) fn test_codex_service_dependencies(
    folder: &Path,
    program: Arc<dyn CodexProgramResolver>,
    events: Arc<dyn CodexServiceEvents>,
) -> Arc<CodexServiceDependencies> {
    // The daemon makes both before any service starts.
    for made in ["data", "logs"] {
        std::fs::create_dir_all(folder.join(made)).expect("a service folder is made");
    }
    Arc::new(CodexServiceDependencies {
        spawner: Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts"),
        provider_services: Arc::new(ProviderServiceProcesses::default()),
        processes: Arc::new(ProviderProcessRegistry::default()),
        program,
        data_folder: folder.join("data"),
        logs_folder: folder.join("logs"),
        additional_config_overrides: Vec::new(),
        startup_timeout: CODEX_SERVICE_STARTUP_TIMEOUT,
        dispatches_hook_mode: TEST_DISPATCHES_HOOK_MODE,
        events,
        release: Arc::new(CodexConversationRelease::default()),
        drains: LastingServiceDrains::default(),
        tasks: TaskTracker::new(),
    })
}

/// The program a test names, run as the Codex build with `environment` its whole environment.
pub(crate) struct TestCodexProgram {
    /// The program.
    pub(crate) program: PathBuf,
    /// Its environment.
    pub(crate) environment: Vec<(String, String)>,
}

impl CodexProgramResolver for TestCodexProgram {
    fn resolve<'call>(
        &'call self,
        _home: &'call CodexServiceHome,
    ) -> BoxFuture<'call, Result<ResolvedProviderExecutable, DriverError>> {
        let resolved = ResolvedProviderExecutable {
            requested_command: "codex".to_owned(),
            resolved_executable_path: self.program.clone(),
            start: ProgramStart {
                program: self.program.clone(),
                leading_arguments: Vec::new(),
            },
            environment: self.environment.clone(),
        };
        Box::pin(async move { Ok(resolved) })
    }
}

/// Starts a service on an account's home whose connection the test scripts. Must be called within
/// a runtime.
pub(crate) fn start_scripted_codex_service() -> ScriptedCodexService {
    start_scripted_codex_service_on(CodexHomeKind::Account, CodexServiceKind::Account)
}

/// Starts the terminal service on the person's own folder with terminal reach on, its connection
/// scripted by the test. Must be called within a runtime.
pub(crate) fn start_scripted_terminal_service() -> ScriptedCodexService {
    start_scripted_codex_service_on(
        CodexHomeKind::PersonalFolder {
            is_terminal_reach_on: true,
        },
        CodexServiceKind::Terminal,
    )
}

// A service of `kind` on a home of `home_kind` whose connection the test scripts.
fn start_scripted_codex_service_on(
    home_kind: CodexHomeKind,
    kind: CodexServiceKind,
) -> ScriptedCodexService {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::new(UnstartedProgram),
        Arc::new(UnheardEvents),
    );
    let socket: PathBuf = folder.path().join("codex.sock");
    let (service, script) = script_codex_service(
        CodexServiceHome {
            codex_home: folder.path().join("home"),
            provider_account_id: None,
            kind: home_kind,
        },
        CodexServiceSocket {
            path: socket.clone(),
            home_socket: socket,
        },
        kind,
        Arc::clone(&dependencies),
    );
    ScriptedCodexService {
        service,
        script,
        dependencies,
        _folder: folder,
    }
}

/// A service of `kind` on `home` and `socket`, published as up on a connection the test scripts,
/// with the script. Must be called within a runtime.
pub(crate) fn script_codex_service(
    home: CodexServiceHome,
    socket: CodexServiceSocket,
    kind: CodexServiceKind,
    dependencies: Arc<CodexServiceDependencies>,
) -> (Arc<CodexService>, ScriptedService) {
    let service = CodexService::new(home, socket, kind, dependencies);
    let (connection, script) = connect_scripted_service(
        SCRIPTED_MESSAGE_LIMIT,
        service.connection_handlers(SCRIPTED_DIAL),
    );
    service.routed_dial.store(SCRIPTED_DIAL, Ordering::Release);
    service.start_connection();
    service.lock_live().connection = Some(Arc::new(connection));
    service
        .availability
        .send_replace(CodexServiceAvailability::Up);
    (service, script)
}

// A scripted service runs no program, so a start on its dependencies fails at the resolve.
struct UnstartedProgram;

impl CodexProgramResolver for UnstartedProgram {
    fn resolve<'call>(
        &'call self,
        _home: &'call CodexServiceHome,
    ) -> BoxFuture<'call, Result<ResolvedProviderExecutable, DriverError>> {
        Box::pin(async {
            Err(DriverError::Internal(
                "a scripted service runs no program".into(),
            ))
        })
    }
}

/// Events no test reads: a service that never ends or recovers, or one whose test reads what it
/// does elsewhere.
pub(crate) struct UnheardEvents;

impl CodexServiceEvents for UnheardEvents {
    fn process_exited(&self, _service: &Arc<CodexService>, _exit: Option<&ProcessExit>) {}

    fn recovered(&self, _service: &Arc<CodexService>, _cause: CodexServiceRecoveryCause) {}

    fn crash_loop(&self, _service: &Arc<CodexService>, _start_failure: Option<Arc<CodexError>>) {}

    fn rate_limits_observed(&self, _service: &Arc<CodexService>) {}

    fn planned_restart_requested(&self, _service: &Arc<CodexService>) {}
}

/// Answers one connection's requests on `stream` as far as a start needs: the version, the hooks
/// the daemon starts a terminal service with, as trusted, and no loaded conversation; a config
/// write is refused, so a start that writes trust fails.
pub(crate) async fn answer_as_codex_service(stream: impl AsyncRead + AsyncWrite + Unpin) {
    let hooks = match read_terminal_service_hooks(TEST_DISPATCHES_HOOK_MODE)
        .expect("the daemon's hooks read")
    {
        TerminalServiceHooks::Daemon(hooks) => vec![
            listed_hook("preToolUse", &hooks.pre_tool_use),
            listed_hook("postToolUse", &hooks.post_tool_use),
        ],
        TerminalServiceHooks::NoHooks | TerminalServiceHooks::ProgramReplaced => Vec::new(),
    };
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
        let id = &request["id"];
        let reply = match request["method"].as_str() {
            Some("config/value/write") => json!({"id": id,
                "error": {"code": -32603, "message": "the test service writes no config"}}),
            Some("initialize") => json!({"id": id,
                "result": {"userAgent": "ai-sidekicks-daemon/0.130.0 (test)"}}),
            Some("hooks/list") => json!({"id": id, "result": {"data": [{"hooks": hooks}]}}),
            Some("thread/loaded/list") => json!({"id": id, "result": {"data": []}}),
            _ => json!({"id": id, "result": {}}),
        };
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

/// Waits until `service` is no longer up, which it leaves only once its connection is gone.
pub(crate) async fn wait_until_disconnected(service: &CodexService) {
    service
        .wait_for(|availability| !matches!(availability, CodexServiceAvailability::Up))
        .await;
}

/// Drops `service`'s connection as its reader does when the socket closes under it, its process
/// left running.
pub(crate) fn drop_service_connection(service: &Arc<CodexService>) {
    let dial = service.routed_dial.load(Ordering::Acquire);
    service
        .connection_handlers(dial)
        .events
        .dropped("the test dropped the connection");
}

/// Writes in `folder` a Codex command that prints nothing and exits 1 at every call, which the
/// search path finds as `codex`, and answers its path. Panics where it cannot be written.
pub(crate) fn write_failing_codex(folder: &Path) -> PathBuf {
    write_stand_in_program(
        folder,
        "codex",
        &StandInProgram {
            answers_by_first_argument: Vec::new(),
            otherwise: StandInAnswer {
                standard_output: String::new(),
                exit_code: 1,
                argument_record: None,
            },
        },
    )
    .expect("the failing Codex command is written")
}

/// A listener at `socket`, or `None` where the system binds no local socket listener. Panics
/// where a bind the system offers fails.
pub(crate) fn bind_test_listener(socket: &Path) -> Option<Listener> {
    CAN_BIND_A_SOCKET_LISTENER
        .then(|| bind_socket_listener(socket).expect("the test's socket listens"))
}

/// The next request the daemon sent on `socket`, its notifications skipped.
pub(crate) async fn next_socket_request<Stream>(socket: &mut WebSocketStream<Stream>) -> Value
where
    Stream: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let message = socket
            .next()
            .await
            .expect("the daemon keeps the connection")
            .expect("the daemon's message reads");
        let Message::Text(text) = message else {
            continue;
        };
        let request: Value = serde_json::from_str(&text).expect("the daemon sends JSON");
        if request.get("id").is_some() {
            return request;
        }
    }
}

/// Sends `message` to the daemon on `socket`.
pub(crate) async fn send_on_socket<Stream>(socket: &mut WebSocketStream<Stream>, message: Value)
where
    Stream: AsyncRead + AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(message.to_string().into()))
        .await
        .expect("the daemon reads");
}
