//! The ports through which the workflow engine reaches the services above this crate: the memory
//! gate a script or quick Code step waits at, the agent runs an agent step starts, the processes a
//! step launches and the artifacts its large payloads go to, the approval cards and questions a
//! step waiting on a person opens, a tool server's tool a step calls, the sink of the engine's own
//! records and the limits a run is held to: how many runs a chain may count, and how long one run
//! may go. The program implements each and hands the ones the dispatch reads to the engine as one
//! bundle.

#[cfg(test)]
pub(crate) mod kept_payloads;
#[cfg(test)]
pub(crate) mod noticed_sessions;
#[cfg(test)]
pub(crate) mod run_limits;
#[cfg(test)]
pub(crate) mod scripted_agent_runs;
pub mod tool_call;
#[cfg(test)]
pub(crate) mod withdrawn_cards;

use std::error::Error;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::future::BoxFuture;
use secrecy::SecretString;
use serde_json::{Map, Value};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::daemon::config::{RunTimeLimitMinutes, WorkflowChainAskAfterRuns};
use sidekicks_contracts::git::local::WorkflowRunSnapshotPoint;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::ComposedText;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowName, WorkflowNodeId,
};
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowStepError};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowCost, WorkflowStepKey, WorkflowStepProcessExit,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::runs::step_action::StepActionApproval;
use crate::secrets::redaction::RunRedaction;

/// Why a port's call failed, as its implementer reports it.
pub type PortError = Box<dyn Error + Send + Sync>;

/// A workflow node as the memory gate learns its peak: `<definition id>/<node id>`, unique across
/// workflows. It names the definition, not a version, so a peak learned survives an edit.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WorkflowNodeKey(String);

impl WorkflowNodeKey {
    /// The key of node `node_id` in the workflow `definition_id`.
    pub fn new(definition_id: WorkflowDefinitionId, node_id: &WorkflowNodeId) -> Self {
        Self(format!("{definition_id}/{}", node_id.as_str()))
    }

    /// The key's text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The interpreter a script step runs in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StepScriptRuntime {
    /// Bun.
    Bun,
    /// Python.
    Python,
}

/// The ports the tick's dispatch reads, which the program's workflow engine builds and hands it.
#[derive(Clone)]
pub struct EnginePorts {
    /// The memory gate a script or quick Code step waits at.
    pub admission: Arc<dyn StepAdmission>,
    /// Starts and reattaches the agent runs agent steps make.
    pub agent_steps: Arc<dyn AgentStepRunner>,
    /// Launches the processes steps run.
    pub processes: Arc<dyn StepProcessLauncher>,
    /// Stores the step payloads too large to carry inline.
    pub payloads: Arc<dyn StepPayloadArtifacts>,
    /// Decides a step's action before it runs.
    pub step_actions: Arc<dyn StepActionApproval>,
    /// Takes the engine's own records, its faults among them.
    pub records: Arc<dyn EngineRecordSink>,
}

/// What a step the memory gate weighs runs, which sets its reservation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StepAdmissionWork {
    /// A bun or Python step, reserved at its node's learned peak, else its runtime's estimate.
    Script {
        /// Its interpreter.
        runtime: StepScriptRuntime,
        /// The node it runs.
        node_key: WorkflowNodeKey,
    },
    /// A quick Code step, reserved at its budget, its thread, its input and its output room.
    QuickCode {
        /// Its interpreter's memory budget, in bytes.
        budget_bytes: u64,
        /// Its input text, in bytes, moved into its thread.
        input_bytes: u64,
        /// The most output text it may return, in bytes.
        output_max_bytes: u64,
        /// The node it runs.
        node_key: WorkflowNodeKey,
    },
}

/// How a wait at the memory gate ended: admitted, or released before its turn came.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepAdmissionOutcome {
    /// Admitted, holding its reservation.
    Admitted,
    /// Released before its turn came.
    Withdrawn,
}

/// The memory gate a script or quick Code step waits at before it starts; the run queue's memory
/// gate implements it. An agent step never calls it: its run joins the gate itself.
pub trait StepAdmission: Send + Sync {
    /// Puts `work` in the gate's line and returns its ticket at once.
    fn enqueue(&self, work: StepAdmissionWork) -> Box<dyn StepAdmissionTicket>;

