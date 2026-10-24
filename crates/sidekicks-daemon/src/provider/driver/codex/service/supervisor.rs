//! One Codex service: its process for one credential home, or the service already there that the
//! daemon only joins, the daemon's connection on it, and what happens when either ends on its
//! own. One task, the service's runner, moves its state through the pure transition table one
//! event at a time and carries out each answer whole; what it starts, dials and waits on reports
//! back as events, each under its own ticket. A process that exits is a crash, restarted on the
//! crash window's waits; a connection that drops is redialed on a wait that grows and never gives
//! up; a service draining toward its exit refuses new work while its turns run on.

pub(crate) mod drain;
pub(crate) mod events;
mod reconnect;
pub(crate) mod routing;
mod runner;
pub(crate) mod start;
#[cfg(test)]
pub(crate) mod test_service;
#[cfg(test)]
mod tests;
mod transition;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, SystemTime};

use futures::future::{BoxFuture, join_all};
use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::Spawner;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::ipc::caller_process::provider_services::ProviderServiceProcesses;
use crate::provider::driver::codex::server_requests::CodexServerRequestResponder;
use crate::provider::driver::codex::service::asks::CodexServiceAsks;
use crate::provider::driver::codex::service::home::{CodexServiceHome, CodexServiceKind};
use crate::provider::driver::codex::service::record::LastingServiceRecordFile;
use crate::provider::driver::codex::service::supervisor::drain::LastingServiceDrains;
use crate::provider::driver::codex::service::supervisor::events::CodexServiceEvents;
use crate::provider::driver::codex::service::supervisor::routing::{
    CODEX_CONFIG_WARNING_METHOD, CodexServiceRouting,
};
use crate::provider::driver::codex::service::supervisor::runner::{RunnerInput, ServiceRunner};
use crate::provider::driver::codex::service::supervisor::start::read_codex_loaded_threads;
use crate::provider::driver::codex::service::supervisor::transition::{
    CodexServiceAvailability, Supervision, SupervisorEvent, SupervisorState,
};
use crate::provider::driver::codex::service::threads::{CodexServiceThreads, ThreadClaim};
use crate::provider::driver::codex::session::conversation_release::CodexConversationRelease;
use crate::provider::driver::codex::session::errors::{
    CODEX_DRAINING_REASON, CODEX_INVALID_REQUEST_CODE, CodexError,
};
use crate::provider::driver::codex::session::inbound::{
    CodexSessionInbound, CodexSessionInboundSender,
};
use crate::provider::driver::codex::session::state::CODEX_THREAD_FRAME_ROUTER_CONFIG;
use crate::provider::driver::codex::transport::connection::{
    CodexAppServerConnection, CodexConnectionEvents, CodexConnectionHandlers,
    CodexForgottenRequest, open_codex_connection, read_codex_object,
};
use crate::provider::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::provider::driver::codex::transport::socket::{
    CodexSocketWait, dial_codex_service_socket,
};
use crate::provider::driver::codex::usage_limit_signal::CodexRateLimitObservation;
use crate::provider::driver::codex::version::CODEX_CLIENT_NAME;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::daemon_stop::DaemonStopIntent;
use crate::provider::spawned_version::{ResolvedProviderExecutable, SpawnedProviderVersionReading};

/// The ask that reads whether the service may run a sandboxed command on Windows.
const WINDOWS_SANDBOX_READINESS_METHOD: &str = "windowsSandbox/readiness";

/// Resolves the configured Codex command again at every start, so a restart runs what the command
/// names now.
pub(crate) trait CodexProgramResolver: Send + Sync {
    /// The build a start on `home` runs, with the environment its spawn takes. Fails with the
    /// resolve's driver error.
    fn resolve<'call>(
        &'call self,
        home: &'call CodexServiceHome,
    ) -> BoxFuture<'call, Result<ResolvedProviderExecutable, DriverError>>;
}

