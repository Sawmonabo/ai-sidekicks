//! The names a workflow expression reads, bound for one evaluation: the current item, the step's
//! own input and each earlier node's items by label, the loop and item indexes, the run's one
//! instant, the environment rows, the run's variables, and the run and workflow it belongs to.
//! `jsonata-core` binds a value only into the `Context` an `Evaluator` is built with, so the
//! bindings build the evaluator for each evaluation.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the evaluator thread, which evaluates each expression against its bindings"
    )
)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use jsonata_core::ast::{AstNode, PathStep, Stage};
use jsonata_core::evaluator::{Context, Evaluator, EvaluatorError, EvaluatorOptions, HostFnResult};
use jsonata_core::parser::parse;
use jsonata_core::value::JValue;
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

use crate::definitions::kept_values::WorkflowKeptValue;
use crate::expressions::key_order::to_jsonata_value;
use crate::expressions::lineage::{LineageError, StepKey, StepOutputs, walk_paired_item};
use crate::runs::creation::WorkflowRunTrigger;

/// The call `$now` formats the run's instant with, so a picture and a time zone read exactly as
/// `$fromMillis` reads them.
const INSTANT_TEXT_CALL: &str = "$fromMillis($instantMillis, $picture, $timezone)";

/// What one evaluation of an expression reads. The run's shared data is held by `Rc`, so the
/// bindings of each item share it; nothing here outlives the run.
pub(crate) struct ExpressionBindings {
    /// The step the expression belongs to.
    pub(crate) step: StepKey,
    /// The step's own input items.
    pub(crate) input_items: Rc<[WorkflowItem]>,
    /// The run's steps so far and the index from each label to its node.
    pub(crate) steps: Rc<StepOutputs>,
    /// Each node's params as the document stores them, by node id.
    pub(crate) node_params: Rc<HashMap<WorkflowNodeId, JsonRecord>>,
    /// The loop's run index, `$runIndex`.
    pub(crate) run_index: u64,
    /// The current input item's index, `$itemIndex`.
    pub(crate) item_index: usize,
    /// The run's one instant, which `$now` and `$millis()` answer.
    pub(crate) instant: Timestamp,
    /// The machine's time zone, which dates `$today`.
    pub(crate) time_zone: TimeZone,
    /// The environment rows of the project the run works in; none when it works in no project's
    /// repository.
    pub(crate) environment_rows: Rc<[EnvironmentRow]>,
    /// The values this run set with `Set variables`.
    pub(crate) run_variables: Rc<Map<String, Value>>,
    /// The values earlier runs kept, read where this run set none.
    pub(crate) kept_values: Rc<[WorkflowKeptValue]>,
    /// The run's id.
    pub(crate) run_id: WorkflowRunId,
    /// When the run started.
    pub(crate) run_started_at: WireInstant,
    /// The trigger node that started the run.
    pub(crate) run_trigger: WorkflowRunTrigger,
    /// The workflow's id.
    pub(crate) workflow_id: WorkflowDefinitionId,
    /// The workflow's name.
    pub(crate) workflow_name: WorkflowName,
}

/// Why an expression has no value: a lineage or label failure of an item binding, a read of a
/// credential's name through `$env`, or the evaluator's own failure.
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
    /// The evaluator refused or failed the expression.
    #[error(transparent)]
    Evaluation(#[from] EvaluatorError),
}

impl ExpressionBindings {
    /// `expression`'s value against these bindings, evaluated under `options`. Fails with
    /// [`ExpressionError::CredentialEnvironmentName`] before evaluating when the expression reads
    /// `$env` by a credential's name, with [`ExpressionError::Lineage`] when an item binding found
    /// no item, and with [`ExpressionError::Evaluation`] when the evaluator fails.
    pub(crate) fn evaluate(
        &self,
        expression: &AstNode,
        options: EvaluatorOptions,
    ) -> Result<JValue, ExpressionError> {
        if let Some(name) = credential_environment_name(expression) {
            return Err(ExpressionError::CredentialEnvironmentName {
                name: name.to_owned(),
            });
        }
        let lineage_error = Rc::new(RefCell::new(None));
        let mut evaluator = Evaluator::with_options(self.context(), options);
        self.register(&mut evaluator, &lineage_error);
        evaluator
            .evaluate(expression, &JValue::Undefined)
            .map_err(|error| match lineage_error.take() {
                Some(lineage) => ExpressionError::Lineage(lineage),
                None => ExpressionError::Evaluation(error),
            })
    }

