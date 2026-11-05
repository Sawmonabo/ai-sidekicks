//! What a running step reads and records: its session, step and run, its params for each item, its
//! secrets, cancel and redaction, the services it runs through, and the log lines, progress and run
//! variables it records for the step's driver to take.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::expression_template::{
    TemplateError, TemplateText, read_template,
};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::engine::ports::{
    StepAdmissionTicket, StepPayloadArtifacts, StepProcessLauncher, WorkflowNodeKey,
};
use crate::expressions::bindings::ExpressionError;
use crate::expressions::evaluator::{ParamTemplate, StepExpressionsHandle};
use crate::expressions::param_strings::{ParamPath, ParamPathSegment, walk_param_strings};
use crate::runs::step_action::StepActionApproval;
use crate::secrets::redaction::RunRedaction;
use crate::secrets::resolution::ResolvedStepSecret;

/// Why a step's params could not be read or evaluated.
#[derive(Debug, thiserror::Error)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the tick's dispatch of each kind")
)]
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
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    base: Arc<Map<String, Value>>,
    /// Where each template sits, in walk order.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    template_paths: Vec<ParamPath>,
}

impl StepParams {
    /// Reads `params`, walking every string they hold, in arrays and objects too: a literal keeps
    /// its read text (an `=` that opens no part dropped), and each template's path and template are
    /// returned in walk order, the order [`StepParams::fill`] takes their values in. Fails with
    /// [`StepParamsError::Unclosed`] for a template whose part never closes.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) fn read(params: &JsonRecord) -> Result<(Self, Vec<ParamTemplate>), StepParamsError> {
        let mut base: Map<String, Value> = params
            .as_map()
            .iter()
            .map(|(name, value)| (name.clone(), value.0.clone()))
            .collect();
        let mut template_paths = Vec::new();
        let mut templates = Vec::new();
        walk_param_strings(params, |path, text| {
            match read_template(text) {
                Ok(TemplateText::Literal(literal)) => {
                    if literal.len() != text.len() {
                        *value_at(&mut base, path) = Value::String(literal.to_owned());
                    }
                }
                Ok(TemplateText::Expression(template)) => {
                    template_paths.push(path.clone());
                    templates.push(ParamTemplate::from(&template));
                }
                Err(source) => {
                    return Err(StepParamsError::Unclosed {
                        path: path.clone(),
                        source,
                    });
                }
            }
            Ok(())
        })?;
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
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) fn fill(&self, values: Vec<Value>) -> Map<String, Value> {
        let mut filled = Map::clone(&self.base);
        for (path, value) in self.template_paths.iter().zip(values) {
            *value_at(&mut filled, path) = value;
        }
        filled
    }
}

/// The value at `path` in `params`, a path the walk of these params gave.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the tick's dispatch of each kind")
)]
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

/// The most log lines a step keeps, 10,000, so a step writing without end holds no more than
/// that in memory; a line past it is counted, not kept, and the log's last line names the count.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the tick's dispatch of each kind")
)]
const STEP_LOG_LINE_CAP: usize = 10_000;

/// The most bytes one kept log line holds, 4 KiB, cut back to a whole character, so with
/// [`STEP_LOG_LINE_CAP`] a step's log holds at most about 40 MiB.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the tick's dispatch of each kind")
)]
const STEP_LOG_LINE_BYTE_CAP: usize = 4_096;

/// What a step recorded since the step's driver last took its records, which it takes when woken
/// and when the step ends.
#[derive(Debug, Default)]
pub(crate) struct StepRecords {
    /// The log lines, each scrubbed of the run's secrets.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) log_lines: Vec<String>,
    /// Whether the step reported progress.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) has_progressed: bool,
    /// The run variables the step set, by name, the latest value of each.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) run_variables: BTreeMap<String, StepRunVariable>,
}

