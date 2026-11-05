//! What the tick keeps of each run it drives between turns: the run's walk, what its steps
//! recorded, and each of its steps still to settle with what its failure route reads.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowPayloadRef, WorkflowStepKey, WorkflowStepSource,
};

use super::commit::RunLiveStep;
use super::run_status::{RunPersonWait, RunStepCounts};
use super::walk::{RunGraph, RunWalk};
use super::{RunScope, StepReport};
use crate::engine::event_record::RunEngineRecord;
use crate::expressions::lineage::StepOutputs;

/// A run the tick drives: its scope, its record, its walk, each node's executions so far, the
/// values it set with `Set variables`, its steps still to settle, the reports its last dispatch
/// answered, which open its next turn, and its step counts and person-wait columns as its last
/// write left them.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct LiveRun {
    /// What the run's steps share.
    pub(crate) scope: Arc<RunScope>,
    /// The run's record in the engine's record.
    pub(crate) record: RunEngineRecord,
    /// The run's walk over its pinned version's graph.
    pub(crate) walk: RunWalk,
    /// Each node's executions so far, which a dispatched step's expressions read.
    pub(crate) outputs: StepOutputs,
    /// The values the run set with `Set variables`, shared with each snapshot that reads them.
    pub(crate) run_variables: Arc<Map<String, Value>>,
    /// The run's steps readied and not yet settled, by execution index, which no two steps of a
    /// run share.
    pub(crate) steps: HashMap<u64, LiveStep>,
    /// The reports the run's last dispatch answered, which the run's next turn writes before any
    /// report its drivers sent.
    pub(crate) next_batch: Vec<StepReport>,
    /// The run's step counts, which each turn's commit moves and answers.
    pub(crate) counts: RunStepCounts,
    /// The run's person-wait columns, which each turn's commit moves and answers.
    pub(crate) person_wait: RunPersonWait,
}

/// A step of a live run readied and not yet settled: what its failure route and its next attempt
/// read, where it stands, which its next report moves the run's counts from, and its place at the
/// memory gate.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct LiveStep {
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// Where it stands.
    pub(crate) status: WorkflowStepStatus,
    /// What it waits on, while it is `waiting`.
    pub(crate) wait_cause: Option<WorkflowWaitCause>,
    /// The feed of each main input slot in slot order.
    pub(crate) sources: Vec<Option<WorkflowStepSource>>,
    /// The input lists, one per input handle of its kind's spec.
    pub(crate) inputs: Vec<Vec<WorkflowItem>>,
    /// The input as its `pending` row stores it.
    pub(crate) input_ref: WorkflowPayloadRef,
    /// The sequence of the event whose write readied it.
    pub(crate) readying_sequence: SafeInt<0>,
    /// The instant of its hold's last report, `Some` only while the memory gate holds it.
    pub(crate) last_hold_report_at: Option<WireInstant>,
}

impl LiveRun {
    /// The run of `scope` before any step, walking `graph` and recording through `record`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn new(scope: Arc<RunScope>, graph: Arc<RunGraph>, record: RunEngineRecord) -> Self {
        let outputs = StepOutputs::new(
            scope
                .nodes
                .values()
                .map(|node| (node.id.clone(), node.name.as_str().to_owned())),
        );
        Self {
            walk: RunWalk::new(graph, scope.run_id),
            scope,
            record,
            outputs,
            run_variables: Arc::new(Map::new()),
            steps: HashMap::new(),
            next_batch: Vec::new(),
            counts: RunStepCounts::default(),
            person_wait: RunPersonWait::default(),
        }
    }

    /// Moves the live step at `execution_index` to `status`, waiting on `wait_cause` where it
    /// waits, as the turn's commit moved its row.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn move_step(
        &mut self,
        execution_index: u64,
        status: WorkflowStepStatus,
        wait_cause: Option<WorkflowWaitCause>,
    ) {
        let live_step = self
            .steps
            .get_mut(&execution_index)
            .expect("a step the turn moved is live");
        live_step.status = status;
        live_step.wait_cause = wait_cause;
    }

    /// The run's live steps as a resumption point reads them.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn live_steps(&self) -> impl Iterator<Item = RunLiveStep<'_>> {
        self.steps.values().map(|live_step| RunLiveStep {
            step: &live_step.step,
            status: live_step.status,
            wait_cause: live_step.wait_cause,
        })
    }
}
