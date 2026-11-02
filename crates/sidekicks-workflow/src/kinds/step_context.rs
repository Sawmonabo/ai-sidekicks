//! What a running step reads and records: its session, step and run, its params for each item, its
//! secrets, cancel and redaction, the services it runs through, and the log lines, progress and run
//! variables it records for the tick to take.

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::expression_template::{
    TemplateError, TemplateText, read_template,
};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_std::mutex_lock::lock;
use tokio_util::sync::CancellationToken;

use crate::engine::ports::{StepPayloadArtifacts, StepProcessLauncher};
use crate::expressions::bindings::ExpressionError;
use crate::expressions::evaluator::{ParamTemplate, StepExpressionsHandle};
use crate::runs::step_action::StepActionApproval;
use crate::secrets::redaction::RunRedaction;
use crate::secrets::resolution::ResolvedStepSecret;

/// One step in a param's value: a member of an object or an entry of an array.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ParamPathSegment {
    /// The member of this name.
    Key(String),
    /// The entry at this index.
    Index(usize),
}

/// Where a string sits in a node's params: the param, then each member or entry below it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParamPath {
    /// The param's name.
    pub(crate) param: String,
    /// Each member or entry below the param, outermost first.
    pub(crate) segments: Vec<ParamPathSegment>,
}

impl fmt::Display for ParamPath {
    /// Writes the path as `param.member[index]`.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.param)?;
        for segment in &self.segments {
            match segment {
                ParamPathSegment::Key(key) => write!(formatter, ".{key}")?,
                ParamPathSegment::Index(index) => write!(formatter, "[{index}]")?,
            }
        }
        Ok(())
    }
}

/// Why a step's params could not be read or evaluated.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StepParamsError {
    /// A param's template opens a part it never closes, which the save check refuses before a run.
    #[error("the template at {path} is never closed")]
    Unclosed {
        /// Where the template sits.
        path: ParamPath,
        /// The cut's refusal.
        source: TemplateError,
    },
    /// An item's evaluation failed.
    #[error(transparent)]
    Expression(#[from] ExpressionError),
}

/// A node's params as a step reads them: every literal as it stands, and where each `=` template
/// sits, in the order its value comes back from the evaluator.
pub(crate) struct StepParams {
    /// The params with each literal read, shared by every item when no template exists.
    base: Arc<Map<String, Value>>,
    /// Where each template sits, in walk order.
    template_paths: Vec<ParamPath>,
}

impl StepParams {
    /// Reads `params`, walking every string they hold, in arrays and objects too: a literal keeps
    /// its read text (an `=` that opens no part dropped), and each template's path and template are
    /// returned in walk order, the order [`StepParams::fill`] takes their values in. Fails with
    /// [`StepParamsError::Unclosed`] for a template whose part never closes.
    pub(crate) fn read(params: &JsonRecord) -> Result<(Self, Vec<ParamTemplate>), StepParamsError> {
        let mut base = Map::new();
        let mut template_paths = Vec::new();
        let mut templates = Vec::new();
        for (name, value) in params.as_map() {
            let mut value = value.0.clone();
            let mut segments = Vec::new();
            read_param_value(
                &mut value,
                name,
                &mut segments,
                &mut template_paths,
                &mut templates,
            )?;
            base.insert(name.clone(), value);
        }
        Ok((
            Self {
                base: Arc::new(base),
                template_paths,
            },
            templates,
        ))
    }

    /// The params with `values`, one per template in the order [`StepParams::read`] returned them,
    /// each put at its template's path.
    pub(crate) fn fill(&self, values: Vec<Value>) -> Map<String, Value> {
        let mut filled = Map::clone(&self.base);
        for (path, value) in self.template_paths.iter().zip(values) {
            *value_at(&mut filled, path) = value;
        }
        filled
    }
}

