//! The table of node kinds: for a node's kind and version, the kind's spec, its executor and the
//! param holding its shell line, and the rules a save checks the node against. An executor
//! describes what its step does; the engine acts on it, opening a wait or starting an agent run
//! through its ports and producing the step's output from the answer.

pub(crate) mod step_context;

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{ComposedText, NonEmptyText};
use sidekicks_contracts::workflow::definition::document::{
    WorkflowNode, WorkflowNodeId, WorkflowNodeKindId, WorkflowNodeOnError,
};
use sidekicks_contracts::workflow::definition::item::{
    WorkflowItem, WorkflowStepCodedError, WorkflowStepError, WorkflowStepErrorCode,
    WorkflowStepUncodedError,
};
use sidekicks_contracts::workflow::definition::refusals::WorkflowNodeHandles;
use sidekicks_contracts::workflow::kind::{
    OutputMainHandleId, WorkflowNodeKindSpec, WorkflowOutputHandleSpec,
};

use crate::engine::ports::{AgentStepRequest, StepScriptRuntime};
use crate::engine::tick::node_settings::{main_input_count, main_output_count};
use crate::kinds::step_context::StepContext;

/// The param holding a command step's shell line.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the tick's dispatch of each kind")
)]
pub(crate) const COMMAND_PARAM: &str = "command";

/// The label of the output a node that routes failures to its error output gains.
const ERROR_OUTPUT_LABEL: &str = "Error";

/// Runs one kind's step. Only the engine calls an executor.
pub(crate) trait NodeExecutor: Send + Sync {
    /// Runs the step over `inputs`, one list of items per input handle in handle order. Its
    /// outputs come one list per main output, before any error output. Fails with
    /// [`StepFailure`] when the step fails or the person declines its action.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    fn execute<'step>(
        &'step self,
        context: &'step StepContext,
        inputs: Vec<Vec<WorkflowItem>>,
    ) -> BoxFuture<'step, Result<StepOutcome, StepFailure>>;

    /// What the step of `node` needs from the memory gate before it starts. The engine fills in
    /// the node's key and a quick step's input size, which a kind cannot know.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    fn admission_need(&self, _node: &WorkflowNode) -> StepAdmissionNeed {
        StepAdmissionNeed::Unweighed
    }

    /// Whether the step of `node` runs on the first main input that settles with items, the
    /// branches feeding its other inputs canceled; otherwise it waits for every main input.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    fn readies_on_first_input(&self, _node: &WorkflowNode) -> bool {
        false
    }
}

/// What a step the memory gate weighs runs, as its kind declares it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the tick's dispatch of each kind")
)]
pub(crate) enum StepAdmissionShape {
    /// A script step, reserved at its node's learned peak, else its runtime's estimate.
    Script {
        /// Its interpreter.
        runtime: StepScriptRuntime,
    },
    /// A quick Code step, reserved at its budget, its input and its output room.
    QuickCode {
        /// Its interpreter's memory budget, in bytes.
        budget_bytes: u64,
        /// The most output text it may return, in bytes.
        output_max_bytes: u64,
    },
}

/// How a kind's step is admitted: at once, after a wait at the memory gate, or with the agent run
/// it creates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the tick's dispatch of each kind")
)]
pub(crate) enum StepAdmissionNeed {
    /// The gate does not weigh the step, so it is admitted in the turn that readies it.
    Unweighed,
    /// The step waits at the gate, reserved by what it runs.
    Gate(StepAdmissionShape),
    /// An agent step, whose run joins the gate when it is created.
    OwnRun,
}

/// What a step's run asks of the engine: its output, a wait on a person, or an agent run, which
/// the engine opens and whose answer or outcome it makes the step's output.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick's dispatch, which acts on what each executor answers"
    )
)]
#[derive(Debug)]
pub(crate) enum StepOutcome {
    /// The step's output items, one list per main output.
    Outputs(Vec<Vec<WorkflowItem>>),
    /// The step waits on a person.
    PersonWait(PersonWait),
    /// The step runs as an agent run.
    AgentRun(AgentStepRequest),
}

