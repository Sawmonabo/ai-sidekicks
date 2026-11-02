//! The names a workflow expression reads: the current item, the step's own input and each earlier
//! node's items by label, the loop and item indexes, the run's one instant, the environment rows,
//! the run's variables, and the run and workflow it belongs to. What does not change per item is
//! built once per step on the evaluator thread; `jsonata-core` binds a value only into the
//! `Context` an `Evaluator` is built with, so each evaluation builds its own evaluator over it.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the evaluator thread, which evaluates each expression against its bindings"
    )
)]

use std::cell::{OnceCell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use jsonata_core::ast::AstNode;
use jsonata_core::evaluator::{Context, Evaluator, EvaluatorError, EvaluatorOptions, HostFnResult};
use jsonata_core::parser::{ParserError, parse};
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
use tokio::sync::oneshot::error::RecvError;

use crate::definitions::kept_values::WorkflowKeptValue;
use crate::expressions::lineage::{LineageError, StepKey, StepOutputs, walk_paired_item};
use crate::expressions::syntax_tree::find_in_syntax_tree;
use crate::runs::creation::WorkflowRunTrigger;

/// The call `$now` formats the run's instant with, so a picture and a time zone read exactly as
/// `$fromMillis` reads them.
const INSTANT_TEXT_CALL: &str = "$fromMillis($instantMillis, $picture, $timezone)";

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
/// step's cancel, or the evaluator thread too busy or stopped to take the evaluation.
#[derive(Debug, thiserror::Error)]
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
    /// The evaluator thread already holds as many jobs waiting as its channel takes.
    #[error("The expression thread has too many evaluations waiting.")]
    EvaluatorBusy,
    /// The evaluator thread stopped, which only a panic on it does, before it answered.
    #[error("The expression thread stopped before it answered.")]
    EvaluatorStopped(#[from] RecvError),
}

/// A step's bindings on the evaluator thread: every value that does not change per item, built
/// once from the step's [`ExpressionBindings`], and its items converted once on first use.
pub(crate) struct StepBindings {
    /// What the item readers and `$params` read, shared by every evaluation of the step.
    items: Rc<StepItems>,
    /// `$runIndex`.
    run_index: JValue,
    /// `$now` read as a value: the run's instant in ISO 8601.
    now: JValue,
    /// `$today`.
    today: JValue,
    /// `$env`, credential-shaped rows left out.
    environment: JValue,
    /// `$vars`.
    variables: JValue,
    /// `$run`.
    run: JValue,
    /// `$workflow`.
    workflow: JValue,
    /// The run's instant in milliseconds, which `$millis()` answers.
    instant_millis: i64,
    /// [`INSTANT_TEXT_CALL`], parsed once for every `$now(...)` call of the step.
    instant_text_call: Rc<AstNode>,
}

impl StepBindings {
    /// The step's bindings, each constant value converted and [`INSTANT_TEXT_CALL`] parsed here,
    /// once for all its items.
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
        let instant_millis = bindings.run_started_at.as_millisecond();
        let instant_text_call = parse(INSTANT_TEXT_CALL).expect("the instant's call is JSONata");
        let now = instant_text(&instant_text_call, instant_millis, &[])
            .expect("an instant formats with no picture");
        Self {
            run_index: JValue::from(bindings.run_index),
            now,
            today: JValue::string(today),
            environment: JValue::object(environment),
            variables: JValue::from(Value::Object(variables)),
            run: JValue::from(json!({
                "id": bindings.run_id,
                "startedAt": WireInstant::from_timestamp(bindings.run_started_at),
                "trigger": bindings.run_trigger,
            })),
            workflow: JValue::from(
                json!({ "id": bindings.workflow_id, "name": bindings.workflow_name }),
            ),
            instant_millis,
            instant_text_call: Rc::new(instant_text_call),
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

    /// The bindings called as functions: the item readers, `$params`, and `$now` and `$millis`
    /// answering the run's instant. An item reader's lineage or label failure is written to
    /// `lineage_error` as well as returned, so the caller reads it typed.
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
        let call = Rc::clone(&self.instant_text_call);
        let millis = self.instant_millis;
        evaluator
            .register_fn_override("now", move |args: &[JValue]| {
                instant_text(&call, millis, args)
            })
            .expect("$now is a built-in the evaluator lets a host replace");
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
    step: StepKey,
    /// The step's own input items.
    input_items: Arc<[WorkflowItem]>,
    /// The run's steps so far.
    steps: Arc<StepOutputs>,
    /// Each node's params by id.
    node_params: Arc<HashMap<WorkflowNodeId, JsonRecord>>,
    /// The step's input items as evaluator values.
    input_values: OnceCell<JArray>,
    /// Each labeled node's items, as `$all('<label>')` reads them, as evaluator values.
    node_values: RefCell<HashMap<WorkflowNodeId, JArray>>,
}

impl StepItems {
    /// The step's input items as evaluator values, converted on the first call.
    fn input_values(&self) -> &JArray {
        self.input_values
            .get_or_init(|| items_array(&self.input_items))
    }

    /// The items `$all('<label>')` reads of `node_id`: its latest execution's first output, as a
    /// node read by label defaults to; empty while it has not run. Converted on the first call.
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
    fn refuse(&self, error: LineageError) -> EvaluatorError {
        let message = error.to_string();
        *self.lineage_error.borrow_mut() = Some(error);
        EvaluatorError::EvaluationError(message)
    }
}

/// The label in `args`, `None` when there are no arguments; fails with a type error for anything
/// but one string.
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
fn items_array(items: &[WorkflowItem]) -> JArray {
    JArray::new(items.iter().map(item_value).collect())
}

/// `item` as the evaluator reads it: its `json`, `binary`, `pairedItem` and `error`.
fn item_value(item: &WorkflowItem) -> JValue {
    JValue::from(serde_json::to_value(item).expect("an item writes as JSON"))
}

/// The instant `instant_millis` as `$fromMillis` writes it under `picture_and_zone`, jsonata's
/// `$now(picture, timezone)`, through `call`, the parsed [`INSTANT_TEXT_CALL`]: ISO 8601 in UTC
/// when both are absent.
fn instant_text(call: &AstNode, instant_millis: i64, picture_and_zone: &[JValue]) -> HostFnResult {
    if picture_and_zone.len() > 2 {
        return Err(EvaluatorError::EvaluationError(
            "T0410: now() takes at most a picture and a timezone".to_owned(),
        ));
    }
    let mut context = Context::new();
    context.bind("instantMillis".to_owned(), JValue::from(instant_millis));
    for (name, value) in ["picture", "timezone"].into_iter().zip(picture_and_zone) {
        context.bind(name.to_owned(), value.clone());
    }
    Evaluator::with_context(context).evaluate(call, &JValue::Undefined)
}

/// Whether `name` is shaped like a credential's, the rule a project's environment rows are saved
/// under.
fn is_credential_name(name: &str) -> bool {
    environment_name_refusal(name) == Some(EnvironmentNameRefusalReason::CredentialShaped)
}

/// The first credential-shaped name `node` or any node inside it reads from `$env`, as `$env.NAME`
/// or `$lookup($env, 'NAME')`.
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
fn is_environment(node: &AstNode) -> bool {
    matches!(node, AstNode::Variable(name) if name == "env")
}

#[cfg(test)]
mod tests;