/// Reads `value`, sitting at `segments` below param `param`, in place, recording each template's
/// path and template.
fn read_param_value(
    value: &mut Value,
    param: &str,
    segments: &mut Vec<ParamPathSegment>,
    template_paths: &mut Vec<ParamPath>,
    templates: &mut Vec<ParamTemplate>,
) -> Result<(), StepParamsError> {
    match value {
        Value::String(text) => {
            let literal = match read_template(text) {
                Ok(TemplateText::Literal(literal)) => {
                    (literal.len() != text.len()).then(|| literal.to_owned())
                }
                Ok(TemplateText::Expression(template)) => {
                    template_paths.push(ParamPath {
                        param: param.to_owned(),
                        segments: segments.clone(),
                    });
                    templates.push(ParamTemplate::from(&template));
                    None
                }
                Err(source) => {
                    return Err(StepParamsError::Unclosed {
                        path: ParamPath {
                            param: param.to_owned(),
                            segments: segments.clone(),
                        },
                        source,
                    });
                }
            };
            if let Some(literal) = literal {
                *text = literal;
            }
        }
        Value::Array(entries) => {
            for (index, entry) in entries.iter_mut().enumerate() {
                segments.push(ParamPathSegment::Index(index));
                read_param_value(entry, param, segments, template_paths, templates)?;
                segments.pop();
            }
        }
        Value::Object(members) => {
            for (key, entry) in members.iter_mut() {
                segments.push(ParamPathSegment::Key(key.clone()));
                read_param_value(entry, param, segments, template_paths, templates)?;
                segments.pop();
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}

/// The value at `path` in `params`, which [`StepParams::read`] recorded from these params.
fn value_at<'params>(
    params: &'params mut Map<String, Value>,
    path: &ParamPath,
) -> &'params mut Value {
    let mut value = params
        .get_mut(&path.param)
        .expect("the path was read from these params");
    for segment in &path.segments {
        value = match segment {
            ParamPathSegment::Key(key) => value.get_mut(key.as_str()),
            ParamPathSegment::Index(index) => value.get_mut(*index),
        }
        .expect("the path was read from these params");
    }
    value
}

/// A run variable a step set: its value, and whether later runs keep it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StepRunVariable {
    /// The value.
    pub(crate) value: Value,
    /// Whether later runs of the workflow read it too.
    pub(crate) is_kept: bool,
}

/// What a step recorded since the tick last took its records.
#[derive(Debug, Default)]
pub(crate) struct StepRecords {
    /// The log lines, each scrubbed of the run's secrets.
    pub(crate) log_lines: Vec<String>,
    /// Whether the step reported progress.
    #[cfg_attr(
        test,
        expect(dead_code, reason = "the tick, which writes what a step recorded")
    )]
    pub(crate) has_progressed: bool,
    /// The run variables the step set, by name, the latest value of each.
    #[cfg_attr(
        test,
        expect(dead_code, reason = "the tick, which writes what a step recorded")
    )]
    pub(crate) run_variables: BTreeMap<String, StepRunVariable>,
    /// Whether the step asked for its node's other inputs' branches to be canceled.
    #[cfg_attr(
        test,
        expect(dead_code, reason = "the tick, which writes what a step recorded")
    )]
    pub(crate) cancels_other_inputs: bool,
}

/// What a running step reads and records. The tick holds it while the executor runs and takes its
/// records between writes.
#[expect(
    dead_code,
    reason = "the tick's dispatch, which builds a step's context, and the kinds' executors, which read it"
)]
pub(crate) struct StepContext {
    /// The session the run lives in.
    pub(crate) session_id: SessionId,
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// The node's name.
    pub(crate) node_name: NonEmptyText,
    /// The loop's run index, `$runIndex`.
    pub(crate) run_index: u64,
    /// The run's level.
    pub(crate) permission_level: PermissionLevel,
    /// The folder the run works in.
    pub(crate) working_folder: PathBuf,
    /// The secrets the node's sensitive params resolved to.
    pub(crate) secrets: Vec<ResolvedStepSecret>,
    /// The step's cancel.
    pub(crate) cancel: CancellationToken,
    /// The run's redaction, which scrubs every record the step writes.
    pub(crate) redaction: Arc<RunRedaction>,
    /// The check a step's action passes before it runs.
    pub(crate) step_actions: Arc<dyn StepActionApproval>,
    /// The launcher of the processes the step runs.
    pub(crate) processes: Arc<dyn StepProcessLauncher>,
    /// The store of the step's payloads too large to carry inline.
    pub(crate) payloads: Arc<dyn StepPayloadArtifacts>,
    /// The daemon's HTTP client.
    pub(crate) http: reqwest::Client,
    /// The node's params.
    params: StepParams,
    /// The step's templates open on the expression thread, `None` when its params hold none.
    expressions: Option<StepExpressionsHandle>,
    /// What the step recorded since the tick last took it.
    records: Mutex<StepRecords>,
}

