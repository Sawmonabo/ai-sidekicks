//! The task that moves one service's state: it reads one event at a time, hands it to the
//! transition table and carries out every action the table answers before it reads the next.
//! What an action starts runs in a task of its own and reports back as an event under its ticket,
//! parking any connection or process it made for the runner to adopt or tear down.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant, SystemTime};

use sidekicks_contracts::daemon::lifecycle::DAEMON_STOP_TERMINAL_DRAIN_MS;
use sidekicks_contracts::run::control::ProcessExit;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::service::managed_daemon::stop_codex_managed_daemon;
use crate::provider::driver::codex::service::socket_link::{clear_socket_link_of, is_listening};
use crate::provider::driver::codex::service::start_lock::{CodexStartLock, take_codex_start_lock};
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::service::supervisor::drain::drain_lasting_service;
use crate::provider::driver::codex::service::supervisor::reconnect::reconnect_wait;
use crate::provider::driver::codex::service::supervisor::start::kept_records::retire_own_record;
use crate::provider::driver::codex::service::supervisor::start::{
    CodexServiceProcess, StartedService, connect, read_codex_loaded_threads, read_service_version,
    start_codex_service,
};
use crate::provider::driver::codex::service::supervisor::transition::SupervisorEvent;
use crate::provider::driver::codex::service::supervisor::transition::action::{
    LastingServiceEnd, SupervisorAction,
};
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;
use crate::provider::driver::codex::transport::diagnostics::{
    CodexTeardownStep, CodexTransportDiagnostic,
};
use crate::provider::driver::codex::transport::socket::CodexSocketWait;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::spawned_version::SpawnedProviderVersionReading;

/// How long the daemon's own service has to stop before it is killed, as long as the daemon
/// gives every child at its own stop.
pub(super) const SERVICE_STOP_GRACE: Duration =
    Duration::from_millis(DAEMON_STOP_TERMINAL_DRAIN_MS);

/// One event for the runner, with what its outcome parked for the runner to adopt or tear down.
pub(super) struct RunnerInput {
    event: SupervisorEvent,
    // What the outcome parked, under its ticket.
    parked: Option<(u64, Parked)>,
    exit: Option<ProcessExit>,
    // Codex's start lock, held for the start the event leads to.
    start_lock: Option<CodexStartLock>,
}

impl RunnerInput {
    /// An event that parks nothing.
    pub(super) fn event(event: SupervisorEvent) -> Self {
        Self {
            event,
            parked: None,
            exit: None,
            start_lock: None,
        }
    }
}

/// What an outcome left for the runner, under its ticket.
enum Parked {
    Started(StartedService),
    Failed(Option<CodexServiceProcess>),
    Dialed {
        connection: Arc<CodexAppServerConnection>,
        version: Option<SpawnedProviderVersionReading>,
    },
}

/// The task that moves one service's state and carries out each answer whole. It holds no sender
/// of its own input, so it ends once the service is let go of.
pub(super) struct ServiceRunner {
    service: Weak<CodexService>,
    inputs: mpsc::UnboundedReceiver<RunnerInput>,
    parked: HashMap<u64, Parked>,
    process: Option<CodexServiceProcess>,
    // Stands down the start, redial or wait under way.
    pending: CancellationToken,
    // How the process last ended, until the exit is reported.
    last_exit: Option<ProcessExit>,
    // Codex's start lock an input carried, for the start its event leads to.
    start_lock: Option<CodexStartLock>,
}

impl ServiceRunner {
    /// A runner for `service`, reading `inputs`.
    pub(super) fn new(
        service: Weak<CodexService>,
        inputs: mpsc::UnboundedReceiver<RunnerInput>,
    ) -> Self {
        Self {
            service,
            inputs,
            parked: HashMap::new(),
            process: None,
            pending: CancellationToken::new(),
            last_exit: None,
            start_lock: None,
        }
    }