    /// Weighs the head of the line against a fresh memory reading; the tick calls it once per turn
    /// so the gate sees memory freed elsewhere.
    fn weigh(&self);
}

/// One step's place at the memory gate; dropping it releases the place and its reservation.
pub trait StepAdmissionTicket: Send + Sync {
    /// The outcome of the latest wait in the line, `None` while the step is waiting at the gate.
    fn admitted(&self) -> watch::Receiver<Option<StepAdmissionOutcome>>;

    /// Gives up the reservation while the step waits on a person or a spent account. Fails unless
    /// admitted.
    fn park(&self) -> Result<(), PortError>;

    /// Rejoins the line after a park; `admitted()` reads `None` until the step is admitted again.
    /// Fails unless parked.
    fn resume(&self) -> Result<(), PortError>;

    /// Reads the peak memory of process `process_id`, which the step runs, and keeps the largest
    /// seen for the release to learn. Fails unless admitted or parked, or when the read fails.
    fn observe_process_peak(&self, process_id: u32) -> BoxFuture<'_, Result<(), PortError>>;

    /// Keeps a quick step's interpreter peak, in bytes, for the release to learn. Fails unless
    /// admitted or parked.
    fn observe_interpreter_peak(&self, bytes: u64) -> Result<(), PortError>;
}

/// What an agent step asks the agent run it starts to do.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentStepRequest {
    /// The session the run lives in.
    pub session_id: SessionId,
    /// The step the run answers.
    pub step: WorkflowStepKey,
    /// The node the step runs, whose learned peak the run's place at the gate takes.
    pub node_key: WorkflowNodeKey,
    /// The level the run asks to run at.
    pub permission_level: PermissionLevel,
    /// The node's params, each template evaluated.
    pub params: Map<String, Value>,
}

/// How an agent run started: the level it actually runs at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgentStepStart {
    /// The level the run runs at.
    pub permission_level: PermissionLevel,
}

/// How an agent step's run ended.
#[derive(Clone, Debug, PartialEq)]
pub enum AgentStepOutcome {
    /// The run finished: its output items and what it cost, where a provider was billed.
    Completed {
        /// The step's output items.
        items: Vec<WorkflowItem>,
        /// What the run cost.
        cost: Option<WorkflowCost>,
    },
    /// The run's provider account is spent; the step waits on it.
    AccountSpent {
        /// The spent account.
        provider_account_id: ProviderAccountId,
        /// When the account's limit resets, where the provider stated the instant.
        resets_at: Option<WireInstant>,
    },
    /// The run failed.
    Failed {
        /// Why.
        error: WorkflowStepError,
    },
}

/// Starts and reattaches the agent runs agent steps make; the program's agent step runner
/// implements it over the session's run service and queue.
pub trait AgentStepRunner: Send + Sync {
    /// Creates the run `request` asks for, which joins the memory gate at its creation. Fails when
    /// the run cannot be created.
    fn run(
        &self,
        request: AgentStepRequest,
    ) -> BoxFuture<'_, Result<Box<dyn AgentStepRun>, PortError>>;

    /// The run `step` made before a restart, which the queue's recovery starts again; `None` where
    /// the step made none. Fails when the stored runs cannot be read.
    fn reattach<'call>(
        &'call self,
        step: &'call WorkflowStepKey,
    ) -> BoxFuture<'call, Result<Option<Box<dyn AgentStepRun>>, PortError>>;
}

/// One agent step's run.
pub trait AgentStepRun: Send + Sync {
    /// Where the run stands at the memory gate: `None` while it is waiting at the gate, then its
    /// outcome.
    fn admission(&self) -> watch::Receiver<Option<StepAdmissionOutcome>>;

    /// How many turn ends and tool calls the run has passed, which the step reports as progress.
    fn progressed(&self) -> watch::Receiver<u64>;

    /// Waits for the run to start. Fails when it ends before starting.
    fn started(&self) -> BoxFuture<'_, Result<AgentStepStart, PortError>>;

    /// Waits for the run to end. Fails when its end cannot be read.
    fn outcome(&self) -> BoxFuture<'_, Result<AgentStepOutcome, PortError>>;

