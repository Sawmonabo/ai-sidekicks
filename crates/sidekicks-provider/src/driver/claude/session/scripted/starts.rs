//! Every process start answered by a script instead of a Claude Code program: a session's process
//! is the next scripted channel, declaring the next scripted `initialize` reply; a one-turn process
//! answers the next scripted reply; a catalog or figures read answers the next scripted reading,
//! and a resting session's command read the next scripted rows;
//! an account read's process and the MCP server probe's process are the next scripted channels;
//! an MCP sign-in's process is the next scripted channel, the next scripted saved sign-ins kept
//! where it was scripted to keep them: its credential folder's file, or the keychain item named
//! for that folder.
//! Each start is recorded with what it asked for. The stop of every process records its deadline
//! and marks it in each channel started, where the order of the channel's writes shows it.

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::Value;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::{StandInKeychain, harness_test_name, run_keychain_tool_stand_in};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::time::Instant;

use super::channel::{ScriptedAnswer, ScriptedChannel};
use crate::driver::claude::account::credentials::{
    CLAUDE_CREDENTIALS_FILE, SECURE_STORAGE_FOLDER_VARIABLE, claude_keychain_account,
    claude_keychain_service,
};
use crate::driver::claude::mcp::ClaudeMcpProcess;
use crate::driver::claude::mcp::connectors::ClaudeAccountServersReadRequest;
use crate::driver::claude::mcp::machine_probe::ClaudeMcpProbeProcessRequest;
use crate::driver::claude::mcp::sign_in::{ClaudeMcpSignInStart, SIGN_IN_KEYCHAIN_ACCOUNT_FILE};
use crate::driver::claude::session::answered_commands::ClaudeAttachedAdvisor;
use crate::driver::claude::session::frame_observation::ClaudeStreamFrameRead;
use crate::driver::claude::session::process::account::ClaudeProcessAccount;
use crate::driver::claude::session::process::{ClaudeProcessListener, ClaudeStreamFrame};
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::ClaudePermissionMode;
use crate::driver::claude::session::transport::declarations::ClaudeInitializeDeclaration;
use crate::driver::claude::session::transport::readings::{
    ClaudeCreationFiguresReading, ClaudeModelCatalogReading, ClaudeReplyReserveReads,
    ClaudeSessionFolderReadRequest,
};
use crate::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::driver::claude::spawn::launch::bring_up::{
    ClaudeBringUpRequest, ClaudeSettingsReadback,
};
use crate::driver::claude::spawn::launch::control_only::ClaudeShortProcessArrival;
use crate::driver::claude::spawn::launch::initialize_reply::ClaudeListedCommand;
use crate::driver::claude::spawn::launch::installed_build::{
    ClaudeProcessStarts, ClaudeStartedSession,
};
use crate::driver::claude::spawn::launch::one_turn::{ClaudeOneTurnOutcome, ClaudeOneTurnRequest};
use crate::driver::claude::spawn::settings::ClaudeSessionAdvisor;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::GetCapabilitiesResult;
use crate::process_identity::ProviderProcessIdentity;
use crate::runtime_binding::test_store::spawned_build;

/// The build every scripted process reports.
pub(super) const SCRIPTED_BUILD_VERSION: &str = "2.1.0";

/// One session start the driver asked for.
pub(crate) struct ScriptedStartRecord {
    /// The conversation it asked to start.
    pub(crate) conversation: ClaudeConversationStart,
    /// Where its frames, requests and exit go.
    pub(crate) listener: Arc<dyn ClaudeProcessListener>,
    /// The account its readers would name, as the launch hands it to them.
    pub(crate) account: ClaudeProcessAccount,
    /// The advisor it starts with.
    pub(crate) advisor: ClaudeSessionAdvisor,
    /// The step bound it starts with.
    pub(crate) step_bound: Option<u32>,
    /// The mode it starts in in place of its level's own.
    pub(crate) permission_mode: Option<ClaudePermissionMode>,
    /// The environment it starts with.
    pub(crate) environment: Vec<(String, String)>,
}

