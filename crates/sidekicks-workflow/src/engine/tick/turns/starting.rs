//! A started run taken into the tick's live set: a whole run's trigger step, readied by the start's
//! own write, or a node run's walk seeded with the earlier steps it reuses and kept to the places
//! it covers, whose first turn the run's share of the tick's turn writes.

use std::collections::HashMap;
use std::sync::Arc;

use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;

use super::EngineTick;
use crate::engine::start::{StartedNodeRun, StartedReusedStep, StartedRun, StartedTrigger};
use crate::engine::tick::ReadyStep;
use crate::engine::tick::live_runs::{LiveRun, LiveStep, ReusedOutputs};
use crate::engine::tick::node_settings::main_inputs;
use crate::engine::tick::walk::{RunWalk, WalkTurn};

/// How a run the tick took opens.
pub(super) enum RunOpening {
    /// Its trigger step, readied by the start's own write, to dispatch this turn.
    Readied(ReadyStep),
    /// Its walk's first turn, the trigger's reused skip first, which the run's share writes.
    Seeded(WalkTurn),
}

impl EngineTick {
    /// Takes `run` into the live set on its walk, a node run's seeded with the steps it reuses,
    /// each step's outputs held until the walk replays it, and kept to the places it covers.
    /// Answers its trigger step, readied by the start's own write, on the start's items, or, where
    /// the walk replays the trigger, the walk's first turn.
    pub(super) fn start_run(&mut self, run: StartedRun) -> (WorkflowRunId, RunOpening) {
        let StartedRun {
            scope,
            graph,
            trigger,
            node_run,
            started_sequence,
        } = run;
        let run_id = scope.run_id;
        let record = self.recorder.for_run(run_id, Arc::clone(&scope.redaction));
        let mut reused_outputs: HashMap<_, ReusedOutputs> = HashMap::new();
        let walk = match node_run {
            None => RunWalk::new(graph, run_id),
            Some(StartedNodeRun { covered, reused }) => {
                let mut seed = Vec::with_capacity(reused.len());
                for StartedReusedStep {
                    seed: step,
                    outputs,
                    session_id,
                } in reused
                {
                    reused_outputs
                        .entry(step.node_id.clone())
                        .or_default()
                        .push((step.record.from.clone(), session_id, outputs));
                    seed.push(step);
                }
                RunWalk::reusing(graph, run_id, Some(covered), seed)
            }
        };
        let mut live = LiveRun::new(scope, walk, reused_outputs, record);
        let mut opened = live.walk.start();
        let opening = if opened.skipped.is_empty() {
            let trigger_step = opened
                .ready
                .pop()
                .expect("a walk starts by readying its trigger where it does not replay it");
            let StartedTrigger { input_ref, items } =
                trigger.expect("a run whose trigger step runs was started on its input");
            let node = live
                .scope
                .nodes
                .get(&trigger_step.step.node_id)
                .expect("the trigger is one of the run's nodes");
            let spec = self.spec(node);
            let mut inputs = vec![Vec::new(); spec.inputs.as_slice().len()];
            if let Some(first) = main_inputs(spec, inputs.iter_mut()).next() {
                *first = items;
            }
            let ready = ReadyStep {
                step: trigger_step.step.clone(),
                run_index: trigger_step.run_index,
                inputs: inputs.clone(),
                input_ref: input_ref.clone(),
            };
            live.counts.moved(None, (WorkflowStepStatus::Pending, None));
            live.steps.insert(
                ready.step.execution_index.get(),
                LiveStep::readied(trigger_step, inputs, input_ref, started_sequence),
            );
            RunOpening::Readied(ready)
        } else {
            RunOpening::Seeded(opened)
        };
        live.follow_cap(&self.deadlines, false);
        self.runs.insert(run_id, live);
        (run_id, opening)
    }
}