    /// Asks the run to stop. Fails when the stop cannot be sent.
    fn cancel(&self) -> BoxFuture<'_, Result<(), PortError>>;

    /// Takes the run's turn the spent account refused again, on the run's account. The resumed
    /// turn enters the memory gate again as a creation does, so `admission` answers `None` while
    /// the gate holds it; the run's next outcome then answers. Fails when the ask cannot be sent.
    fn resume(&self) -> BoxFuture<'_, Result<(), PortError>>;
}

/// What a step process runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StepCommand {
    /// A command line run by a shell program.
    Shell {
        /// The shell program.
        shell: PathBuf,
        /// The line it runs.
        line: String,
    },
    /// A program and its arguments, the program first.
    Program {
        /// The program and its arguments.
        argv: Vec<OsString>,
    },
}

/// One process a step launches.
pub struct StepLaunch {
    /// The provider whose driver's sandbox the process runs in.
    pub provider: ProviderId,
    /// The run's level.
    pub permission_level: PermissionLevel,
    /// What the process runs.
    pub command: StepCommand,
    /// The environment it adds, each value held as a secret since a fill may carry one.
    pub environment: Vec<(String, SecretString)>,
    /// The folder it runs in.
    pub working_folder: PathBuf,
    /// The step's cancel, which ends the process.
    pub cancel: CancellationToken,
    /// The run's redaction, which scrubs the process's stdout and stderr.
    pub redaction: Arc<RunRedaction>,
}

/// How a step process ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepProcessEnd {
    /// Its exit code or the signal that ended it.
    pub exit: WorkflowStepProcessExit,
    /// What it wrote to stdout, scrubbed.
    pub stdout: Vec<u8>,
    /// What it wrote to stderr, scrubbed.
    pub stderr: Vec<u8>,
}

/// Launches the processes steps run, inside the provider's sandbox; the Code and command step
/// launcher implements it.
pub trait StepProcessLauncher: Send + Sync {
    /// The shell program `provider`'s driver runs command lines in, `None` when it names none.
    fn command_shell(&self, provider: &ProviderId) -> Option<PathBuf>;

    /// Starts `launch`. Fails when the process cannot be started.
    fn launch(&self, launch: StepLaunch) -> BoxFuture<'_, Result<Box<dyn StepProcess>, PortError>>;
}

/// One process a step launched.
pub trait StepProcess: Send + Sync {
    /// The process's id, which the memory gate reads its peak by.
    fn process_id(&self) -> u32;

    /// Waits for the process to end. Fails when its end cannot be read.
    fn finish(self: Box<Self>) -> BoxFuture<'static, Result<StepProcessEnd, PortError>>;
}

/// Stores the step payloads too large to carry inline as artifacts; the step payload store
/// implements it.
pub trait StepPayloadArtifacts: Send + Sync {
    /// Stores `bytes`, a payload of `item_count` items `step` wrote in `session_id`. Fails when
    /// the artifact cannot be written.
    fn write<'call>(
        &'call self,
        session_id: SessionId,
        step: &'call WorkflowStepKey,
        bytes: Vec<u8>,
        item_count: u64,
    ) -> BoxFuture<'call, Result<ArtifactId, PortError>>;

    /// The bytes of `artifact_id`. Fails when the artifact cannot be read.
    fn read<'call>(
        &'call self,
        artifact_id: &'call ArtifactId,
    ) -> BoxFuture<'call, Result<Vec<u8>, PortError>>;

    /// Deletes `artifact_id`, a stored payload no record will name. Fails when the artifact cannot
    /// be removed.
    fn delete<'call>(
        &'call self,
        artifact_id: &'call ArtifactId,
    ) -> BoxFuture<'call, Result<(), PortError>>;
}

/// An approval card a workflow wait opens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowApprovalCardRequest {
    /// The session the card is raised in.
    pub session_id: SessionId,
    /// The run that waits.
    pub run_id: WorkflowRunId,
    /// The workflow whose wait asks, named on the card.
    pub workflow_name: WorkflowName,
    /// The step that waits, `None` for a chain's hold.
    pub step: Option<WorkflowStepKey>,
    /// The wait the answer settles.
    pub wait_id: UuidTextForm,
    /// What the card asks.
    pub prompt: ComposedText,
}

