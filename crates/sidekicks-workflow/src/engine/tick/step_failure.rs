//! What follows a failed step: a retry while tries are left, else its node's `onError`, which parks
//! the run or passes the step's input on; and, on a park or an end, which of the run's other live
//! steps stop.

use std::time::Duration;

use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{WorkflowNode, WorkflowNodeOnError};
use sidekicks_contracts::workflow::definition::item::{
    WorkflowItem, WorkflowPairedItem, WorkflowPairedItems, WorkflowStepError,
};
use sidekicks_contracts::workflow::kind::WorkflowNodeKindSpec;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use tokio_util::sync::CancellationToken;

use crate::engine::tick::StepReport;
use crate::engine::tick::branch_cancellation::{
    BranchCancelReason, BranchLoser, BranchWave, cancel_branches,
};
use crate::engine::tick::node_settings::{
    index, main_inputs, main_output_count, place_on_first_output,
};
use crate::kinds::{StepFailure, uncoded_step_error};

/// The most tries the engine gives a step, whatever its node's `retry.maxTries` asks.
pub(crate) const RETRY_TRIES_CEILING: u64 = 5;

/// The longest wait the engine leaves between two tries, whatever its node's `retry.waitMs` asks.
pub(crate) const RETRY_WAIT_CEILING: Duration = Duration::from_millis(5_000);

/// The tries a node's step gets and the wait between them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StepRetry {
    /// The tries, counted from 1.
    pub(crate) max_tries: u64,
    /// The wait before each new try.
    pub(crate) wait: Duration,
}

/// The tries `node`'s step gets: one with no wait when it sets no `retry`, else its `retry` held
/// under [`RETRY_TRIES_CEILING`] and [`RETRY_WAIT_CEILING`]. The clamp is the engine's; the
/// document's numbers are never trusted past it.
pub(crate) fn step_retry(node: &WorkflowNode) -> StepRetry {
    match node.retry {
        None => StepRetry {
            max_tries: 1,
            wait: Duration::ZERO,
        },
        Some(retry) => StepRetry {
            max_tries: retry.max_tries.get().min(RETRY_TRIES_CEILING),
            wait: Duration::from_millis(retry.wait_ms.get()).min(RETRY_WAIT_CEILING),
        },
    }
}

/// What follows a failed step.
pub(crate) enum StepFailureRoute {
    /// The step runs again as a new attempt after `wait`.
    Retry {
        /// The new attempt's number.
        attempt: SafeInt<1>,
        /// The wait before it runs.
        wait: Duration,
    },
    /// The run parks: nothing new starts.
    Park,
    /// The run goes on with the step's input passed on as its outputs.
    PassOn {
        /// The outputs, one list per main output, the error output last where the node has one.
        outputs: Vec<Vec<WorkflowItem>>,
    },
}

/// What follows `step`'s `failure` on `node`, a node of the kind `spec`, over `inputs`, one list per
/// input handle of `spec`: a retry while tries are left, never for a decline; else `stop` or an
/// unset `onError` parks, `continue` passes the inputs' items on the first main output, and
/// `continueErrorOutput` sends them down the error output, after the kind's main outputs.
pub(crate) fn route_step_failure(
    node: &WorkflowNode,
    spec: &WorkflowNodeKindSpec,
    step: &WorkflowStepKey,
    failure: &StepFailure,
    inputs: &[Vec<WorkflowItem>],
) -> StepFailureRoute {
    let retry = step_retry(node);
    if matches!(failure, StepFailure::Failed(_)) && step.attempt.get() < retry.max_tries {
        return StepFailureRoute::Retry {
            attempt: SafeInt::new(step.attempt.get() + 1)
                .expect("an attempt below the tries ceiling is far below 2^53"),
            wait: retry.wait,
        };
    }
    let main_output_count = main_output_count(spec);
    match node.on_error {
        None | Some(WorkflowNodeOnError::Stop) => StepFailureRoute::Park,
        Some(WorkflowNodeOnError::Continue) => StepFailureRoute::PassOn {
            outputs: place_on_first_output(
                passed_on_items(spec, failure, inputs),
                main_output_count,
            ),
        },
        Some(WorkflowNodeOnError::ContinueErrorOutput) => {
            let mut outputs = vec![Vec::new(); main_output_count];
            outputs.push(passed_on_items(spec, failure, inputs));
            StepFailureRoute::PassOn { outputs }
        }
    }
}