/// What every service of one driver starts, connects and reports through.
pub(crate) struct CodexServiceDependencies {
    /// The daemon's spawner thread.
    pub(crate) spawner: Spawner,
    /// The serving processes of the connections the daemon holds, for the caller check.
    pub(crate) provider_services: Arc<ProviderServiceProcesses>,
    /// Resolves the Codex command at each start.
    pub(crate) program: Arc<dyn CodexProgramResolver>,
    /// The daemon's data folder, where the lasting service's record and the services' working
    /// folder live.
    pub(crate) data_folder: PathBuf,
    /// The daemon's logs folder, where the lasting service writes its log.
    pub(crate) logs_folder: PathBuf,
    /// More `key=value` switches every service the daemon starts runs with.
    pub(crate) additional_config_overrides: Vec<String>,
    /// How long a start or redial has to dial and complete its handshake.
    pub(crate) startup_timeout: Duration,
    /// The session's recovery, told of exits, recoveries, crash loops and planned restarts.
    pub(crate) events: Arc<dyn CodexServiceEvents>,
    /// The conversations sessions moved off, which see each of their frames first.
    pub(crate) release: Arc<CodexConversationRelease>,
    /// The drains of the lasting services another took the home's link from, which outlive the
    /// service that asked them and end with the registry's shutdown.
    pub(crate) drains: LastingServiceDrains,
}

/// The socket one service listens on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexServiceSocket {
    /// Where the daemon dials it.
    pub(crate) path: PathBuf,
    /// The home's own control socket, which a terminal joins: the same as `path`, or the link the
    /// home's terminal service is pointed at when this service listens on a socket of its own.
    pub(crate) home_socket: PathBuf,
}

impl CodexServiceSocket {
    /// Whether the service listens on the home's own control socket, which it names with a bare
    /// `unix://`.
    pub(crate) fn is_home_socket(&self) -> bool {
        self.path == self.home_socket
    }
}

/// One service's identity among a driver's services, for the conversation release's bookkeeping.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct CodexServiceId(u64);

// The next service id; ids never repeat within a daemon.
static NEXT_SERVICE_ID: AtomicU64 = AtomicU64::new(1);

/// What `windowsSandbox/readiness` says of the service's sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexWindowsSandboxReadiness {
    /// The sandbox runs commands.
    Ready,
    /// It is not set up, or the reply named a status this daemon does not know.
    NotConfigured,
    /// It needs an update first.
    UpdateRequired,
}

// The member of a `windowsSandbox/readiness` reply the read reads.
#[derive(Deserialize)]
struct WindowsSandboxReadinessReply {
    status: Option<Box<RawValue>>,
}

/// The connection, version and process of the service while it is up.
#[derive(Default)]
struct LiveService {
    connection: Option<Arc<CodexAppServerConnection>>,
    version: Option<SpawnedProviderVersionReading>,
    process_id: Option<u32>,
}

/// One Codex service and the daemon's connection on it.
pub(crate) struct CodexService {
    id: CodexServiceId,
    home: CodexServiceHome,
    socket: CodexServiceSocket,
    dependencies: Arc<CodexServiceDependencies>,
    supervision: Mutex<Supervision>,
    inputs: mpsc::UnboundedSender<RunnerInput>,
    availability: watch::Sender<CodexServiceAvailability>,
    live: Mutex<LiveService>,
    // Where the socket of the process the last start brought up really is, which the home's link
    // is cleared against once that process ends.
    physical_socket: Mutex<Option<PathBuf>>,
    // The record file of the lasting process the last start brought up, which a former daemon's
    // service joined keeps under its own socket's name.
    process_record_file: Mutex<Option<LastingServiceRecordFile>>,
    // Whether the home's link was moved onto this service's own socket and it still holds it.
    holds_home_link: AtomicBool,
    // The ticket of the connection whose frames are routed; an older one's are not.
    routed_dial: AtomicU64,
    threads: Arc<Mutex<CodexServiceThreads>>,
    routing: Mutex<CodexServiceRouting>,
}

impl CodexService {
    /// A stopped service of `kind` on `home` listening on `socket`; its runner runs until the
    /// service is let go of. Must be called within the daemon's runtime.
    pub(crate) fn new(
        home: CodexServiceHome,
        socket: CodexServiceSocket,
        kind: CodexServiceKind,
        dependencies: Arc<CodexServiceDependencies>,
    ) -> Arc<Self> {
        let (inputs, received) = mpsc::unbounded_channel();
        let service = Arc::new(Self {
            id: CodexServiceId(NEXT_SERVICE_ID.fetch_add(1, Ordering::Relaxed)),
            home,
            socket,
            dependencies,
            supervision: Mutex::new(Supervision::new(kind)),
            inputs,
            availability: watch::Sender::new(CodexServiceAvailability::Stopped),
            live: Mutex::default(),
            physical_socket: Mutex::default(),
            process_record_file: Mutex::default(),
            holds_home_link: AtomicBool::new(false),
            routed_dial: AtomicU64::new(0),
            threads: Arc::new(Mutex::new(CodexServiceThreads::new(
                CODEX_THREAD_FRAME_ROUTER_CONFIG.max_pending_hold_frames,
                Arc::new(|unclaimed| {
                    for frame in unclaimed {
                        CodexTransportDiagnostic::UnroutedThreadFrame {
                            method: frame.method,
                            thread_id: frame.thread_id,
                        }
                        .report();
                    }
                }),
            ))),
            routing: Mutex::default(),
        });
        tokio::spawn(ServiceRunner::new(Arc::downgrade(&service), received).run());
        service
    }