/// One one-turn process the driver asked for.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ScriptedOneTurnRecord {
    /// The model it runs on.
    pub(crate) model: String,
    /// The conversation it copies.
    pub(crate) resume_handle: Option<String>,
    /// The mode it runs in in place of its level's own.
    pub(crate) permission_mode: Option<ClaudePermissionMode>,
    /// The one message it is sent.
    pub(crate) text: String,
}

#[derive(Default)]
struct ScriptedStartTables {
    sessions: VecDeque<Result<Arc<ScriptedChannel>, String>>,
    initializes: VecDeque<ClaudeInitializeDeclaration>,
    resolved_advisors: VecDeque<ClaudeSessionAdvisor>,
    session_holds: VecDeque<oneshot::Receiver<()>>,
    catalogs: VecDeque<Value>,
    catalog_environments: Vec<Vec<(String, String)>>,
    creation_figures: VecDeque<ClaudeCreationFiguresReading>,
    creation_reads: usize,
    session_commands: VecDeque<Vec<ClaudeListedCommand>>,
    session_command_holds: VecDeque<oneshot::Receiver<()>>,
    session_command_reads: usize,
    // Each scripted one turn's outcome, and what it waits for before answering it.
    one_turn_outcomes: VecDeque<(ClaudeOneTurnOutcome, OneTurnWait)>,
    one_turns: Vec<ScriptedOneTurnRecord>,
    one_turn_environments: Vec<Vec<(String, String)>>,
    account_server_channels: VecDeque<Arc<ScriptedChannel>>,
    account_server_holds: VecDeque<oneshot::Receiver<()>>,
    account_server_reads: usize,
    sign_ins: VecDeque<ScriptedSignIn>,
    sign_in_starts: Vec<ScriptedSignInStart>,
    mcp_probes: VecDeque<(Arc<ScriptedChannel>, Vec<Value>)>,
    mcp_probe_starts: Vec<ClaudeMcpProbeProcessRequest>,
    started: Vec<ScriptedStartRecord>,
    started_channels: Vec<Arc<ScriptedChannel>>,
    stop_deadlines: Vec<Instant>,
    stop_hold: Option<oneshot::Receiver<()>>,
    next_process_id: u32,
}

// What a scripted one turn waits for before it answers.
enum OneTurnWait {
    // Nothing: it answers at once.
    Nothing,
    // Its stop.
    Stop,
    // The test's release.
    Release(oneshot::Receiver<()>),
}

// One scripted MCP sign-in's process: its channel, the stored credentials it keeps and where, and
// what it writes once its `initialize` is answered.
struct ScriptedSignIn {
    channel: Arc<ScriptedChannel>,
    credentials: Value,
    place: ScriptedSignInPlace,
    writes: Vec<ScriptedProcessWrite>,
}

/// One thing a scripted MCP sign-in's process writes once its `initialize` is answered, in order.
pub(crate) enum ScriptedProcessWrite {
    /// A frame, read as the reader reads one.
    Frame(Value),
    /// Its exit.
    Exit,
}

/// Where a scripted MCP sign-in's process keeps the sign-ins it saves.
#[derive(Clone, Copy, Debug)]
pub(crate) enum ScriptedSignInPlace {
    /// Its credential folder's `.credentials.json`.
    File,
    /// The keychain item named for its credential folder, in the starts' keychain.
    Keychain,
}

/// One MCP sign-in's process the driver asked for.
pub(crate) struct ScriptedSignInStart {
    /// Its whole environment.
    pub(crate) environment: Vec<(String, String)>,
    /// The servers file it was handed, as read when it started; `None` where it was handed none.
    pub(crate) servers: Option<Value>,
    /// The keychain account its folder recorded when it started; `None` where none was.
    pub(crate) keychain_account_record: Option<String>,
}

/// Every start answered as scripted; a start with nothing scripted fails as a spawn would.
pub(crate) struct ScriptedStarts {
    tables: Mutex<ScriptedStartTables>,
    started: Notify,
    /// The keychain a scripted sign-in saves into, which the driver a test builds reads.
    pub(crate) keychain: StandInKeychain,
}

