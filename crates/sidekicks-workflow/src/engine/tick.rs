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
mod dispatch;
mod node_settings;

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
    /// The test items pinned onto nodes, by node id; only a manual run honors them.
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

/// A run's scope for a test: the run, workflow and start instant of the test expression
/// bindings, started in `mode` over `nodes`, in UTC with no project or pins, working in
/// `/workspace` at `Ask` on the provider `test-provider`.
#[cfg(test)]
pub(crate) fn test_run_scope(mode: WorkflowRunMode, nodes: Vec<WorkflowNode>) -> RunScope {
    let bindings =
        crate::expressions::bindings::test_expression_bindings(Vec::new(), StepOutputs::default());
    RunScope {
        session_id: SessionId::new("0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7b")
            .expect("the test's session id is a UUID"),
        run_id: bindings.run_id,
        workflow_id: bindings.workflow_id,
        workflow_name: bindings.workflow_name,
        mode,
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
        pin_data: None,
        run_started_at: bindings.run_started_at,
        time_zone: TimeZone::UTC,
        environment_rows: Arc::new([]),
        kept_values: Arc::new([]),
        project: None,
        working_folder: PathBuf::from("/workspace"),
        permission_level: PermissionLevel::Ask,
        provider: ProviderId::new("test-provider".to_owned()).expect("the test's provider id"),
        redaction: Arc::new(RunRedaction::new(&[])),
        cancel: CancellationToken::new(),
    }
}

/// What a run's steps had recorded when the turn began, handed to each step that turn dispatches
/// so every one reads the same fixed copy.
#[derive(Clone)]
pub(crate) struct RunSnapshot {
    /// Each node's executions so far.
    pub(crate) outputs: Arc<StepOutputs>,
    /// The values the run set with `Set variables`.
    pub(crate) run_variables: Arc<Map<String, Value>>,
}

/// A step the walk readied: its key, its loop's run index and its input.
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
/// any report from its driver; a step the gate weighs reports its hold and its admission from its
/// driver.
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
    #[cfg_attr(
        test,
        expect(dead_code, reason = "the branch wind-down, which reports it")
    )]
    Canceling,
    /// The wave the step belongs to had its other branches canceled.
    #[cfg_attr(
        test,
        expect(dead_code, reason = "the branch wind-down, which reports it")
    )]
    BranchesCanceled,
    /// The step ended.
    Settled(StepSettlement),
}

/// How a step ended.
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
    #[cfg_attr(
        test,
        expect(
            dead_code,
            reason = "the agent step's flow, which settles a step on a spent account"
        )
    )]
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
