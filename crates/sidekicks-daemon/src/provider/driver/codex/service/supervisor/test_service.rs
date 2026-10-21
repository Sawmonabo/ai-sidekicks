//! A Codex service whose connection a test scripts: a stopped service of the daemon's own kind
//! holding a connection on a `ScriptedService`, its frames and asks routed as a dialed one's are.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures::future::BoxFuture;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_platforms::Spawner;
use tempfile::TempDir;

use crate::ipc::caller_process::provider_services::ProviderServiceProcesses;
use crate::provider::driver::codex::service::home::{
    CodexHomeKind, CodexServiceHome, CodexServiceKind,
};
use crate::provider::driver::codex::service::supervisor::events::{
    CodexServiceEvents, CodexServiceRecoveryCause,
};
use crate::provider::driver::codex::service::supervisor::{
    CodexProgramResolver, CodexService, CodexServiceDependencies, CodexServiceSocket,
};
use crate::provider::driver::codex::session::conversation_release::CodexConversationRelease;
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
    /// The conversations the service's sessions moved off.
    pub(crate) release: Arc<CodexConversationRelease>,
    _folder: TempDir,
}

/// Starts a service whose connection the test scripts. Must be called within a runtime.
pub(crate) fn start_scripted_codex_service() -> ScriptedCodexService {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let release = Arc::new(CodexConversationRelease::default());
    let dependencies = Arc::new(CodexServiceDependencies {
        spawner: Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts"),
        provider_services: Arc::new(ProviderServiceProcesses::default()),
        program: Arc::new(UnstartedProgram),
        data_folder: folder.path().join("data"),
        logs_folder: folder.path().join("logs"),
        additional_config_overrides: Vec::new(),
        startup_timeout: Duration::from_secs(5),
        events: Arc::new(UnheardEvents),
        release: Arc::clone(&release),
    });
    let socket: PathBuf = folder.path().join("codex.sock");
    let service = CodexService::new(
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
        dependencies,
    );
    let (connection, script) = connect_scripted_service(
        SCRIPTED_MESSAGE_LIMIT,
        service.connection_handlers(SCRIPTED_DIAL),
    );
    service.routed_dial.store(SCRIPTED_DIAL, Ordering::Release);
    service.start_connection();
    service.lock_live().connection = Some(Arc::new(connection));
    ScriptedCodexService {
        service,
        script,
        release,
        _folder: folder,
    }
}

// The scripted service is never started, so its program is never resolved.
struct UnstartedProgram;

impl CodexProgramResolver for UnstartedProgram {
    fn resolve<'call>(
        &'call self,
        _home: &'call CodexServiceHome,
    ) -> BoxFuture<'call, Result<ResolvedProviderExecutable, DriverError>> {
        unreachable!("a scripted service never starts a process")
    }
}

// The scripted service never ends or recovers, so nothing hears its events.
struct UnheardEvents;

impl CodexServiceEvents for UnheardEvents {
    fn process_exited(&self, _service: &Arc<CodexService>, _exit: Option<&ProcessExit>) {}

    fn recovered(&self, _service: &Arc<CodexService>, _cause: CodexServiceRecoveryCause) {}

    fn crash_loop(&self, _service: &Arc<CodexService>) {}

    fn planned_restart_requested(&self, _service: &Arc<CodexService>) {}
}