impl Default for ScriptedStarts {
    fn default() -> Self {
        Self {
            tables: Mutex::default(),
            started: Notify::new(),
            keychain: stand_in_keychain(),
        }
    }
}

impl ScriptedStarts {
    /// Scripts the next session start to bring up `channel`.
    pub(crate) fn script_session(&self, channel: Arc<ScriptedChannel>) {
        self.lock().sessions.push_back(Ok(channel));
    }

    /// Scripts the next session start to fail with `reason`.
    pub(crate) fn script_failed_session(&self, reason: &str) {
        self.lock().sessions.push_back(Err(reason.to_owned()));
    }

    /// Scripts the next session start's process to declare `initialize`, in place of an empty
    /// declaration.
    pub(crate) fn script_initialize(&self, initialize: ClaudeInitializeDeclaration) {
        self.lock().initializes.push_back(initialize);
    }

    /// Scripts the next session start's settings to read back `advisor` as the one its settings
    /// resolve, in place of no effective settings.
    pub(crate) fn script_resolved_advisor(&self, advisor: ClaudeSessionAdvisor) {
        self.lock().resolved_advisors.push_back(advisor);
    }

    /// Holds the next session start, once recorded, until the returned sender fires or drops.
    pub(crate) fn hold_next_session_start(&self) -> oneshot::Sender<()> {
        let (release, held) = oneshot::channel();
        self.lock().session_holds.push_back(held);
        release
    }

    /// Holds the stop of every process, once marked in each channel, until the returned sender
    /// fires or drops.
    pub(crate) fn hold_stop(&self) -> oneshot::Sender<()> {
        let (release, held) = oneshot::channel();
        self.lock().stop_hold = Some(held);
        release
    }

    /// Takes the deadline of each stop of every process so far.
    pub(crate) fn take_stop_deadlines(&self) -> Vec<Instant> {
        std::mem::take(&mut self.lock().stop_deadlines)
    }

    /// Scripts the next model catalog read to answer `initialize` as its `initialize` reply.
    pub(crate) fn script_catalog(&self, initialize: Value) {
        self.lock().catalogs.push_back(initialize);
    }

    /// Scripts the next creation-time figures read to answer `reading`.
    pub(crate) fn script_creation_figures(&self, reading: ClaudeCreationFiguresReading) {
        self.lock().creation_figures.push_back(reading);
    }

    /// Scripts the next resting session's command read to answer `rows`.
    pub(crate) fn script_session_commands(&self, rows: Vec<ClaudeListedCommand>) {
        self.lock().session_commands.push_back(rows);
    }

    /// Holds the next resting session's command read, once counted, until the returned sender
    /// fires or drops.
    pub(crate) fn hold_next_session_commands_read(&self) -> oneshot::Sender<()> {
        let (release, held) = oneshot::channel();
        self.lock().session_command_holds.push_back(held);
        release
    }

    /// Takes the count of resting sessions' command reads so far, each one process.
    pub(crate) fn take_session_commands_read_count(&self) -> usize {
        std::mem::take(&mut self.lock().session_command_reads)
    }

    /// Scripts the next one-turn process to end as `outcome`.
    pub(crate) fn script_one_turn(&self, outcome: ClaudeOneTurnOutcome) {
        let wait = OneTurnWait::Nothing;
        self.lock().one_turn_outcomes.push_back((outcome, wait));
    }

    /// Scripts the next one-turn process to run until its stop fires, then end as `outcome`.
    pub(crate) fn script_one_turn_until_stopped(&self, outcome: ClaudeOneTurnOutcome) {
        let wait = OneTurnWait::Stop;
        self.lock().one_turn_outcomes.push_back((outcome, wait));
    }

    /// Scripts the next one-turn process to run until the answered sender sends or drops, then
    /// end as `outcome`, whether or not anyone still waits for it.
    pub(crate) fn script_one_turn_until_released(
        &self,
        outcome: ClaudeOneTurnOutcome,
    ) -> oneshot::Sender<()> {
        let (release, released) = oneshot::channel();
        let wait = OneTurnWait::Release(released);
        self.lock().one_turn_outcomes.push_back((outcome, wait));
        release
    }