/// What a running step reads and records. The step's driver holds it while the executor runs, and
/// takes its records when woken and when the step ends.
#[expect(dead_code, reason = "the kinds' executors, which read it")]
pub(crate) struct StepContext {
    /// The session the run lives in.
    pub(crate) session_id: SessionId,
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// The node as the memory gate knows it, which an agent step's request and a process step's
    /// peak read are keyed on.
    pub(crate) node_key: WorkflowNodeKey,
    /// The node's name.
    pub(crate) node_name: NonEmptyText,
    /// The loop's run index, `$runIndex`.
    pub(crate) run_index: u64,
    /// The run's level.
    pub(crate) permission_level: PermissionLevel,
    /// The folder the run works in.
    pub(crate) working_folder: PathBuf,
    /// The workflow's provider as the run started, whose sandbox and shell its command steps use;
    /// `None` when the workflow names none, which a start allows only when no step runs in a
    /// sandbox.
    pub(crate) provider: Option<ProviderId>,
    /// The secrets the node's sensitive params resolved to.
    pub(crate) secrets: Vec<ResolvedStepSecret>,
    /// The step's cancel.
    pub(crate) cancel: CancellationToken,
    /// The run's redaction, which scrubs every record the step writes.
    pub(crate) redaction: Arc<RunRedaction>,
    /// The step's place at the memory gate, which a script or quick step reports its peak
    /// through; `None` for a step the gate does not weigh.
    pub(crate) admission: Option<Arc<dyn StepAdmissionTicket>>,
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
    /// The input item a per-item call's item 0 stands for, so its params evaluate over its own
    /// item; 0 for a step run once over all its items.
    item_call_offset: AtomicUsize,
    /// The log lines the step wrote, kept or not, which [`STEP_LOG_LINE_CAP`] is held against.
    log_lines_written: AtomicUsize,
    /// What the step recorded since the step's driver last took it.
    records: Mutex<StepRecords>,
    /// Woken when the step marks progress.
    recorded: Notify,
}

/// What a step's context is built from: its public members, its node's params and its templates
/// open on the expression thread.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the tick's dispatch of each kind")
)]
pub(crate) struct StepContextParts {
    /// The session the run lives in.
    pub(crate) session_id: SessionId,
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// The node as the memory gate knows it, which an agent step's request and a process step's
    /// peak read are keyed on.
    pub(crate) node_key: WorkflowNodeKey,
    /// The node's name.
    pub(crate) node_name: NonEmptyText,
    /// The loop's run index, `$runIndex`.
    pub(crate) run_index: u64,
    /// The run's level.
    pub(crate) permission_level: PermissionLevel,
    /// The folder the run works in.
    pub(crate) working_folder: PathBuf,
    /// The workflow's provider as the run started, whose sandbox and shell its command steps use;
    /// `None` when the workflow names none, which a start allows only when no step runs in a
    /// sandbox.
    pub(crate) provider: Option<ProviderId>,
    /// The secrets the node's sensitive params resolved to.
    pub(crate) secrets: Vec<ResolvedStepSecret>,
    /// The step's cancel.
    pub(crate) cancel: CancellationToken,
    /// The run's redaction, which scrubs every record the step writes.
    pub(crate) redaction: Arc<RunRedaction>,
    /// The step's place at the memory gate, which a script or quick step reports its peak
    /// through; `None` for a step the gate does not weigh.
    pub(crate) admission: Option<Arc<dyn StepAdmissionTicket>>,
    /// The check a step's action passes before it runs.
    pub(crate) step_actions: Arc<dyn StepActionApproval>,
    /// The launcher of the processes the step runs.
    pub(crate) processes: Arc<dyn StepProcessLauncher>,
    /// The store of the step's payloads too large to carry inline.
    pub(crate) payloads: Arc<dyn StepPayloadArtifacts>,
    /// The daemon's HTTP client.
    pub(crate) http: reqwest::Client,
    /// The node's params.
    pub(crate) params: StepParams,
    /// The step's templates open on the expression thread, `None` when its params hold none.
    pub(crate) expressions: Option<StepExpressionsHandle>,
}