/// A wait on a person a step asks for, and how long it waits.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the person-wait kinds and the tick's dispatch, which opens their waits"
    )
)]
#[derive(Debug)]
pub(crate) struct PersonWait {
    /// What the person is asked.
    pub(crate) ask: PersonAsk,
    /// How long the step waits for an answer; `None` waits until it is answered.
    pub(crate) timeout: Option<Duration>,
}

/// What a step waiting on a person asks.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the person-wait kinds and the tick's dispatch, which opens their waits"
    )
)]
#[derive(Debug)]
pub(crate) enum PersonAsk {
    /// An approval card.
    Approval {
        /// What the card asks.
        prompt: ComposedText,
    },
    /// A form.
    Form {
        /// What the form asks.
        prompt: ComposedText,
        /// The JSON Schema of the answer's fields.
        input_schema: Map<String, Value>,
    },
    /// A chat reply.
    Reply {
        /// What the question asks.
        prompt: ComposedText,
    },
}

/// Why a step's run failed.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick's dispatch, which routes a failed step by its onError"
    )
)]
#[derive(Debug)]
pub(crate) enum StepFailure {
    /// The step failed; its node's `onError` decides what follows. Boxed, so a result that may
    /// carry it stays small.
    Failed(Box<WorkflowStepError>),
    /// The step failed in a way that ends its run: on purpose, as `Stop and error` does, or when
    /// the output its node's `onError` passes on cannot be stored either. It is never retried, its
    /// node's `onError` does not apply, and the run ends.
    EndsRun(Box<WorkflowStepError>),
    /// The daemon stopped while the step ran, so the next start's sweep failed it: it is never
    /// retried, its node's `onError` does not apply, and the run parks for a Resume.
    Crashed(Box<WorkflowStepError>),
    /// The person declined the step's own card: the step fails and is never retried.
    Declined {
        /// The `why not` words, where the person typed any.
        words: Option<NonEmptyText>,
        /// When the decline was recorded.
        at: WireInstant,
    },
}

impl StepFailure {
    /// The failure's error, `None` for a decline, which carries words instead.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) fn error_mut(&mut self) -> Option<&mut WorkflowStepError> {
        match self {
            Self::Failed(error) | Self::EndsRun(error) | Self::Crashed(error) => Some(error),
            Self::Declined { .. } => None,
        }
    }
}

/// A step failure with no code of its own, saying `message`, its node and item left for the step's
/// driver to set.
pub(crate) fn uncoded_step_error(message: String) -> WorkflowStepError {
    WorkflowStepError::Uncoded(WorkflowStepUncodedError {
        message: NonEmptyText::new(message).expect("a step failure's text is never empty"),
        node_id: None,
        item_index: None,
        code: None,
        details: None,
    })
}

/// A step failure carrying `code`, a `workflow.*` refusal code, with `details`, a JSON object,
/// saying `message`; its node is `node_id` where the caller knows it, else left with its item for
/// the step's driver to set.
pub(crate) fn coded_step_error(
    code: RefusalCode,
    message: String,
    details: Value,
    node_id: Option<WorkflowNodeId>,
) -> WorkflowStepError {
    WorkflowStepError::Coded(WorkflowStepCodedError {
        message: NonEmptyText::new(message).expect("a step failure's text is never empty"),
        node_id,
        item_index: None,
        code: WorkflowStepErrorCode::new(code.as_str().to_owned())
            .expect("a workflow refusal's code follows the step failure code's grammar"),
        details: Some(
            serde_json::from_value(details).expect("a step failure's details are a JSON object"),
        ),
    })
}

/// One kind's version: its spec, the param holding its shell line, the loop's loop output, and
/// its executor.
pub(crate) struct NodeKind {
    /// The kind's spec, as the catalog lists it.
    pub(crate) spec: WorkflowNodeKindSpec,
    /// The id of the param holding the kind's shell line, one the spec lists, so a save holds it to
    /// its spec like any other param; `None` for a kind that runs none.
    pub(crate) shell_line_param: Option<&'static str>,
    /// For the loop kind, the index among its main outputs of its loop output, which starts its
    /// body on each pass; `None` for any other kind. The loop's one input takes both its entry and
    /// the edge its body's last node wires back, so an edge from its body into it closes the loop.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) loop_output: Option<usize>,
    /// What runs the kind's step.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) executor: Box<dyn NodeExecutor>,
}