    /// Scripts the next account read to answer `mcp_status` and `settings`, in place of answers
    /// that carry no list and no settings.
    pub(crate) fn script_account_servers(&self, mcp_status: Value, settings: Value) {
        let channel = Arc::new(ScriptedChannel::default());
        channel.answer("mcp_status", ScriptedAnswer::Reply(mcp_status));
        channel.answer("get_settings", ScriptedAnswer::Reply(settings));
        self.script_account_servers_read(channel);
    }

    /// Scripts the next account read's process to be `channel`.
    pub(crate) fn script_account_servers_read(&self, channel: Arc<ScriptedChannel>) {
        self.lock().account_server_channels.push_back(channel);
    }

    /// Holds the next account read, once counted, until the returned sender fires or drops.
    pub(crate) fn hold_next_account_servers_read(&self) -> oneshot::Sender<()> {
        let (release, held) = oneshot::channel();
        self.lock().account_server_holds.push_back(held);
        release
    }

    /// Scripts the next MCP sign-in's process to be `channel`, keeping `credentials` as Claude
    /// Code's stored credentials in `place` once it starts and writing `writes` once its
    /// `initialize` is answered.
    pub(crate) fn script_mcp_sign_in(
        &self,
        channel: Arc<ScriptedChannel>,
        credentials: Value,
        place: ScriptedSignInPlace,
        writes: Vec<ScriptedProcessWrite>,
    ) {
        self.lock().sign_ins.push_back(ScriptedSignIn {
            channel,
            credentials,
            place,
            writes,
        });
    }

    /// Takes each MCP sign-in's process start so far.
    pub(crate) fn take_sign_in_starts(&self) -> Vec<ScriptedSignInStart> {
        std::mem::take(&mut self.lock().sign_in_starts)
    }

    /// Takes the count of account reads so far, each one process.
    pub(crate) fn take_account_servers_read_count(&self) -> usize {
        std::mem::take(&mut self.lock().account_server_reads)
    }

    /// Scripts the next MCP server probe's process to be `channel`, `frames` written once its
    /// `initialize` is answered.
    pub(crate) fn script_mcp_probe(&self, channel: Arc<ScriptedChannel>, frames: Vec<Value>) {
        self.lock().mcp_probes.push_back((channel, frames));
    }

    /// Takes every MCP server probe's start recorded so far, each with its command line.
    pub(crate) fn take_mcp_probe_starts(&self) -> Vec<ClaudeMcpProbeProcessRequest> {
        std::mem::take(&mut self.lock().mcp_probe_starts)
    }

    /// Takes the environment of each model catalog read so far.
    pub(crate) fn take_catalog_environments(&self) -> Vec<Vec<(String, String)>> {
        std::mem::take(&mut self.lock().catalog_environments)
    }

    /// Takes the count of creation-time figures reads so far.
    pub(crate) fn take_creation_read_count(&self) -> usize {
        std::mem::take(&mut self.lock().creation_reads)
    }

    /// Takes every session start recorded so far.
    pub(crate) fn take_started(&self) -> Vec<ScriptedStartRecord> {
        std::mem::take(&mut self.lock().started)
    }

    /// Takes every one-turn process run so far.
    pub(crate) fn take_one_turns(&self) -> Vec<ScriptedOneTurnRecord> {
        std::mem::take(&mut self.lock().one_turns)
    }

    /// Takes the environment of each one-turn process run so far.
    pub(crate) fn take_one_turn_environments(&self) -> Vec<Vec<(String, String)>> {
        std::mem::take(&mut self.lock().one_turn_environments)
    }

    /// Waits until at least `count` session starts were recorded since the last take.
    pub(crate) async fn wait_for_starts(&self, count: usize) {
        loop {
            let notified = self.started.notified();
            if self.lock().started.len() >= count {
                return;
            }
            notified.await;
        }
    }

    fn lock(&self) -> MutexGuard<'_, ScriptedStartTables> {
        sidekicks_std::mutex_lock::lock(&self.tables)
    }
}

