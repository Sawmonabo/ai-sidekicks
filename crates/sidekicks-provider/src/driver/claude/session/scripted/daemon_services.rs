//! The daemon services a scripted session reaches: approval ports, a queue intake and a status
//! line intake that record what reaches them, files whose read takes a set time, the bindings of
//! daemon turns, a binding store that takes every write and a machine with no repositories.

use std::collections::HashMap;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::ready;
use serde_json::{Map, Value};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::tool_call_status::TOOL_CALL_STATUS_MAX_LEN;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::mutex_lock::lock;

use super::binding_id;
use super::driver::create_params;
use crate::callback_tools::host::{
    CallbackToolActivityRecord, CallbackToolActivitySink, CallbackToolExecutor, CallbackToolHost,
    CallbackToolPortError, CallbackToolSpawnRequest,
};
use crate::callback_tools::spawn_binding::{
    CallbackToolSpawnBinding, bind_callback_tools_for_spawn,
};
use crate::driver::attachments::{
    AttachmentResolver, ProviderAttachment, ResolvedAttachment, UnresolvedAttachmentCause,
    UnresolvedAttachmentMarker,
};
use crate::driver::callback_tool::{CallbackToolInvocation, CallbackToolResult};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::ports::{DriverPorts, MessageTakenListener, ProcessGoneListener};
use crate::driver::run_control::{
    DaemonTurnAdmission, DaemonTurnBinding, DaemonTurnBindingError, DaemonTurnBindingResolver,
    DaemonTurnProcess,
};
use crate::driver::session_control::SessionToolServer;
use crate::driver::test_registry::new_agent_id;
use crate::port::permission_ask::{
    PermissionAskPort, ProviderPermissionAsk, ProviderPermissionAskWithdrawal,
};
use crate::port::repository_reader::{RepositoryReader, RepositoryReading};
use crate::port::reviewer_denial::{ProviderReviewerDenial, ReviewerDenialPort};
use crate::port::session_message_reading_publisher::{
    SessionMessageReading, SessionMessageReadingPublisher,
};
use crate::port::tool_call_status_publisher::ToolCallStatusPublisher;
use crate::port::tool_traces::ToolTraces;
use crate::port::tool_traces::test_port::KeptToolTraces;
use crate::port::usage_sink::{
    MeteredUsage, PricedRequest, ProviderQuotaWindow, RecordedUsage, UsageSink,
};
use crate::runtime_binding::store::RuntimeBindingRebind;
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::runtime_binding::writer::RuntimeBindingWriter;
use crate::usage_delta_accountant::UsageAxisCounts;

/// What reached the approval ports and the status line intake, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PortCall {
    /// An ask, by its request id.
    Ask(String),
    /// An ask's withdrawal, by its request id.
    AskWithdrawn(String),
    /// A reviewer's block, by the run it was made in.
    Denial(RunId),
    /// The held presses of an ended process's binding, released.
    PressesReleased(RuntimeBindingId),
    /// A session's process told gone, once a test registers the recorder for it.
    ProcessGone(SessionId),
    /// A tool call's status line, by the call's id; `None` for a clear.
    ToolCallStatus {
        /// The call.
        tool_call_id: String,
        /// Its new line, or `None` where it was cleared.
        status: Option<String>,
    },
}

/// What brings a session's process up for a daemon turn's binding, as the queue's open does.
pub(crate) type ScriptedProcessOpener =
    Arc<dyn Fn(SessionId) -> BoxFuture<'static, ()> + Send + Sync>;

/// Approval ports, the queue's intake of taken messages, the status line intake, the session
/// message readings and the tool traces, each recording what reaches it, and the queue's opening
/// of a daemon turn's process once a test sets one, its refusal of every daemon turn's binding,
/// or a live-only binding answered as one whose process was let go.
#[derive(Default)]
pub(crate) struct RecordingPorts {
    calls: Mutex<Vec<PortCall>>,
    taken: Mutex<Vec<(String, RunId)>>,
    message_readings: Mutex<Vec<SessionMessageReading>>,
    process_opener: Mutex<Option<ScriptedProcessOpener>>,
    refuses_daemon_turn_bindings: AtomicBool,
    has_let_processes_go: AtomicBool,
    /// The tool traces the driver records, its switch off until a test turns it on.
    pub(crate) tool_traces: Arc<KeptToolTraces>,
}

impl RecordingPorts {
    /// Every call so far, in order.
    pub(crate) fn calls(&self) -> Vec<PortCall> {
        lock(&self.calls).clone()
    }