/// What a save checks a node against from its kind: its category and handles, and the param
/// holding the shell line the kind runs, whose fills the save reads.
#[derive(Clone, Debug)]
pub(crate) struct WorkflowNodeKindRules {
    /// The kind's category and the node's handles.
    pub(crate) handles: WorkflowNodeHandles,
    /// The id of the param holding the kind's shell line; `None` for a kind that runs none.
    pub(crate) shell_line_param: Option<&'static str>,
}

/// Why a table of kinds could not be built.
#[derive(Debug, thiserror::Error)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the tick's dispatch of each kind")
)]
pub(crate) enum NodeKindTableError {
    /// Two entries list one kind at one version.
    #[error("the kind {} is listed twice at version {}", .kind.0.as_str(), .version.get())]
    Repeated {
        /// The kind.
        kind: WorkflowNodeKindId,
        /// The version.
        version: SafeInt<1>,
    },
    /// A kind that runs once per item lists any input but one main input, so no one input's items
    /// say what to run over, or a call over one item would lose another input's place.
    #[error(
        "the kind {} at version {} runs once per item but lists inputs other than one main input",
        .kind.0.as_str(),
        .version.get()
    )]
    PerItemInputs {
        /// The kind.
        kind: WorkflowNodeKindId,
        /// The version.
        version: SafeInt<1>,
    },
}

/// Every kind the engine runs, by kind and version, so a node runs the exact version it records.
pub(crate) struct NodeKindTable {
    /// The kinds by id, then by version.
    kinds: HashMap<WorkflowNodeKindId, HashMap<SafeInt<1>, NodeKind>>,
}

impl NodeKindTable {
    /// The table of `kinds`. Fails with [`NodeKindTableError::Repeated`] when two list one kind at
    /// one version, and with [`NodeKindTableError::PerItemInputs`] when a kind that runs once per
    /// item lists any input but one main input, a tool input among them.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) fn new(kinds: Vec<NodeKind>) -> Result<Self, NodeKindTableError> {
        let mut table: HashMap<WorkflowNodeKindId, HashMap<SafeInt<1>, NodeKind>> = HashMap::new();
        for kind in kinds {
            let is_one_main_input =
                kind.spec.inputs.as_slice().len() == 1 && main_input_count(&kind.spec) == 1;
            if kind.spec.per_item == Some(true) && !is_one_main_input {
                return Err(NodeKindTableError::PerItemInputs {
                    kind: kind.spec.kind,
                    version: kind.spec.version,
                });
            }
            let versions = table.entry(kind.spec.kind.clone()).or_default();
            match versions.entry(kind.spec.version) {
                Entry::Occupied(_) => {
                    return Err(NodeKindTableError::Repeated {
                        kind: kind.spec.kind,
                        version: kind.spec.version,
                    });
                }
                Entry::Vacant(slot) => {
                    slot.insert(kind);
                }
            }
        }
        Ok(Self { kinds: table })
    }

    /// The kind `node` names at the version it records, `None` for one the table does not list.
    pub(crate) fn kind_of(&self, node: &WorkflowNode) -> Option<&NodeKind> {
        self.kinds.get(&node.kind)?.get(&node.kind_version)
    }

    /// The rules a save checks `node` against, `None` for a kind or version the table does not
    /// list. A node whose `onError` sends failures to its error output gains that output last,
    /// after the kind's own, as the next main output, labeled `Error`.
    pub(crate) fn kind_rules(&self, node: &WorkflowNode) -> Option<WorkflowNodeKindRules> {
        let kind = self.kind_of(node)?;
        let spec = &kind.spec;
        let mut outputs = spec.outputs.as_slice().to_vec();
        if node.on_error == Some(WorkflowNodeOnError::ContinueErrorOutput) {
            let main_count = main_output_count(spec.outputs.as_slice());
            outputs.push(WorkflowOutputHandleSpec::Main {
                id: OutputMainHandleId::new(main_count as u64)
                    .expect("a kind's output count is far below the largest handle index"),
                label: NonEmptyText::new(ERROR_OUTPUT_LABEL.to_owned())
                    .expect("the error output's label is not empty"),
                max_connections: None,
                required: None,
            });
        }
        Some(WorkflowNodeKindRules {
            handles: WorkflowNodeHandles {
                category: spec.category,
                inputs: spec.inputs.as_slice().to_vec(),
                outputs,
                needs_repository: spec.needs_repository(),
                repository_param: spec.repository_param().cloned(),
            },
            shell_line_param: kind.shell_line_param,
        })
    }
}