impl StepContext {
    /// The context built from `parts`, its redaction masking each of its secrets before any record
    /// the step makes.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) fn new(parts: StepContextParts) -> Self {
        let StepContextParts {
            session_id,
            step,
            node_key,
            node_name,
            run_index,
            permission_level,
            working_folder,
            provider,
            secrets,
            cancel,
            redaction,
            admission,
            step_actions,
            processes,
            payloads,
            http,
            params,
            expressions,
        } = parts;
        for secret in &secrets {
            redaction.add_secret(&secret.value);
        }
        Self {
            session_id,
            step,
            node_key,
            node_name,
            run_index,
            permission_level,
            working_folder,
            provider,
            secrets,
            cancel,
            redaction,
            admission,
            step_actions,
            processes,
            payloads,
            http,
            params,
            expressions,
            item_call_offset: AtomicUsize::new(0),
            log_lines_written: AtomicUsize::new(0),
            records: Mutex::default(),
            recorded: Notify::new(),
        }
    }

    /// Starts the per-item call over the step's input item `item_index`, so the call's item 0 is
    /// that item when it reads its params.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) fn begin_item_call(&self, item_index: usize) {
        self.item_call_offset.store(item_index, Ordering::Relaxed);
    }

    /// The node's params for item `item_index` of the items the executor was handed: the one
    /// shared map when they hold no template, else each template evaluated for the item in one
    /// hop. Fails with [`StepParamsError::Expression`] when the evaluation does.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) async fn item_params(
        &self,
        item_index: usize,
    ) -> Result<Arc<Map<String, Value>>, StepParamsError> {
        let Some(expressions) = &self.expressions else {
            return Ok(Arc::clone(&self.params.base));
        };
        let offset = self.item_call_offset.load(Ordering::Relaxed);
        let values = expressions.evaluate_item(offset + item_index).await?;
        Ok(Arc::new(self.params.fill(values)))
    }

    /// Records `line` in the step's log, scrubbed of the run's secrets and then cut to
    /// [`STEP_LOG_LINE_BYTE_CAP`], while the step has written fewer than [`STEP_LOG_LINE_CAP`]
    /// lines; past it the line is only counted.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) fn write_log(&self, line: &str) {
        if self.log_lines_written.fetch_add(1, Ordering::Relaxed) >= STEP_LOG_LINE_CAP {
            return;
        }
        // Scrubbed before the cut, since a secret cut short no longer matches its mask.
        let mut line = self.redaction.scrub(line).into_owned();
        line.truncate(line.floor_char_boundary(STEP_LOG_LINE_BYTE_CAP));
        lock(&self.records).log_lines.push(line);
    }

    /// Records that the step made progress.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) fn mark_progress(&self) {
        lock(&self.records).has_progressed = true;
        self.recorded.notify_one();
    }

    /// Sets the run variables `values`, which later runs keep too when `keep`; a name set again
    /// takes the later value and keep, so the last item wins.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
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

    /// Waits until the step marks progress; returns at once when it did since the last wait ended.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) async fn wait_for_records(&self) {
        self.recorded.notified().await;
    }

    /// Takes what the step recorded since the last take, leaving nothing recorded.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) fn take_records(&self) -> StepRecords {
        std::mem::take(&mut *lock(&self.records))
    }

    /// Takes the step's last records when it ends, as [`Self::take_records`] does, with a last log
    /// line naming how many lines the step wrote past [`STEP_LOG_LINE_CAP`] when it did.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tick's dispatch of each kind")
    )]
    pub(crate) fn finish_records(&self) -> StepRecords {
        let mut records = self.take_records();
        let dropped = self
            .log_lines_written
            .load(Ordering::Relaxed)
            .saturating_sub(STEP_LOG_LINE_CAP);
        if dropped > 0 {
            records
                .log_lines
                .push(format!("{dropped} more log lines were not kept"));
        }
        records
    }
}