    /// The messages reported taken so far, with the run each was reported under.
    pub(crate) fn taken(&self) -> Vec<(String, RunId)> {
        lock(&self.taken).clone()
    }

    /// The session message readings published so far, in order.
    pub(crate) fn message_readings(&self) -> Vec<SessionMessageReading> {
        lock(&self.message_readings).clone()
    }

    /// Brings each daemon turn's session process up through `opener` before its binding opens.
    pub(crate) fn open_processes_for_daemon_turns(&self, opener: ScriptedProcessOpener) {
        *lock(&self.process_opener) = Some(opener);
    }

    /// Answers every live-only daemon turn's binding from now on as the queue does once the
    /// session's process was let go: `NoProviderSession`, nothing opened.
    pub(crate) fn let_processes_go(&self) {
        self.has_let_processes_go.store(true, Ordering::SeqCst);
    }

    /// Refuses every daemon turn's binding from now on, as the queue refuses one on a session
    /// closed meanwhile.
    pub(crate) fn refuse_daemon_turn_bindings(&self) {
        self.refuses_daemon_turn_bindings
            .store(true, Ordering::SeqCst);
    }

    fn record(&self, call: PortCall) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.calls).push(call);
        async { Ok(()) }.boxed()
    }
}

impl PermissionAskPort for RecordingPorts {
    fn take_ask(
        &self,
        ask: ProviderPermissionAsk,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.record(PortCall::Ask(ask.request_id))
    }

    fn withdraw_ask(
        &self,
        withdrawal: ProviderPermissionAskWithdrawal,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.record(PortCall::AskWithdrawn(withdrawal.request_id))
    }
}

impl ReviewerDenialPort for RecordingPorts {
    fn take_denial(
        &self,
        denial: ProviderReviewerDenial,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.record(PortCall::Denial(denial.run_id))
    }

    fn release_held_presses(&self, binding_id: &RuntimeBindingId) {
        lock(&self.calls).push(PortCall::PressesReleased(binding_id.clone()));
    }
}

impl ProcessGoneListener for RecordingPorts {
    fn process_gone(&self, session_id: SessionId) {
        lock(&self.calls).push(PortCall::ProcessGone(session_id));
    }
}

impl ToolCallStatusPublisher for RecordingPorts {
    fn publish_tool_call_status(
        &self,
        _session_id: SessionId,
        tool_call_id: ToolCallId,
        status: FreeFormText<TOOL_CALL_STATUS_MAX_LEN>,
    ) {
        lock(&self.calls).push(PortCall::ToolCallStatus {
            tool_call_id: tool_call_id.as_str().to_owned(),
            status: Some(status.as_str().to_owned()),
        });
    }

    fn clear_tool_call_status(&self, _session_id: SessionId, tool_call_id: ToolCallId) {
        lock(&self.calls).push(PortCall::ToolCallStatus {
            tool_call_id: tool_call_id.as_str().to_owned(),
            status: None,
        });
    }
}

impl MessageTakenListener for RecordingPorts {
    fn message_taken(&self, _session_id: SessionId, message_id: &str, run_id: RunId) {
        lock(&self.taken).push((message_id.to_owned(), run_id));
    }
}

impl SessionMessageReadingPublisher for RecordingPorts {
    fn publish(&self, reading: SessionMessageReading) {
        lock(&self.message_readings).push(reading);
    }
}

/// Registers what a scripted driver composes over: `recording` as the approval ports, the queue's
/// intake, the status line intake, the session message readings and the tool traces, every daemon
/// turn on one binding, and a machine with no repositories.
pub(super) fn register_scripted_ports(ports: &DriverPorts, recording: &Arc<RecordingPorts>) {
    ports
        .daemon_turn_bindings
        .register(Arc::new(ScriptedBindings(Arc::clone(recording))))
        .expect("the turn bindings register once");
    ports
        .repositories
        .register(Arc::new(NoRepositories))
        .expect("the repositories register once");
    ports
        .reviewer_denials
        .register(recording.clone())
        .expect("the denials register once");
    ports
        .permission_asks
        .register(recording.clone())
        .expect("the asks register once");
    ports
        .message_taken
        .register(recording.clone())
        .expect("the intake registers once");
    ports
        .tool_call_statuses
        .register(recording.clone())
        .expect("the status lines register once");
    ports
        .session_message_readings
        .register(recording.clone())
        .expect("the message readings register once");
    ports
        .tool_traces
        .register(Arc::clone(&recording.tool_traces) as Arc<dyn ToolTraces>)
        .expect("the tool traces register once");
}