    /// The service's identity among the driver's services.
    pub(crate) fn id(&self) -> CodexServiceId {
        self.id
    }

    /// The home the service runs on.
    pub(crate) fn home(&self) -> &CodexServiceHome {
        &self.home
    }

    /// The socket the daemon dials.
    pub(crate) fn socket_path(&self) -> &Path {
        &self.socket.path
    }

    /// Where the socket of the process the last start brought up really is: the target of the link
    /// it was dialed through, or the path itself where that is no link; `None` before any start.
    pub(crate) fn physical_socket(&self) -> Option<PathBuf> {
        self.lock_physical_socket().clone()
    }

    /// The record file of the lasting process the last start brought up; `None` before any start
    /// and for a service with no lasting process.
    pub(crate) fn process_record_file(&self) -> Option<LastingServiceRecordFile> {
        self.lock_process_record_file().clone()
    }

    /// Whether the home's link was moved onto this service's own socket and still belongs to it, so
    /// its restart after a crash points the link back at it.
    pub(crate) fn holds_home_link(&self) -> bool {
        self.holds_home_link.load(Ordering::Acquire)
    }

    /// Records whether the home's link belongs to this service, as the registry moves it on.
    pub(crate) fn set_holds_home_link(&self, is_held: bool) {
        self.holds_home_link.store(is_held, Ordering::Release);
    }

    /// Tells the service a planned restart's second service took its place on its home, so it is
    /// never started again and its record goes once its process ends.
    pub(crate) fn mark_replaced(&self) {
        self.send(SupervisorEvent::Replaced);
    }

    /// The kind of service it is, as its last start found it; a session's recovery and a
    /// conversation's purge read it.
    pub(crate) fn kind(&self) -> CodexServiceKind {
        self.lock_supervision().kind()
    }

