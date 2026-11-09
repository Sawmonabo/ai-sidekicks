//! What follows a failed step: the end of its run for a failure that ends it, else a retry while
//! tries are left, else its node's `onError`, which parks the run or passes the step's input on;
//! and, on a park or an end, which of the run's other live steps stop.

use std::time::Duration;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowNode, WorkflowNodeId, WorkflowNodeOnError,
};
use sidekicks_contracts::workflow::definition::item::{
    WorkflowItem, WorkflowPairedItem, WorkflowPairedItems, WorkflowStepError,
};
use sidekicks_contracts::workflow::kind::WorkflowNodeKindSpec;
use sidekicks_contracts::workflow::run::failures::{
    WorkflowStepTimedOutCause, WorkflowStepTimedOutDetails,
};
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseCancellationReason;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use tokio_util::sync::CancellationToken;

use crate::engine::tick::StepReport;
use crate::engine::tick::branch_cancellation::{BranchLoser, BranchWave, cancel_branches};
use crate::engine::tick::dispatch::error_members;
use crate::engine::tick::node_settings::{main_inputs, main_output_count, place_on_first_output};
use crate::kinds::{StepFailure, coded_step_error, uncoded_step_error};

/// The most tries the engine gives a step, whatever its node's `retry.maxTries` asks.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) const RETRY_TRIES_CEILING: u64 = 5;

/// The longest wait the engine leaves between two tries, whatever its node's `retry.waitMs` asks.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) const RETRY_WAIT_CEILING: Duration = Duration::from_millis(5_000);

/// The tries a node's step gets and the wait between them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct StepRetry {
    /// The tries, counted from 1.
    pub(crate) max_tries: u64,
    /// The wait before each new try.
    pub(crate) wait: Duration,
}

/// The tries `node`'s step gets: one with no wait when it sets no `retry`, else its `retry` held
/// under [`RETRY_TRIES_CEILING`] and [`RETRY_WAIT_CEILING`]. The clamp is the engine's; the
/// document's numbers are never trusted past it.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
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
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum StepFailureRoute {
    /// The step runs again as its next attempt, which the walk's retry numbers, after `wait`.
    Retry {
        /// The wait before it runs.
        wait: Duration,
    },
    /// The run parks: nothing new starts. Its siblings stop as [`RunStop::Park`].
    Park,
    /// The run ends, as the step's failure asked. Its siblings stop as [`RunStop::End`].
    End,
    /// The run goes on with the step's input passed on as its outputs.
    PassOn {
        /// The outputs, one list per main output, the error output last where the node has one.
        outputs: Vec<Vec<WorkflowItem>>,
    },
}

/// What follows `step`'s `failure` on `node`, a node of the kind `spec`, over `inputs`, one list
/// per input handle of `spec`: the run's end for a failure that ends it; else a retry while tries
/// are left, never for a decline; else what [`passed_on_outputs`] answers, or a park where
/// `onError` goes on past nothing.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn route_step_failure(
    node: &WorkflowNode,
    spec: &WorkflowNodeKindSpec,
    step: &WorkflowStepKey,
    failure: &StepFailure,
    inputs: &[Vec<WorkflowItem>],
) -> StepFailureRoute {
    match failure {
        StepFailure::EndsRun(_) => return StepFailureRoute::End,
        StepFailure::Crashed(_) => return StepFailureRoute::Park,
        StepFailure::Failed(_) | StepFailure::Declined { .. } => {}
    }
    let retry = step_retry(node);
    if matches!(failure, StepFailure::Failed(_)) && step.attempt.get() < retry.max_tries {
        return StepFailureRoute::Retry { wait: retry.wait };
    }
    match passed_on_outputs(node, spec, failure, inputs) {
        Some(outputs) => StepFailureRoute::PassOn { outputs },
        None => StepFailureRoute::Park,
    }
}

/// The outputs `node`'s `onError` gives `failure` over `inputs`, one list per input handle of
/// `spec`, when it goes on past it: `continue` passes the inputs' items on the first main output,
/// and `continueErrorOutput` sends them down the error output, after the kind's main outputs.
/// `None` for `stop` and an unset `onError`, which go on past nothing.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn passed_on_outputs(
    node: &WorkflowNode,
    spec: &WorkflowNodeKindSpec,
    failure: &StepFailure,
    inputs: &[Vec<WorkflowItem>],
) -> Option<Vec<Vec<WorkflowItem>>> {
    let main_output_count = main_output_count(spec.outputs.as_slice());
    match node.on_error {
        None | Some(WorkflowNodeOnError::Stop) => None,
        Some(WorkflowNodeOnError::Continue) => Some(place_on_first_output(
            passed_on_items(node, spec, failure, inputs),
            main_output_count,
        )),
        Some(WorkflowNodeOnError::ContinueErrorOutput) => {
            let mut outputs = vec![Vec::new(); main_output_count];
            outputs.push(passed_on_items(node, spec, failure, inputs));
            Some(outputs)
        }
    }
}