/// A usage record that keeps each metered delta, each priced request and each set of quota
/// windows, answers each delta a row of its own charged to the account it is set to, and answers
/// one set of sums as every thread's already reported ones.
#[derive(Default)]
pub(crate) struct RecordingUsage {
    reported: Mutex<UsageAxisCounts>,
    metered: Mutex<Vec<MeteredUsage>>,
    priced: Mutex<Vec<PricedRequest>>,
    // The account each row is charged to, the test account until a test moves it.
    account: Mutex<Option<ProviderAccountId>>,
    quota_windows: Mutex<Vec<(ProviderAccountId, Vec<ProviderQuotaWindow>)>>,
}

impl RecordingUsage {
    /// Answers `reported` as the sums already reported under every thread.
    pub(crate) fn report_prior(&self, reported: UsageAxisCounts) {
        *lock(&self.reported) = reported;
    }

    /// Every set of quota windows taken so far, a push or a whole set, with its account, in order.
    pub(crate) fn quota_windows(&self) -> Vec<(ProviderAccountId, Vec<ProviderQuotaWindow>)> {
        lock(&self.quota_windows).clone()
    }

    /// Every delta metered so far, with where it came from, in order.
    pub(crate) fn metered(&self) -> Vec<MeteredUsage> {
        lock(&self.metered).clone()
    }

    /// Every request priced so far, in order.
    pub(crate) fn priced(&self) -> Vec<PricedRequest> {
        lock(&self.priced).clone()
    }

    /// Each request priced so far, in order, as its cost's source and its rows' accounts with their
    /// shares.
    pub(crate) fn priced_shares(&self) -> Vec<(UsageCostSource, Vec<(String, u64)>)> {
        let shares = |request: &PricedRequest| {
            let rows = request.rows.iter().map(|priced| {
                let account = priced.row.provider_account_id.as_str().to_owned();
                (account, priced.cost_usd_micros.0.get())
            });
            (request.cost_source, rows.collect())
        };
        lock(&self.priced).iter().map(shares).collect()
    }

    /// Charges every later row to `account`.
    pub(crate) fn charge_to(&self, account: ProviderAccountId) {
        *lock(&self.account) = Some(account);
    }
}

impl UsageSink for RecordingUsage {
    fn record_metered(
        &self,
        metered: MeteredUsage,
    ) -> BoxFuture<'_, Result<Option<RecordedUsage>, Box<dyn Error + Send + Sync>>> {
        let mut all_metered = lock(&self.metered);
        all_metered.push(metered);
        let recorded = RecordedUsage {
            event_id: FreeFormText::new(format!("row-{}", all_metered.len()))
                .expect("a row id fits"),
            run_id: None,
            provider_account_id: lock(&self.account)
                .clone()
                .unwrap_or_else(test_provider_account_id),
            subagent_id: None,
        };
        ready(Ok(Some(recorded))).boxed()
    }

    fn record_cost(
        &self,
        request: PricedRequest,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.priced).push(request);
        ready(Ok(())).boxed()
    }

    fn read_prior_emitted(
        &self,
        _session_id: SessionId,
        _thread_id: String,
    ) -> BoxFuture<'_, Result<UsageAxisCounts, Box<dyn Error + Send + Sync>>> {
        ready(Ok(*lock(&self.reported))).boxed()
    }

    fn read_thread_speed_at(
        &self,
        _session_id: SessionId,
        _at: sidekicks_contracts::wire::instant::WireInstant,
    ) -> BoxFuture<'_, Result<Option<String>, Box<dyn Error + Send + Sync>>> {
        async { Ok(None) }.boxed()
    }

    fn read_run_at(
        &self,
        _session_id: SessionId,
        _at: sidekicks_contracts::wire::instant::WireInstant,
    ) -> BoxFuture<
        '_,
        Result<Option<sidekicks_contracts::run::id::RunId>, Box<dyn Error + Send + Sync>>,
    > {
        async { Ok(None) }.boxed()
    }

    fn record_quota_windows(
        &self,
        _provider: ProviderId,
        provider_account_id: ProviderAccountId,
        windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.quota_windows).push((provider_account_id, windows));
        ready(Ok(())).boxed()
    }

    fn record_whole_quota_windows(
        &self,
        provider: ProviderId,
        provider_account_id: ProviderAccountId,
        windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.record_quota_windows(provider, provider_account_id, windows)
    }
}