impl ClaudeProcessStarts for ScriptedStarts {
    fn start_session<'a>(
        &'a self,
        request: ClaudeBringUpRequest<'a>,
    ) -> BoxFuture<'a, Result<ClaudeStartedSession, ClaudeLaunchError>> {
        async move {
            let (channel, initialize, resolved_advisor, process_id, hold) = {
                let mut tables = self.lock();
                let channel = match tables.sessions.pop_front() {
                    Some(Ok(channel)) => channel,
                    Some(Err(reason)) => return Err(spawn_failure(&reason)),
                    None => return Err(spawn_failure("no session scripted")),
                };
                tables.next_process_id += 1;
                channel.hand_exit_to(Arc::clone(&request.listener));
                tables.started_channels.push(Arc::clone(&channel));
                tables.started.push(ScriptedStartRecord {
                    conversation: request.conversation,
                    listener: request.listener,
                    account: request.account,
                    advisor: request.spawn.legs.advisor.clone(),
                    step_bound: request.spawn.step_bound,
                    permission_mode: request.permission_mode,
                    environment: request.spawn.legs.spawn_environment.clone(),
                });
                (
                    channel,
                    tables.initializes.pop_front().unwrap_or_default(),
                    tables
                        .resolved_advisors
                        .pop_front()
                        .unwrap_or(ClaudeSessionAdvisor::Unpicked),
                    tables.next_process_id,
                    tables.session_holds.pop_front(),
                )
            };
            self.started.notify_one();
            if let Some(hold) = hold {
                // A dropped sender releases the start too.
                hold.await.unwrap_or(());
            }
            Ok(ClaudeStartedSession {
                channel,
                identity: ProviderProcessIdentity {
                    process_id,
                    spawn_sequence: u64::from(process_id),
                },
                initialize,
                settings_readback: ClaudeSettingsReadback {
                    cleanup_period_days: None,
                    auto_memory_enabled: None,
                    attached_advisor: ClaudeAttachedAdvisor::Unreported,
                    resolved_advisor,
                    ultracode: None,
                },
                spawned_version: spawned_build(SCRIPTED_BUILD_VERSION, "/scripted/claude"),
            })
        }
        .boxed()
    }

    fn read_creation_figures(
        &self,
        _place: ClaudeSessionFolderReadRequest,
        _read_models: HashSet<String>,
    ) -> BoxFuture<'static, Result<ClaudeCreationFiguresReading, ClaudeLaunchError>> {
        let reading = {
            let mut tables = self.lock();
            tables.creation_reads += 1;
            tables.creation_figures.pop_front()
        };
        async move { reading.ok_or_else(|| spawn_failure("no figures scripted")) }.boxed()
    }

    fn read_reply_reserve(
        &self,
        _place: ClaudeSessionFolderReadRequest,
    ) -> BoxFuture<'static, Result<ClaudeReplyReserveReads, ClaudeLaunchError>> {
        async { Err(spawn_failure("no reserve scripted")) }.boxed()
    }

    fn run_one_turn<'a>(
        &'a self,
        request: ClaudeOneTurnRequest<'a>,
    ) -> BoxFuture<'a, ClaudeOneTurnOutcome> {
        let outcome = {
            let mut tables = self.lock();
            tables.one_turns.push(ScriptedOneTurnRecord {
                model: request.spawn.legs.model.clone(),
                resume_handle: request.resume_handle,
                permission_mode: request.permission_mode,
                text: request.text.text.clone(),
            });
            tables
                .one_turn_environments
                .push(request.spawn.legs.spawn_environment.clone());
            tables.one_turn_outcomes.pop_front()
        };
        let (outcome, wait) = outcome.unwrap_or_else(|| {
            let outcome = ClaudeOneTurnOutcome {
                reply: Err(spawn_failure("no one-turn reply scripted")),
                spend: None,
            };
            (outcome, OneTurnWait::Nothing)
        });
        let stop = request.stop;
        async move {
            match wait {
                OneTurnWait::Nothing => {}
                OneTurnWait::Stop => stop.cancelled().await,
                // A dropped sender releases the turn as a send does.
                OneTurnWait::Release(released) => {
                    let _is_sent = released.await.is_ok();
                }
            }
            outcome
        }
        .boxed()
    }

    fn probe_sign_in(
        &self,
        _environment: Vec<(String, String)>,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<String, ClaudeLaunchError>> {
        async { Err(spawn_failure("no sign-in scripted")) }.boxed()
    }

    fn read_session_commands(
        &self,
        _environment: Vec<(String, String)>,
        _working_directory: PathBuf,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'static, Result<Vec<ClaudeListedCommand>, ClaudeLaunchError>> {
        let (rows, hold) = {
            let mut tables = self.lock();
            tables.session_command_reads += 1;
            (
                tables.session_commands.pop_front(),
                tables.session_command_holds.pop_front(),
            )
        };
        async move {
            if let Some(hold) = hold {
                // A dropped sender releases the read too.
                hold.await.unwrap_or(());
            }
            rows.ok_or_else(|| spawn_failure("no session commands scripted"))
        }
        .boxed()
    }

    fn read_model_catalog(
        &self,
        environment: Vec<(String, String)>,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<ClaudeModelCatalogReading, ClaudeLaunchError>> {
        let initialize = {
            let mut tables = self.lock();
            tables.catalog_environments.push(environment);
            tables.catalogs.pop_front()
        };
        async move {
            let initialize = initialize.ok_or_else(|| spawn_failure("no catalog scripted"))?;
            Ok(ClaudeModelCatalogReading {
                initialize: Some(
                    serde_json::value::to_raw_value(&initialize)
                        .expect("a scripted reply serializes"),
                ),
                context_usage: None,
            })
        }
        .boxed()
    }

    fn read_capabilities(
        &self,
        _environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<GetCapabilitiesResult, DriverError>> {
        async { Err(DriverError::Internal("no capabilities scripted".into())) }.boxed()
    }

    fn start_account_servers_read(
        &self,
        _request: ClaudeAccountServersReadRequest,
    ) -> BoxFuture<'_, Result<Arc<dyn ClaudeProcessChannel>, ClaudeLaunchError>> {
        let (channel, hold) = {
            let mut tables = self.lock();
            tables.account_server_reads += 1;
            let channel = tables
                .account_server_channels
                .pop_front()
                .unwrap_or_default();
            tables.started_channels.push(Arc::clone(&channel));
            (channel, tables.account_server_holds.pop_front())
        };
        async move {
            if let Some(hold) = hold {
                // A dropped sender releases the read too.
                hold.await.unwrap_or(());
            }
            let channel: Arc<dyn ClaudeProcessChannel> = channel;
            Ok(channel)
        }
        .boxed()
    }

    fn start_mcp_sign_in(
        &self,
        start: ClaudeMcpSignInStart,
    ) -> BoxFuture<'_, Result<ClaudeMcpProcess, ClaudeLaunchError>> {
        let scripted = self.lock().sign_ins.pop_front();
        async move {
            let servers =
                match &start.servers_file {
                    Some(servers_file) => {
                        let servers = tokio::fs::read(servers_file)
                            .await
                            .map_err(ClaudeLaunchError::Spawn)?;
                        Some(serde_json::from_slice(&servers).map_err(|error| {
                            ClaudeLaunchError::Spawn(std::io::Error::other(error))
                        })?)
                    }
                    None => None,
                };
            let keychain_account_record =
                tokio::fs::read_to_string(start.folder.join(SIGN_IN_KEYCHAIN_ACCOUNT_FILE))
                    .await
                    .ok();
            self.lock().sign_in_starts.push(ScriptedSignInStart {
                environment: start.environment.clone(),
                servers,
                keychain_account_record,
            });
            let ScriptedSignIn {
                channel,
                credentials,
                place,
                writes,
            } = scripted.ok_or_else(|| spawn_failure("no sign-in process scripted"))?;
            self.lock().started_channels.push(Arc::clone(&channel));
            match place {
                ScriptedSignInPlace::File => {
                    let credential_folder = start
                        .environment
                        .iter()
                        .find(|(name, _value)| name == SECURE_STORAGE_FOLDER_VARIABLE)
                        .map(|(_name, value)| value.clone())
                        .ok_or_else(|| spawn_failure("no credential folder in the environment"))?;
                    tokio::fs::write(
                        std::path::Path::new(&credential_folder).join(CLAUDE_CREDENTIALS_FILE),
                        credentials.to_string(),
                    )
                    .await
                    .map_err(ClaudeLaunchError::Spawn)?;
                }
                ScriptedSignInPlace::Keychain => self.keychain.put_item(
                    &claude_keychain_service(&start.environment),
                    &claude_keychain_account(&start.environment),
                    credentials.to_string().as_bytes(),
                ),
            }
            let channel: Arc<dyn ClaudeProcessChannel> = channel;
            Ok(ClaudeMcpProcess {
                channel,
                arrivals: scripted_arrivals(writes),
            })
        }
        .boxed()
    }

    fn start_mcp_probe(
        &self,
        request: ClaudeMcpProbeProcessRequest,
    ) -> BoxFuture<'_, Result<ClaudeMcpProcess, ClaudeLaunchError>> {
        let probe = {
            let mut tables = self.lock();
            tables.mcp_probe_starts.push(request);
            tables.mcp_probes.pop_front()
        };
        async move {
            let (channel, frames) = probe.ok_or_else(|| spawn_failure("no probe scripted"))?;
            self.lock().started_channels.push(Arc::clone(&channel));
            let channel: Arc<dyn ClaudeProcessChannel> = channel;
            Ok(ClaudeMcpProcess {
                channel,
                arrivals: scripted_arrivals(frames.into_iter().map(ScriptedProcessWrite::Frame)),
            })
        }
        .boxed()
    }

    fn stop_every_process(&self, deadline: Instant) -> BoxFuture<'_, ()> {
        let (channels, hold) = {
            let mut tables = self.lock();
            tables.stop_deadlines.push(deadline);
            (
                std::mem::take(&mut tables.started_channels),
                tables.stop_hold.take(),
            )
        };
        for channel in &channels {
            channel.mark_processes_stopped();
        }
        async move {
            if let Some(hold) = hold {
                // A dropped sender releases the stop too.
                hold.await.unwrap_or(());
            }
        }
        .boxed()
    }
}