/// Every main input's items, input by input, each pointing at the input item it is and carrying
/// the step's error on `node`: on the one item of the first main input the error's item index
/// names, the input a per-item kind runs over, or on every item when it names none. A decline's
/// error names the decline and carries its words where the person typed any.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn passed_on_items(
    node: &WorkflowNode,
    spec: &WorkflowNodeKindSpec,
    failure: &StepFailure,
    inputs: &[Vec<WorkflowItem>],
) -> Vec<WorkflowItem> {
    let mut error = step_failure_error(&node.id, failure);
    let failed_item = error_members(&mut error).2.map(SafeInt::get);
    main_inputs(spec, inputs)
        .enumerate()
        .flat_map(|(input_index, items)| {
            items
                .iter()
                .enumerate()
                .map(move |(item_index, item)| (input_index, item_index, item))
        })
        .map(|(input_index, item_index, item)| {
            let is_failed = failed_item.is_none_or(|failed| {
                input_index == 0 && SafeInt::from_usize(item_index).get() == failed
            });
            WorkflowItem {
                json: item.json.clone(),
                binary: item.binary.clone(),
                paired_item: Some(WorkflowPairedItems::One(WorkflowPairedItem {
                    item: SafeInt::from_usize(item_index),
                    input: Some(SafeInt::from_usize(input_index)),
                })),
                error: is_failed.then(|| error.clone()),
            }
        })
        .collect()
}

/// The error `failure` records on the step of node `node_id`: its own, naming that node where it
/// names none, or for a decline one naming the decline and carrying its words where the person
/// typed any.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn step_failure_error(
    node_id: &WorkflowNodeId,
    failure: &StepFailure,
) -> WorkflowStepError {
    let mut error = match failure {
        StepFailure::Failed(error) | StepFailure::EndsRun(error) | StepFailure::Crashed(error) => {
            (**error).clone()
        }
        StepFailure::Declined { words, .. } => uncoded_step_error(match words {
            Some(words) => format!("The step was declined: {}", words.as_str()),
            None => "The step was declined".to_owned(),
        }),
    };
    error_members(&mut error)
        .1
        .get_or_insert_with(|| node_id.clone());
    error
}

/// The failure the run cap gives the step it cuts, `limit_ms` the cap: `workflow.step.timedOut`,
/// cause `runCap`, a failure that ends its run.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn run_cap_failure(limit_ms: SafeInt<1>) -> StepFailure {
    let details = WorkflowStepTimedOutDetails {
        cause: WorkflowStepTimedOutCause::RunCap,
        limit_ms,
    };
    StepFailure::EndsRun(Box::new(coded_step_error(
        RefusalCode::WorkflowStepTimedOut,
        "The run passed its time cap".to_owned(),
        serde_json::to_value(details).expect("the timed-out details write as JSON"),
        None,
    )))
}

/// The failure the restart's sweep gives `step`, which was running when the daemon stopped:
/// `workflow.step.crashed`, a failure that parks its run.
pub(crate) fn crashed_step_failure(step: &WorkflowStepKey) -> StepFailure {
    StepFailure::Crashed(Box::new(coded_step_error(
        RefusalCode::WorkflowStepCrashed,
        "The daemon stopped while the step ran".to_owned(),
        serde_json::json!({}),
        Some(step.node_id.clone()),
    )))
}

/// How a failure stops its run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum RunStop {
    /// The run parks and can be resumed.
    Park,
    /// The run ends.
    End,
}

/// Where one of the run's other live steps stands when a failure stops the run.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum SiblingState {
    /// The step runs, with its cancel.
    Running(CancellationToken),
    /// The step is in the entry line or held at the memory gate, with its cancel.
    Held(CancellationToken),
    /// The step waits on a person or on its agent run's spent account.
    Waiting,
}

/// One of the run's other live steps.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct RunSibling {
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// Where it stands.
    pub(crate) state: SiblingState,
}

