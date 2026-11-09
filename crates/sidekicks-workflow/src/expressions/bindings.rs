//! The names a workflow expression reads: the current item, the step's own input and each earlier
//! node's items by label, the loop and item indexes, the run's one instant, the environment rows,
//! the run's variables, and the run and workflow it belongs to. What does not change per item is
//! built once per step on the evaluator thread; `jsonata-core` binds a value only into the
//! `Context` an `Evaluator` is built with, so each evaluation builds its own evaluator over it.

use std::cell::{OnceCell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use jsonata_core::ast::AstNode;
use jsonata_core::evaluator::{Context, Evaluator, EvaluatorError, EvaluatorOptions, HostFnResult};
use jsonata_core::parser::ParserError;
use jsonata_core::value::{JArray, JValue};
use serde_json::{Map, Value, json};
use sidekicks_contracts::machine::settings::{
    EnvironmentNameRefusalReason, EnvironmentRow, environment_name_refusal,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowName, WorkflowNodeId,
};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::trigger::WorkflowRunTrigger;
use tokio::sync::oneshot::error::RecvError;

use crate::definitions::kept_values::WorkflowKeptValue;
use crate::expressions::lineage::{LineageError, StepKey, StepOutputs, walk_paired_item};
use crate::expressions::syntax_tree::find_in_syntax_tree;

/// The binding that answers a labeled node's params, `$params('<label>')`.
const PARAMS_BINDING: &str = "params";

/// Every item reader, in the order they are registered.
const ITEM_PICKS: [ItemPick; 4] = [
    ItemPick::All,
    ItemPick::First,
    ItemPick::Last,
    ItemPick::Linked,
];

/// What a step's expressions read, handed to the evaluator thread once when the step is
/// dispatched. The run's shared data is held by `Arc`, so the steps of one run share it.
#[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
pub(crate) struct ExpressionBindings {
    /// The step the expressions belong to.
    pub(crate) step: StepKey,
    /// The step's own input items.
    pub(crate) input_items: Arc<[WorkflowItem]>,
    /// The run's steps so far and the index from each label to its node.
    pub(crate) steps: Arc<StepOutputs>,
    /// Each node's params as the document stores them, by node id.
    pub(crate) node_params: Arc<HashMap<WorkflowNodeId, JsonRecord>>,
    /// The loop's run index, `$runIndex`.
    pub(crate) run_index: u64,
    /// When the run started, the run's one instant: `$run.startedAt`, `$now`, `$millis()` and
    /// `$today` all read it.
    pub(crate) run_started_at: Timestamp,
    /// The machine's time zone, which dates `$today`.
    pub(crate) time_zone: TimeZone,
    /// The environment rows of the project the run works in; none when it works in no project's
    /// repository.
    pub(crate) environment_rows: Arc<[EnvironmentRow]>,
    /// The values this run set with `Set variables`.
    pub(crate) run_variables: Arc<Map<String, Value>>,
    /// The values earlier runs kept, read where this run set none.
    pub(crate) kept_values: Arc<[WorkflowKeptValue]>,
    /// The run's id.
    pub(crate) run_id: WorkflowRunId,
    /// The trigger node that started the run.
    pub(crate) run_trigger: WorkflowRunTrigger,
    /// The workflow's id.
    pub(crate) workflow_id: WorkflowDefinitionId,
    /// The workflow's name.
    pub(crate) workflow_name: WorkflowName,
}

/// Why an expression has no value: a lineage or label failure of an item binding, a read of a
/// credential's name through `$env`, a part the parser refuses, the evaluator's own failure, the
/// step's cancel, or the evaluator thread stopped before it answered.
#[derive(Debug, thiserror::Error)]
#[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
pub(crate) enum ExpressionError {
    /// `$item('<label>')`, or another binding naming a label, found no item.
    #[error(transparent)]
    Lineage(#[from] LineageError),
    /// The expression reads `$env` by a name shaped like a credential's, which it never reads.
    #[error(
        "$env.{name} isn't read: a name shaped like a credential's never reaches an expression."
    )]
    CredentialEnvironmentName {
        /// The name the expression read.
        name: String,
    },
    /// A template's part does not parse, which the save check refuses before a run.
    #[error("The expression {{{{ {part} }}}} doesn't parse: {error}")]
    TemplateUnparsable {
        /// The part's text, between its braces.
        part: String,
        /// The parser's refusal.
        #[source]
        error: ParserError,
    },
    /// The evaluator refused or failed the expression.
    #[error(transparent)]
    Evaluation(#[from] EvaluatorError),
    /// The step was canceled while this evaluation ran, or before it began.
    #[error("The step was canceled while its expression was evaluated.")]
    Canceled,
    /// The evaluator thread stopped, which only a panic on it does, before it answered.
    #[error("The expression thread stopped before it answered.")]
    EvaluatorStopped(#[from] RecvError),
}

/// A step's bindings on the evaluator thread: every value that does not change per item, built
/// once from the step's [`ExpressionBindings`], and its items converted once on first use.
pub(crate) struct StepBindings {
    /// What the item readers and `$params` read, shared by every evaluation of the step.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    items: Rc<StepItems>,
    /// `$runIndex`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    run_index: JValue,
    /// `$now`, a value as `$json` is, which hides the engine's own `$now()`: the run's instant as
    /// `$run.startedAt` writes it.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    now: JValue,
    /// `$today`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    today: JValue,
    /// `$env`, credential-shaped rows left out.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    environment: JValue,
    /// `$vars`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    variables: JValue,
    /// `$run`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    run: JValue,
    /// `$workflow`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    workflow: JValue,
    /// The run's instant in milliseconds, which `$millis()` answers.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    instant_millis: i64,
}

impl StepBindings {
    /// The step's bindings, each constant value converted here, once for all its items.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    pub(crate) fn new(bindings: ExpressionBindings) -> Self {
        let environment = bindings
            .environment_rows
            .iter()
            .filter(|row| !is_credential_name(row.name.as_str()))
            .map(|row| {
                (
                    row.name.as_str().to_owned(),
                    JValue::string(row.value.as_str()),
                )
            })
            .collect();
        let mut variables: Map<String, Value> = bindings
            .kept_values
            .iter()
            .map(|kept| (kept.name.clone(), kept.value.clone()))
            .collect();
        variables.extend(
            bindings
                .run_variables
                .iter()
                .map(|(name, value)| (name.clone(), value.clone())),
        );
        let today = bindings
            .run_started_at
            .to_zoned(bindings.time_zone.clone())
            .date()
            .strftime("%Y-%m-%d")
            .to_string();
        let started_at = WireInstant::from_timestamp(bindings.run_started_at);
        Self {
            run_index: JValue::from(bindings.run_index),
            now: JValue::from(json!(started_at)),
            today: JValue::string(today),
            environment: JValue::object(environment),
            variables: JValue::from(Value::Object(variables)),
            run: JValue::from(json!({
                "id": bindings.run_id,
                "startedAt": started_at,
                "trigger": bindings.run_trigger,
            })),
            workflow: JValue::from(
                json!({ "id": bindings.workflow_id, "name": bindings.workflow_name }),
            ),
            instant_millis: bindings.run_started_at.as_millisecond(),
            items: Rc::new(StepItems {
                step: bindings.step,
                input_items: bindings.input_items,
                steps: bindings.steps,
                node_params: bindings.node_params,
                input_values: OnceCell::new(),
                node_values: RefCell::new(HashMap::new()),
            }),
        }
    }

    /// `expression`'s value for input item `item_index`, evaluated under `options`. Fails with
    /// [`ExpressionError::CredentialEnvironmentName`] before evaluating when the expression reads
    /// `$env` by a credential's name, with [`ExpressionError::Lineage`] when an item binding found
    /// no item, and with [`ExpressionError::Evaluation`] when the evaluator fails.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    pub(crate) fn evaluate(
        &self,
        expression: &AstNode,
        item_index: usize,
        options: EvaluatorOptions,
    ) -> Result<JValue, ExpressionError> {
        if let Some(name) = credential_environment_name(expression) {
            return Err(ExpressionError::CredentialEnvironmentName {
                name: name.to_owned(),
            });
        }
        let lineage_error = Rc::new(RefCell::new(None));
        let mut evaluator = Evaluator::with_options(self.context(item_index), options);
        self.register(&mut evaluator, item_index, &lineage_error);
        evaluator
            .evaluate(expression, &JValue::Undefined)
            .map_err(|error| match lineage_error.take() {
                Some(lineage) => ExpressionError::Lineage(lineage),
                None => ExpressionError::Evaluation(error),
            })
    }

    /// The bindings read as values for input item `item_index`: the step's constants cloned,
    /// which shares them, and the item's `json` and index.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    fn context(&self, item_index: usize) -> Context {
        // A step with no input item, such as one that always outputs data, reads `$json` as `{}`.
        let item_json = self
            .items
            .input_values()
            .get(item_index)
            .and_then(|item| {
                if let JValue::Object(members) = item {
                    members.get("json").cloned()
                } else {
                    None
                }
            })
            .unwrap_or_else(|| JValue::from(json!({})));
        let mut context = Context::new();
        context.bind("json".to_owned(), item_json);
        context.bind("runIndex".to_owned(), self.run_index.clone());
        context.bind("itemIndex".to_owned(), JValue::from(item_index));
        context.bind("now".to_owned(), self.now.clone());
        context.bind("today".to_owned(), self.today.clone());
        context.bind("env".to_owned(), self.environment.clone());
        context.bind("vars".to_owned(), self.variables.clone());
        context.bind("run".to_owned(), self.run.clone());
        context.bind("workflow".to_owned(), self.workflow.clone());
        context
    }

    /// The bindings called as functions: the item readers, `$params`, and `$millis` answering the
    /// run's instant. An item reader's lineage or label failure is written to
    /// `lineage_error` as well as returned, so the caller reads it typed.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    fn register(
        &self,
        evaluator: &mut Evaluator,
        item_index: usize,
        lineage_error: &Rc<RefCell<Option<LineageError>>>,
    ) {
        let reader = Rc::new(ItemReader {
            items: Rc::clone(&self.items),
            item_index,
            lineage_error: Rc::clone(lineage_error),
        });
        for pick in ITEM_PICKS {
            let reader = Rc::clone(&reader);
            evaluator
                .register_fn(pick.name(), move |args: &[JValue]| reader.items(pick, args))
                .expect("no item reader's name is a built-in's");
        }
        evaluator
            .register_fn(PARAMS_BINDING, move |args: &[JValue]| reader.params(args))
            .expect("params is no built-in's name");
        let millis = self.instant_millis;
        evaluator
            .register_fn_override("millis", move |args: &[JValue]| {
                if args.is_empty() {
                    Ok(JValue::from(millis))
                } else {
                    Err(EvaluatorError::EvaluationError(
                        "T0410: millis() takes no arguments".to_owned(),
                    ))
                }
            })
            .expect("$millis is a built-in the evaluator lets a host replace");
    }
}