/// Every main input's items, input by input, each pointing at the input item it is and carrying
/// the step's error: on the one item of the first main input the error's item index names, the
/// input a per-item kind runs over, or on every item when it names none. A decline's error names
/// the decline and carries its words where the person typed any.
fn passed_on_items(
    spec: &WorkflowNodeKindSpec,
    failure: &StepFailure,
    inputs: &[Vec<WorkflowItem>],
) -> Vec<WorkflowItem> {
    let error = match failure {
        StepFailure::Failed(error) => (**error).clone(),
        StepFailure::Declined { words, .. } => uncoded_step_error(match words {
            Some(words) => format!("The step was declined: {}", words.as_str()),
            None => "The step was declined".to_owned(),
        }),
    };
    let failed_item = error_item_index(&error).map(SafeInt::get);
    main_inputs(spec, inputs)
        .enumerate()
        .flat_map(|(input_index, items)| {
            items
                .iter()
                .enumerate()
                .map(move |(item_index, item)| (input_index, item_index, item))
        })
        .map(|(input_index, item_index, item)| {
            let is_failed = failed_item
                .is_none_or(|failed| input_index == 0 && index(item_index).get() == failed);
            WorkflowItem {
                json: item.json.clone(),
                binary: item.binary.clone(),
                paired_item: Some(WorkflowPairedItems::One(WorkflowPairedItem {
                    item: index(item_index),
                    input: Some(index(input_index)),
                })),
                error: is_failed.then(|| error.clone()),
            }
        })
        .collect()
}

/// The input item a step failure names, whichever arm it is.
fn error_item_index(error: &WorkflowStepError) -> Option<SafeInt<0>> {
    match error {
        WorkflowStepError::Uncoded(arm) => arm.item_index,
        WorkflowStepError::Coded(arm) => arm.item_index,
        WorkflowStepError::AgentResolution(arm) => arm.item_index,
    }
}

/// How a failure stops its run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunStop {
    /// The run parks and can be resumed.
    Park,
    /// The run ends.
    End,
}

/// Where one of the run's other live steps stands when a failure stops the run.
pub(crate) enum SiblingState {
    /// The step runs, with its cancel.
    Running(CancellationToken),
    /// The step is in the entry line or held at the memory gate, with its cancel.
    Held(CancellationToken),
    /// The step waits on a person.
    Waiting,
}

/// One of the run's other live steps.
pub(crate) struct RunSibling {
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// Where it stands.
    pub(crate) state: SiblingState,
}

/// What stopping a run's siblings answers.
pub(crate) struct SiblingStop {
    /// A `Canceling` for each running sibling.
    pub(crate) reports: Vec<StepReport>,
    /// The running siblings, winding down as one sibling-failure wave, when there are any.
    pub(crate) wave: Option<BranchWave>,
    /// The waiting siblings canceled by an end; a park keeps them waiting.
    pub(crate) canceled_waits: Vec<WorkflowStepKey>,
}