/// What stopping a run's siblings answers.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct SiblingStop {
    /// A `Canceling` for each running sibling.
    pub(crate) reports: Vec<StepReport>,
    /// The running siblings, winding down as one wave, when there are any.
    pub(crate) wave: Option<BranchWave>,
    /// The waiting siblings canceled by an end; a park keeps them waiting.
    pub(crate) canceled_waits: Vec<WorkflowStepKey>,
}

/// Stops the run's live `siblings` when the run stops as `stop` for `reason`, `deciding` the step
/// the wave's event sits on: each running sibling winds down in one wave, each held one is
/// canceled at once and settles from its own driver, and a waiting one keeps waiting on a park
/// and is canceled on an end. The commit writes each canceled wait's `workflow.step.canceled` and
/// clears its live columns.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn stop_siblings(
    deciding: WorkflowStepKey,
    stop: RunStop,
    reason: WorkflowPhaseCancellationReason,
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
    let (reports, wave) = cancel_branches(deciding, reason, losers);
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
    use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseCancellationReason;
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
            StepFailureRoute::Retry { wait } => json!({ "retry": {
                "waitMs": u64::try_from(wait.as_millis()).expect("a clamped wait fits"),
            } }),
            StepFailureRoute::Park => json!("park"),
            StepFailureRoute::End => json!("end"),
            StepFailureRoute::PassOn { outputs } => json!({ "passOn": outputs }),
        }
    }

    /// A failure that ends its run ends it, past any retry or `onError`; any other failed step
    /// retries while its clamped tries last and never on a decline, then its `onError` parks,
    /// passes its two main inputs' items on its one main output, or sends them down the error
    /// output after it, each item pointing at its input item and carrying the error, on its node,
    /// only on the item the error names. Mutations: retry or pass on a failure that ends the run;
    /// retry a decline; drop either clamp; compare attempts with `<=`; put a named item's error on
    /// every item; leave a decline's error without its node; place the error output at another
    /// index or count the tool output; drop the lineage or index the inputs with the tool input
    /// counted.
    #[rstest]
    #[case::ends_run(Some([3, 200]), Some("continue"), 1,
        StepFailure::EndsRun(Box::new(
            serde_json::from_value(json!({ "message": "stopped", "nodeId": "step" }))
                .expect("the test's error reads"),
        )),
        json!("end"))]
    #[case::retry_left(Some([3, 200]), None, 1, failed(None),
        json!({ "retry": { "waitMs": 200 } }))]
    #[case::last_try(Some([3, 200]), Some("stop"), 3, failed(None), json!("park"))]
    #[case::clamped_retry(Some([9, 60_000]), None, 4, failed(None),
        json!({ "retry": { "waitMs": 5_000 } }))]
    #[case::clamped_last(Some([9, 60_000]), None, 5, failed(None), json!("park"))]
    #[case::declined(Some([3, 200]), Some("continue"), 1,
        StepFailure::Declined {
            words: Some(NonEmptyText::new("not now".to_owned()).expect("the words are not empty")),
            at: WireInstant::now(),
        },
        json!({ "passOn": [[
            passed("Ada", 0, 0, Some(&json!({
                "message": "The step was declined: not now", "nodeId": "step",
            }))),
            passed("Bob", 1, 0, Some(&json!({
                "message": "The step was declined: not now", "nodeId": "step",
            }))),
            passed("Cy", 0, 1, Some(&json!({
                "message": "The step was declined: not now", "nodeId": "step",
            }))),
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
    /// waiting sibling on a park or keep it on an end; put the held sibling in the wave or give it
    /// a `Canceling`; open the wave as `firstToArrive`.
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

        let stopped = stop_siblings(
            step("failed", 1),
            stop,
            WorkflowPhaseCancellationReason::SiblingFailure,
            siblings,
        );
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
                cancellation_reason: None,
            }),
        };
        let WaveSettle::Closed {
            reports: closing, ..
        } = wave.settle(settled)
        else {
            panic!("the one member's settlement closes the wave");
        };
        let closing: Vec<(String, Option<Option<WorkflowPhaseCancellationReason>>)> = closing
            .iter()
            .map(|report| {
                let cancellation_reason =
                    if let StepReportKind::Settled(StepSettlement::Canceled {
                        cancellation_reason,
                        ..
                    }) = report.kind
                    {
                        Some(cancellation_reason)
                    } else {
                        None
                    };
                (report.step.node_id.as_str().to_owned(), cancellation_reason)
            })
            .collect();
        assert_eq!(
            closing,
            vec![
                ("failed".to_owned(), None),
                (
                    "a".to_owned(),
                    Some(Some(WorkflowPhaseCancellationReason::SiblingFailure))
                )
            ]
        );
    }
}