    /// The bindings read as values: `$json`, the indexes, `$now`, `$today`, `$env`, `$vars`,
    /// `$run` and `$workflow`.
    fn context(&self) -> Context {
        // A step with no input item, such as one that always outputs data, reads `$json` as `{}`.
        let item_json = self.input_items.get(self.item_index).map_or_else(
            || to_jsonata_value(&json!({})),
            |item| to_jsonata_value(&item.json.0),
        );
        let environment = self
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
        let mut variables: Map<String, Value> = self
            .kept_values
            .iter()
            .map(|kept| (kept.name.clone(), kept.value.clone()))
            .collect();
        variables.extend(
            self.run_variables
                .iter()
                .map(|(name, value)| (name.clone(), value.clone())),
        );
        let today = self
            .instant
            .to_zoned(self.time_zone.clone())
            .date()
            .strftime("%Y-%m-%d")
            .to_string();

        let mut context = Context::new();
        context.bind("json".to_owned(), item_json);
        context.bind("runIndex".to_owned(), JValue::from(self.run_index));
        context.bind("itemIndex".to_owned(), JValue::from(self.item_index));
        context.bind(
            "now".to_owned(),
            instant_text(self.instant, &[]).expect("an instant formats with no picture"),
        );
        context.bind("today".to_owned(), JValue::string(today));
        context.bind("env".to_owned(), JValue::object(environment));
        context.bind(
            "vars".to_owned(),
            to_jsonata_value(&Value::Object(variables)),
        );
        context.bind(
            "run".to_owned(),
            to_jsonata_value(&json!({
                "id": self.run_id,
                "startedAt": self.run_started_at,
                "trigger": self.run_trigger,
            })),
        );
        context.bind(
            "workflow".to_owned(),
            to_jsonata_value(&json!({ "id": self.workflow_id, "name": self.workflow_name })),
        );
        context
    }