    /// The process the daemon started or re-pinned, while it runs.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex session's recovery names the service process in its diagnostics"
        )
    )]
    pub(crate) fn process_id(&self) -> Option<u32> {
        self.lock_live().process_id
    }

    /// The version the running service reported at its last connect, with the build resolved at
    /// its start.
    pub(crate) fn version_reading(&self) -> Option<SpawnedProviderVersionReading> {
        self.lock_live().version.clone()
    }

    /// The account's rate-limit readings this service has seen.
    pub(crate) fn rate_limit_observation(&self) -> CodexRateLimitObservation {
        self.lock_routing().rate_limits.clone()
    }

    /// Replaces the account's rate-limit readings with a complete read's.
    pub(crate) fn store_rate_limit_read(&self, observation: CodexRateLimitObservation) {
        self.lock_routing().rate_limits = observation;
    }

    /// The queue of every session attached to the service.
    pub(crate) fn attached_sessions(&self) -> Vec<CodexSessionInboundSender> {
        self.lock_routing().attached()
    }

    /// The `--listen` address a launch on `socket` starts with: a bare `unix://` on the home's own
    /// control socket, the path otherwise.
    pub(crate) fn listen_address(&self, socket: &Path) -> String {
        if socket == self.socket.home_socket {
            "unix://".to_owned()
        } else {
            format!("unix://{}", socket.display())
        }
    }

    /// Starts the service, or joins it, waiting at most `bound`; callers meanwhile share the
    /// start, and a restart or redial under way is waited for. Fails with `CodexError::Transport`
    /// while the service is down after a crash loop or shut down, while it is still reconnecting
    /// at the bound, and with the start's failure as its cause.
    pub(crate) async fn ensure_started(&self, bound: Duration) -> Result<(), CodexError> {
        let mut availability = self.availability.subscribe();
        let current = availability.borrow_and_update().clone();
        match current {
            CodexServiceAvailability::Up => return Ok(()),
            CodexServiceAvailability::CrashLoop => return Err(crash_loop_refusal()),
            CodexServiceAvailability::ShutDown => return Err(shut_down_refusal()),
            CodexServiceAvailability::Stopped
            | CodexServiceAvailability::Starting
            | CodexServiceAvailability::Reconnecting
            | CodexServiceAvailability::Restarting
            | CodexServiceAvailability::StartFailed(_)
            | CodexServiceAvailability::Stopping => {}
        }
        self.send(SupervisorEvent::Start);
        let waited = tokio::time::timeout(bound, async {
            loop {
                if availability.changed().await.is_err() {
                    return Err(shut_down_refusal());
                }
                let current = availability.borrow_and_update().clone();
                match current {
                    CodexServiceAvailability::Up => return Ok(()),
                    CodexServiceAvailability::StartFailed(failure) => {
                        return Err(CodexError::Transport {
                            detail: "The Codex service could not be started.".to_owned(),
                            cause: Some(Box::new(SharedCodexError(failure))),
                        });
                    }
                    CodexServiceAvailability::CrashLoop => return Err(crash_loop_refusal()),
                    CodexServiceAvailability::ShutDown => return Err(shut_down_refusal()),
                    CodexServiceAvailability::Stopped => {
                        return Err(CodexError::Transport {
                            detail: "The Codex service was stopped while it was starting."
                                .to_owned(),
                            cause: None,
                        });
                    }
                    CodexServiceAvailability::Starting
                    | CodexServiceAvailability::Reconnecting
                    | CodexServiceAvailability::Restarting
                    | CodexServiceAvailability::Stopping => {}
                }
            }
        })
        .await;
        waited.unwrap_or_else(|_elapsed| {
            let is_reconnecting = matches!(
                &*availability.borrow(),
                CodexServiceAvailability::Reconnecting
            );
            let detail = if is_reconnecting {
                "The Codex service is reconnecting.".to_owned()
            } else {
                format!(
                    "The Codex service did not start within {} seconds.",
                    bound.as_secs()
                )
            };
            Err(CodexError::Transport {
                detail,
                cause: None,
            })
        })
    }

    /// The connection while the service is up. Fails with `CodexError::Transport` otherwise.
    pub(crate) fn connection(&self) -> Result<Arc<CodexAppServerConnection>, CodexError> {
        self.lock_live()
            .connection
            .clone()
            .ok_or_else(|| CodexError::Transport {
                detail: "The Codex service is not running.".to_owned(),
                cause: None,
            })
    }

    /// Whether the service takes new work: one draining toward its exit refuses it with Codex's
    /// own words, which refuse `provider.unavailable`, while reads and interrupts go on.
    pub(crate) fn check_takes_new_work(&self, method: &str) -> Result<(), CodexError> {
        if let SupervisorState::Up {
            draining: Some(message),
            ..
        } = self.lock_supervision().state()
        {
            return Err(CodexError::ProviderRequest {
                method: method.to_owned(),
                code: CODEX_INVALID_REQUEST_CODE,
                message: message.clone(),
                reason: Some(CODEX_DRAINING_REASON.to_owned()),
            });
        }
        Ok(())
    }

    /// Opens a second connection on the running service that belongs to no session, for a read
    /// that must not touch one, such as the capability probe, or a conversation of the driver's
    /// own, such as a title's; its notifications and close go to `events`. Fails as a start or a
    /// dial fails.
    pub(crate) async fn open_detached_connection(
        &self,
        events: Arc<dyn CodexConnectionEvents>,
    ) -> Result<CodexAppServerConnection, CodexError> {
        self.ensure_started(self.dependencies.startup_timeout)
            .await?;
        let (sender, receiver) = dial_codex_service_socket(
            &self.socket.path,
            CodexSocketWait::Never,
            &self.dependencies.provider_services,
            &CancellationToken::new(),
        )
        .await?;
        let (connection, _reply) = open_codex_connection(
            sender,
            receiver,
            CodexConnectionHandlers {
                events,
                responder: None,
            },
            CODEX_CLIENT_NAME,
            self.dependencies.startup_timeout,
        )
        .await?;
        Ok(connection)
    }

    /// Stops the service and answers once it is stopped: the daemon's own process ends, a joined
    /// one is only disconnected.
    pub(crate) async fn stop(&self) {
        self.send(SupervisorEvent::Stop);
        self.wait_for(|availability| {
            matches!(
                availability,
                CodexServiceAvailability::Stopped | CodexServiceAvailability::ShutDown
            )
        })
        .await;
    }

    /// Shuts the service down for good as the daemon stops or restarts, and answers once it has;
    /// under a restart a lasting service is only disconnected and keeps running in its record.
    pub(crate) async fn shutdown(&self, intent: DaemonStopIntent) {
        self.send(SupervisorEvent::Shutdown { intent });
        self.wait_for(|availability| matches!(availability, CodexServiceAvailability::ShutDown))
            .await;
    }

    /// The person's restart of a service left down: forgets the crash window and starts it.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex session's restart brings back a service left down after a crash loop"
        )
    )]
    pub(crate) fn restart(&self) {
        self.send(SupervisorEvent::Restart);
    }

    /// A start on the program as it is now: an account service stops and starts, a terminal
    /// service hands its planned restart to the session's recovery, a joined one is redialed.
    pub(crate) fn request_planned_restart(&self) {
        self.send(SupervisorEvent::PlannedRestart);
    }

    /// Restarts an account's service on the program as it is now and answers once it is up
    /// again, the start bounded as [`Self::ensure_started`] bounds it. Fails as that start fails.
    pub(crate) async fn restart_planned(&self) -> Result<(), CodexError> {
        let mut availability = self.availability.subscribe();
        availability.borrow_and_update();
        self.send(SupervisorEvent::PlannedRestart);
        // Up again only once it left Up, so the old process is never taken for the new one.
        if availability
            .wait_for(|current| !matches!(current, CodexServiceAvailability::Up))
            .await
            .is_err()
        {
            return Err(shut_down_refusal());
        }
        self.ensure_started(self.dependencies.startup_timeout).await
    }

    /// The daemon's last conversation on the service closed, so Codex's managed daemon it joined
    /// may be free to take over.
    #[expect(
        dead_code,
        reason = "the Codex session's close tells the service its last conversation closed"
    )]
    pub(crate) fn last_conversation_closed(&self) {
        self.send(SupervisorEvent::LastConversationClosed);
    }

    /// Sends a session's frames and asks to `sender` from now on, and first the config warnings
    /// the service sent that the session has not heard.
    pub(crate) fn attach_session(&self, sender: CodexSessionInboundSender) {
        let session_id = sender.session_id();
        let mut routing = self.lock_routing();
        for warning in routing.config_warnings.take_owed(&session_id) {
            // A queue whose task ended takes nothing more; its session is closing.
            let _unheard = sender.push(CodexSessionInbound::Frame {
                method: CODEX_CONFIG_WARNING_METHOD.to_owned(),
                params: warning,
            });
        }
        routing.attach(sender);
    }

    /// Stops sending a session its frames.
    pub(crate) fn detach_session(&self, session_id: &SessionId) {
        self.lock_routing().detach(session_id);
    }

    /// Queues `item` for one session; answers whether an attached session's queue took it.
    pub(crate) fn push_session_item(
        &self,
        session_id: &SessionId,
        item: CodexSessionInbound,
    ) -> bool {
        self.lock_routing()
            .session(session_id)
            .is_some_and(|session| session.push(item))
    }

    /// Records a conversation as a session's and delivers the frames held for it, in order.
    pub(crate) fn register_thread(&self, thread_id: String, session_id: SessionId) {
        let held = self.lock_threads().register(thread_id, session_id);
        for frame in held {
            self.deliver_thread_frame(&session_id, &frame.thread_id, &frame.method, frame.params);
        }
    }

    /// Forgets one conversation.
    pub(crate) fn release_thread(&self, thread_id: &str) {
        self.lock_threads().release(thread_id);
    }

    /// Every conversation one session holds here: its own and its helpers'.
    pub(crate) fn threads_of(&self, session_id: &SessionId) -> Vec<String> {
        self.lock_threads().threads_of(session_id)
    }

    /// Opens a claim on the conversation a start or fork in flight is about to name, so its
    /// frames are held until it is registered.
    pub(crate) fn begin_thread_claim(&self) -> ThreadClaim {
        CodexServiceThreads::begin_claim(&self.threads)
    }

    /// Answers once Codex sends `thread_id`'s `thread/closed`, or once the connection ends, which
    /// unloads it too. Armed before the step that leads to the close, so the notice cannot come
    /// first; dropping it stops the wait.
    pub(crate) fn wait_for_thread_closed(&self, thread_id: String) -> oneshot::Receiver<()> {
        self.lock_routing().wait_for_closed(thread_id)
    }

    /// The conversations started in a terminal that the service has loaded: every loaded one less
    /// those the daemon's sessions hold. Fails as the read's request does.
    pub(crate) async fn terminal_sessions(&self) -> Result<Vec<String>, CodexError> {
        let loaded = read_codex_loaded_threads(&*self.connection()?).await?;
        let threads = self.lock_threads();
        Ok(loaded
            .into_iter()
            .filter(|thread_id| threads.session_for(thread_id).is_none())
            .collect())
    }

    /// Answers once the service is free to stop: no conversation a session moved off it is held
    /// for a command it still runs, and no terminal session is inside it, each unload awaited as
    /// Codex reports it rather than polled. One starting or reconnecting is waited for first; one
    /// that ended or is stopping holds none. Fails as a read of the loaded conversations fails.
    pub(crate) async fn when_free_to_stop(&self) -> Result<(), CodexError> {
        self.dependencies.release.when_none_held_on(self.id).await;
        loop {
            let mut availability = self.availability.subscribe();
            // The sender lives in the service, which outlives this wait.
            let is_up = availability
                .wait_for(|availability| {
                    !matches!(
                        availability,
                        CodexServiceAvailability::Starting
                            | CodexServiceAvailability::Reconnecting
                            | CodexServiceAvailability::Restarting
                    )
                })
                .await
                .is_ok_and(|settled| matches!(*settled, CodexServiceAvailability::Up));
            if !is_up {
                return Ok(());
            }
            let inside = self.terminal_sessions().await?;
            if inside.is_empty() {
                return Ok(());
            }
            // Armed before the second read, so an unload between the two reads is never missed.
            let mut unloads: HashMap<String, oneshot::Receiver<()>> = inside
                .into_iter()
                .map(|thread_id| {
                    let unloaded = self.wait_for_thread_closed(thread_id.clone());
                    (thread_id, unloaded)
                })
                .collect();
            let still_inside = self.terminal_sessions().await?;
            // A wait whose sender went answers as the connection's end does.
            let _unloaded = join_all(
                still_inside
                    .iter()
                    .filter_map(|thread_id| unloads.remove(thread_id)),
            )
            .await;
        }
    }

    /// Whether the service's Windows sandbox runs commands: only `Ready` offers it; a status this
    /// daemon does not know reads as not configured, never as ready. Fails as the request does.
    #[expect(
        dead_code,
        reason = "the sandboxed permission level's check asks the service on Windows"
    )]
    pub(crate) async fn read_windows_sandbox_readiness(
        &self,
    ) -> Result<CodexWindowsSandboxReadiness, CodexError> {
        let reply = self
            .connection()?
            .request(WINDOWS_SANDBOX_READINESS_METHOD, &())
            .await?;
        Ok(read_windows_sandbox_readiness(&reply))
    }

    /// The handlers of the connection the ticket `dial` opens: its frames routed on its reader,
    /// its asks to their sessions, its drop and drain to the runner.
    fn connection_handlers(self: &Arc<Self>, dial: u64) -> CodexConnectionHandlers {
        CodexConnectionHandlers {
            events: Arc::new(ServiceConnectionEvents {
                service: Arc::downgrade(self),
                dial,
            }),
            responder: Some(Arc::new(CodexServiceAsks::new(Arc::downgrade(self)))
                as Arc<dyn CodexServerRequestResponder>),
        }
    }

    /// Starts a new connection's routing: its reports and its config warnings begin again.
    fn start_connection(&self) {
        self.lock_routing().start_connection();
    }

    /// What the service starts, connects and reports through.
    pub(crate) fn dependencies(&self) -> &CodexServiceDependencies {
        &self.dependencies
    }

    fn is_routed_dial(&self, dial: u64) -> bool {
        self.routed_dial.load(Ordering::Acquire) == dial
    }

    fn lock_routing(&self) -> MutexGuard<'_, CodexServiceRouting> {
        self.routing.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn lock_threads(&self) -> MutexGuard<'_, CodexServiceThreads> {
        self.threads.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn lock_live(&self) -> MutexGuard<'_, LiveService> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn lock_physical_socket(&self) -> MutexGuard<'_, Option<PathBuf>> {
        self.physical_socket
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn lock_process_record_file(&self) -> MutexGuard<'_, Option<LastingServiceRecordFile>> {
        self.process_record_file
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn lock_supervision(&self) -> MutexGuard<'_, Supervision> {
        self.supervision
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn send(&self, event: SupervisorEvent) {
        self.send_input(RunnerInput::event(event));
    }

    fn send_input(&self, input: RunnerInput) {
        // The runner holds no sender, so it runs while the service lives.
        if self.inputs.send(input).is_err() {
            tracing::error!("a Codex service's runner ended while the service lives");
        }
    }

    async fn wait_for(&self, is_reached: impl Fn(&CodexServiceAvailability) -> bool) {
        let mut availability = self.availability.subscribe();
        // The sender lives in the service, which outlives this wait.
        let _reached = availability.wait_for(is_reached).await;
    }
}