    /// Runs until the service is let go of.
    pub(super) async fn run(mut self) {
        while let Some(input) = self.inputs.recv().await {
            let Some(service) = self.service.upgrade() else {
                return;
            };
            let RunnerInput {
                mut event,
                parked,
                exit,
                start_lock,
            } = input;
            if let Some((ticket, parked)) = parked {
                self.parked.insert(ticket, parked);
            }
            if exit.is_some() {
                self.last_exit = exit;
            }
            self.start_lock = start_lock;
            self.read_process_gone(&mut event);
            let actions = service.lock_supervision().transition(event);
            for action in actions {
                self.carry_out(&service, action).await;
            }
            // A lock no start took is let go of with its event.
            self.start_lock = None;
        }
    }

    // A lasting service a former daemon started has no exit to wait on, so a drop or a failed
    // redial reads whether its pinned process is gone.
    fn read_process_gone(&self, event: &mut SupervisorEvent) {
        let (SupervisorEvent::Dropped {
            process_gone_at, ..
        }
        | SupervisorEvent::ReconnectFailed {
            process_gone_at, ..
        }) = event
        else {
            return;
        };
        if let Some(CodexServiceProcess::Lasting { service, .. }) = &self.process
            && service.exited().is_none()
        {
            match service.has_ended() {
                Ok(true) => *process_gone_at = Some(SystemTime::now()),
                Ok(false) => {}
                Err(error) => tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "whether the Codex terminal service is still running could not be read"
                ),
            }
        }
    }

    async fn carry_out(&mut self, service: &Arc<CodexService>, action: SupervisorAction) {
        match action {
            SupervisorAction::Launch { launch } => self.launch(service, launch),
            SupervisorAction::AdoptStart { launch } => self.adopt_start(service, launch),
            SupervisorAction::AdoptDial { dial } => self.adopt_dial(service, dial),
            SupervisorAction::TearDown { ticket, end } => self.tear_down(service, ticket, end),
            SupervisorAction::Disconnect { is_process_gone } => {
                self.disconnect(service, is_process_gone);
                if is_process_gone {
                    clear_home_socket_link(service, service.physical_socket()).await;
                }
            }
            SupervisorAction::Dial { dial, attempt } => self.dial(service, dial, attempt),
            SupervisorAction::WaitToRestart { ticket, wait } => {
                let waiting = Arc::clone(service);
                let cancel = self.pending.child_token();
                tokio::spawn(async move {
                    tokio::select! {
                        () = cancel.cancelled() => {}
                        () = tokio::time::sleep(wait) => {
                            waiting.send(SupervisorEvent::WaitElapsed { wait: ticket });
                        }
                    }
                });
            }
            SupervisorAction::CancelPending => {
                self.pending.cancel();
                self.pending = CancellationToken::new();
            }
            SupervisorAction::StopService { launch, end } => {
                self.stop_service(service, launch, end);
            }
            SupervisorAction::CheckJoinedServiceFree { dial } => {
                check_joined_service_free(service, dial);
            }
            SupervisorAction::BeginPlannedRestart => {
                service
                    .dependencies
                    .events
                    .planned_restart_requested(service);
            }
            SupervisorAction::ReportRecovered(cause) => {
                service.dependencies.events.recovered(service, cause);
            }
            SupervisorAction::ReportProcessExited => {
                let exit = self.last_exit.take();
                service
                    .dependencies
                    .events
                    .process_exited(service, exit.as_ref());
            }
            SupervisorAction::ReportCrashLoop => {
                clear_home_socket_link(service, service.physical_socket()).await;
                report_crash_loop(service);
                service.dependencies.events.crash_loop(service);
            }
            SupervisorAction::RetireRecord => {
                let retiring = Arc::clone(service);
                tokio::spawn(async move {
                    if let Err(error) = retire_own_record(&retiring).await {
                        CodexTransportDiagnostic::TeardownStepFailed {
                            step: CodexTeardownStep::ServiceStop,
                            error: Box::new(error),
                        }
                        .report();
                    }
                });
            }
            // The connection's own drop already reported it, on the reader.
            SupervisorAction::ReportDropped => {}
            SupervisorAction::ReportStartFailed(failure) => {
                CodexTransportDiagnostic::ServiceStartFailed {
                    codex_home: service.home.codex_home.clone(),
                    error: Box::new(super::SharedCodexError(failure)),
                }
                .report();
            }
            SupervisorAction::Publish(availability) => {
                service.availability.send_replace(availability);
            }
        }
    }

    fn launch(&mut self, service: &Arc<CodexService>, launch: u64) {
        service.routed_dial.store(launch, Ordering::Release);
        let starting = Arc::clone(service);
        let cancel = self.pending.child_token();
        let start_lock = self.start_lock.take();
        tokio::spawn(async move {
            let started = start_codex_service(Arc::clone(&starting), launch, cancel, start_lock);
            let input = match started.await {
                Ok(started) => RunnerInput {
                    event: SupervisorEvent::Started {
                        launch,
                        at: Instant::now(),
                        kind: started.kind,
                    },
                    parked: Some((launch, Parked::Started(started))),
                    exit: None,
                    start_lock: None,
                },
                Err(failure) => RunnerInput {
                    event: SupervisorEvent::StartFailed {
                        launch,
                        at: SystemTime::now(),
                        failure: Arc::new(failure.error),
                    },
                    parked: Some((launch, Parked::Failed(failure.process))),
                    exit: None,
                    start_lock: None,
                },
            };
            starting.send_input(input);
        });
    }

    fn adopt_start(&mut self, service: &Arc<CodexService>, launch: u64) {
        let Some(Parked::Started(started)) = self.parked.remove(&launch) else {
            return;
        };
        if let Some(exit) = started
            .process
            .as_ref()
            .and_then(CodexServiceProcess::exited)
        {
            let watching = Arc::downgrade(service);
            tokio::spawn(async move {
                let exit = exit.await;
                if let Some(watching) = watching.upgrade() {
                    watching.send_input(RunnerInput {
                        event: SupervisorEvent::ProcessExited {
                            launch,
                            at: SystemTime::now(),
                        },
                        parked: None,
                        exit: exit.ok(),
                        start_lock: None,
                    });
                }
            });
        }
        log_version(service, &started.version);
        *service.lock_physical_socket() = Some(started.physical_socket);
        *service.lock_process_record_file() = match &started.process {
            Some(CodexServiceProcess::Lasting { record_file, .. }) => Some(record_file.clone()),
            Some(CodexServiceProcess::Managed(_)) | None => None,
        };
        *service.lock_live() = super::LiveService {
            connection: Some(started.connection),
            process_id: started
                .process
                .as_ref()
                .and_then(CodexServiceProcess::process_id),
            version: Some(started.version),
        };
        self.process = started.process;
        if started.is_restart_owed {
            service.send(SupervisorEvent::PlannedRestart);
        }
    }

    fn adopt_dial(&mut self, service: &Arc<CodexService>, dial: u64) {
        let Some(Parked::Dialed {
            connection,
            version,
        }) = self.parked.remove(&dial)
        else {
            return;
        };
        if let Some(version) = &version {
            log_version(service, version);
        }
        let mut live = service.lock_live();
        if version.is_some() {
            live.version = version;
        }
        live.connection = Some(connection);
    }

    fn tear_down(&mut self, service: &Arc<CodexService>, ticket: u64, end: LastingServiceEnd) {
        let parked = self.parked.remove(&ticket);
        let stopping = Arc::clone(service);
        tokio::spawn(async move {
            match parked {
                Some(Parked::Started(started)) => {
                    close_connection(&started.connection).await;
                    if let Some(process) = started.process
                        && stop_process(&stopping, process, end).await
                    {
                        clear_home_socket_link(&stopping, Some(started.physical_socket)).await;
                    }
                }
                Some(Parked::Failed(Some(process))) => {
                    stop_process(&stopping, process, end).await;
                }
                Some(Parked::Dialed { connection, .. }) => close_connection(&connection).await,
                Some(Parked::Failed(None)) | None => {}
            }
            stopping.send(SupervisorEvent::StopDone { ticket });
        });
    }

    fn disconnect(&mut self, service: &Arc<CodexService>, is_process_gone: bool) {
        let connection = {
            let mut live = service.lock_live();
            if is_process_gone {
                live.process_id = None;
            }
            live.connection.take()
        };
        // The connection's end unloads every conversation on it.
        service.lock_routing().settle_closed(None);
        if is_process_gone {
            self.process = None;
        }
        if let Some(connection) = connection {
            tokio::spawn(async move { close_connection(&connection).await });
        }
    }

    fn dial(&self, service: &Arc<CodexService>, dial: u64, attempt: u32) {
        service.routed_dial.store(dial, Ordering::Release);
        let dialing = Arc::clone(service);
        let cancel = self.pending.child_token();
        tokio::spawn(async move {
            let sample = match getrandom::u64() {
                Ok(sample) => sample,
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "the reconnect wait's jitter could not be drawn; it waits the middle"
                    );
                    u64::MAX / 2
                }
            };
            tokio::select! {
                () = cancel.cancelled() => return,
                () = tokio::time::sleep(reconnect_wait(attempt, sample)) => {}
            }
            // The socket of the service's own process, which the home's link may no longer name.
            let socket = dialing
                .physical_socket()
                .unwrap_or_else(|| dialing.socket_path().to_owned());
            let connected = connect(
                &dialing,
                &socket,
                dial,
                CodexSocketWait::Never,
                None,
                &cancel,
            );
            let input = match connected.await {
                Ok((connection, reply)) => {
                    let version = match dialing.dependencies.program.resolve(&dialing.home).await {
                        Ok(executable) => read_service_version(&reply, &executable)
                            .inspect_err(|error| report_version_unread(error))
                            .ok(),
                        Err(error) => {
                            report_version_unread(&error);
                            None
                        }
                    };
                    RunnerInput {
                        event: SupervisorEvent::Reconnected {
                            dial,
                            at: Instant::now(),
                        },
                        parked: Some((
                            dial,
                            Parked::Dialed {
                                connection,
                                version,
                            },
                        )),
                        exit: None,
                        start_lock: None,
                    }
                }
                Err(error) => {
                    tracing::debug!(
                        error = &error as &(dyn std::error::Error + 'static),
                        attempt,
                        "a Codex service redial failed"
                    );
                    // A socket whose state cannot be read is redialed, never started over.
                    let is_listening = is_listening(&socket).await.unwrap_or_else(|error| {
                        tracing::warn!(
                            error = &error as &(dyn std::error::Error + 'static),
                            "whether the Codex service's socket listens could not be read"
                        );
                        true
                    });
                    RunnerInput::event(SupervisorEvent::ReconnectFailed {
                        dial,
                        is_listening,
                        process_gone_at: None,
                    })
                }
            };
            dialing.send_input(input);
        });
    }

    fn stop_service(&mut self, service: &Arc<CodexService>, launch: u64, end: LastingServiceEnd) {
        let connection = std::mem::take(&mut *service.lock_live()).connection;
        service.lock_routing().settle_closed(None);
        let process = self.process.take();
        let stopping = Arc::clone(service);
        tokio::spawn(async move {
            if let Some(connection) = connection {
                close_connection(&connection).await;
            }
            if let Some(process) = process
                && stop_process(&stopping, process, end).await
            {
                clear_home_socket_link(&stopping, stopping.physical_socket()).await;
            }
            stopping.send(SupervisorEvent::StopDone { ticket: launch });
        });
    }
}