// What a scripted process writes: each of `writes`, a frame read as the reader reads one, and then
// nothing more.
fn scripted_arrivals(
    writes: impl IntoIterator<Item = ScriptedProcessWrite>,
) -> mpsc::UnboundedReceiver<ClaudeShortProcessArrival> {
    let (sender, arrivals) = mpsc::unbounded_channel();
    for write in writes {
        let arrival = match write {
            ScriptedProcessWrite::Frame(frame) => {
                let text = frame.to_string();
                let observation = ClaudeStreamFrameRead::read(&text)
                    .expect("a test frame is an object")
                    .into_observation();
                ClaudeShortProcessArrival::Frame(Box::new(ClaudeStreamFrame { text, observation }))
            }
            ScriptedProcessWrite::Exit => ClaudeShortProcessArrival::Exit,
        };
        sender.send(arrival).expect("the arrivals are held");
    }
    arrivals
}

// A start that fails as a spawn the system refused.
fn spawn_failure(reason: &str) -> ClaudeLaunchError {
    ClaudeLaunchError::Spawn(std::io::Error::other(reason.to_owned()))
}

/// A stand-in keychain whose tool is this module's stand-in test, answering every call as Apple's
/// keychain tool would.
pub(crate) fn stand_in_keychain() -> StandInKeychain {
    StandInKeychain::new(
        &harness_test_name(module_path!(), "the_keychain_tool_stand_in"),
        &[],
    )
}

/// The keychain tool's stand-in, run as `security` through a stand-in keychain's script; it does
/// nothing in any other run.
#[test]
#[ignore = "run only as the keychain tool's stand-in, through a stand-in keychain's script"]
fn the_keychain_tool_stand_in() {
    run_keychain_tool_stand_in();
}