/// A start's failure shared by every caller that waited on it.
#[derive(Debug, thiserror::Error)]
#[error(transparent)]
struct SharedCodexError(Arc<CodexError>);

/// The readiness a `windowsSandbox/readiness` reply names.
fn read_windows_sandbox_readiness(reply: &RawValue) -> CodexWindowsSandboxReadiness {
    let status = read_codex_object::<WindowsSandboxReadinessReply>(reply.get())
        .and_then(|reply| reply.status)
        .and_then(|status| serde_json::from_str::<String>(status.get()).ok());
    match status.as_deref() {
        Some("ready") => CodexWindowsSandboxReadiness::Ready,
        Some("updateRequired") => CodexWindowsSandboxReadiness::UpdateRequired,
        Some(_) | None => CodexWindowsSandboxReadiness::NotConfigured,
    }
}

fn crash_loop_refusal() -> CodexError {
    CodexError::Transport {
        detail: "The Codex service ended too many times in a short window and was not restarted."
            .to_owned(),
        cause: None,
    }
}

fn shut_down_refusal() -> CodexError {
    CodexError::Transport {
        detail: "The Codex service was shut down with the daemon.".to_owned(),
        cause: None,
    }
}

/// What a service's connection hands its service: frames routed on the reader, its drop, the
/// asks a close let go of and Codex's drain.
struct ServiceConnectionEvents {
    service: Weak<CodexService>,
    dial: u64,
}

