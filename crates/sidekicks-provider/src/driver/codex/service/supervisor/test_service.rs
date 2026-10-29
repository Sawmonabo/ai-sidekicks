//! What a test's Codex services run on: their shared dependencies, a program a test names, a
//! listener's answers as a Codex service gives them, a service whose connection a test scripts, a
//! service of the daemon's own kind published as up and holding a connection on a
//! `ScriptedService`, its frames and asks routed as a dialed one's are, a terminal service a
//! former daemon kept on the person's own folder, which a daemon's start finds again, and a `codex`
//! command whose service starts run a test program as a recorded stand-in service.

use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use futures::{SinkExt as _, StreamExt as _};
use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::{Value, json};
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_ipc::caller_process::provider_services::ProviderServiceProcesses;
use sidekicks_ipc::caller_process::system_reader::ProcessTableReader;
#[cfg(test)]
use sidekicks_platforms::ProgramStart;
use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, CAN_LINK_A_SOCKET, LeftoverSweep, Spawner, StandInAnswer,
    StandInProgram, bind_socket_listener, pin_running_process, read_recorded_arguments,
    replace_file_atomically, replace_socket_link, short_socket_folder, write_stand_in_program,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::data_folder::program_link_folder;
use tempfile::TempDir;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
#[cfg(test)]
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::task::{AbortOnDropHandle, TaskTracker};

use crate::command::askpass::command_askpass_program_path;
use crate::command::channel::command_channel_root;
use crate::command::waiting_checks::SystemInputWaitReader;
use crate::command::wrapper::command_wrapper_program_path;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::exec_relay::CodexExecRelayDependencies;
use crate::driver::codex::lifecycle::CODEX_SERVICE_STARTUP_TIMEOUT;
use crate::driver::codex::service::command_line::{
    TerminalServiceHooks, read_terminal_service_hooks,
};
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::registry::home_socket_path;
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
pub(crate) struct ExitsHeard {
    exits: mpsc::UnboundedSender<Option<ProcessExit>>,
    recoveries: mpsc::UnboundedSender<()>,
}

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