impl StepContext {
    /// The node's params for input item `item_index`: the one shared map when they hold no
    /// template, else each template evaluated for the item in one hop. Fails with
    /// [`StepParamsError::Expression`] when the evaluation does.
    #[expect(dead_code, reason = "the kinds' executors")]
    pub(crate) async fn item_params(
        &self,
        item_index: usize,
    ) -> Result<Arc<Map<String, Value>>, StepParamsError> {
        let Some(expressions) = &self.expressions else {
            return Ok(Arc::clone(&self.params.base));
        };
        let values = expressions.evaluate_item(item_index).await?;
        Ok(Arc::new(self.params.fill(values)))
    }

    /// Records `line` in the step's log, scrubbed of the run's secrets.
    pub(crate) fn write_log(&self, line: &str) {
        let line = self.redaction.scrub(line).into_owned();
        lock(&self.records).log_lines.push(line);
    }

    /// Records that the step made progress.
    #[expect(dead_code, reason = "the kinds' executors")]
    pub(crate) fn mark_progress(&self) {
        lock(&self.records).has_progressed = true;
    }

    /// Sets the run variables `values`, which later runs keep too when `keep`; a name set again
    /// takes the later value and keep, so the last item wins.
    #[expect(dead_code, reason = "the kinds' executors")]
    pub(crate) fn set_run_variables(&self, values: Map<String, Value>, keep: bool) {
        let mut records = lock(&self.records);
        for (name, value) in values {
            records.run_variables.insert(
                name,
                StepRunVariable {
                    value,
                    is_kept: keep,
                },
            );
        }
    }

    /// Asks the engine to cancel the branches still running into the node's other inputs.
    #[expect(dead_code, reason = "the kinds' executors")]
    pub(crate) fn cancel_other_inputs(&self) {
        lock(&self.records).cancels_other_inputs = true;
    }

    /// Takes what the step recorded since the last take, leaving nothing recorded.
    pub(crate) fn take_records(&self) -> StepRecords {
        std::mem::take(&mut *lock(&self.records))
    }
}

/// The ports a test context holds, which refuse every call: a test that reaches one has a fault.
#[cfg(test)]
struct RefusingPorts;

#[cfg(test)]
const REFUSED_PORT_CALL: &str = "a test context's ports take no call";

#[cfg(test)]
impl StepActionApproval for RefusingPorts {
    fn check_step_action(
        &self,
        _check: crate::runs::step_action::StepActionCheck,
    ) -> futures::future::BoxFuture<
        '_,
        Result<crate::runs::step_action::StepActionVerdict, crate::engine::ports::PortError>,
    > {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }
}

#[cfg(test)]
impl StepProcessLauncher for RefusingPorts {
    fn command_shell(
        &self,
        _provider: &sidekicks_contracts::provider::id::ProviderId,
    ) -> Option<PathBuf> {
        None
    }

    fn launch(
        &self,
        _launch: crate::engine::ports::StepLaunch,
    ) -> futures::future::BoxFuture<
        '_,
        Result<Box<dyn crate::engine::ports::StepProcess>, crate::engine::ports::PortError>,
    > {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }
}

