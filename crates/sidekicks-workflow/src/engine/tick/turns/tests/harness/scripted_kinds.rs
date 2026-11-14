//! The kinds the tick loop's tests run: a trigger, a step and a pair passing their inputs on, and
//! one kind per script, each waking the test's signals where its script waits or is canceled.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::{Value, json};
use sidekicks_contracts::wire::text::ComposedText;
use sidekicks_contracts::workflow::definition::document::WorkflowNode;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use tokio::sync::Notify;

use super::{item, large_items};
use crate::engine::ports::AgentStepRequest;
use crate::kinds::step_context::StepContext;
use crate::kinds::{
    NodeExecutor, NodeKind, NodeKindTable, PassThroughExecutor, PersonAsk, PersonWait,
    StepAdmissionNeed, StepFailure, StepOutcome, main_test_kind, uncoded_step_error,
};

/// A test executor's behavior, by the node it runs.
#[derive(Clone, Copy)]
enum Script {
    /// Fails its first try uncoded, then outputs one item.
    Flaky,
    /// Wakes the test once it runs, waits for its cancel, wakes the test, waits for the test's
    /// release, then passes its inputs on.
    Linger,
    /// Waits for the test's go, then passes its inputs on.
    Gated,
    /// Waits for the test's go, then fails uncoded.
    GatedFailure,
    /// Waits for the test's go, then fails uncoded in a way that ends its run.
    GatedStop,
    /// Passes its inputs on, readied on its first main input with items.
    First,
    /// Outputs one empty list.
    Empty,
    /// Waits for the test's release, then outputs ten items of 7 KiB, above the inline cap
    /// together.
    Large,
    /// Waits for its cancel, then passes its inputs on.
    AwaitCancel,
    /// On the first try of an input whose first item is marked `hang`, waits for its cancel as a
    /// step the daemon's stop cuts off; any other try passes its inputs on.
    HangsFirst,
    /// Outputs the level it runs at; the node `A` first waits for the test's release.
    Level,
    /// Asks an approval that times out after 60 s.
    Approve,
    /// A loop: pass `n` puts batch `n` of the `batches` its first item carries on its loop
    /// output, each batch carrying the list on, and once none is left passes its inputs on done.
    Batches,
    /// Asks for a chat reply that times out after 120 s.
    Ask,
    /// Asks for a form that times out after 120 s.
    Form,
    /// Asks for an agent run, which the harness's runner makes.
    Agent,
    /// Keeps the run variable `report`, above the inline cap, for later runs, then passes its
    /// inputs on.
    Keep,
    /// The loop: one pass of its body on an item marked `pass`, done once that item comes back.
    Loop,
}

/// An executor that runs `script`, waking `signal` where the script waits or is canceled.
struct ScriptedExecutor {
    script: Script,
    signal: Arc<Signals>,
}

/// What the test and its executors wake each other with.
#[derive(Default)]
pub(in crate::engine::tick::turns) struct Signals {
    /// Woken when a step starts waiting for its release or is canceled.
    pub(in crate::engine::tick::turns) reached: Notify,
    /// Woken by the test to release a waiting step.
    pub(in crate::engine::tick::turns) release: Notify,
    /// Woken when a lingering step runs, so the test lets a cancel land only on a running step.
    pub(in crate::engine::tick::turns) running: Notify,
    /// Woken by the test to let a gated step settle.
    pub(in crate::engine::tick::turns) go: Notify,
    /// Set by the test to fail every agent step's params from then on.
    pub(in crate::engine::tick::turns) is_agent_failing: AtomicBool,
}