/// A test kind's executor that passes its inputs on as its outputs.
#[cfg(test)]
pub(crate) struct PassThroughExecutor;

#[cfg(test)]
impl NodeExecutor for PassThroughExecutor {
    fn execute<'step>(
        &'step self,
        _context: &'step StepContext,
        inputs: Vec<Vec<WorkflowItem>>,
    ) -> BoxFuture<'step, Result<StepOutcome, StepFailure>> {
        Box::pin(async move { Ok(StepOutcome::Outputs(inputs)) })
    }
}

/// A kind other than the loop whose spec is `spec`, a `workflow.kind.list` entry's JSON, that holds
/// its shell line in `shell_line_param` and runs its steps through `executor`.
#[cfg(test)]
pub(crate) fn test_kind(
    spec: Value,
    shell_line_param: Option<&'static str>,
    executor: Box<dyn NodeExecutor>,
) -> NodeKind {
    NodeKind {
        spec: serde_json::from_value(spec).expect("the test kind's spec reads"),
        shell_line_param,
        loop_output: None,
        executor,
    }
}

/// The test kind `kind` in `category` with `input_count` main inputs and `output_count` main
/// outputs, `inputs/main/<i>` and `outputs/main/<i>`, run by `executor`.
#[cfg(test)]
pub(crate) fn main_test_kind(
    kind: &str,
    category: &str,
    (input_count, output_count): (usize, usize),
    executor: Box<dyn NodeExecutor>,
) -> NodeKind {
    let handles = |side: &str, label: &str, count: usize| -> Vec<Value> {
        (0..count)
            .map(|index| {
                serde_json::json!({
                    "type": "main", "id": format!("{side}/main/{index}"), "label": label,
                })
            })
            .collect()
    };
    test_kind(
        serde_json::json!({
            "kind": kind, "version": 1, "category": category, "displayName": kind,
            "description": "A test kind.", "icon": "test", "params": [],
            "outputsDeriveFromParams": false,
            "inputs": handles("inputs", "In", input_count),
            "outputs": handles("outputs", "Out", output_count),
        }),
        None,
        executor,
    )
}

/// The loop kind `test.loop`, with one main input, its done output and the loop output that
/// starts its body, passing its inputs on.
#[cfg(test)]
pub(crate) fn loop_test_kind() -> NodeKind {
    NodeKind {
        loop_output: Some(1),
        ..main_test_kind(
            "test.loop",
            "developer",
            (1, 2),
            Box::new(PassThroughExecutor),
        )
    }
}

/// The command step `developer.shell` at version 1, with one main input and one main output,
/// whose shell line is the `command` param it lists, which runs in its provider's sandbox, passing
/// its inputs on as its outputs.
#[cfg(test)]
pub(crate) fn command_test_kind() -> NodeKind {
    test_kind(
        serde_json::json!({
            "kind": "developer.shell", "version": 1, "category": "developer",
            "displayName": "Run a command", "description": "A command in a working directory.",
            "icon": "terminal",
            "params": [{ "id": COMMAND_PARAM, "label": "Command", "type": "text" }],
            "inputs": [{ "type": "main", "id": "inputs/main/0", "label": "In" }],
            "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
            "outputsDeriveFromParams": false,
            "capabilities": {
                "cancelable": true, "resumable": false, "sideEffects": "local", "repository": false,
                "sandbox": {}
            },
        }),
        Some(COMMAND_PARAM),
        Box::new(PassThroughExecutor),
    )
}