/// Which items an item reader answers.
#[derive(Clone, Copy)]
enum ItemPick {
    /// Every item, `$all`.
    All,
    /// The first item, `$first`.
    First,
    /// The last item, `$last`.
    Last,
    /// The current item, or the item it came from, `$item`.
    Linked,
}

impl ItemPick {
    /// The binding's name.
    fn name(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::First => "first",
            Self::Last => "last",
            Self::Linked => "item",
        }
    }
}

/// The items a step's expressions read, each set converted to evaluator values once, on first
/// use, and shared by every later evaluation of the step.
struct StepItems {
    /// The step the expressions belong to.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    step: StepKey,
    /// The step's own input items.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    input_items: Arc<[WorkflowItem]>,
    /// The run's steps so far.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    steps: Arc<StepOutputs>,
    /// Each node's params by id.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    node_params: Arc<HashMap<WorkflowNodeId, JsonRecord>>,
    /// The step's input items as evaluator values.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    input_values: OnceCell<JArray>,
    /// Each labeled node's items, as `$all('<label>')` reads them, as evaluator values.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    node_values: RefCell<HashMap<WorkflowNodeId, JArray>>,
}

impl StepItems {
    /// The step's input items as evaluator values, converted on the first call.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    fn input_values(&self) -> &JArray {
        self.input_values
            .get_or_init(|| items_array(&self.input_items))
    }

    /// The items `$all('<label>')` reads of `node_id`: its latest execution's first output, as a
    /// node read by label defaults to; empty while it has not run. Converted on the first call.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    fn node_values(&self, node_id: &WorkflowNodeId) -> JArray {
        self.node_values
            .borrow_mut()
            .entry(node_id.clone())
            .or_insert_with(|| {
                self.steps
                    .latest_step(node_id)
                    .and_then(|step| step.outputs.first())
                    .map(Vec::as_slice)
                    .map_or_else(JArray::default, items_array)
            })
            .clone()
    }
}

