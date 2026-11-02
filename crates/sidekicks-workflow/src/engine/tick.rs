//! The engine's tick: each turn of its loop walks what committed, admits and dispatches the
//! steps the walk readied, and commits what they reported in one write.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the program's workflow engine, which runs the tick"
    )
)]

mod admission;

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
use sidekicks_contracts::wire::record::{JsonRecord, Record};
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowName, WorkflowNode, WorkflowNodeId,
};
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowPinnedItem};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowCost, WorkflowPayloadRef, WorkflowStepKey,
};
use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
use tokio_util::sync::CancellationToken;

use crate::definitions::kept_values::WorkflowKeptValue;
use crate::engine::ports::{AgentStepRun, StepAdmissionTicket};
use crate::expressions::lineage::StepOutputs;
use crate::kinds::step_context::StepRunVariable;
use crate::kinds::{PersonWait, StepFailure};
use crate::runs::creation::WorkflowRunTrigger;
use crate::secrets::redaction::RunRedaction;

/// What one run's steps share, built once by the run's start or its restart and held as an `Arc`
/// by every step the run dispatches.
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the run's start and restart, which build it, and the dispatch, which reads it"
    )
)]
pub(crate) struct RunScope {
    /// The session the run works in.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: WorkflowRunId,
    /// The workflow the run runs.
    pub(crate) workflow_id: WorkflowDefinitionId,
    /// The workflow's name, as the run's expressions read it.
    pub(crate) workflow_name: WorkflowName,
    /// How the run was started.
    pub(crate) mode: WorkflowRunMode,
    /// The trigger node that started the run.
    pub(crate) trigger: WorkflowRunTrigger,
    /// The pinned version's nodes by id, the trigger included.
    pub(crate) nodes: HashMap<WorkflowNodeId, WorkflowNode>,
    /// Each node's params as the pinned version stores them, by node id.
    pub(crate) node_params: Arc<HashMap<WorkflowNodeId, JsonRecord>>,
    /// The test items pinned onto nodes, by node id, which a step of a pinned node returns
    /// instead of running.
    pub(crate) pin_data: Option<Record<String, Vec<WorkflowPinnedItem>>>,
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
    /// The level the run's steps run at.
    pub(crate) permission_level: PermissionLevel,
    /// The provider of the session's driver, whose shell a command step runs in.
    pub(crate) provider: ProviderId,
    /// The run's redaction, which scrubs every write the run makes.
    pub(crate) redaction: Arc<RunRedaction>,
    /// The run's cancel, of which each step's is a child.
    pub(crate) cancel: CancellationToken,
}

/// What a run's steps had recorded when the turn began, handed to each step that turn dispatches
/// so every one reads the same fixed copy.
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the tick's turn, which takes it, and the dispatch, which hands it to each step"
    )
)]
pub(crate) struct RunSnapshot {
    /// Each node's executions so far.
    pub(crate) outputs: Arc<StepOutputs>,
    /// The values the run set with `Set variables`.
    pub(crate) run_variables: Arc<Map<String, Value>>,
}

/// A step the walk readied: its key, its loop's run index and its input.
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the walk, which readies it, and the dispatch, which starts it"
    )
)]
pub(crate) struct ReadyStep {
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// The loop's run index, `$runIndex`.
    pub(crate) run_index: u64,
    /// The input items, one list per input handle in handle order.
    pub(crate) inputs: Vec<Vec<WorkflowItem>>,
    /// The input exactly as the pending row stored it, which `workflow.step.started` repeats.
    pub(crate) input_ref: WorkflowPayloadRef,
}

/// What one step reported to the tick, which the commit turns into events and rows. The commit
/// writes `at` as the event's instant, so the live rows and the fold read the same instant.
pub(crate) struct StepReport {
    /// The step that reported.
    pub(crate) step: WorkflowStepKey,
    /// When the report was made, from the system clock.
    pub(crate) at: WireInstant,
    /// What the step reported.
    pub(crate) kind: StepReportKind,
}

/// What a step reports: where it stands at the memory gate, its start, its progress, its wind-down
/// or its end. The tick writes a step's `Admitted` before any report from its driver.
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the dispatch and the branch wind-down, which report the rest"
    )
)]
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
        /// The level the step actually runs at, where its account runs another than the run's.
        permission_level: Option<PermissionLevel>,
    },
    /// The step passed a turn end or a tool call.
    Progressed,
    /// The step was asked to stop and is winding down.
    Canceling,
    /// The wave the step belongs to had its other branches canceled.
    BranchesCanceled,
    /// The step ended.
    Settled(StepSettlement),
}

/// How a step ended.
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the dispatch and the branch wind-down, which settle steps"
    )
)]
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
        /// The step's agent run, kept to resume when the account is back.
        run: Box<dyn AgentStepRun>,
    },
    /// The step was canceled. A step canceled while the gate held it adds its hold to the step's
    /// pool wait.
    Canceled {
        /// When the hold the cancel ended began, `None` when the gate was not holding the step.
        hold_started_at: Option<WireInstant>,
        /// Whether a sibling's failure canceled it.
        is_sibling_failure: bool,
    },
}
