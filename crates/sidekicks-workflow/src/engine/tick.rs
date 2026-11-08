//! The engine's tick: each turn of its loop walks what committed, admits and dispatches the
//! steps the walk readied, and commits what they reported in one write.

mod admission;
mod branch_cancellation;
pub(crate) mod commit;
mod dispatch;
mod live_runs;
pub(crate) mod node_settings;
pub(crate) mod run_status;
pub(crate) mod step_failure;
mod turns;
mod walk;

pub(crate) use self::branch_cancellation::BranchCancelReason;
pub(crate) use self::walk::{RunGraph, RunGraphError};

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde_json::{Map, Value};
use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowContentHash, WorkflowDefinitionId, WorkflowName, WorkflowNode, WorkflowNodeId,
    WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowPinnedItem};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseCancellationReason;
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowCost, WorkflowPayloadRef, WorkflowStepKey,
};
use sidekicks_contracts::workflow::run::trigger::{WorkflowRunMode, WorkflowRunTrigger};
use tokio_util::sync::CancellationToken;

use crate::definitions::kept_values::WorkflowKeptValue;
use crate::engine::ports::{AgentStepRun, StepAdmissionTicket};
use crate::expressions::lineage::StepOutputs;
use crate::kinds::step_context::StepRunVariable;
use crate::kinds::{PersonWait, StepFailure};
use crate::secrets::redaction::RunRedaction;

/// What one run's steps share, built once by the run's start or its restart and held as an `Arc`
/// by every step the run dispatches.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct RunScope {
    /// The session the run works in.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: WorkflowRunId,
    /// The workflow the run runs.
    pub(crate) workflow_id: WorkflowDefinitionId,
    /// The version of the workflow the run pins.
    pub(crate) workflow_version_id: WorkflowVersionId,
    /// The workflow's name, as the run's expressions read it.
    pub(crate) workflow_name: WorkflowName,
    /// How the run was started, which decides whether its ending posts its results.
    pub(crate) mode: WorkflowRunMode,
    /// For a retry, how the first run of its chain of retries that is not a retry was started,
    /// which its ending posts as; `None` for every run that is not a retry.
    pub(crate) retried_mode: Option<WorkflowRunMode>,
    /// The trigger node that started the run.
    pub(crate) trigger: WorkflowRunTrigger,
    /// The pinned version's nodes by id, the trigger included.
    pub(crate) nodes: HashMap<WorkflowNodeId, WorkflowNode>,
    /// Each node's params as the pinned version stores them, by node id.
    pub(crate) node_params: Arc<HashMap<WorkflowNodeId, JsonRecord>>,
    /// The test items pinned onto nodes with their hashes, by node id; empty outside a manual run,
    /// the only run that honors them.
    pub(crate) pins: HashMap<WorkflowNodeId, RunPin>,
    /// When the run started, the one instant its expressions read as now.
    pub(crate) run_started_at: Timestamp,
    /// The machine's time zone, which dates the run's expressions.
    pub(crate) time_zone: TimeZone,
    /// The environment rows of the project the run works in; none outside a project.
    pub(crate) environment_rows: Arc<[EnvironmentRow]>,
    /// The values earlier runs of the workflow kept.
    pub(crate) kept_values: Arc<[WorkflowKeptValue]>,
    /// The project the run works in, `None` outside a project's repository.
    pub(crate) project: Option<ProjectId>,
    /// The folder the run's steps work in.
    pub(crate) working_folder: PathBuf,
    /// The workflow's provider as the run started, whose sandbox and shell its command steps use;
    /// `None` when the workflow names none, which a start allows only when no step runs in a
    /// sandbox.
    pub(crate) provider: Option<ProviderId>,
    /// The run's redaction, which scrubs every write the run makes.
    pub(crate) redaction: Arc<RunRedaction>,
    /// The run's cancel, of which each step's is a child.
    pub(crate) cancel: CancellationToken,
}

/// The test items pinned onto one node for a manual run, hashed once at the run's start.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct RunPin {
    /// The pinned items, which the node gives in place of running.
    pub(crate) items: Vec<WorkflowPinnedItem>,
    /// The content hash of the pinned items' canonical JSON, which tells a changed pin apart.
    pub(crate) hash: WorkflowContentHash,
}

/// A run's scope for a test: the run, workflow and start instant of the test expression
/// bindings, pinning a fixed version, started in `mode` over `nodes`, in UTC with no project or
/// pins, working in `/workspace` on the provider `test-provider`.
#[cfg(test)]
pub(crate) fn test_run_scope(mode: WorkflowRunMode, nodes: Vec<WorkflowNode>) -> RunScope {
    let bindings =
        crate::expressions::bindings::test_expression_bindings(Vec::new(), StepOutputs::default());
    RunScope {
        session_id: SessionId::new("0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7b")
            .expect("the test's session id is a UUID"),
        run_id: bindings.run_id,
        workflow_id: bindings.workflow_id,
        workflow_version_id: WorkflowVersionId::new("0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7c")
            .expect("the test's version id is a UUID"),
        workflow_name: bindings.workflow_name,
        mode,
        retried_mode: None,
        trigger: bindings.run_trigger,
        node_params: Arc::new(
            nodes
                .iter()
                .map(|node| (node.id.clone(), node.params.clone()))
                .collect(),
        ),
        nodes: nodes
            .into_iter()
            .map(|node| (node.id.clone(), node))
            .collect(),
        pins: HashMap::new(),
        run_started_at: bindings.run_started_at,
        time_zone: TimeZone::UTC,
        environment_rows: Arc::new([]),
        kept_values: Arc::new([]),
        project: None,
        working_folder: PathBuf::from("/workspace"),
        provider: Some(
            ProviderId::new("test-provider".to_owned()).expect("the test's provider id"),
        ),
        redaction: Arc::new(RunRedaction::new(&[])),
        cancel: CancellationToken::new(),
    }
}

