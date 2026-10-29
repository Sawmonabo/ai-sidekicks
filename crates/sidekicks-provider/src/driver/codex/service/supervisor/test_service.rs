//! What a test's Codex services run on: their shared dependencies, a program a test names, a
//! listener's answers as a Codex service gives them, and a service whose connection a test
//! scripts, a service of the daemon's own kind published as up and holding a connection on a
//! `ScriptedService`, its frames and asks routed as a dialed one's are.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use futures::future::BoxFuture;
#[cfg(test)]
use futures::{SinkExt as _, StreamExt as _};
#[cfg(test)]
use interprocess::local_socket::tokio::Listener;
#[cfg(test)]
use serde_json::{Value, json};
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_ipc::caller_process::provider_services::ProviderServiceProcesses;
use sidekicks_ipc::caller_process::system_reader::ProcessTableReader;
use sidekicks_platforms::Spawner;
#[cfg(test)]
use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, ProgramStart, StandInAnswer, StandInProgram, bind_socket_listener,
    write_stand_in_program,
};
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::data_folder::program_link_folder;
use tempfile::TempDir;
#[cfg(test)]
use tokio::io::{AsyncRead, AsyncWrite};
#[cfg(test)]
use tokio::sync::mpsc;
#[cfg(test)]
use tokio_tungstenite::WebSocketStream;
#[cfg(test)]
use tokio_tungstenite::tungstenite::Message;
use tokio_util::task::TaskTracker;

use crate::command::askpass::command_askpass_program_path;
use crate::command::channel::command_channel_root;
use crate::command::waiting_checks::SystemInputWaitReader;
use crate::command::wrapper::command_wrapper_program_path;
use crate::driver::codex::exec_relay::CodexExecRelayDependencies;
use crate::driver::codex::lifecycle::CODEX_SERVICE_STARTUP_TIMEOUT;
#[cfg(test)]
use crate::driver::codex::service::command_line::{
    TerminalServiceHooks, read_terminal_service_hooks,
};
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::supervisor::drain::LastingServiceDrains;
use crate::driver::codex::service::supervisor::events::{
    CodexServiceEvents, CodexServiceRecoveryCause,
};
use crate::driver::codex::service::supervisor::transition::CodexServiceAvailability;
#[cfg(test)]
use crate::driver::codex::service::supervisor::transition::event::SupervisorEvent;
#[cfg(test)]
use crate::driver::codex::service::supervisor::transition::state::SupervisorState;
use crate::driver::codex::service::supervisor::{
    CodexProgramResolver, CodexService, CodexServiceDependencies, CodexServiceSocket,
};
use crate::driver::codex::session::conversation_release::CodexConversationRelease;
use crate::driver::codex::session::errors::CodexError;
#[cfg(test)]
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::codex::transport::connection::scripted_service::{
    ScriptedService, connect_scripted_service,
};
use crate::driver::contract::error::DriverError;
#[cfg(test)]
use crate::process_identity::ProviderProcessIdentity;
use crate::process_registry::ProviderProcessRegistry;
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::spawned_version::ResolvedProviderExecutable;
#[cfg(test)]
use crate::spawned_version::{SpawnedProviderVersionReading, parse_cli_version_report};

/// Whether the test services' daemon runs the hook mode a hook command starts: the tests' program
/// runs none, so a terminal service starts, and is answered, with no hooks.
const TEST_DISPATCHES_HOOK_MODE: bool = false;

/// The largest message the scripted service takes, far above any a test sends.
const SCRIPTED_MESSAGE_LIMIT: usize = 1 << 20;

/// The scripted connection's ticket, which routes its frames.
const SCRIPTED_DIAL: u64 = 1;

/// A service on a scripted connection, the folder its home names, and the script.
pub struct ScriptedCodexService {
    /// The service.
    pub(crate) service: Arc<CodexService>,
    /// What its connection sent, and what the service sends it.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's restart test scripts the service's conversation"
        )
    )]
    pub(crate) script: ScriptedService,
    /// What the service runs on, the conversations its sessions moved off among them.
    pub(crate) dependencies: Arc<CodexServiceDependencies>,
    _folder: TempDir,
}

#[cfg(test)]
impl ScriptedCodexService {
    /// Publishes the service reconnecting, its connection set aside until [`Self::publish_up`]
    /// hands it back.
    pub(crate) fn publish_reconnecting(&self) -> Option<Arc<CodexAppServerConnection>> {
        self.publish_disconnected(CodexServiceAvailability::Reconnecting)
    }