// Codex's own managed daemon, joined while it had conversations of its own, is stopped once it
// has none, under its start lock, which the daemon's own terminal service's start keeps, so it
// takes the managed daemon's place with no terminal starting another in between. A listener no
// pid file names is left joined.
fn check_joined_service_free(service: &Arc<CodexService>, dial: u64) {
    let Ok(connection) = service.connection() else {
        return;
    };
    let checking = Arc::clone(service);
    tokio::spawn(async move {
        match read_codex_loaded_threads(&connection).await {
            Ok(loaded) if loaded.is_empty() => {}
            Ok(_still_used) => return,
            Err(error) => {
                tracing::debug!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "whether Codex's own service is free could not be read"
                );
                return;
            }
        }
        let codex_home = checking.home.codex_home.clone();
        let stopped = async {
            let lock =
                take_codex_start_lock(&codex_home, checking.dependencies.startup_timeout).await?;
            let is_stopped =
                stop_codex_managed_daemon(&codex_home, checking.socket_path(), &lock).await?;
            Ok::<_, io::Error>(is_stopped.then_some(lock))
        };
        match stopped.await {
            Ok(Some(lock)) => checking.send_input(RunnerInput {
                event: SupervisorEvent::JoinedServiceFreed { dial },
                parked: None,
                exit: None,
                start_lock: Some(lock),
            }),
            Ok(None) => {}
            Err(error) => report_stop_failed(error),
        }
    });
}

