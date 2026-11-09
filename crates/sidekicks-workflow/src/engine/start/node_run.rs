//! A node run's start on its plan, and the node run as its start hands it to the tick: the places
//! it covers, by place, and the earlier steps its walk replays, each with its outputs read back
//! and the session it lives in.

use std::sync::Arc;

use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::events::WorkflowNodeRun;
use sidekicks_contracts::workflow::run::step::record::WorkflowPayloadRef;
use sidekicks_store::database::connection::read_pool::ReadLength;

use super::check::fill_start_items;
use super::{WorkflowRunStart, WorkflowRunStartError, WorkflowRunStarter, WorkflowStartOutcome};
use crate::definitions::versions::history::WorkflowVersions;
use crate::engine::partial_run::{
    PartialRunPlan, ReplayedStep, plan_partial_run, read_settled_steps,
};
use crate::engine::ports::StepPayloadArtifacts;
use crate::engine::tick::{ReusedSeedStep, ReusedStepRecord, RunGraph};
use crate::runs::step_payload::{
    StepPayloadReadError, StepPayloadWriteError, join_step_outputs, read_step_payload,
    split_step_outputs, write_step_payload,
};

/// A node run's start: how it ended, and the nodes its run executes and reuses, as the node run's
/// reply lists them.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.node.execute handler")
)]
pub(crate) struct NodeRunStartOutcome {
    /// How the start ended.
    pub(crate) outcome: WorkflowStartOutcome,
    /// The nodes the run executes, in execution order.
    pub(crate) executed_node_ids: Vec<WorkflowNodeId>,
    /// The nodes whose earlier steps it reuses, or reads as its target's prior input.
    pub(crate) reused_node_ids: Vec<WorkflowNodeId>,
}

impl WorkflowRunStarter {
    /// Starts `start`'s run as `node_run`, on its plan: the start's checks, with
    /// `workflow.node.notFound` for a node the version lacks; the plan on one pooled read; the
    /// trigger reused where no items were given or the given items equal its earlier input, and
    /// every covered node executed where they differ; each reused output read back and split;
    /// then the start's one write naming the node run, holding the trigger's row and input only
    /// where the trigger runs. A trigger given no items that runs starts on its earlier input, or,
    /// with no earlier step, fills its declared inputs from none. Fails as
    /// [`WorkflowRunStarter::start`] does, and with [`WorkflowRunStartError::Plan`],
    /// [`WorkflowRunStartError::ReusedOutput`] or [`WorkflowRunStartError::ReusedOutputStore`]
    /// when the plan does not read, a reused payload does not read back, or a reused output of
    /// another session cannot be stored in this run's, with nothing written.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the workflow.node.execute handler")
    )]
    pub(crate) async fn start_node_run(
        &self,
        start: WorkflowRunStart,
        node_run: WorkflowNodeRun,
    ) -> Result<NodeRunStartOutcome, WorkflowRunStartError> {
        let mut checked = self.check(&start, Some(&node_run.node_id)).await?;
        let trigger_id = checked.trigger_node.node_id.clone();
        let pins = std::mem::take(&mut checked.pins);
        let graph = Arc::clone(&checked.graph);
        let (workflow_version_id, target, scope) = (
            start.workflow_version_id,
            node_run.node_id.clone(),
            node_run.scope,
        );
        let plan_trigger_id = trigger_id.clone();
        let (mut plan, pins, trigger_steps) = self
            .pool
            .read(ReadLength::Short, move |connection| {
                let version =
                    WorkflowVersions::new(connection).read_version(workflow_version_id)?;
                let plan = plan_partial_run(connection, &version, &graph, &target, scope, &pins)?;
                // A trigger the plan runs has its earlier steps read for the input it may reuse.
                let trigger_steps = if plan.executed.contains(&plan_trigger_id) {
                    read_settled_steps(connection, version.definition_id, [&plan_trigger_id])?
                        .remove(&plan_trigger_id)
                } else {
                    None
                };
                Ok::<_, WorkflowRunStartError>((plan, pins, trigger_steps))
            })
            .await?;
        checked.pins = pins;
        let reused_trigger = plan
            .reused
            .iter()
            .chain(&plan.inputs)
            .find(|(node_id, _)| *node_id == trigger_id)
            .map(|(_, steps)| steps);
        let is_trigger_reused = reused_trigger.is_some();
        let earlier_input = reused_trigger
            .or(trigger_steps.as_ref())
            .and_then(|steps| steps.last())
            .map(|step| step.input_ref.clone());
        let read_earlier = async |earlier: &WorkflowPayloadRef| {
            read_step_payload(&*self.payloads, earlier)
                .await
                .map_err(WorkflowRunStartError::ReusedOutput)
        };
        checked.start_items = match (checked.start_items.take(), earlier_input) {
            (Some(items), Some(earlier)) if is_trigger_reused => {
                if read_earlier(&earlier).await? == items {
                    None
                } else {
                    plan.execute_covered(&checked.graph, &node_run.node_id);
                    Some(items)
                }
            }
            (None, Some(_)) if is_trigger_reused => None,
            (None, Some(earlier)) => Some(read_earlier(&earlier).await?),
            (None, None) => Some(fill_start_items(&checked.declared_inputs, &[])?),
            (Some(items), _) => Some(items),
        };
        let executed_node_ids = plan.executed.clone();
        let reused_node_ids = plan
            .reused
            .iter()
            .chain(&plan.inputs)
            .map(|(node_id, _)| node_id.clone())
            .collect();
        let replayed = StartedNodeRun::from_plan(&checked.graph, plan, &*self.payloads)
            .await
            .map_err(WorkflowRunStartError::ReusedOutput)?;
        let outcome = self
            .start_checked(start, checked, None, Some((node_run, replayed)))
            .await?;
        Ok(NodeRunStartOutcome {
            outcome,
            executed_node_ids,
            reused_node_ids,
        })
    }
}