    /// Publishes the service down after a crash loop, its connection set aside as the reconnect
    /// sets it aside.
    pub(crate) fn publish_crash_loop(&self) -> Option<Arc<CodexAppServerConnection>> {
        self.publish_disconnected(CodexServiceAvailability::CrashLoop)
    }

    // Publishes the service as `availability`, one it is not up in, its connection set aside so
    // the script stays open.
    fn publish_disconnected(
        &self,
        availability: CodexServiceAvailability,
    ) -> Option<Arc<CodexAppServerConnection>> {
        let connection = self.service.lock_live().connection.take();
        self.service.availability.send_replace(availability);
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

    /// Moves the service's supervisor to up on the scripted connection, as a start the daemon
    /// made leaves it, so the silence watch and a crash's restart run on it.
    pub(crate) fn mark_started(&self) {
        let mut supervision = self.service.lock_supervision();
        let kind = supervision.kind();
        supervision.transition(SupervisorEvent::Start);
        supervision.transition(SupervisorEvent::Started {
            launch: SCRIPTED_DIAL,
            at: std::time::Instant::now(),
            kind,
        });
        let SupervisorState::Up { dial, .. } = supervision.state() else {
            panic!("the started service is up");
        };
        assert_eq!(
            *dial, SCRIPTED_DIAL,
            "the scripted connection is the one up"
        );
    }

    /// Publishes the service up again on `connection`.
    pub(crate) fn publish_up(&self, connection: Option<Arc<CodexAppServerConnection>>) {
        self.service.lock_live().connection = connection;
        self.service
            .availability
            .send_replace(CodexServiceAvailability::Up);
    }

    /// Publishes the service up again on `connection` once its supervisor reads it starting, as a
    /// new process would come up under a start that never answers.
    pub(crate) async fn publish_up_once_starting(
        &self,
        connection: Option<Arc<CodexAppServerConnection>>,
    ) {
        self.service
            .wait_for(|availability| matches!(availability, CodexServiceAvailability::Starting))
            .await;
        self.publish_up(connection);
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
    let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
    let link_folder = program_link_folder(&folder.join("data"));
    let exec_relay = Arc::new(CodexExecRelayDependencies {
        spawner: spawner.clone(),
        command_channel_root: command_channel_root(&folder.join("data")),
        caller_processes: Arc::new(
            ProcessTableReader::for_this_program().expect("this program's reader builds"),
        ),
        input_waits: Arc::new(SystemInputWaitReader {
            spawner: spawner.clone(),
        }),
        command_output: Arc::new(PortRegistration::new("running commands")),
        wrapper_program: command_wrapper_program_path(&link_folder),
        askpass_program: command_askpass_program_path(&link_folder),
    });
    Arc::new(CodexServiceDependencies {
        spawner,
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
        exec_relay,
    })
}

/// The program a test names, run as the Codex build with `environment` its whole environment.
#[cfg(test)]
pub(crate) struct TestCodexProgram {
    /// The program.
    pub(crate) program: PathBuf,
    /// Its environment.
    pub(crate) environment: Vec<(String, String)>,
}

#[cfg(test)]
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
pub fn start_scripted_codex_service() -> ScriptedCodexService {
    start_scripted_account_service_reporting_to(Arc::new(UnheardEvents))
}

/// Starts a service on an account's home whose connection the test scripts, telling `events` what
/// happens to it. Must be called within a runtime.
pub(crate) fn start_scripted_account_service_reporting_to(
    events: Arc<dyn CodexServiceEvents>,
) -> ScriptedCodexService {
    start_scripted_codex_service_on(
        CodexHomeKind::Account(test_provider_account_id()),
        CodexServiceKind::Account,
        Arc::new(UnstartedProgram),
        events,
    )
}

/// Starts a service on an account's home whose connection the test scripts and whose own start,
/// once its supervisor begins one, never answers, so the test publishes the new process up. Must
/// be called within a runtime.
#[cfg(test)]
pub(crate) fn start_scripted_codex_service_whose_start_waits() -> ScriptedCodexService {
    start_scripted_codex_service_on(
        CodexHomeKind::Account(test_provider_account_id()),
        CodexServiceKind::Account,
        Arc::new(WaitingProgram),
        Arc::new(UnheardEvents),
    )
}

/// Starts the terminal service on the person's own folder with terminal reach on, its connection
/// scripted by the test. Must be called within a runtime.
#[cfg(test)]
pub(crate) fn start_scripted_terminal_service() -> ScriptedCodexService {
    start_scripted_codex_service_on(
        CodexHomeKind::PersonalFolder,
        CodexServiceKind::Terminal,
        Arc::new(UnstartedProgram),
        Arc::new(UnheardEvents),
    )
}

// A service of `kind` on a home of `home_kind` whose connection the test scripts, a start of its
// own running `program`, telling `events` what happens to it.
fn start_scripted_codex_service_on(
    home_kind: CodexHomeKind,
    kind: CodexServiceKind,
    program: Arc<dyn CodexProgramResolver>,
    events: Arc<dyn CodexServiceEvents>,
) -> ScriptedCodexService {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let dependencies = test_codex_service_dependencies(folder.path(), program, events);
    let socket: PathBuf = folder.path().join("codex.sock");
    let (service, script) = script_codex_service(
        CodexServiceHome {
            codex_home: folder.path().join("home"),
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
    let service = CodexService::new(home, socket, kind, dependencies, Vec::new());
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

// A program whose resolve never answers, so a start on it stays starting.
#[cfg(test)]
struct WaitingProgram;

#[cfg(test)]
impl CodexProgramResolver for WaitingProgram {
    fn resolve<'call>(
        &'call self,
        _home: &'call CodexServiceHome,
    ) -> BoxFuture<'call, Result<ResolvedProviderExecutable, DriverError>> {
        Box::pin(std::future::pending())
    }
}

/// Events no test reads: a service that never ends or recovers, or one whose test reads what it
/// does elsewhere.
pub(crate) struct UnheardEvents;

impl CodexServiceEvents for UnheardEvents {
    fn process_exited(&self, _service: &Arc<CodexService>, _exit: Option<&ProcessExit>) {}

    fn recovered(&self, _service: &Arc<CodexService>, _cause: CodexServiceRecoveryCause) {}

    fn crash_loop(&self, _service: &Arc<CodexService>, _start_failure: Option<Arc<CodexError>>) {}

    fn start_failed(&self, _service: &Arc<CodexService>) {}

    fn rate_limits_observed(&self, _service: &Arc<CodexService>) {}

    fn planned_restart_requested(&self, _service: &Arc<CodexService>) {}
}

/// Tells a test how each service process ended, and each time a service is back after a crash.
#[cfg(test)]
pub(crate) struct ExitsHeard {
    exits: mpsc::UnboundedSender<Option<ProcessExit>>,
    recoveries: mpsc::UnboundedSender<()>,
}

#[cfg(test)]
impl ExitsHeard {
    /// The events, with the receivers of each exit and of each recovery.
    pub(crate) fn new() -> (
        Self,
        mpsc::UnboundedReceiver<Option<ProcessExit>>,
        mpsc::UnboundedReceiver<()>,
    ) {
        let (exits, exits_heard) = mpsc::unbounded_channel();
        let (recoveries, recoveries_heard) = mpsc::unbounded_channel();
        (Self { exits, recoveries }, exits_heard, recoveries_heard)
    }
}

#[cfg(test)]
impl CodexServiceEvents for ExitsHeard {
    fn process_exited(&self, _service: &Arc<CodexService>, exit: Option<&ProcessExit>) {
        let _heard = self.exits.send(exit.cloned());
    }

    fn recovered(&self, _service: &Arc<CodexService>, _cause: CodexServiceRecoveryCause) {
        let _heard = self.recoveries.send(());
    }

    fn crash_loop(&self, _service: &Arc<CodexService>, _start_failure: Option<Arc<CodexError>>) {}

    fn start_failed(&self, _service: &Arc<CodexService>) {}

    fn rate_limits_observed(&self, _service: &Arc<CodexService>) {}

    fn planned_restart_requested(&self, _service: &Arc<CodexService>) {}
}

/// The conversation a machine probe's ephemeral start opens on a test service.
#[cfg(test)]
pub(crate) const PROBE_THREAD_ID: &str = "probe-thread";

/// The one tool each server a test service lists for a machine probe has.
#[cfg(test)]
pub(crate) const PROBE_TOOL_NAME: &str = "lookup";

/// Answers one connection's requests on `stream` as far as a start needs: the version, the hooks
/// the daemon starts a terminal service with, as trusted, and no loaded conversation; a config
/// write is refused, so a start that writes trust fails. A machine probe is answered too: its
/// ephemeral start opens [`PROBE_THREAD_ID`], each server its config switches on or sends reports
/// ready, and each listed server is connected with [`PROBE_TOOL_NAME`]. A config read is answered
/// with `config_read_reply` where one is given. Each request is appended, one to a line, to
/// `record` where one is named.
#[cfg(test)]
pub(crate) async fn answer_as_codex_service(
    stream: impl AsyncRead + AsyncWrite + Unpin,
    record: Option<PathBuf>,
    config_read_reply: Option<Value>,
) {
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
        if let Some(record) = &record {
            let mut line = text.to_string();
            line.push('\n');
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(record)
                .expect("the request record opens");
            std::io::Write::write_all(&mut file, line.as_bytes()).expect("the request is recorded");
        }
        let id = &request["id"];
        let mut notices = Vec::new();
        let reply = match request["method"].as_str() {
            Some("thread/start") if request["params"]["ephemeral"] == json!(true) => {
                notices = started_probe_servers(&request["params"]);
                json!({"id": id,
                    "result": {"thread": {"id": PROBE_THREAD_ID, "sessionId": "probe-session"}}})
            }
            Some("mcpServerStatus/list") => json!({"id": id, "result": {"data": [{
                "name": request["params"]["serverName"],
                "authStatus": "unsupported",
                "runtimeStatus": "connected",
                "tools": {PROBE_TOOL_NAME: {"name": PROBE_TOOL_NAME, "inputSchema": {}}},
                "resources": [],
                "resourceTemplates": [],
            }], "nextCursor": null}}),
            Some("config/read") if config_read_reply.is_some() => {
                json!({"id": id, "result": config_read_reply})
            }
            Some("config/value/write") => json!({"id": id,
                "error": {"code": -32603, "message": "the test service writes no config"}}),
            Some("initialize") => json!({"id": id,
                "result": {"userAgent": "ai-sidekicks-daemon/0.130.0 (test)"}}),
            Some("hooks/list") => json!({"id": id, "result": {"data": [{"hooks": hooks}]}}),
            Some("thread/loaded/list") => json!({"id": id, "result": {"data": []}}),
            _ => json!({"id": id, "result": {}}),
        };
        for message in std::iter::once(reply).chain(notices) {
            if socket
                .send(Message::Text(message.to_string().into()))
                .await
                .is_err()
            {
                return;
            }
        }
    }
}

#[cfg(test)]
// The ready notice of each server a probe's start switches on or sends, by its config's server
// table.
fn started_probe_servers(params: &Value) -> Vec<Value> {
    params["config"]["mcp_servers"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, entry)| entry["enabled"] == json!(true))
        .map(|(name, _)| {
            json!({"jsonrpc": "2.0", "method": "mcpServer/startupStatus/updated", "params": {
                "threadId": PROBE_THREAD_ID, "name": name, "status": "ready", "error": null,
            }})
        })
        .collect()
}

#[cfg(test)]
fn listed_hook(event_name: &str, command: &str) -> Value {
    json!({"source": "sessionFlags", "eventName": event_name, "command": command,
        "key": event_name, "currentHash": "hash", "trustStatus": "trusted"})
}

/// Waits until `service` is no longer up, which it leaves only once its connection is gone.
#[cfg(test)]
pub(crate) async fn wait_until_disconnected(service: &CodexService) {
    service
        .wait_for(|availability| !matches!(availability, CodexServiceAvailability::Up))
        .await;
}

/// Drops `service`'s connection as its reader does when the socket closes under it, its process
/// left running.
#[cfg(test)]
pub(crate) fn drop_service_connection(service: &Arc<CodexService>) {
    let dial = service.routed_dial.load(Ordering::Acquire);
    service
        .connection_handlers(dial)
        .events
        .dropped("the test dropped the connection");
}

/// Writes in `folder` a Codex command that prints nothing and exits 1 at every call, which the
/// search path finds as `codex`, and answers its path. Panics where it cannot be written.
#[cfg(test)]
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
#[cfg(test)]
pub(crate) fn bind_test_listener(socket: &Path) -> Option<Listener> {
    CAN_BIND_A_SOCKET_LISTENER
        .then(|| bind_socket_listener(socket).expect("the test's socket listens"))
}

/// The next request the daemon sent on `socket`, its notifications skipped.
#[cfg(test)]
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
#[cfg(test)]
pub(crate) async fn send_on_socket<Stream>(socket: &mut WebSocketStream<Stream>, message: Value)
where
    Stream: AsyncRead + AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(message.to_string().into()))
        .await
        .expect("the daemon reads");
}