/// What the item readers and `$params` of one evaluation read.
#[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
struct ItemReader {
    /// The step's items.
    items: Rc<StepItems>,
    /// The current input item's index.
    item_index: usize,
    /// Where a lineage or label failure is written for the caller.
    lineage_error: Rc<RefCell<Option<LineageError>>>,
}

impl ItemReader {
    /// `pick` over the step's own input when `args` is empty, else over the node `args` labels:
    /// that node's latest execution's first output, and for `$item` the item the current one
    /// came from. An absent first or last item is undefined.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    fn items(&self, pick: ItemPick, args: &[JValue]) -> HostFnResult {
        let label = label_argument(pick.name(), args)?;
        let items = match (label, pick) {
            (None, ItemPick::Linked) => {
                return Ok(self
                    .items
                    .input_values()
                    .get(self.item_index)
                    .cloned()
                    .unwrap_or(JValue::Undefined));
            }
            (Some(label), ItemPick::Linked) => {
                let item =
                    walk_paired_item(&self.items.steps, &self.items.step, self.item_index, label)
                        .map_err(|error| self.refuse(error))?;
                return Ok(item_value(item));
            }
            (None, ItemPick::All | ItemPick::First | ItemPick::Last) => {
                self.items.input_values().clone()
            }
            (Some(label), ItemPick::All | ItemPick::First | ItemPick::Last) => {
                let node_id = self
                    .items
                    .steps
                    .node_id(label)
                    .map_err(|error| self.refuse(error))?;
                self.items.node_values(node_id)
            }
        };
        let picked = match pick {
            ItemPick::All => return Ok(JValue::Array(items)),
            ItemPick::First | ItemPick::Linked => items.first(),
            ItemPick::Last => items.last(),
        };
        Ok(picked.cloned().unwrap_or(JValue::Undefined))
    }

    /// The params of the node `args` labels, as the document stores them.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    fn params(&self, args: &[JValue]) -> HostFnResult {
        let Some(label) = label_argument(PARAMS_BINDING, args)? else {
            return Err(EvaluatorError::TypeError(
                "$params() takes a node's label".to_owned(),
            ));
        };
        let node_id = self
            .items
            .steps
            .node_id(label)
            .map_err(|error| self.refuse(error))?;
        Ok(self
            .items
            .node_params
            .get(node_id)
            .map_or(JValue::Undefined, |params| {
                JValue::from(serde_json::to_value(params).expect("params write as JSON"))
            }))
    }

    /// `error` written for the caller and returned as the evaluator's failure.
    #[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
    fn refuse(&self, error: LineageError) -> EvaluatorError {
        let message = error.to_string();
        *self.lineage_error.borrow_mut() = Some(error);
        EvaluatorError::EvaluationError(message)
    }
}