/// Answers one connection's requests on `stream` as far as a start needs, telling `on_request`
/// each request's method as it comes: the version, the hooks the daemon starts a terminal service
/// with, as trusted, and no loaded conversation; a config write is refused, so a start that writes
/// trust fails.
pub(crate) async fn answer_as_codex_service(
    stream: impl AsyncRead + AsyncWrite + Unpin,
    mut on_request: impl FnMut(&str),
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
        let id = &request["id"];
        on_request(request["method"].as_str().unwrap_or_default());
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

/// Writes in `folder` a Codex command that prints nothing and exits 1 at every call, each call's
/// arguments appended to `argument_record` where one is named, which the search path finds as
/// `codex`, and answers its path. Panics where it cannot be written.
pub(crate) fn write_failing_codex(folder: &Path, argument_record: Option<PathBuf>) -> PathBuf {
    write_stand_in_program(
        folder,
        "codex",
        &StandInProgram {
            answers_by_first_argument: Vec::new(),
            otherwise: StandInAnswer {
                standard_output: String::new(),
                exit_code: 1,
                argument_record,
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

/// A terminal service a former daemon kept running on the person's own Codex folder, stood in by a
/// listener on the folder's own socket that answers as a Codex service, beside a `codex` command
/// first on the search path that fails at once and records each start: a test reads whether a
/// daemon launched a service of its own and, connection by connection, what it asked the kept one.
pub struct KeptTerminalService {
    codex_home: PathBuf,
    programs_folder: PathBuf,
    launch_record: PathBuf,
    asked: Arc<Mutex<Vec<Vec<String>>>>,
    _answering: AbortOnDropHandle<()>,
    _folder: TempDir,
}

impl KeptTerminalService {
    /// The environment a daemon's providers start in to take this folder as the person's own
    /// Codex folder and the recording command as their `codex`.
    pub fn provider_environment(&self) -> Vec<(String, String)> {
        codex_folder_environment(&self.codex_home, &self.programs_folder)
    }

    /// Each connection the kept service answered, in the order of its first request, as the
    /// methods asked on it in order.
    pub fn connections(&self) -> Vec<Vec<String>> {
        lock(&self.asked).clone()
    }

    /// The arguments of every start of the `codex` command, one after another: empty while no
    /// service of the daemon's own was launched. Panics where the record cannot be read.
    pub fn launch_arguments(&self) -> Vec<String> {
        match read_recorded_arguments(&self.launch_record) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            read => read.expect("the launch record reads"),
        }
    }
}

/// Keeps a terminal service on a new person's own Codex folder, answering until it drops, or
/// `None` where the system binds no local socket listener. Must be called within a runtime.
/// Panics where its folder, its command or its listener cannot be made.
pub fn keep_terminal_service() -> Option<KeptTerminalService> {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let codex_home = folder.path().join("c");
    let programs_folder = folder.path().join("bin");
    let launch_record = folder.path().join("launches");
    let socket = home_socket_path(&codex_home);
    std::fs::create_dir_all(socket.parent().expect("the socket sits in its folder"))
        .expect("the Codex folder is made");
    let listener = bind_test_listener(&socket)?;
    std::fs::create_dir(&programs_folder).expect("the programs folder is made");
    write_failing_codex(&programs_folder, Some(launch_record.clone()));
    let asked = Arc::default();
    Some(KeptTerminalService {
        codex_home,
        programs_folder,
        launch_record,
        _answering: AbortOnDropHandle::new(tokio::spawn(answer_kept_connections(
            listener,
            Arc::clone(&asked),
        ))),
        asked,
        _folder: folder,
    })
}

// Answers each connection on `listener` as a Codex service, recording in `asked` the methods each
// asked; every connection's answering ends with this one.
async fn answer_kept_connections(listener: Listener, asked: Arc<Mutex<Vec<Vec<String>>>>) {
    let mut answering = JoinSet::new();
    while let Ok(stream) = listener.accept().await {
        let asked = Arc::clone(&asked);
        let mut connection = None;
        answering.spawn(answer_as_codex_service(stream, move |method| {
            let mut asked = lock(&asked);
            let index = *connection.get_or_insert_with(|| {
                asked.push(Vec::new());
                asked.len() - 1
            });
            asked[index].push(method.to_owned());
        }));
    }
}

// The environment a daemon's providers start in to take `codex_home` as the person's own Codex
// folder and `programs_folder`, alone on the search path, as where their `codex` is.
fn codex_folder_environment(codex_home: &Path, programs_folder: &Path) -> Vec<(String, String)> {
    DESCRIPTOR
        .credential_home_environment_names
        .iter()
        .map(|name| ((*name).to_owned(), codex_home.display().to_string()))
        .chain([("PATH".to_owned(), programs_folder.display().to_string())])
        .collect()
}

/// The Codex home a stand-in service serves, as Codex reads it.
pub(crate) const CODEX_HOME_NAME: &str = "CODEX_HOME";

/// Set for a stand-in that ignores the hang-up, as a service still finishing its replies does;
/// only a test's program sets it.
pub(crate) const HANG_UP_IGNORED_NAME: &str = "SIDEKICKS_TEST_HANG_UP_IGNORED";

/// The file a stand-in's script keeps its last start's arguments in, one to a line.
pub(crate) const LAUNCH_ARGUMENTS_FILE: &str = "codex-arguments";

// The address a stand-in listens on, as its `--listen` names it; only its script sets it.
const LISTEN_ADDRESS_NAME: &str = "SIDEKICKS_TEST_LISTEN_ADDRESS";

// The file a stand-in records the requests it answers in; only its script sets it.
const CONNECTION_RECORD_NAME: &str = "SIDEKICKS_TEST_CONNECTION_RECORD";

// The daemon socket whose presence a stand-in records at each connection's first request; only
// its script sets it, and only where a test names one.
const DAEMON_SOCKET_NAME: &str = "SIDEKICKS_TEST_DAEMON_SOCKET";

// The file a stand-in's script adds each service start's process to, one to a line.
const LAUNCHES_FILE: &str = "codex-launches";

// The file a stand-in's requests are recorded in, one line each.
const CONNECTIONS_FILE: &str = "codex-connections";

/// Writes in `folder` the `codex` script a stand-in service starts through and answers its path:
/// it keeps its arguments in [`LAUNCH_ARGUMENTS_FILE`], adds each service start's process to its
/// launches, names its record of requests and, where `daemon_socket` is given, the socket whose
/// presence it records, has the program ignore the hang-up where its environment asks, and runs
/// this test program's `stand_in_test`. Panics where it cannot be written.
pub(crate) fn write_codex_service_script(
    folder: &Path,
    stand_in_test: &str,
    daemon_socket: Option<&Path>,
) -> PathBuf {
    let program = std::env::current_exe().expect("the test program names itself");
    let script = folder.join("codex");
    let daemon_socket = daemon_socket.map_or_else(String::new, |socket| {
        format!(
            "{DAEMON_SOCKET_NAME}='{}'; export {DAEMON_SOCKET_NAME}\n",
            socket.display()
        )
    });
    let body = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n\
         while [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = --listen ]; then \
         {LISTEN_ADDRESS_NAME}=\"$2\"; export {LISTEN_ADDRESS_NAME}; fi\n  shift\ndone\n\
         if [ -n \"${LISTEN_ADDRESS_NAME}\" ]; then printf '%s\\n' \"$$\" >> '{}'; fi\n\
         {CONNECTION_RECORD_NAME}='{}'; export {CONNECTION_RECORD_NAME}\n{daemon_socket}\
         if [ -n \"${HANG_UP_IGNORED_NAME}\" ]; then trap '' HUP; fi\n\
         exec '{}' --exact {stand_in_test} --include-ignored >/dev/null 2>&1\n",
        folder.join(LAUNCH_ARGUMENTS_FILE).display(),
        folder.join(LAUNCHES_FILE).display(),
        folder.join(CONNECTIONS_FILE).display(),
        program.display()
    );
    replace_file_atomically(&script, body.as_bytes(), 0o755, LeftoverSweep::Unswept)
        .expect("the script is written");
    script
}

/// Serves as a Codex service where a stand-in's script started this program: on a real socket of
/// its own, with the path its `--listen` names made a link to it, answering each connection as a
/// start needs and recording each request in the script's record. Returns at once where no
/// script started it. Panics where its socket cannot listen or its link cannot be made.
pub async fn serve_as_codex_service_stand_in() {
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
    let listener = bind_socket_listener(&real_socket).expect("the real socket listens");
    replace_socket_link(&link, &real_socket).expect("the link names the real socket");
    let record =
        PathBuf::from(std::env::var_os(CONNECTION_RECORD_NAME).expect("the record is named"));
    let daemon_socket = std::env::var_os(DAEMON_SOCKET_NAME).map(PathBuf::from);
    let connections = Arc::new(AtomicUsize::new(0));
    while let Ok(stream) = listener.accept().await {
        let mut recording = ConnectionRecording {
            record: record.clone(),
            daemon_socket: daemon_socket.clone(),
            connections: Arc::clone(&connections),
            first_request: None,
        };
        tokio::spawn(answer_as_codex_service(stream, move |method| {
            recording.record(method);
        }));
    }
}

// What a stand-in records of one connection's requests: the connection's place among those that
// asked anything and whether the daemon's socket was there, both taken at its first request.
struct ConnectionRecording {
    record: PathBuf,
    daemon_socket: Option<PathBuf>,
    connections: Arc<AtomicUsize>,
    first_request: Option<(usize, bool)>,
}

impl ConnectionRecording {
    // Appends one line for a request of `method`: this process, the connection, the daemon
    // socket's presence at the connection's first request, and the method. Panics where the
    // record cannot be written.
    fn record(&mut self, method: &str) {
        let (connection, is_daemon_socket_bound) = *self.first_request.get_or_insert_with(|| {
            (
                self.connections.fetch_add(1, Ordering::Relaxed),
                self.daemon_socket.as_deref().is_some_and(Path::exists),
            )
        });
        // One write of a whole line to a file opened to append, so lines never interleave.
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.record)
            .and_then(|mut record| {
                record.write_all(
                    format!(
                        "{}\t{connection}\t{is_daemon_socket_bound}\t{method}\n",
                        std::process::id()
                    )
                    .as_bytes(),
                )
            })
            .expect("the request is recorded");
    }
}

/// One connection a stand-in Codex service answered, as its record keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandInConnection {
    /// The service process that answered it.
    pub process_id: u32,
    /// Whether the daemon's socket was there when the connection asked its first request.
    pub is_daemon_socket_bound: bool,
    /// The methods it asked, in order.
    pub methods: Vec<String>,
}

/// A `codex` command alone on a daemon's search path, beside a person's own Codex folder, whose
/// every service start runs a test program's stand-in service: a test reads the process each
/// start launched and, connection by connection, what each asked. Ends every service it started
/// that still runs when it drops.
pub struct CodexServiceStandIn {
    codex_home: PathBuf,
    programs_folder: PathBuf,
    _folder: TempDir,
}

impl CodexServiceStandIn {
    /// The environment a daemon's providers start in to take this folder as the person's own
    /// Codex folder and the stand-in's command as their `codex`.
    pub fn provider_environment(&self) -> Vec<(String, String)> {
        codex_folder_environment(&self.codex_home, &self.programs_folder)
    }

    /// The process of every service start, in order: one entry per service launched. Panics where
    /// the record cannot be read.
    pub fn launches(&self) -> Vec<u32> {
        self.read_launches().expect("the launches read")
    }

    /// Each connection a started service answered, in the order of its first request. Panics
    /// where the record cannot be read.
    pub fn connections(&self) -> Vec<StandInConnection> {
        let lines = match std::fs::read_to_string(self.programs_folder.join(CONNECTIONS_FILE)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            read => read.expect("the connections read"),
        };
        let mut connections: Vec<((u32, usize), StandInConnection)> = Vec::new();
        for line in lines.lines() {
            let mut fields = line.split('\t');
            let mut field = || {
                fields
                    .next()
                    .expect("a request's line holds its four fields")
            };
            let process_id = field().parse().expect("a process reads");
            let connection = field().parse().expect("a connection reads");
            let is_daemon_socket_bound = field().parse().expect("the socket's presence reads");
            let method = field().to_owned();
            let key = (process_id, connection);
            match connections.iter_mut().find(|(seen, _)| *seen == key) {
                Some((_, seen)) => seen.methods.push(method),
                None => connections.push((
                    key,
                    StandInConnection {
                        process_id,
                        is_daemon_socket_bound,
                        methods: vec![method],
                    },
                )),
            }
        }
        connections
            .into_iter()
            .map(|(_, connection)| connection)
            .collect()
    }

    // The process of every service start, none while no service was launched.
    fn read_launches(&self) -> io::Result<Vec<u32>> {
        let lines = match std::fs::read_to_string(self.programs_folder.join(LAUNCHES_FILE)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            read => read?,
        };
        lines
            .lines()
            .map(|line| line.parse().map_err(io::Error::other))
            .collect()
    }
}

impl Drop for CodexServiceStandIn {
    // A lasting service outlives the daemon that started it, so one a test left running is ended
    // here; one already gone has nothing to end.
    fn drop(&mut self) {
        let ended = self.read_launches().and_then(|launches| {
            for process_id in launches {
                if let Some(process) = pin_running_process(process_id)? {
                    process.kill()?;
                }
            }
            Ok(())
        });
        // A drop has no caller to fail, so a service left running is told where the test ran.
        if let Err(error) = ended {
            eprintln!("a stand-in Codex service could not be ended: {error}");
        }
    }
}

/// A `codex` command whose service starts run this test program's `stand_in_test`, which serves
/// through [`serve_as_codex_service_stand_in`], recording at each connection's first request
/// whether `daemon_socket` is there; `None` where the system links or binds no local socket.
/// Panics where its folders or its command cannot be made.
pub fn stand_in_codex_service(
    stand_in_test: &str,
    daemon_socket: &Path,
) -> Option<CodexServiceStandIn> {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return None;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let codex_home = folder.path().join("c");
    let programs_folder = folder.path().join("bin");
    std::fs::create_dir(&codex_home).expect("the Codex folder is made");
    std::fs::create_dir(&programs_folder).expect("the programs folder is made");
    write_codex_service_script(&programs_folder, stand_in_test, Some(daemon_socket));
    Some(CodexServiceStandIn {
        codex_home,
        programs_folder,
        _folder: folder,
    })
}