/// Files whose read takes the given time, and stored PNG pictures: a picture's id answers its
/// stored copy, and every other id its unresolved marker once its delay passed, so a message's
/// blocks name it.
#[derive(Default)]
pub(crate) struct ScriptedAttachments {
    delays: Mutex<HashMap<ArtifactId, Duration>>,
    pictures: Mutex<HashMap<ArtifactId, PathBuf>>,
}

impl ScriptedAttachments {
    /// A file whose read takes `delay`.
    pub(crate) fn slow_file(&self, delay: Duration) -> ArtifactId {
        let artifact_id = ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID is an id");
        lock(&self.delays).insert(artifact_id, delay);
        artifact_id
    }

    /// A PNG picture stored at `path`, named by its file name.
    pub(crate) fn picture(&self, path: PathBuf) -> ArtifactId {
        let artifact_id = ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID is an id");
        lock(&self.pictures).insert(artifact_id, path);
        artifact_id
    }
}

impl AttachmentResolver for ScriptedAttachments {
    fn resolve_attachments(
        &self,
        _session_id: SessionId,
        artifact_ids: Vec<ArtifactId>,
    ) -> BoxFuture<'_, Result<Vec<ProviderAttachment>, Box<dyn Error + Send + Sync>>> {
        let delay = artifact_ids
            .iter()
            .filter_map(|artifact_id| lock(&self.delays).get(artifact_id).copied())
            .max()
            .unwrap_or_default();
        async move {
            tokio::time::sleep(delay).await;
            let pictures = lock(&self.pictures).clone();
            Ok(artifact_ids
                .into_iter()
                .map(|artifact_id| match pictures.get(&artifact_id) {
                    Some(path) => ProviderAttachment::Resolved(ResolvedAttachment {
                        artifact_id,
                        path: path.clone(),
                        file_name: path
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        media_type: "image/png".to_owned(),
                    }),
                    None => ProviderAttachment::Unresolved(UnresolvedAttachmentMarker {
                        artifact_id,
                        cause: UnresolvedAttachmentCause::Deleted,
                    }),
                })
                .collect())
        }
        .boxed()
    }
}

/// Opens every daemon turn on one binding, after the process opener the recording ports hold
/// where a test set one, and admits each on the account and at the posture a scripted session is
/// created with.
struct ScriptedBindings(Arc<RecordingPorts>);

impl DaemonTurnBindingResolver for ScriptedBindings {
    fn open_daemon_turn_binding(
        &self,
        _run_id: RunId,
        session_id: SessionId,
        process: DaemonTurnProcess,
    ) -> BoxFuture<'_, Result<DaemonTurnBinding, DaemonTurnBindingError>> {
        if self.0.refuses_daemon_turn_bindings.load(Ordering::SeqCst) {
            let refusal =
                DomainError::new("the session is closed", RefusalCode::SessionAlreadyClosed);
            return ready(Err(DaemonTurnBindingError::Refused {
                session_id,
                refusal: Box::new(refusal),
            }))
            .boxed();
        }
        let is_live_only = process == DaemonTurnProcess::LiveOnly;
        if is_live_only && self.0.has_let_processes_go.load(Ordering::SeqCst) {
            return ready(Err(DaemonTurnBindingError::NoProviderSession {
                session_id,
            }))
            .boxed();
        }
        let opener = lock(&self.0.process_opener)
            .clone()
            .filter(|_| !is_live_only);
        async move {
            if let Some(opener) = opener {
                opener(session_id).await;
            }
            Ok(DaemonTurnBinding {
                binding_id: binding_id("daemon-turn"),
                agent_id: new_agent_id(),
                step_bound: None,
            })
        }
        .boxed()
    }

    fn admit_daemon_turn(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<DaemonTurnAdmission, DaemonTurnBindingError>> {
        let created = create_params(session_id);
        async move {
            Ok(DaemonTurnAdmission {
                admitted_provider_account_id: created.provider_account_id,
                execution_posture: created
                    .execution_posture
                    .expect("a scripted session is created with a posture"),
            })
        }
        .boxed()
    }
}

/// A machine with no repositories.
struct NoRepositories;

impl RepositoryReader for NoRepositories {
    fn read_repository<'a>(
        &'a self,
        _working_folder: &'a Path,
    ) -> BoxFuture<'a, Option<RepositoryReading>> {
        async { None }.boxed()
    }

    fn is_owned_by_user<'a>(&'a self, _path: &'a Path) -> BoxFuture<'a, bool> {
        async { false }.boxed()
    }
}