/// The label in `args`, `None` when there are no arguments; fails with a type error for anything
/// but one string.
#[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
fn label_argument<'args>(
    binding: &str,
    args: &'args [JValue],
) -> Result<Option<&'args str>, EvaluatorError> {
    match args {
        [] => Ok(None),
        [JValue::String(label)] => Ok(Some(label.as_ref())),
        _ => Err(EvaluatorError::TypeError(format!(
            "${binding}() takes a node's label, or nothing for this step's own input"
        ))),
    }
}

/// `items` as an evaluator array of [`item_value`]s.
#[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
fn items_array(items: &[WorkflowItem]) -> JArray {
    JArray::new(items.iter().map(item_value).collect())
}

/// `item` as the evaluator reads it: its `json`, `binary`, `pairedItem` and `error`.
#[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
fn item_value(item: &WorkflowItem) -> JValue {
    JValue::from(serde_json::to_value(item).expect("an item writes as JSON"))
}

/// Whether `name` is shaped like a credential's, the rule a project's environment rows are saved
/// under.
#[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
fn is_credential_name(name: &str) -> bool {
    environment_name_refusal(name) == Some(EnvironmentNameRefusalReason::CredentialShaped)
}

/// The first credential-shaped name `node` or any node inside it reads from `$env`, as `$env.NAME`
/// or `$lookup($env, 'NAME')`.
#[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
fn credential_environment_name(node: &AstNode) -> Option<&str> {
    find_in_syntax_tree(node, &mut |inner| {
        environment_read(inner).filter(|name| is_credential_name(name))
    })
}