fn report_crash_loop(service: &CodexService) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: service.home.provider_account_id.clone(),
        kind: DriverDiagnosticKind::ProviderCrashLoop,
        raw_wire_type: None,
        disposition_reason: "the Codex service ended on its own too many times in the crash \
                             window, so it was not restarted"
            .to_owned(),
        details: serde_json::Map::from_iter([(
            "codexHome".to_owned(),
            serde_json::Value::String(service.home.codex_home.display().to_string()),
        )]),
    });
}

// Logs the version a connect read, never branching on it.
fn log_version(service: &CodexService, version: &SpawnedProviderVersionReading) {
    tracing::info!(
        codex_home = %service.home.codex_home.display(),
        version = version.report.raw_version.as_str(),
        executable = %version.resolved_executable_path.display(),
        "the Codex service reported its version"
    );
}

fn report_version_unread(error: &(dyn std::error::Error + 'static)) {
    tracing::warn!(
        error,
        "the version of a redialed Codex service could not be read"
    );
}

async fn close_connection(connection: &CodexAppServerConnection) {
    if let Err(error) = connection.close().await {
        tracing::debug!(
            error = &error as &(dyn std::error::Error + 'static),
            "a Codex connection did not close cleanly"
        );
    }
}

// Ends a service process by its kind: the daemon's own child asked to stop and killed once the
// wait runs out; a lasting service as `end` says: drained to its end, stopped with its record
// removed, or left running in its record. Answers whether it was ended.
async fn stop_process(
    service: &CodexService,
    process: CodexServiceProcess,
    end: LastingServiceEnd,
) -> bool {
    match process {
        CodexServiceProcess::Managed(managed) => {
            managed.stop();
            if tokio::time::timeout(SERVICE_STOP_GRACE, managed.exited())
                .await
                .is_err()
            {
                managed.kill();
                if let Err(error) = managed.exited().await {
                    report_stop_failed(io::Error::new(error.kind(), error.to_string()));
                }
            }
        }
        CodexServiceProcess::Lasting {
            service: lasting,
            record_file,
        } => match end {
            LastingServiceEnd::Keep => return false,
            LastingServiceEnd::Drain => {
                return drain_lasting_service(
                    &service.dependencies.drains,
                    lasting,
                    record_file,
                    service.socket_path(),
                )
                .await;
            }
            LastingServiceEnd::Stop => {
                if let Err(error) = lasting
                    .stop(SERVICE_STOP_GRACE, service.socket_path())
                    .await
                {
                    report_stop_failed(error);
                }
                let stopped = lasting.record().clone();
                let removed =
                    tokio::task::spawn_blocking(move || record_file.remove_if_naming(&stopped))
                        .await
                        .map_err(io::Error::other)
                        .and_then(|removed| removed);
                if let Err(error) = removed {
                    report_stop_failed(error);
                }
            }
        },
    }
    true
}

// Takes the home's link off `physical_socket`, where the socket of the service's ended process
// really was: a clean exit removed Codex's own link already, a killed one left it dangling, and a
// link the daemon moved onto another service's socket is left.
async fn clear_home_socket_link(service: &CodexService, physical_socket: Option<PathBuf>) {
    let Some(physical_socket) = physical_socket else {
        return;
    };
    let home_socket = service.socket.home_socket.clone();
    let cleared =
        tokio::task::spawn_blocking(move || clear_socket_link_of(&home_socket, &physical_socket))
            .await
            .map_err(io::Error::other)
            .and_then(|cleared| cleared);
    if let Err(error) = cleared {
        report_stop_failed(error);
    }
}

/// Reports a failed step of a service's stop, which the stop carries on past.
pub(super) fn report_stop_failed(error: io::Error) {
    CodexTransportDiagnostic::TeardownStepFailed {
        step: CodexTeardownStep::ServiceStop,
        error: Box::new(error),
    }
    .report();
}
