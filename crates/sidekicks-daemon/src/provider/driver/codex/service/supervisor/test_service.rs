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
use serde_json::{Value, json};
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_platforms::{ProgramStart, Spawner};
use tempfile::TempDir;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::tungstenite::Message;

use crate::ipc::caller_process::provider_services::ProviderServiceProcesses;
use crate::provider::driver::codex::service::command_line::CodexHookCommands;
use crate::provider::driver::codex::service::home::{
    CodexHomeKind, CodexServiceHome, CodexServiceKind,
};
use crate::provider::driver::codex::service::supervisor::drain::LastingServiceDrains;
use crate::provider::driver::codex::service::supervisor::events::{
    CodexServiceEvents, CodexServiceRecoveryCause,
};
use crate::provider::driver::codex::service::supervisor::transition::CodexServiceAvailability;
use crate::provider::driver::codex::service::supervisor::{
    CodexProgramResolver, CodexService, CodexServiceDependencies, CodexServiceSocket,
};
use crate::provider::driver::codex::session::conversation_release::CodexConversationRelease;
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;
use crate::provider::driver::codex::transport::connection::scripted_service::{
    ScriptedService, connect_scripted_service,
};
use crate::provider::driver::contract::DriverError;
use crate::provider::spawned_version::ResolvedProviderExecutable;

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
        program,
        data_folder: folder.join("data"),
        logs_folder: folder.join("logs"),
        additional_config_overrides: Vec::new(),
        startup_timeout: Duration::from_secs(5),
        events,
        release: Arc::new(CodexConversationRelease::default()),
        drains: LastingServiceDrains::default(),
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

/// Starts a service whose connection the test scripts. Must be called within a runtime.
pub(crate) fn start_scripted_codex_service() -> ScriptedCodexService {
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
            kind: CodexHomeKind::Account,
        },
        CodexServiceSocket {
            path: socket.clone(),
            home_socket: socket,
        },
        CodexServiceKind::Account,
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

    fn crash_loop(&self, _service: &Arc<CodexService>) {}

    fn planned_restart_requested(&self, _service: &Arc<CodexService>) {}
}

/// Answers one connection's requests on `stream` as far as a start needs: the version, `hooks` as
/// trusted, and no loaded conversation.
pub(crate) async fn answer_as_codex_service(
    stream: impl AsyncRead + AsyncWrite + Unpin,
    hooks: Arc<CodexHookCommands>,
) {
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

/// Drops `service`'s connection as its reader does when the socket closes under it, its process
/// left running.
pub(crate) fn drop_service_connection(service: &Arc<CodexService>) {
    let dial = service.routed_dial.load(Ordering::Acquire);
    service
        .connection_handlers(dial)
        .events
        .dropped("the test dropped the connection");
}