/// What a run's steps had recorded when the turn began, handed to each step that turn dispatches
/// so every one reads the same fixed copy.
#[derive(Clone)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct RunSnapshot {
    /// Each node's executions so far.
    pub(crate) outputs: Arc<StepOutputs>,
    /// The values the run set with `Set variables`.
    pub(crate) run_variables: Arc<Map<String, Value>>,
    /// The level the steps run at, the workflow's as the turn read it, so a change reaches a live
    /// run from its next step.
    pub(crate) permission_level: PermissionLevel,
}

/// A step the walk readied: its key, its loop's run index and its input.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct ReadyStep {
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// The loop's run index, `$runIndex`.
    pub(crate) run_index: u64,
    /// The input items, one list per input handle of the kind's spec in spec order. The main
    /// inputs are the lists at the inputs whose `is_tool()` is false, in spec order; a tool input's
    /// list is empty, since a node wired into a `tool` input runs only when its agent calls it,
    /// never as a step.
    pub(crate) inputs: Vec<Vec<WorkflowItem>>,
    /// The input exactly as the pending row stored it, which `workflow.step.started` repeats.
    pub(crate) input_ref: WorkflowPayloadRef,
}

/// What one step reported to the tick, which the commit turns into events and rows. The commit
/// writes `at` as the event's instant, so the live rows and the fold read the same instant.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct StepReport {
    /// The step that reported.
    pub(crate) step: WorkflowStepKey,
    /// When the report was made, from the system clock.
    pub(crate) at: WireInstant,
    /// What the step reported.
    pub(crate) kind: StepReportKind,
}

/// What a step reports: where it stands at the memory gate, its start, its progress, its wind-down
/// or its end. A step the dispatch admits has its `Admitted` in the dispatch's own answer, before
/// any report from its driver; a step the gate weighs, and an agent step, whose run joins the gate
/// when it is made, reports its hold and its admission from its driver. An agent step whose run
/// leaves the gate's line unadmitted reports no `Admitted` before it settles.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum StepReportKind {
    /// The memory gate holds the step; every report of one hold carries the instant of its first,
    /// so the first is the one whose `at` equals `hold_started_at`.
    WaitingOnPool {
        /// When the hold began: the `at` of its first report.
        hold_started_at: WireInstant,
    },
    /// The memory gate admitted the step.
    Admitted {
        /// When the hold the admission ends began, `None` when the gate admitted it unheld.
        hold_started_at: Option<WireInstant>,
    },
    /// The step started.
    Started {
        /// The input exactly as the pending row stored it.
        input_ref: WorkflowPayloadRef,
        /// The level the step runs at, where its account runs it at another level than the run's.
        permission_level: Option<PermissionLevel>,
        /// The hash of the pin the step gave in place of running, where it gave one.
        pin_hash: Option<WorkflowContentHash>,
    },
    /// The step passed a turn end or a tool call.
    Progressed,
    /// The step was asked to stop and is winding down.
    Canceling,
    /// The step's turn canceled a wave of its run's other branches, and the last running one has
    /// settled; the report sits on the deciding step.
    BranchesCanceled {
        /// Why the branches were canceled.
        reason: BranchCancelReason,
        /// How many running branches the wave canceled.
        count: usize,
    },
    /// The step's armed resume came due; the tick resumes it while it still waits on its spent
    /// account.
    ResumeDue,
    /// The step ended.
    Settled(StepSettlement),
}

/// How a step ended.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum StepSettlement {
    /// The step finished with its outputs.
    Completed {
        /// The output items, one list per main output.
        outputs: Vec<Vec<WorkflowItem>>,
        /// What the step cost, where a provider was billed.
        cost: Option<WorkflowCost>,
        /// The log lines it recorded, scrubbed.
        log_lines: Vec<String>,
        /// The run variables it set.
        run_variables: BTreeMap<String, StepRunVariable>,
    },
    /// The step failed.
    Failed {
        /// Why.
        failure: StepFailure,
        /// The log lines it recorded, scrubbed.
        log_lines: Vec<String>,
    },
    /// The step waits on a person.
    PersonWait {
        /// What the person is asked and how long the step waits.
        wait: PersonWait,
        /// The step's place at the memory gate, parked while it waits; `None` for a step the gate
        /// does not weigh.
        admission: Option<Arc<dyn StepAdmissionTicket>>,
        /// The log lines it recorded, scrubbed.
        log_lines: Vec<String>,
    },
    /// The provider account of the step's agent run is spent; the step waits on it.
    AccountSpent {
        /// The spent account.
        provider_account_id: ProviderAccountId,
        /// When the account's limit resets, where the provider stated the instant.
        resets_at: Option<WireInstant>,
        /// The step's agent run, kept to resume when the account is back.
        run: Box<dyn AgentStepRun>,
    },
    /// The step was canceled. A step canceled while the gate held it adds its hold to the step's
    /// pool wait.
    Canceled {
        /// When the hold the cancel ended began, `None` when the gate was not holding the step.
        hold_started_at: Option<WireInstant>,
        /// Why its run's stop canceled it, a sibling's failure or a person's cancel of the run;
        /// `None` for any other cancel.
        cancellation_reason: Option<WorkflowPhaseCancellationReason>,
    },
}