impl CodexConnectionEvents for ServiceConnectionEvents {
    fn notification(&self, method: &str, params: Box<RawValue>) {
        if let Some(service) = self.service.upgrade() {
            service.route(self.dial, method, params);
        }
    }

    fn dropped(&self, reason: &str) {
        if let Some(service) = self.service.upgrade() {
            if service.is_routed_dial(self.dial) {
                CodexTransportDiagnostic::ServiceConnectionDropped {
                    codex_home: service.home.codex_home.clone(),
                    reason: reason.to_owned(),
                }
                .report();
            }
            service.send(SupervisorEvent::Dropped {
                dial: self.dial,
                at: std::time::Instant::now(),
                wall_at: SystemTime::now(),
                process_gone_at: None,
            });
        }
    }

    fn held_requests_dropped(&self, dropped: Vec<CodexForgottenRequest>) {
        if let Some(service) = self.service.upgrade() {
            CodexServiceAsks::new(Arc::downgrade(&service)).withdraw(dropped);
        }
    }

    fn service_draining(&self, message: &str) {
        if let Some(service) = self.service.upgrade() {
            service.send(SupervisorEvent::Draining {
                dial: self.dial,
                message: message.to_owned(),
            });
        }
    }
}

/// The events of a detached connection that starts no conversation: nothing on it belongs to a
/// session.
pub(crate) struct DetachedConnectionEvents;

impl CodexConnectionEvents for DetachedConnectionEvents {
    fn notification(&self, method: &str, _params: Box<RawValue>) {
        CodexTransportDiagnostic::UnconsumedServerNotification {
            method: method.to_owned(),
        }
        .report();
    }

    // A drop fails the reads in flight on it, which is all it carries.
    fn dropped(&self, _reason: &str) {}

    // It starts no conversation, so Codex holds no ask on it.
    fn held_requests_dropped(&self, _dropped: Vec<CodexForgottenRequest>) {}

    // Its read fails with Codex's own words.
    fn service_draining(&self, _message: &str) {}
}