/// Whether `name` is an item reader's, which a node's label argument names a node to: `all`,
/// `first`, `last` or `item`.
pub(crate) fn is_item_reader_name(name: &str) -> bool {
    ITEM_PICKS.iter().any(|pick| pick.name() == name)
}

/// Whether the binding `name`, called with a string, reads that string as a node's label: an item
/// reader or `params`.
pub(crate) fn reads_a_label(name: &str) -> bool {
    is_item_reader_name(name) || name == PARAMS_BINDING
}

/// The name `node` itself reads from `$env`, as `$env.NAME` or `$lookup($env, 'NAME')`.
#[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
fn environment_read(node: &AstNode) -> Option<&str> {
    if let AstNode::Path { steps } = node
        && let [first, second, ..] = steps.as_slice()
        && is_environment(&first.node)
        && let AstNode::Name(name) = &second.node
    {
        return Some(name.as_str());
    }
    if let AstNode::Function { name, args, .. } = node
        && name == "lookup"
        && let [object, AstNode::String(key)] = args.as_slice()
        && is_environment(object)
    {
        return Some(key.as_str());
    }
    None
}

/// Whether `node` is the variable `$env`.
#[cfg_attr(not(test), expect(dead_code, reason = "the evaluator thread"))]
fn is_environment(node: &AstNode) -> bool {
    matches!(node, AstNode::Variable(name) if name == "env")
}