/// The git step `developer.git` at version 1, with one main input and one main output, which
/// needs a project's repository, passing its inputs on as its outputs.
#[cfg(test)]
pub(crate) fn git_test_kind() -> NodeKind {
    test_kind(
        serde_json::json!({
            "kind": "developer.git", "version": 1, "category": "developer",
            "displayName": "Git", "description": "A git command in the run's repository.",
            "icon": "git", "params": [],
            "inputs": [{ "type": "main", "id": "inputs/main/0", "label": "In" }],
            "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
            "outputsDeriveFromParams": false,
            "capabilities": {
                "cancelable": true, "resumable": false, "sideEffects": "local", "repository": true
            },
        }),
        None,
        Box::new(PassThroughExecutor),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::workflow::definition::document::{WorkflowEdge, WorkflowNode};
    use sidekicks_contracts::workflow::definition::refusals::{
        WorkflowDefinitionFinding, check_workflow_graph,
    };

    use super::{
        NodeKindTable, NodeKindTableError, PassThroughExecutor, command_test_kind, git_test_kind,
        test_kind,
    };

    /// A kind spec of `kind` at `version` with one main input and `outputs`.
    fn kind_spec(kind: &str, version: u64, outputs: &Value) -> Value {
        json!({
            "kind": kind, "version": version, "category": "developer",
            "displayName": "Test", "description": "A test kind.", "icon": "test",
            "params": [], "outputsDeriveFromParams": false,
            "inputs": [{ "type": "main", "id": "inputs/main/0", "label": "In" }],
            "outputs": outputs,
        })
    }

    /// A node `id` of `kind` at `version`, with `on_error` when given.
    fn node(id: &str, kind: &str, version: u64, on_error: Option<&str>) -> WorkflowNode {
        let mut node = json!({
            "id": id, "kind": kind, "kindVersion": version, "name": id, "order": 0, "params": {},
        });
        if let Some(on_error) = on_error {
            node["onError"] = json!(on_error);
        }
        serde_json::from_value(node).expect("the test's node reads")
    }

    /// Only `continueErrorOutput` gives a node its error output, at the next main index after the
    /// kind's main outputs (a tool output not counted), labeled `Error`, so an edge from
    /// `outputs/main/1` checks only then. Mutations: drop the error output; count the tool output;
    /// add the output for every `onError`.
    #[rstest]
    #[case::continue_error_output(Some("continueErrorOutput"), true)]
    #[case::stop(Some("stop"), false)]
    #[case::continue_on(Some("continue"), false)]
    #[case::absent(None, false)]
    fn only_continue_error_output_adds_the_error_output(
        #[case] on_error: Option<&str>,
        #[case] has_error_output: bool,
    ) {
        let table = NodeKindTable::new(vec![test_kind(
            kind_spec(
                "test.step",
                1,
                &json!([
                    { "type": "main", "id": "outputs/main/0", "label": "Out" },
                    { "type": "tool", "id": "outputs/tool/0", "label": "Tool" },
                ]),
            ),
            None,
            Box::new(PassThroughExecutor),
        )])
        .expect("the table builds");
        let source = node("source", "test.step", 1, on_error);
        let target = node("target", "test.step", 1, None);
        let edge: WorkflowEdge = serde_json::from_value(json!({
            "id": "failures", "source": "source", "sourceHandle": "outputs/main/1",
            "target": "target", "targetHandle": "inputs/main/0",
        }))
        .expect("the test's edge reads");
        let source_rules = table.kind_rules(&source).expect("the kind is listed");
        let node_handles: HashMap<_, _> = [&source, &target]
            .into_iter()
            .map(|node| {
                let rules = table.kind_rules(node).expect("the kind is listed");
                (node.id.clone(), rules.handles)
            })
            .collect();
        let findings = check_workflow_graph(None, &[source, target], &[edge], &node_handles);

        let is_unknown = findings
            .iter()
            .any(|finding| matches!(finding, WorkflowDefinitionFinding::HandleTypeUnknown { .. }));
        assert_eq!(is_unknown, !has_error_output, "{findings:?}");
        let error_output = source_rules
            .handles
            .outputs
            .iter()
            .find(|output| output.id_text() == "outputs/main/1");
        assert_eq!(
            error_output.map(|output| serde_json::to_value(output).expect("a handle serializes")),
            has_error_output
                .then(|| json!({ "type": "main", "id": "outputs/main/1", "label": "Error" })),
        );
    }

    /// A trigger's rules name its `project` param as its `Repository`, and a kind's need of a
    /// repository reaches its rules. Mutation: either member left at its default, which turns off
    /// the save's repository rule.
    #[test]
    fn kind_rules_carry_the_kinds_repository_facts() {
        let trigger = json!({
            "kind": "trigger.schedule", "version": 1, "category": "trigger",
            "displayName": "Schedule", "description": "Runs on a schedule.", "icon": "clock",
            "params": [
                { "id": "cron", "label": "Cron", "type": "text" },
                { "id": "repository", "label": "Repository", "type": "project" },
            ],
            "inputs": [],
            "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
            "outputsDeriveFromParams": false,
        });
        let table = NodeKindTable::new(vec![
            test_kind(trigger, None, Box::new(PassThroughExecutor)),
            git_test_kind(),
            command_test_kind(),
        ])
        .expect("the table builds");
        let rules_of = |kind| {
            table
                .kind_rules(&node("step", kind, 1, None))
                .expect("the kind is listed")
                .handles
        };

        let trigger = rules_of("trigger.schedule");
        assert_eq!(
            trigger
                .repository_param
                .map(|param| param.0.as_str().to_owned()),
            Some("repository".to_owned())
        );
        assert!(!trigger.needs_repository);
        assert!(rules_of("developer.git").needs_repository);
        assert!(!rules_of("developer.shell").needs_repository);
    }

    /// Each version of a kind answers its own rules, an unlisted version none, a table listing one
    /// kind at one version twice is refused, and so is a kind run once per item with two main
    /// inputs or a tool input beside its main one. Mutations: look a kind up by id alone; let a
    /// later entry overwrite an earlier one; drop the per-item refusal; let a tool input pass.
    #[test]
    fn each_version_answers_its_own_rules() {
        let one_output = json!([{ "type": "main", "id": "outputs/main/0", "label": "Out" }]);
        let two_outputs = json!([
            { "type": "main", "id": "outputs/main/0", "label": "Yes" },
            { "type": "main", "id": "outputs/main/1", "label": "No" },
        ]);
        let table = NodeKindTable::new(vec![
            test_kind(
                kind_spec("test.step", 1, &one_output),
                None,
                Box::new(PassThroughExecutor),
            ),
            test_kind(
                kind_spec("test.step", 2, &two_outputs),
                None,
                Box::new(PassThroughExecutor),
            ),
        ])
        .expect("the table builds");
        let output_count = |version| {
            table
                .kind_rules(&node("step", "test.step", version, None))
                .map(|rules| rules.handles.outputs.len())
        };
        assert_eq!(output_count(1), Some(1));
        assert_eq!(output_count(2), Some(2));
        assert_eq!(output_count(3), None);

        let repeated = NodeKindTable::new(vec![
            test_kind(
                kind_spec("test.step", 1, &one_output),
                None,
                Box::new(PassThroughExecutor),
            ),
            test_kind(
                kind_spec("test.step", 1, &one_output),
                None,
                Box::new(PassThroughExecutor),
            ),
        ]);
        assert!(matches!(
            repeated,
            Err(NodeKindTableError::Repeated { kind, version })
                if kind.0.as_str() == "test.step" && version.get() == 1
        ));

        let per_item_inputs = |inputs: Value| {
            let mut spec = kind_spec("test.merge", 1, &one_output);
            spec["perItem"] = json!(true);
            spec["inputs"] = inputs;
            NodeKindTable::new(vec![test_kind(spec, None, Box::new(PassThroughExecutor))])
        };
        assert!(
            per_item_inputs(json!([{ "type": "main", "id": "inputs/main/0", "label": "In" }]))
                .is_ok()
        );
        for inputs in [
            json!([
                { "type": "main", "id": "inputs/main/0", "label": "A" },
                { "type": "main", "id": "inputs/main/1", "label": "B" },
            ]),
            json!([
                { "type": "main", "id": "inputs/main/0", "label": "In" },
                { "type": "tool", "id": "inputs/tool/0", "label": "Tool" },
            ]),
        ] {
            assert!(matches!(
                per_item_inputs(inputs),
                Err(NodeKindTableError::PerItemInputs { kind, version })
                    if kind.0.as_str() == "test.merge" && version.get() == 1
            ));
        }
    }
}