#[cfg(test)]
impl StepPayloadArtifacts for RefusingPorts {
    fn write<'call>(
        &'call self,
        _session_id: SessionId,
        _step: &'call WorkflowStepKey,
        _bytes: Vec<u8>,
        _item_count: u64,
    ) -> futures::future::BoxFuture<
        'call,
        Result<sidekicks_contracts::artifacts::id::ArtifactId, crate::engine::ports::PortError>,
    > {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }

    fn read<'call>(
        &'call self,
        _artifact_id: &'call sidekicks_contracts::artifacts::id::ArtifactId,
    ) -> futures::future::BoxFuture<'call, Result<Vec<u8>, crate::engine::ports::PortError>> {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }
}

/// A context for step `run`'s first attempt in a test session, its params `params` with no
/// template open, writing through `redaction`, its ports refusing every call.
#[cfg(test)]
pub(crate) fn test_step_context(params: &JsonRecord, redaction: Arc<RunRedaction>) -> StepContext {
    let (params, _templates) = StepParams::read(params).expect("the test's params read");
    let ports = Arc::new(RefusingPorts);
    StepContext {
        session_id: SessionId::new("0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7b")
            .expect("the test's session id is a UUID"),
        step: serde_json::from_value(serde_json::json!({
            "workflowRunId": "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7c",
            "nodeId": "run", "attempt": 1, "executionIndex": 0,
        }))
        .expect("the test's step key reads"),
        node_name: NonEmptyText::new("Run".to_owned()).expect("the name is not empty"),
        run_index: 0,
        permission_level: PermissionLevel::Ask,
        working_folder: PathBuf::from("/workspace"),
        secrets: Vec::new(),
        cancel: CancellationToken::new(),
        redaction,
        step_actions: Arc::clone(&ports) as Arc<dyn StepActionApproval>,
        processes: Arc::clone(&ports) as Arc<dyn StepProcessLauncher>,
        payloads: ports,
        http: reqwest::Client::new(),
        params,
        expressions: None,
        records: Mutex::default(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use secrecy::SecretString;
    use serde_json::{Value, json};
    use sidekicks_contracts::wire::record::JsonRecord;
    use sidekicks_ipc::redaction::CREDENTIAL_REDACTION;

    use super::{ParamPath, ParamPathSegment, StepParams, StepParamsError, test_step_context};
    use crate::secrets::redaction::RunRedaction;

    fn params(value: Value) -> JsonRecord {
        serde_json::from_value(value).expect("the test's params read")
    }

    /// Every string a param holds is read, nested ones too, and each value fills its own template's
    /// place while literals stay as they read; a template never closed is refused with its path.
    /// Mutations: skip nested strings; swap the slots; touch a literal; run an unclosed template as
    /// text.
    #[test]
    fn fill_puts_each_value_at_its_templates_place() {
        let (step_params, templates) = StepParams::read(&params(json!({
            "a": "=x {{ 1 }}",
            "nested": { "list": ["lit", "={{ 2 }}"] },
            "plain": "text",
            "bare": "=no part",
        })))
        .expect("the params read");
        assert_eq!(templates.len(), 2);
        assert_eq!(
            Value::Object(step_params.fill(vec![json!("A"), json!("B")])),
            json!({
                "a": "A",
                "nested": { "list": ["lit", "B"] },
                "plain": "text",
                "bare": "no part",
            }),
        );

        let unclosed = StepParams::read(&params(json!({ "outer": [{ "bad": "={{ a" }] })));
        let Err(StepParamsError::Unclosed { path, .. }) = unclosed else {
            panic!("an unclosed template is refused");
        };
        assert_eq!(
            path,
            ParamPath {
                param: "outer".to_owned(),
                segments: vec![
                    ParamPathSegment::Index(0),
                    ParamPathSegment::Key("bad".to_owned())
                ],
            }
        );
    }

    /// A log line holding one of the run's secrets is stored with the secret masked. Mutation:
    /// store the line unscrubbed.
    #[test]
    fn the_log_masks_the_runs_secrets() {
        let redaction = Arc::new(RunRedaction::new(&[SecretString::from("hunter2secretXYZ")]));
        let context = test_step_context(&JsonRecord::default(), redaction);
        context.write_log("token hunter2secretXYZ sent");
        assert_eq!(
            context.take_records().log_lines,
            vec![format!("token {CREDENTIAL_REDACTION} sent")]
        );
    }
}