impl NodeExecutor for ScriptedExecutor {
    fn execute<'step>(
        &'step self,
        context: &'step StepContext,
        inputs: Vec<Vec<WorkflowItem>>,
    ) -> BoxFuture<'step, Result<StepOutcome, StepFailure>> {
        Box::pin(async move {
            Ok(StepOutcome::Outputs(match self.script {
                Script::Flaky => {
                    if context.step.attempt.get() == 1 {
                        return Err(StepFailure::Failed(Box::new(uncoded_step_error(
                            "the first try fails".to_owned(),
                        ))));
                    }
                    vec![vec![item(json!({ "attempt": context.step.attempt }))]]
                }
                Script::Linger => {
                    self.signal.running.notify_one();
                    context.cancel.cancelled().await;
                    self.signal.reached.notify_one();
                    self.signal.release.notified().await;
                    inputs
                }
                Script::First => inputs,
                Script::Batches => {
                    let carried = inputs
                        .first()
                        .and_then(|items| items.first())
                        .map_or(Value::Null, |first| first.json.0.clone());
                    let pass = usize::try_from(context.run_index).expect("a pass fits a usize");
                    match carried["batches"].get(pass) {
                        Some(batch) => {
                            let mut next = batch.clone();
                            next["batches"] = carried["batches"].clone();
                            vec![Vec::new(), vec![item(next)]]
                        }
                        None => vec![inputs.into_iter().next().unwrap_or_default(), Vec::new()],
                    }
                }
                Script::Gated => {
                    self.signal.go.notified().await;
                    inputs
                }
                Script::GatedFailure => {
                    self.signal.go.notified().await;
                    return Err(StepFailure::Failed(Box::new(uncoded_step_error(
                        "the gated step fails".to_owned(),
                    ))));
                }
                Script::GatedStop => {
                    self.signal.go.notified().await;
                    return Err(StepFailure::EndsRun(Box::new(uncoded_step_error(
                        "the gated step stops its run".to_owned(),
                    ))));
                }
                Script::Empty => vec![Vec::new()],
                Script::Loop => match inputs.concat() {
                    back if back.iter().any(|item| item.json.0.get("pass").is_some()) => {
                        vec![back, Vec::new()]
                    }
                    _ => vec![Vec::new(), vec![item(json!({ "pass": 1 }))]],
                },
                Script::Keep => {
                    let report = json!("y".repeat(70 * 1024));
                    context.set_run_variables(
                        serde_json::Map::from_iter([("report".to_owned(), report)]),
                        true,
                    );
                    inputs
                }
                Script::Large => {
                    self.signal.release.notified().await;
                    vec![large_items()]
                }
                Script::HangsFirst => {
                    let is_marked = inputs
                        .first()
                        .and_then(|items| items.first())
                        .is_some_and(|first| first.json.0.get("hang").is_some());
                    if is_marked && context.step.attempt.get() == 1 {
                        context.cancel.cancelled().await;
                    }
                    inputs
                }
                Script::AwaitCancel => {
                    context.cancel.cancelled().await;
                    self.signal.reached.notify_one();
                    inputs
                }
                Script::Level => {
                    if context.step.node_id.as_str() == "A" {
                        self.signal.reached.notify_one();
                        self.signal.release.notified().await;
                    }
                    let level = serde_json::to_value(context.permission_level)
                        .expect("a level writes as JSON");
                    vec![vec![item(json!({ "level": level }))]]
                }
                Script::Approve => {
                    return Ok(person_wait(PersonAsk::Approval { prompt: prompt() }, 60));
                }
                Script::Ask => return Ok(person_wait(PersonAsk::Reply { prompt: prompt() }, 120)),
                Script::Agent => {
                    if self.signal.is_agent_failing.load(Ordering::SeqCst) {
                        return Err(StepFailure::Failed(Box::new(uncoded_step_error(
                            "the agent step's params fail".to_owned(),
                        ))));
                    }
                    return Ok(StepOutcome::AgentRun(AgentStepRequest {
                        session_id: context.session_id,
                        step: context.step.clone(),
                        node_key: context.node_key.clone(),
                        permission_level: context.permission_level,
                        params: serde_json::Map::new(),
                    }));
                }
                Script::Form => {
                    let input_schema = serde_json::Map::new();
                    let form = PersonAsk::Form {
                        prompt: prompt(),
                        input_schema,
                    };
                    return Ok(person_wait(form, 120));
                }
            }))
        })
    }

    fn readies_on_first_input(&self, _node: &WorkflowNode) -> bool {
        matches!(self.script, Script::First)
    }

    fn admission_need(&self, _node: &WorkflowNode) -> StepAdmissionNeed {
        if matches!(self.script, Script::Agent) {
            StepAdmissionNeed::OwnRun
        } else {
            StepAdmissionNeed::Unweighed
        }
    }
}

/// A wait on a person asking `ask`, which times out after `timeout_secs`.
fn person_wait(ask: PersonAsk, timeout_secs: u64) -> StepOutcome {
    StepOutcome::PersonWait(PersonWait {
        ask,
        timeout: Some(Duration::from_secs(timeout_secs)),
    })
}

/// What the test's person waits ask.
fn prompt() -> ComposedText {
    ComposedText::new("Ship it?".to_owned()).expect("the test's prompt")
}

/// The test's kinds: a trigger, a step and a pair passing their inputs on, and one per script.
pub(super) fn kinds(signal: &Arc<Signals>) -> Arc<NodeKindTable> {
    let scripted = |name: &str, inputs: usize, script: Script| {
        let outputs = if matches!(script, Script::Approve | Script::Batches | Script::Loop) {
            2
        } else {
            1
        };
        main_test_kind(
            name,
            "developer",
            (inputs, outputs),
            Box::new(ScriptedExecutor {
                script,
                signal: Arc::clone(signal),
            }),
        )
    };
    let passing = |name: &str, category: &str, inputs: usize| {
        main_test_kind(name, category, (inputs, 1), Box::new(PassThroughExecutor))
    };
    Arc::new(
        NodeKindTable::new(vec![
            passing("test.trigger", "trigger", 1),
            passing("test.step", "developer", 1),
            passing("test.pair", "developer", 2),
            scripted("test.empty", 1, Script::Empty),
            scripted("test.large", 1, Script::Large),
            scripted("test.wait", 1, Script::AwaitCancel),
            scripted("test.hangsFirst", 1, Script::HangsFirst),
            scripted("test.level", 1, Script::Level),
            scripted("test.flaky", 1, Script::Flaky),
            scripted("test.linger", 1, Script::Linger),
            scripted("test.first", 2, Script::First),
            scripted("test.gated", 1, Script::Gated),
            scripted("test.gatedFailure", 1, Script::GatedFailure),
            scripted("test.gatedStop", 1, Script::GatedStop),
            scripted("test.approve", 1, Script::Approve),
            scripted("test.ask", 1, Script::Ask),
            scripted("test.form", 1, Script::Form),
            scripted("test.agent", 1, Script::Agent),
            scripted("test.keep", 1, Script::Keep),
            NodeKind {
                loop_output: Some(1),
                ..scripted("test.batches", 1, Script::Batches)
            },
            NodeKind {
                loop_output: Some(1),
                ..scripted("test.loop", 1, Script::Loop)
            },
        ])
        .expect("the test's kinds build a table"),
    )
}