/// Raises the durable approval cards workflow waits open; the approval service's workflow gate
/// card implements it.
pub trait ApprovalCardRaiser: Send + Sync {
    /// Raises `request`'s card, returning once it is durable; the answer lands later. Idempotent by
    /// the request's wait id: the restart raises again for a stored wait whose card never landed,
    /// and a second raise for one wait keeps its one card. Fails when the card cannot be written.
    fn raise(&self, request: WorkflowApprovalCardRequest) -> BoxFuture<'_, Result<(), PortError>>;

    /// Withdraws the card the wait `wait_id` holds open in `session_id`, once the write that ended
    /// the wait unanswered committed; a card already answered or withdrawn is left as it is. Fails
    /// when the card cannot be read or its cancel cannot be written.
    fn withdraw(
        &self,
        session_id: SessionId,
        wait_id: UuidTextForm,
    ) -> BoxFuture<'_, Result<(), PortError>>;
}

/// A snapshot point a workflow run takes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowRunSnapshotPointRequest {
    /// The session the run belongs to.
    pub session_id: SessionId,
    /// The run whose checkout is recorded.
    pub workflow_run_id: WorkflowRunId,
    /// The point taken, in the execution it belongs to.
    pub point: WorkflowRunSnapshotPoint,
}

/// Takes a workflow run's snapshot points; the program implements it over the turn-snapshot
/// service.
pub trait RunSnapshotPoints: Send + Sync {
    /// Records `request`'s point of the run's checkout. A run with no checkout captures nothing
    /// and answers `Ok`; the point's ref is create-only, so a point taken twice keeps its first
    /// capture. The future borrows nothing, so the caller can spawn it. Fails when the capture
    /// cannot be written.
    fn take(
        &self,
        request: WorkflowRunSnapshotPointRequest,
    ) -> BoxFuture<'static, Result<(), PortError>>;
}

/// A form question a step waiting on a person opens.
#[derive(Clone, Debug, PartialEq)]
pub struct FormQuestionRequest {
    /// The session the question is asked in.
    pub session_id: SessionId,
    /// The workflow whose step asks, named on the question's card.
    pub workflow_name: WorkflowName,
    /// The step that waits.
    pub step: WorkflowStepKey,
    /// The wait the answer settles.
    pub wait_id: UuidTextForm,
    /// What the form asks.
    pub prompt: ComposedText,
    /// The JSON Schema of the answer's fields.
    pub input_schema: Map<String, Value>,
}

/// A chat-reply question a step waiting on a person opens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplyQuestionRequest {
    /// The session the question is asked in.
    pub session_id: SessionId,
    /// The workflow whose step asks, named on the question's card.
    pub workflow_name: WorkflowName,
    /// The step that waits.
    pub step: WorkflowStepKey,
    /// The wait the answer settles.
    pub wait_id: UuidTextForm,
    /// What the question asks.
    pub prompt: ComposedText,
}

/// Opens the questions steps waiting on a person ask; the session's workflow waits implement it
/// over the question service.
pub trait PersonWaitQuestions: Send + Sync {
    /// Opens `request`'s form question. Idempotent by the request's wait id, as the restart opens
    /// again a stored wait whose question never landed: a second open answers the first's
    /// question. Fails when the question cannot be written.
    fn open_form(
        &self,
        request: FormQuestionRequest,
    ) -> BoxFuture<'_, Result<QuestionId, PortError>>;

    /// Opens `request`'s chat-reply question. Idempotent by the request's wait id, as
    /// [`Self::open_form`] is. Fails when the question cannot be written.
    fn open_reply(
        &self,
        request: ReplyQuestionRequest,
    ) -> BoxFuture<'_, Result<QuestionId, PortError>>;

    /// The open question the wait `wait_id` holds in `session_id`, which a restart reattaches to
    /// its stored wait; `None` where none is open, so the restart asks it again. Fails when the
    /// question cannot be read.
    fn reattach(
        &self,
        session_id: SessionId,
        wait_id: UuidTextForm,
    ) -> BoxFuture<'_, Result<Option<QuestionId>, PortError>>;
}