/// A callback-tool host with no approval seam, so every spawn's registry is withheld.
pub(super) fn test_callback_tool_host() -> Arc<CallbackToolHost> {
    Arc::new(CallbackToolHost::new(
        Arc::new(NoCallbackTools),
        Arc::new(NoCallbackTools),
        None,
    ))
}

/// The callback-tool binding of a spawn of `session_id` that offers none.
pub(super) fn test_callback_tool_binding(session_id: SessionId) -> Arc<CallbackToolSpawnBinding> {
    Arc::new(bind_callback_tools_for_spawn(
        &test_callback_tool_host(),
        CallbackToolSpawnRequest {
            session_id,
            provider: DESCRIPTOR.provider_id(),
            requested_tools: Vec::new(),
            provider_registration_unavailable: None,
        },
    ))
}

// Runs no tool and records nothing: no seam is registered, so no call reaches either.
struct NoCallbackTools;

impl CallbackToolExecutor for NoCallbackTools {
    fn execute(
        &self,
        _invocation: CallbackToolInvocation,
    ) -> BoxFuture<'_, Result<CallbackToolResult, CallbackToolPortError>> {
        async {
            Ok(CallbackToolResult::Completed {
                output: None,
                session_links: Vec::new(),
            })
        }
        .boxed()
    }
}

impl CallbackToolActivitySink for NoCallbackTools {
    fn record<'a>(
        &'a self,
        _record: &'a CallbackToolActivityRecord,
    ) -> BoxFuture<'a, Result<(), CallbackToolPortError>> {
        async { Ok(()) }.boxed()
    }
}

/// One write a binding store took: an account move or the recovery data kept.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum TakenBindingWrite {
    /// The binding moved onto the account.
    Move(RuntimeBindingId, ProviderAccountId),
    /// The binding holds this recovery data now.
    RecoveryData(RuntimeBindingId, Map<String, Value>),
}

/// A binding store that takes every write, so a rewind's fork is adopted, and keeps each account
/// move and each recovery data kept, in the order made; a test can have it refuse every move.
#[derive(Default)]
pub(crate) struct TakenBindingWrites {
    writes: Mutex<Vec<TakenBindingWrite>>,
    is_refusing_moves: AtomicBool,
}

impl TakenBindingWrites {
    /// Every write so far, in the order made.
    pub(crate) fn writes(&self) -> Vec<TakenBindingWrite> {
        lock(&self.writes).clone()
    }

    /// Every account move so far: the binding, and the account it moved onto.
    pub(crate) fn moves(&self) -> Vec<(RuntimeBindingId, ProviderAccountId)> {
        self.writes()
            .into_iter()
            .filter_map(|write| match write {
                TakenBindingWrite::Move(binding_id, account) => Some((binding_id, account)),
                TakenBindingWrite::RecoveryData(..) => None,
            })
            .collect()
    }

    /// Every recovery data kept so far: the binding, and the data it holds now.
    pub(crate) fn recovery_data(&self) -> Vec<(RuntimeBindingId, Map<String, Value>)> {
        self.writes()
            .into_iter()
            .filter_map(|write| match write {
                TakenBindingWrite::RecoveryData(binding_id, data) => Some((binding_id, data)),
                TakenBindingWrite::Move(..) => None,
            })
            .collect()
    }

    /// Refuses every account move from now on, writing none.
    pub(crate) fn refuse_moves(&self) {
        self.is_refusing_moves.store(true, Ordering::SeqCst);
    }
}

impl RuntimeBindingWriter for TakenBindingWrites {
    fn rebind(
        &self,
        _rebind: RuntimeBindingRebind,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        ready(Ok(())).boxed()
    }

    fn keep_recovery_data(
        &self,
        binding_id: RuntimeBindingId,
        runtime_metadata: Map<String, Value>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.writes).push(TakenBindingWrite::RecoveryData(
            binding_id,
            runtime_metadata,
        ));
        ready(Ok(())).boxed()
    }

    fn move_account(
        &self,
        binding_id: RuntimeBindingId,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        if self.is_refusing_moves.load(Ordering::SeqCst) {
            return ready(Err("the test refuses every binding move".into())).boxed();
        }
        lock(&self.writes).push(TakenBindingWrite::Move(binding_id, provider_account_id));
        ready(Ok(())).boxed()
    }

    fn replace_tool_servers(
        &self,
        _run_id: RunId,
        _tool_servers: Vec<SessionToolServer>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        ready(Ok(())).boxed()
    }
}
