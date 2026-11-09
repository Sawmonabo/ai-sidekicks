//! A node run as its start hands it to the tick: the places it covers, by place, and the earlier
//! steps its walk replays, each with its outputs read back and the session it lives in.

use std::sync::Arc;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;

use crate::engine::partial_run::PartialRunPlan;
use crate::engine::ports::StepPayloadArtifacts;
use crate::engine::tick::{ReusedSeedStep, ReusedStepRecord, RunGraph};
use crate::runs::step_payload::{StepPayloadReadError, read_step_payload, split_step_outputs};

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
        let mut covered = vec![false; graph.node_count()];
        for node_id in &plan.executed {
            covered[graph.place(node_id)] = true;
        }
        let mut reused = Vec::new();
        for (node_id, steps) in plan.reused.into_iter().chain(plan.inputs) {
            let place = graph.place(&node_id);
            covered[place] = true;
            if graph.node(place).is_disabled {
                continue;
            }
            for settled in steps {
                let output_lengths: Vec<usize> = settled
                    .output_item_counts
                    .iter()
                    .map(|count| {
                        usize::try_from(count.get())
                            .expect("an output's item count fits in a pointer-sized integer")
                    })
                    .collect();
                let is_own_skip =
                    settled.status == WorkflowStepStatus::Skipped && settled.reused_from.is_none();
                if is_own_skip && output_lengths.iter().all(|&length| length == 0) {
                    continue;
                }
                let items = read_step_payload(payloads, &settled.output_ref).await?;
                let outputs = split_step_outputs(items, &output_lengths)?;
                let from = settled.origin();
                reused.push(StartedReusedStep {
                    seed: ReusedSeedStep {
                        node_id: node_id.clone(),
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
        }
        Ok(Self {
            covered: Arc::from(covered),
            reused,
        })
    }
}