/// Takes the engine's own records, its intents and outcomes, which are never read back as facts;
/// the program's workflow engine bucket implements it and reports its own loss.
pub trait EngineRecordSink: Send + Sync {
    /// Records `entry`, already scrubbed.
    fn record(&self, entry: Map<String, Value>) -> BoxFuture<'_, ()>;
}

/// The limits a run is held to, which the daemon reads from its configuration and hands the
/// engine; each is read again where it applies, so a change holds from the next read.
pub trait WorkflowRunLimits: Send + Sync {
    /// `Ask me after one start leads to`, in runs, as set now; `None` is `Never ask`.
    fn chain_ask_after_runs(&self) -> Option<WorkflowChainAskAfterRuns>;

    /// `Stop a run after`, as set now; `None` is `No limit`.
    fn run_time_limit(&self) -> Option<RunTimeLimitMinutes>;
}

/// What a refusing test port panics or fails with: a test that reaches one has a fault.
#[cfg(test)]
pub(crate) const REFUSED_PORT_CALL: &str = "a test's ports take no call";

/// The ports a test holds, which refuse every call: a test that reaches one has a fault.
#[cfg(test)]
pub(crate) struct RefusingPorts;

#[cfg(test)]
impl StepAdmission for RefusingPorts {
    fn enqueue(&self, _work: StepAdmissionWork) -> Box<dyn StepAdmissionTicket> {
        panic!("{REFUSED_PORT_CALL}")
    }

    fn weigh(&self) {
        panic!("{REFUSED_PORT_CALL}")
    }
}

#[cfg(test)]
impl AgentStepRunner for RefusingPorts {
    fn run(
        &self,
        _request: AgentStepRequest,
    ) -> BoxFuture<'_, Result<Box<dyn AgentStepRun>, PortError>> {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }

    fn reattach<'call>(
        &'call self,
        _step: &'call WorkflowStepKey,
    ) -> BoxFuture<'call, Result<Option<Box<dyn AgentStepRun>>, PortError>> {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }
}

#[cfg(test)]
impl StepActionApproval for RefusingPorts {
    fn check_step_action(
        &self,
        _check: crate::runs::step_action::StepActionCheck,
    ) -> BoxFuture<'_, Result<crate::runs::step_action::StepActionVerdict, PortError>> {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }
}

#[cfg(test)]
impl StepProcessLauncher for RefusingPorts {
    fn command_shell(&self, _provider: &ProviderId) -> Option<PathBuf> {
        None
    }

    fn launch(
        &self,
        _launch: StepLaunch,
    ) -> BoxFuture<'_, Result<Box<dyn StepProcess>, PortError>> {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }
}

#[cfg(test)]
impl StepPayloadArtifacts for RefusingPorts {
    fn write<'call>(
        &'call self,
        _session_id: SessionId,
        _step: &'call WorkflowStepKey,
        _bytes: Vec<u8>,
        _item_count: u64,
    ) -> BoxFuture<'call, Result<ArtifactId, PortError>> {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }

    fn read<'call>(
        &'call self,
        _artifact_id: &'call ArtifactId,
    ) -> BoxFuture<'call, Result<Vec<u8>, PortError>> {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }

    fn delete<'call>(
        &'call self,
        _artifact_id: &'call ArtifactId,
    ) -> BoxFuture<'call, Result<(), PortError>> {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }
}

/// An engine record sink for a test, keeping every line it is handed.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct KeptEngineRecords(std::sync::Mutex<Vec<Map<String, Value>>>);

#[cfg(test)]
impl KeptEngineRecords {
    /// The lines kept so far.
    pub(crate) fn lines(&self) -> Vec<Map<String, Value>> {
        sidekicks_std::mutex_lock::lock(&self.0).clone()
    }
}

#[cfg(test)]
impl EngineRecordSink for KeptEngineRecords {
    fn record(&self, entry: Map<String, Value>) -> BoxFuture<'_, ()> {
        sidekicks_std::mutex_lock::lock(&self.0).push(entry);
        Box::pin(async {})
    }
}