/// A context for step `run`'s first attempt in a test session, its params `params` with no
/// template open and its secrets `secrets`, writing through `redaction`, its ports refusing every
/// call.
#[cfg(test)]
pub(crate) fn test_step_context(
    params: &JsonRecord,
    secrets: Vec<ResolvedStepSecret>,
    redaction: Arc<RunRedaction>,
) -> StepContext {
    use sidekicks_contracts::workflow::definition::document::{
        WorkflowDefinitionId, WorkflowNodeId,
    };

    let (params, _templates) = StepParams::read(params).expect("the test's params read");
    let ports = crate::engine::ports::refusing_engine_ports();
    StepContext::new(StepContextParts {
        session_id: SessionId::new("0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7b")
            .expect("the test's session id is a UUID"),
        step: serde_json::from_value(serde_json::json!({
            "workflowRunId": "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7c",
            "nodeId": "run", "attempt": 1, "executionIndex": 0,
        }))
        .expect("the test's step key reads"),
        node_key: WorkflowNodeKey::new(
            WorkflowDefinitionId::new("0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7d")
                .expect("the test's definition id is a UUID"),
            &WorkflowNodeId::new("run".to_owned()).expect("the test's node id"),
        ),
        node_name: NonEmptyText::new("Run".to_owned()).expect("the name is not empty"),
        run_index: 0,
        permission_level: PermissionLevel::Ask,
        working_folder: PathBuf::from("/workspace"),
        provider: Some(
            ProviderId::new("test-provider".to_owned()).expect("the test's provider id"),
        ),
        secrets,
        cancel: CancellationToken::new(),
        redaction,
        admission: None,
        step_actions: ports.step_actions,
        processes: ports.processes,
        payloads: ports.payloads,
        http: reqwest::Client::new(),
        params,
        expressions: None,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use secrecy::SecretString;
    use serde_json::{Value, json};
    use sidekicks_contracts::wire::record::JsonRecord;
    use sidekicks_ipc::redaction::CREDENTIAL_REDACTION;

    use super::{
        STEP_LOG_LINE_BYTE_CAP, STEP_LOG_LINE_CAP, StepParams, StepParamsError, test_step_context,
    };
    use crate::expressions::param_strings::{ParamPath, ParamPathSegment};
    use crate::secrets::redaction::RunRedaction;
    use crate::secrets::resolution::ResolvedStepSecret;

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

    /// A context built with a resolved secret over a redaction that does not hold it stores a log
    /// line holding the secret with the secret masked. Mutations: store the line unscrubbed; build
    /// the context without adding its secrets to the redaction.
    #[test]
    fn the_log_masks_the_steps_own_secrets() {
        let secret = ResolvedStepSecret {
            parameter: "token".to_owned(),
            value: SecretString::from("hunter2secretXYZ"),
        };
        let context = test_step_context(
            &JsonRecord::default(),
            vec![secret],
            Arc::new(RunRedaction::new(&[])),
        );
        context.write_log("token hunter2secretXYZ sent");
        assert_eq!(
            context.take_records().log_lines,
            vec![format!("token {CREDENTIAL_REDACTION} sent")]
        );
    }

    /// A step writing past the cap keeps the cap's lines across takes, and its last records end
    /// with a line naming the lines it did not keep; a line past the byte cap is kept cut to it on
    /// a whole character. Mutations: count per take, not per step; keep lines past the cap; drop
    /// the count line or miscount it; keep a long line whole.
    #[test]
    fn a_steps_log_keeps_the_cap_and_names_what_it_dropped() {
        let context = test_step_context(
            &JsonRecord::default(),
            Vec::new(),
            Arc::new(RunRedaction::new(&[])),
        );
        context.write_log(&format!("a{}", "é".repeat(STEP_LOG_LINE_BYTE_CAP)));
        for index in 1..STEP_LOG_LINE_CAP - 1 {
            context.write_log(&format!("line {index}"));
        }
        let kept = context.take_records().log_lines;
        assert_eq!(kept.len(), STEP_LOG_LINE_CAP - 1);
        assert_eq!(
            kept[0],
            format!("a{}", "é".repeat((STEP_LOG_LINE_BYTE_CAP - 1) / 2))
        );
        for index in 0..4 {
            context.write_log(&format!("late {index}"));
        }
        assert_eq!(
            context.finish_records().log_lines,
            vec![
                "late 0".to_owned(),
                "3 more log lines were not kept".to_owned()
            ]
        );
    }
}