/// What a node run covers and the earlier steps it replays, which its walk is seeded with.
pub(crate) struct StartedNodeRun {
    /// Whether each place of the run's graph, by place, is one the run covers.
    pub(crate) covered: Arc<[bool]>,
    /// The earlier steps the walk replays, each node's in its earlier run's execution order.
    pub(crate) reused: Vec<StartedReusedStep>,
}

/// One earlier step a node run replays: the seed its walk takes, the outputs the run's later steps
/// read, and the session of the run it came from.
pub(crate) struct StartedReusedStep {
    /// The step as the walk replays it.
    pub(crate) seed: ReusedSeedStep,
    /// Its main outputs' items, in output order.
    pub(crate) outputs: Vec<Vec<WorkflowItem>>,
    /// The session of the run it came from, whose purge erases only that session's payloads.
    pub(crate) session_id: SessionId,
}

impl StartedNodeRun {
    /// The node run of `plan` over `graph`, the graph the plan was made on: covering every node the
    /// plan names, and replaying each settled step of the nodes it reuses or reads as the target's
    /// prior input, its output read back through `payloads` and split by its counts. A step the
    /// walk skips on its own is left out, since the walk never readies it to replay: every step of
    /// a node `graph` disables, and a skip that passed no items on. Fails as
    /// [`StepPayloadReadError`] says when an output cannot be read back.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's node run start handler")
    )]
    pub(crate) async fn from_plan(
        graph: &RunGraph,
        plan: PartialRunPlan,
        payloads: &dyn StepPayloadArtifacts,
    ) -> Result<Self, StepPayloadReadError> {
        let (covered, replayed) = plan.replayed(graph);
        let mut reused = Vec::with_capacity(replayed.len());
        for ReplayedStep {
            node_id,
            settled,
            output_lengths,
        } in replayed
        {
            let items = read_step_payload(payloads, &settled.output_ref).await?;
            let outputs = split_step_outputs(items, &output_lengths)?;
            let from = settled.origin();
            reused.push(StartedReusedStep {
                seed: ReusedSeedStep {
                    node_id,
                    output_lengths,
                    record: ReusedStepRecord {
                        from,
                        output_ref: settled.output_ref,
                        pin_hash: settled.pin_hash,
                    },
                },
                outputs,
                session_id: settled.session_id,
            });
        }
        Ok(Self { covered, reused })
    }

    /// Stores again in `session_id`, the run's session, each replayed output kept as an artifact
    /// of another session, since a session's purge erases only its own payloads: under the step
    /// that computed it, its copy then replayed in its place, each copy's artifact pushed onto
    /// `stored` as it is made. Fails as [`StepPayloadWriteError`] says on the first copy that
    /// cannot be stored.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the workflow.node.execute handler")
    )]
    pub(crate) async fn store_in_session(
        &mut self,
        payloads: &dyn StepPayloadArtifacts,
        session_id: SessionId,
        stored: &mut Vec<ArtifactId>,
    ) -> Result<(), StepPayloadWriteError> {
        for step in &mut self.reused {
            let record = &mut step.seed.record;
            if step.session_id == session_id
                || matches!(record.output_ref, WorkflowPayloadRef::Inline { .. })
            {
                continue;
            }
            let joined = join_step_outputs(&step.outputs);
            let output_ref =
                write_step_payload(payloads, session_id, &record.from.step, &joined).await?;
            if let WorkflowPayloadRef::Artifact { artifact_id, .. } = &output_ref {
                stored.push(*artifact_id);
            }
            record.output_ref = output_ref;
            step.session_id = session_id;
        }
        Ok(())
    }
}