/// Stops the run's other live `siblings` when `deciding`'s failure stops the run as `stop`: each
/// running sibling winds down in one sibling-failure wave, each held one is canceled at once and
/// settles from its own driver, and a waiting one keeps waiting on a park and is canceled on an
/// end. The commit writes each canceled wait's `workflow.step.canceled` and clears its live
/// columns.
pub(crate) fn stop_siblings(
    deciding: WorkflowStepKey,
    stop: RunStop,
    siblings: Vec<RunSibling>,
) -> SiblingStop {
    let mut losers = Vec::new();
    let mut canceled_waits = Vec::new();
    for sibling in siblings {
        match sibling.state {
            SiblingState::Running(cancel) => losers.push(BranchLoser {
                step: sibling.step,
                is_running: true,
                cancel,
            }),
            SiblingState::Held(cancel) => losers.push(BranchLoser {
                step: sibling.step,
                is_running: false,
                cancel,
            }),
            SiblingState::Waiting => {
                if stop == RunStop::End {
                    canceled_waits.push(sibling.step);
                }
            }
        }
    }
    let (reports, wave) = cancel_branches(deciding, BranchCancelReason::SiblingFailure, losers);
    SiblingStop {
        reports,
        wave,
        canceled_waits,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::text::NonEmptyText;
    use sidekicks_contracts::workflow::definition::document::WorkflowNode;
    use sidekicks_contracts::workflow::definition::item::WorkflowItem;
    use sidekicks_contracts::workflow::kind::WorkflowNodeKindSpec;
    use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
    use tokio_util::sync::CancellationToken;

    use super::{
        RunSibling, RunStop, SiblingState, StepFailureRoute, route_step_failure, stop_siblings,
    };
    use crate::engine::tick::branch_cancellation::WaveSettle;
    use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
    use crate::kinds::StepFailure;

    /// Execution 0 of node `node_id` at `attempt`.
    fn step(node_id: &str, attempt: u64) -> WorkflowStepKey {
        serde_json::from_value(json!({
            "workflowRunId": "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7c",
            "nodeId": node_id, "attempt": attempt, "executionIndex": 0,
        }))
        .expect("the test's step key reads")
    }

    /// A kind with two main inputs, a tool input between them, one main output and a tool output.
    fn spec() -> WorkflowNodeKindSpec {
        serde_json::from_value(json!({
            "kind": "test.step", "version": 1, "category": "developer",
            "displayName": "Test", "description": "A test kind.", "icon": "test",
            "params": [], "outputsDeriveFromParams": false,
            "inputs": [
                { "type": "main", "id": "inputs/main/0", "label": "In" },
                { "type": "tool", "id": "inputs/tool/0", "label": "Tool" },
                { "type": "main", "id": "inputs/main/1", "label": "Other" },
            ],
            "outputs": [
                { "type": "main", "id": "outputs/main/0", "label": "Out" },
                { "type": "tool", "id": "outputs/tool/0", "label": "Tool" },
            ],
        }))
        .expect("the test's spec reads")
    }

    /// The node `step` of `test.step` with `retry` as `[maxTries, waitMs]` and `on_error`, each
    /// where given.
    fn node(retry: Option<[u64; 2]>, on_error: Option<&str>) -> WorkflowNode {
        let mut node = json!({
            "id": "step", "kind": "test.step", "kindVersion": 1, "name": "Step", "order": 0,
            "params": {},
        });
        if let Some([max_tries, wait_ms]) = retry {
            node["retry"] = json!({ "maxTries": max_tries, "waitMs": wait_ms });
        }
        if let Some(on_error) = on_error {
            node["onError"] = json!(on_error);
        }
        serde_json::from_value(node).expect("the test's node reads")
    }

    /// An input item named `name`.
    fn input_item(name: &str) -> WorkflowItem {
        serde_json::from_value(json!({ "json": { "name": name } })).expect("the test's item reads")
    }

    /// The step's own failure, naming input item `item_index` where given.
    fn failed(item_index: Option<u64>) -> StepFailure {
        let mut error = json!({ "message": "disk full", "nodeId": "step" });
        if let Some(item_index) = item_index {
            error["itemIndex"] = json!(item_index);
        }
        StepFailure::Failed(Box::new(
            serde_json::from_value(error).expect("the test's error reads"),
        ))
    }

    /// A passed-on item named `name` from item `item` of main input `input`, carrying `error`.
    fn passed(name: &str, item: u64, input: u64, error: Option<&Value>) -> Value {
        let mut passed = json!({
            "json": { "name": name }, "pairedItem": { "item": item, "input": input },
        });
        if let Some(error) = error {
            passed["error"] = error.clone();
        }
        passed
    }

    /// `route` as JSON, reading every member it carries.
    fn route_json(route: StepFailureRoute) -> Value {
        match route {
            StepFailureRoute::Retry { attempt, wait } => json!({ "retry": {
                "attempt": attempt.get(),
                "waitMs": u64::try_from(wait.as_millis()).expect("a clamped wait fits"),
            } }),
            StepFailureRoute::Park => json!("park"),
            StepFailureRoute::PassOn { outputs } => json!({ "passOn": outputs }),
        }
    }

    /// A failed step retries while its clamped tries last and never on a decline, then its
    /// `onError` parks, passes its two main inputs' items on its one main output, or sends them
    /// down the error output after it, each item pointing at its input item and carrying the error
    /// only on the item the error names. Mutations: retry a decline; drop either clamp; compare
    /// attempts with `<=`; put a named item's error on every item; place the error output at
    /// another index or count the tool output; drop the lineage or index the inputs with the tool
    /// input counted.
    #[rstest]
    #[case::retry_left(Some([3, 200]), None, 1, failed(None),
        json!({ "retry": { "attempt": 2, "waitMs": 200 } }))]
    #[case::last_try(Some([3, 200]), Some("stop"), 3, failed(None), json!("park"))]
    #[case::clamped_retry(Some([9, 60_000]), None, 4, failed(None),
        json!({ "retry": { "attempt": 5, "waitMs": 5_000 } }))]
    #[case::clamped_last(Some([9, 60_000]), None, 5, failed(None), json!("park"))]
    #[case::declined(Some([3, 200]), Some("continue"), 1,
        StepFailure::Declined {
            words: Some(NonEmptyText::new("not now".to_owned()).expect("the words are not empty")),
            at: WireInstant::now(),
        },
        json!({ "passOn": [[
            passed("Ada", 0, 0, Some(&json!({ "message": "The step was declined: not now" }))),
            passed("Bob", 1, 0, Some(&json!({ "message": "The step was declined: not now" }))),
            passed("Cy", 0, 1, Some(&json!({ "message": "The step was declined: not now" }))),
        ]] }))]
    #[case::continue_whole(None, Some("continue"), 1, failed(None),
        json!({ "passOn": [[
            passed("Ada", 0, 0, Some(&json!({ "message": "disk full", "nodeId": "step" }))),
            passed("Bob", 1, 0, Some(&json!({ "message": "disk full", "nodeId": "step" }))),
            passed("Cy", 0, 1, Some(&json!({ "message": "disk full", "nodeId": "step" }))),
        ]] }))]
    #[case::continue_one_item(None, Some("continue"), 1, failed(Some(1)),
        json!({ "passOn": [[
            passed("Ada", 0, 0, None),
            passed("Bob", 1, 0, Some(&json!({
                "message": "disk full", "nodeId": "step", "itemIndex": 1,
            }))),
            passed("Cy", 0, 1, None),
        ]] }))]
    #[case::error_output(None, Some("continueErrorOutput"), 1, failed(None),
        json!({ "passOn": [[], [
            passed("Ada", 0, 0, Some(&json!({ "message": "disk full", "nodeId": "step" }))),
            passed("Bob", 1, 0, Some(&json!({ "message": "disk full", "nodeId": "step" }))),
            passed("Cy", 0, 1, Some(&json!({ "message": "disk full", "nodeId": "step" }))),
        ]] }))]
    #[case::unset(None, None, 1, failed(None), json!("park"))]
    fn a_failed_step_retries_then_routes_by_its_on_error(
        #[case] retry: Option<[u64; 2]>,
        #[case] on_error: Option<&str>,
        #[case] attempt: u64,
        #[case] failure: StepFailure,
        #[case] expected: Value,
    ) {
        let inputs = vec![
            vec![input_item("Ada"), input_item("Bob")],
            Vec::new(),
            vec![input_item("Cy")],
        ];
        let route = route_step_failure(
            &node(retry, on_error),
            &spec(),
            &step("step", attempt),
            &failure,
            &inputs,
        );
        assert_eq!(route_json(route), expected);
    }

    /// A stop cancels the running sibling into a sibling-failure wave and the held one at once,
    /// outside the wave, and keeps the waiting one on a park but cancels it on an end; settling the
    /// running one closes the wave with its cancel marked a sibling failure. Mutations: cancel a
    /// waiting sibling on a park or keep it on an end; put the held sibling in the wave or give it a
    /// `Canceling`; open the wave as `firstToArrive`.
    #[rstest]
    #[case::park(RunStop::Park, &[])]
    #[case::end(RunStop::End, &["w"])]
    fn a_park_keeps_waits_and_an_end_cancels_them(
        #[case] stop: RunStop,
        #[case] canceled_waits: &[&str],
    ) {
        let running = CancellationToken::new();
        let held = CancellationToken::new();
        let siblings = vec![
            RunSibling {
                step: step("a", 1),
                state: SiblingState::Running(running.clone()),
            },
            RunSibling {
                step: step("h", 1),
                state: SiblingState::Held(held.clone()),
            },
            RunSibling {
                step: step("w", 1),
                state: SiblingState::Waiting,
            },
        ];

        let stopped = stop_siblings(step("failed", 1), stop, siblings);
        let reports: Vec<(String, bool)> = stopped
            .reports
            .iter()
            .map(|report| {
                let is_canceling = matches!(report.kind, StepReportKind::Canceling);
                (report.step.node_id.as_str().to_owned(), is_canceling)
            })
            .collect();
        assert_eq!(reports, vec![("a".to_owned(), true)]);
        assert!(running.is_cancelled() && held.is_cancelled());
        let waits: Vec<&str> = stopped
            .canceled_waits
            .iter()
            .map(|wait| wait.node_id.as_str())
            .collect();
        assert_eq!(waits, canceled_waits);

        let mut wave = stopped.wave.expect("a running sibling makes a wave");
        let settled = StepReport {
            step: step("a", 1),
            at: WireInstant::now(),
            kind: StepReportKind::Settled(StepSettlement::Canceled {
                hold_started_at: None,
                is_sibling_failure: false,
            }),
        };
        let WaveSettle::Closed(closing) = wave.settle(settled) else {
            panic!("the one member's settlement closes the wave");
        };
        let closing: Vec<(String, Option<bool>)> = closing
            .iter()
            .map(|report| {
                let is_sibling_failure =
                    if let StepReportKind::Settled(StepSettlement::Canceled {
                        is_sibling_failure,
                        ..
                    }) = report.kind
                    {
                        Some(is_sibling_failure)
                    } else {
                        None
                    };
                (report.step.node_id.as_str().to_owned(), is_sibling_failure)
            })
            .collect();
        assert_eq!(
            closing,
            vec![("failed".to_owned(), None), ("a".to_owned(), Some(true))]
        );
    }
}