    /// The bindings called as functions: the item readers, `$params`, and `$now` and `$millis`
    /// answering the run's instant. An item reader's lineage or label failure is written to
    /// `lineage_error` as well as returned, so the caller reads it typed.
    fn register(
        &self,
        evaluator: &mut Evaluator,
        lineage_error: &Rc<RefCell<Option<LineageError>>>,
    ) {
        let reader = Rc::new(ItemReader {
            step: self.step.clone(),
            item_index: self.item_index,
            input_items: Rc::clone(&self.input_items),
            steps: Rc::clone(&self.steps),
            node_params: Rc::clone(&self.node_params),
            lineage_error: Rc::clone(lineage_error),
        });
        for pick in [
            ItemPick::All,
            ItemPick::First,
            ItemPick::Last,
            ItemPick::Linked,
        ] {
            let reader = Rc::clone(&reader);
            evaluator
                .register_fn(pick.name(), move |args: &[JValue]| reader.items(pick, args))
                .expect("no item reader's name is a built-in's");
        }
        evaluator
            .register_fn("params", move |args: &[JValue]| reader.params(args))
            .expect("params is no built-in's name");
        let instant = self.instant;
        evaluator
            .register_fn_override("now", move |args: &[JValue]| instant_text(instant, args))
            .expect("$now is a built-in the evaluator lets a host replace");
        let millis = instant.as_millisecond();
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

/// What the item readers and `$params` read, shared by the functions registered for one
/// evaluation.
struct ItemReader {
    /// The step the expression belongs to.
    step: StepKey,
    /// The current input item's index.
    item_index: usize,
    /// The step's own input items.
    input_items: Rc<[WorkflowItem]>,
    /// The run's steps so far.
    steps: Rc<StepOutputs>,
    /// Each node's params by id.
    node_params: Rc<HashMap<WorkflowNodeId, JsonRecord>>,
    /// Where a lineage or label failure is written for the caller.
    lineage_error: Rc<RefCell<Option<LineageError>>>,
}

impl ItemReader {
    /// `pick` over the step's own input when `args` is empty, else over the node `args` labels:
    /// that node's latest execution, every output in handle order, and for `$item` the item the
    /// current one came from. An absent first or last item is undefined.
    fn items(&self, pick: ItemPick, args: &[JValue]) -> HostFnResult {
        let label = label_argument(pick.name(), args)?;
        let items: Vec<&WorkflowItem> = match (label, pick) {
            (None, ItemPick::Linked) => self.input_items.get(self.item_index).into_iter().collect(),
            (None, ItemPick::All | ItemPick::First | ItemPick::Last) => {
                self.input_items.iter().collect()
            }
            (Some(label), ItemPick::Linked) => {
                vec![
                    walk_paired_item(&self.steps, &self.step, self.item_index, label)
                        .map_err(|error| self.refuse(error))?,
                ]
            }
            (Some(label), ItemPick::All | ItemPick::First | ItemPick::Last) => {
                let node_id = self
                    .steps
                    .node_id(label)
                    .map_err(|error| self.refuse(error))?;
                self.steps
                    .latest_step(node_id)
                    .map(|step| step.outputs.iter().flatten().collect())
                    .unwrap_or_default()
            }
        };
        let picked = match pick {
            ItemPick::All => return Ok(JValue::array(items.into_iter().map(item_value).collect())),
            ItemPick::First | ItemPick::Linked => items.first(),
            ItemPick::Last => items.last(),
        };
        Ok(picked.map_or(JValue::Undefined, |item| item_value(item)))
    }

    /// The params of the node `args` labels, as the document stores them.
    fn params(&self, args: &[JValue]) -> HostFnResult {
        let Some(label) = label_argument("params", args)? else {
            return Err(EvaluatorError::TypeError(
                "$params() takes a node's label".to_owned(),
            ));
        };
        let node_id = self
            .steps
            .node_id(label)
            .map_err(|error| self.refuse(error))?;
        Ok(self
            .node_params
            .get(node_id)
            .map_or(JValue::Undefined, |params| {
                to_jsonata_value(&serde_json::to_value(params).expect("params write as JSON"))
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

/// `item` as the evaluator reads it: its `json`, `binary`, `pairedItem` and `error`.
fn item_value(item: &WorkflowItem) -> JValue {
    to_jsonata_value(&serde_json::to_value(item).expect("an item writes as JSON"))
}

/// `instant` as `$fromMillis` writes it under `picture_and_zone`, jsonata's `$now(picture,
/// timezone)`: ISO 8601 in UTC when both are absent.
fn instant_text(instant: Timestamp, picture_and_zone: &[JValue]) -> HostFnResult {
    if picture_and_zone.len() > 2 {
        return Err(EvaluatorError::EvaluationError(
            "T0410: now() takes at most a picture and a timezone".to_owned(),
        ));
    }
    let mut context = Context::new();
    context.bind(
        "instantMillis".to_owned(),
        JValue::from(instant.as_millisecond()),
    );
    for (name, value) in ["picture", "timezone"].into_iter().zip(picture_and_zone) {
        context.bind(name.to_owned(), value.clone());
    }
    let call = parse(INSTANT_TEXT_CALL).expect("the instant's call is JSONata");
    Evaluator::with_context(context).evaluate(&call, &JValue::Undefined)
}

/// Whether `name` is shaped like a credential's, the rule a project's environment rows are saved
/// under.
fn is_credential_name(name: &str) -> bool {
    environment_name_refusal(name) == Some(EnvironmentNameRefusalReason::CredentialShaped)
}

/// The first credential-shaped name `node` reads from `$env`, as `$env.NAME` or
/// `$lookup($env, 'NAME')`.
fn credential_environment_name(node: &AstNode) -> Option<&str> {
    if let Some(name) = environment_read(node).filter(|name| is_credential_name(name)) {
        return Some(name);
    }
    match node {
        AstNode::String(_)
        | AstNode::Name(_)
        | AstNode::Number(_)
        | AstNode::Boolean(_)
        | AstNode::Null
        | AstNode::Undefined
        | AstNode::Placeholder
        | AstNode::Regex { .. }
        | AstNode::Variable(_)
        | AstNode::ParentVariable(_)
        | AstNode::Wildcard
        | AstNode::Descendant
        | AstNode::KeepArray
        | AstNode::Parent(_) => None,
        AstNode::Path { steps } => steps.iter().find_map(step_credential_environment_name),
        AstNode::Binary { lhs, rhs, .. } => {
            credential_environment_name(lhs).or_else(|| credential_environment_name(rhs))
        }
        AstNode::Unary { operand, .. } => credential_environment_name(operand),
        AstNode::Function { args, .. } => args.iter().find_map(credential_environment_name),
        AstNode::Call { procedure, args } => credential_environment_name(procedure)
            .or_else(|| args.iter().find_map(credential_environment_name)),
        AstNode::Lambda { body, .. } => credential_environment_name(body),
        AstNode::Array(elements) | AstNode::Block(elements) | AstNode::ArrayGroup(elements) => {
            elements.iter().find_map(credential_environment_name)
        }
        AstNode::Object(pairs) => pairs.iter().find_map(|(key, value)| {
            credential_environment_name(key).or_else(|| credential_environment_name(value))
        }),
        AstNode::ObjectTransform { input, pattern } => {
            credential_environment_name(input).or_else(|| {
                pattern.iter().find_map(|(key, value)| {
                    credential_environment_name(key).or_else(|| credential_environment_name(value))
                })
            })
        }
        AstNode::Conditional {
            condition,
            then_branch,
            else_branch,
        } => credential_environment_name(condition)
            .or_else(|| credential_environment_name(then_branch))
            .or_else(|| else_branch.as_deref().and_then(credential_environment_name)),
        AstNode::Predicate(inner) | AstNode::FunctionApplication(inner) => {
            credential_environment_name(inner)
        }
        AstNode::Sort { input, terms } => credential_environment_name(input).or_else(|| {
            terms
                .iter()
                .find_map(|(term, _)| credential_environment_name(term))
        }),
        AstNode::Transform {
            location,
            update,
            delete,
        } => credential_environment_name(location)
            .or_else(|| credential_environment_name(update))
            .or_else(|| delete.as_deref().and_then(credential_environment_name)),
    }
}

/// The first credential-shaped name a path step or its filters read from `$env`.
fn step_credential_environment_name(step: &PathStep) -> Option<&str> {
    credential_environment_name(&step.node).or_else(|| {
        step.stages.iter().find_map(|stage| match stage {
            Stage::Filter(filter) => credential_environment_name(filter),
            Stage::KeepArray | Stage::Index(_) => None,
        })
    })
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