/// The bindings of step `current` in a run of the workflow `Nightly` that a manual trigger at node
/// `L` started at 15:00 UTC on 4 March 2025, reading `input_items` and `steps`, in loop run 0 with
/// no params, environment rows, run variables or kept values.
#[cfg(test)]
pub(crate) fn test_expression_bindings(
    input_items: Vec<WorkflowItem>,
    steps: StepOutputs,
) -> ExpressionBindings {
    use crate::test_rows::test_node_id;

    ExpressionBindings {
        step: StepKey {
            node_id: test_node_id("current"),
            execution_index: 0,
        },
        input_items: input_items.into(),
        steps: Arc::new(steps),
        node_params: Arc::new(HashMap::new()),
        run_index: 0,
        run_started_at: "2025-03-04T15:00:00Z".parse().expect("an instant"),
        time_zone: TimeZone::UTC,
        environment_rows: Arc::new([]),
        run_variables: Arc::new(Map::new()),
        kept_values: Arc::new([]),
        run_id: WorkflowRunId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e62").expect("a run id"),
        run_trigger: WorkflowRunTrigger {
            kind: sidekicks_contracts::workflow::run::trigger::WorkflowTriggerKind::Manual,
            node_id: test_node_id("L"),
        },
        workflow_id: WorkflowDefinitionId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e60")
            .expect("a definition id"),
        workflow_name: WorkflowName::new("Nightly".to_owned()).expect("a name"),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use jiff::Timestamp;
    use jiff::tz::TimeZone;
    use jsonata_core::evaluator::EvaluatorOptions;
    use jsonata_core::parser::parse;
    use rstest::rstest;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::workflow::definition::item::WorkflowItem;
    use sidekicks_contracts::workflow::run::id::WorkflowRunId;
    use sidekicks_contracts::workflow::run::trigger::{WorkflowRunTrigger, WorkflowTriggerKind};

    use super::{ExpressionBindings, ExpressionError, StepBindings, test_expression_bindings};
    use crate::definitions::kept_values::WorkflowKeptValue;
    use crate::expressions::lineage::{LineageError, StepKey, StepOutput, StepOutputs};
    use crate::test_rows::test_node_id;

    const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e62";
    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e60";

    fn step_key(id: &str) -> StepKey {
        StepKey {
            node_id: test_node_id(id),
            execution_index: 0,
        }
    }

    fn from_json<T: serde::de::DeserializeOwned>(json: Value) -> T {
        serde_json::from_value(json).expect("the fixture reads")
    }

    /// The step `current`, fed by `source`'s two items, in loop run 2 of a run whose instant is
    /// 15:00 UTC on 4 March 2025, which is already 5 March on Kiritimati. `empty` ran with no
    /// items; the project holds a plain row and a credential-shaped one.
    fn bindings() -> ExpressionBindings {
        let source_items: Vec<WorkflowItem> = vec![
            from_json(json!({ "json": { "name": "Bob" }, "pairedItem": { "item": 0 } })),
            from_json(json!({ "json": { "name": "Ada" }, "pairedItem": { "item": 0 } })),
        ];
        let mut steps = StepOutputs::new(
            ["trigger", "source", "empty", "current"]
                .map(|label| (test_node_id(label), label.to_owned())),
        );
        steps.record(
            step_key("trigger"),
            StepOutput {
                sources: vec![],
                outputs: vec![vec![from_json(json!({ "json": {} }))]],
            },
        );
        steps.record(
            step_key("source"),
            StepOutput {
                sources: vec![from_json(
                    json!({ "nodeId": "trigger", "outputIndex": 0, "executionIndex": 0 }),
                )],
                outputs: vec![source_items.clone()],
            },
        );
        steps.record(
            step_key("empty"),
            StepOutput {
                sources: vec![],
                outputs: vec![vec![]],
            },
        );
        steps.record(
            step_key("current"),
            StepOutput {
                sources: vec![from_json(
                    json!({ "nodeId": "source", "outputIndex": 0, "executionIndex": 0 }),
                )],
                outputs: vec![],
            },
        );
        let instant: Timestamp = "2025-03-04T15:00:00Z".parse().expect("an instant");
        let run_id = WorkflowRunId::new(RUN_ID).expect("a run id");
        ExpressionBindings {
            node_params: Arc::new(HashMap::from([(
                test_node_id("source"),
                from_json(json!({ "mode": "fast" })),
            )])),
            run_index: 2,
            time_zone: TimeZone::get("Pacific/Kiritimati").expect("a zone"),
            environment_rows: vec![
                from_json(json!({ "name": "REGION", "value": "eu" })),
                from_json(json!({ "name": "GITHUB_TOKEN", "value": "leaked-value" })),
            ]
            .into(),
            run_variables: Arc::new(
                [("both".to_owned(), json!("this run's"))]
                    .into_iter()
                    .collect::<Map<String, Value>>(),
            ),
            kept_values: vec![
                WorkflowKeptValue {
                    name: "kept".to_owned(),
                    value: json!("kept earlier"),
                    kept_by_run_id: run_id,
                    kept_at: WireInstant::from_timestamp(instant).expect("an instant"),
                },
                WorkflowKeptValue {
                    name: "both".to_owned(),
                    value: json!("kept earlier"),
                    kept_by_run_id: run_id,
                    kept_at: WireInstant::from_timestamp(instant).expect("an instant"),
                },
            ]
            .into(),
            run_trigger: WorkflowRunTrigger {
                kind: WorkflowTriggerKind::Manual,
                node_id: test_node_id("trigger"),
            },
            ..test_expression_bindings(source_items, steps)
        }
    }

    /// `expression`'s value against [`bindings`] for input item 1, read back as JSON.
    fn evaluated(expression: &str) -> Result<Value, ExpressionError> {
        StepBindings::new(bindings())
            .evaluate(
                &parse(expression).expect("the expression parses"),
                1,
                EvaluatorOptions::default(),
            )
            .map(|value| Value::from(&value))
    }

    /// Each binding reads what it names, and each absent case reads as its row says: no first item
    /// of an empty node, no variable nobody set.
    #[rstest]
    #[case::json("$json.name", json!("Ada"))]
    #[case::own_input(
        "[$first().json.name, $last().json.name, $item().json.name, $count($all())]",
        json!(["Bob", "Ada", "Ada", 2.0])
    )]
    #[case::linked_item("$item('source').json.name", json!("Ada"))]
    #[case::empty_node("$exists($first('empty'))", json!(false))]
    #[case::params("$params('source').mode", json!("fast"))]
    #[case::indexes("[$runIndex, $itemIndex]", json!([2.0, 1.0]))]
    #[case::now_value("$now", json!("2025-03-04T15:00:00.000Z"))]
    #[case::millis("$string($millis())", json!("1741100400000"))]
    #[case::today("$today", json!("2025-03-05"))]
    #[case::env("$env.REGION", json!("eu"))]
    #[case::vars(
        "[$vars.kept, $vars.both, $exists($vars.never)]",
        json!(["kept earlier", "this run's", false])
    )]
    #[case::run(
        "[$run.id, $run.startedAt, $run.trigger.kind, $run.trigger.nodeId]",
        json!([RUN_ID, "2025-03-04T15:00:00.000Z", "trigger.manual", "trigger"])
    )]
    #[case::workflow("[$workflow.id, $workflow.name]", json!([DEFINITION_ID, "Nightly"]))]
    fn each_binding_reads_what_it_names(#[case] expression: &str, #[case] expected: Value) {
        assert_eq!(
            evaluated(expression).expect("the expression evaluates"),
            expected
        );
    }

    /// A read of `$env` by a credential's name is refused before evaluating, and a
    /// credential-shaped row's value is never bound, so no spelling the refusal misses reaches it.
    #[test]
    fn env_never_answers_a_credentials_name() {
        assert!(matches!(
            evaluated("$env.GITHUB_TOKEN"),
            Err(ExpressionError::CredentialEnvironmentName { name }) if name == "GITHUB_TOKEN"
        ));
        assert!(matches!(
            evaluated("$uppercase($lookup($env, 'GITHUB_TOKEN'))"),
            Err(ExpressionError::CredentialEnvironmentName { name }) if name == "GITHUB_TOKEN"
        ));
        assert_eq!(
            evaluated("[$string($env), $lookup($env, 'GITHUB' & '_TOKEN')]")
                .expect("the expression evaluates"),
            json!([r#"{"REGION":"eu"}"#])
        );
    }

    /// A label no node has is a typed error naming it, read back from the evaluation.
    #[test]
    fn an_unknown_label_is_a_typed_error() {
        for expression in ["$item('nowhere')", "$first('nowhere')"] {
            assert!(
                matches!(
                    evaluated(expression),
                    Err(ExpressionError::Lineage(LineageError::UnknownLabel { label }))
                        if label == "nowhere"
                ),
                "{expression}"
            );
        }
    }
}