/// A memory gate for a test: it records each work enqueued and wakes the test, and every ticket it
/// answers reads one outcome the test sets, starting at the outcome it was built with.
#[cfg(test)]
pub(crate) struct ScriptedGate {
    /// The outcome every ticket reads.
    outcome: watch::Sender<Option<StepAdmissionOutcome>>,
    /// The work each enqueue was given, in order.
    enqueued: std::sync::Mutex<Vec<StepAdmissionWork>>,
    /// Woken at each enqueue; a wake with no waiter is kept for the next.
    entered: tokio::sync::Notify,
    /// How many of its tickets were dropped.
    dropped_tickets: Arc<AtomicUsize>,
}

#[cfg(test)]
impl ScriptedGate {
    /// A gate whose tickets start at `initial`: `None` holds, `Some(Admitted)` admits at once.
    pub(crate) fn new(initial: Option<StepAdmissionOutcome>) -> Self {
        Self {
            outcome: watch::Sender::new(initial),
            enqueued: std::sync::Mutex::new(Vec::new()),
            entered: tokio::sync::Notify::new(),
            dropped_tickets: Arc::default(),
        }
    }

    /// Admits every ticket.
    pub(crate) fn admit(&self) {
        self.outcome
            .send_replace(Some(StepAdmissionOutcome::Admitted));
    }

    /// Returns once a work is enqueued, at once when one was enqueued since the last return.
    pub(crate) async fn wait_for_entry(&self) {
        self.entered.notified().await;
    }

    /// The work enqueued so far, in order.
    pub(crate) fn enqueued(&self) -> Vec<StepAdmissionWork> {
        sidekicks_std::mutex_lock::lock(&self.enqueued).clone()
    }

    /// How many of its tickets were dropped.
    pub(crate) fn dropped_tickets(&self) -> usize {
        self.dropped_tickets.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
impl StepAdmission for ScriptedGate {
    fn enqueue(&self, work: StepAdmissionWork) -> Box<dyn StepAdmissionTicket> {
        sidekicks_std::mutex_lock::lock(&self.enqueued).push(work);
        self.entered.notify_one();
        Box::new(ScriptedTicket {
            outcome: self.outcome.subscribe(),
            dropped_tickets: Arc::clone(&self.dropped_tickets),
        })
    }

    fn weigh(&self) {}
}

/// A ticket of a [`ScriptedGate`], which counts its own drop.
#[cfg(test)]
struct ScriptedTicket {
    /// The gate's outcome.
    outcome: watch::Receiver<Option<StepAdmissionOutcome>>,
    /// The gate's count of dropped tickets.
    dropped_tickets: Arc<AtomicUsize>,
}

#[cfg(test)]
impl StepAdmissionTicket for ScriptedTicket {
    fn admitted(&self) -> watch::Receiver<Option<StepAdmissionOutcome>> {
        self.outcome.clone()
    }

    fn park(&self) -> Result<(), PortError> {
        Err(REFUSED_PORT_CALL.into())
    }

    fn resume(&self) -> Result<(), PortError> {
        Err(REFUSED_PORT_CALL.into())
    }

    fn observe_process_peak(&self, _process_id: u32) -> BoxFuture<'_, Result<(), PortError>> {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }

    fn observe_interpreter_peak(&self, _bytes: u64) -> Result<(), PortError> {
        Err(REFUSED_PORT_CALL.into())
    }
}

#[cfg(test)]
impl Drop for ScriptedTicket {
    fn drop(&mut self) {
        self.dropped_tickets.fetch_add(1, Ordering::SeqCst);
    }
}

/// An engine's ports for a test, each refusing every call, with a record sink keeping every line.
#[cfg(test)]
pub(crate) fn refusing_engine_ports() -> EnginePorts {
    let ports = Arc::new(RefusingPorts);
    EnginePorts {
        admission: Arc::clone(&ports) as Arc<dyn StepAdmission>,
        agent_steps: Arc::clone(&ports) as Arc<dyn AgentStepRunner>,
        processes: Arc::clone(&ports) as Arc<dyn StepProcessLauncher>,
        payloads: Arc::clone(&ports) as Arc<dyn StepPayloadArtifacts>,
        step_actions: ports,
        records: Arc::new(KeptEngineRecords::default()),
    }
}
