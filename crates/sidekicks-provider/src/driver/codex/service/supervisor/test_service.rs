//! What a test's Codex services run on: their shared dependencies, a program a test names, a
//! listener's answers as a Codex service gives them, a service whose connection a test scripts, a
//! service of the daemon's own kind published as up and holding a connection on a
//! `ScriptedService`, its frames and asks routed as a dialed one's are, and a terminal service a
//! former daemon kept on the person's own folder, which a daemon's start finds again.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use futures::{SinkExt as _, StreamExt as _};
use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::{Value, json};
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_ipc::caller_process::provider_services::ProviderServiceProcesses;
#[cfg(test)]
use sidekicks_platforms::ProgramStart;
use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, Spawner, StandInAnswer, StandInProgram, bind_socket_listener,
    read_recorded_arguments, short_socket_folder, write_stand_in_program,
};
use sidekicks_std::mutex_lock::lock;
use tempfile::TempDir;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::task::JoinSet;
#[cfg(test)]
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::task::{AbortOnDropHandle, TaskTracker};

use crate::driver::codex::DESCRIPTOR;
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
use crate::driver::contract::DriverError;
#[cfg(test)]
use crate::process_identity::ProviderProcessIdentity;
use crate::process_registry::ProviderProcessRegistry;
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
    start_scripted_codex_service_on(
        CodexHomeKind::Account,
        CodexServiceKind::Account,
        Arc::new(UnstartedProgram),
    )
}

/// Starts a service on an account's home whose connection the test scripts and whose own start,
/// once its supervisor begins one, never answers, so the test publishes the new process up. Must
/// be called within a runtime.
#[cfg(test)]
pub(crate) fn start_scripted_codex_service_whose_start_waits() -> ScriptedCodexService {
    start_scripted_codex_service_on(
        CodexHomeKind::Account,
        CodexServiceKind::Account,
        Arc::new(WaitingProgram),
    )
}

/// Starts the terminal service on the person's own folder with terminal reach on, its connection
/// scripted by the test. Must be called within a runtime.
#[cfg(test)]
pub(crate) fn start_scripted_terminal_service() -> ScriptedCodexService {
    start_scripted_codex_service_on(
        CodexHomeKind::PersonalFolder {
            is_terminal_reach_on: true,
        },
        CodexServiceKind::Terminal,
        Arc::new(UnstartedProgram),
    )
}

// A service of `kind` on a home of `home_kind` whose connection the test scripts, a start of its
// own running `program`.
fn start_scripted_codex_service_on(
    home_kind: CodexHomeKind,
    kind: CodexServiceKind,
    program: Arc<dyn CodexProgramResolver>,
) -> ScriptedCodexService {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let dependencies =
        test_codex_service_dependencies(folder.path(), program, Arc::new(UnheardEvents));
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
        DESCRIPTOR
            .credential_home_environment_names
            .iter()
            .map(|name| ((*name).to_owned(), self.codex_home.display().to_string()))
            .chain([(
                "PATH".to_owned(),
                self.programs_folder.display().to_string(),
            )])
            .collect()
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
