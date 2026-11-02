//! The service's one expression thread. Every param template a workflow step reads is evaluated
//! here, per item, never on a thread that serves sessions, since one item can hold a thread for
//! hundreds of milliseconds. A step's data crosses to the thread once, when the step opens; each
//! item's evaluation then crosses only the item's index and its answer.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick's dispatch, which evaluates each step's params on this thread"
    )
)]

use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

use jsonata_core::ast::AstNode;
use jsonata_core::evaluator::{CancelToken, EvaluatorOptions};
use jsonata_core::functions::string::string;
use jsonata_core::parser::parse;
use jsonata_core::value::JValue;
use serde_json::Value;
use sidekicks_contracts::workflow::definition::expression_template::{
    ExpressionTemplate, TemplatePart, TemplateShape,
};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::expressions::bindings::{ExpressionBindings, ExpressionError, StepBindings};

/// The thread's name, as a process listing shows it.
const THREAD_NAME: &str = "workflow-expressions";

/// The most jobs that wait for the thread; one more waits for room on the channel, so the queue
/// never holds more and a job's worst wait is the jobs ahead of it.
const JOB_CAPACITY: usize = 256;

/// The deepest an evaluation nests, in evaluator levels, past which it fails with `D1011`: about
/// 3,300 nested non-tail calls and about 30 MB of stack segments at its peak, a third of the
/// 30,000-level backstop `jsonata-core` keeps when none is set.
const MAX_STACK_DEPTH: usize = 10_000;

/// The longest sequence a query builds (a map, a filter, a wildcard, a range), past which the
/// evaluation fails with `D2015`; an array literal or an input array is not counted.
const MAX_SEQUENCE_LENGTH: usize = 1_000_000;

/// The steps open on the thread, by the id their handle holds.
type OpenSteps = HashMap<u64, StepExpressions>;

/// Work for the thread, run over the steps open on it.
type Job = Box<dyn FnOnce(&mut OpenSteps) + Send>;

/// The way to the service's one expression thread; clones share the thread. No evaluation has a
/// time limit of its own: a long one is ended only by its step's cancel.
#[derive(Clone)]
pub(crate) struct ExpressionEvaluator {
    /// The bounded channel of jobs the thread runs in order.
    jobs: mpsc::Sender<Job>,
    /// The steps whose close found the channel full, dropped before the thread's next job.
    closed_steps: std::sync::mpsc::Sender<u64>,
    /// The id the next step opened gets.
    next_step: Arc<AtomicU64>,
}

impl ExpressionEvaluator {
    /// Starts the thread; the service makes one. Fails when the thread cannot be made.
    pub(crate) fn start() -> io::Result<Self> {
        let (jobs, mut waiting_jobs) = mpsc::channel::<Job>(JOB_CAPACITY);
        let (closed_steps, closed) = std::sync::mpsc::channel();
        thread::Builder::new()
            .name(THREAD_NAME.to_owned())
            .spawn(move || {
                let mut open_steps = OpenSteps::new();
                while let Some(job) = waiting_jobs.blocking_recv() {
                    for step in closed.try_iter() {
                        open_steps.remove(&step);
                    }
                    job(&mut open_steps);
                }
            })?;
        Ok(Self {
            jobs,
            closed_steps,
            next_step: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Opens a step's expressions on the thread: its bindings, built once, and `templates`, its
    /// params' `=` templates, each part parsed once. The step's evaluations end
    /// [`ExpressionError::Canceled`] once `step_cancel` is canceled. Must be called inside a tokio
    /// runtime, and waits for room when the channel is full. Fails with
    /// [`ExpressionError::TemplateUnparsable`] for a part the parser refuses, and
    /// [`ExpressionError::EvaluatorStopped`] when the thread stopped.
    pub(crate) async fn open_step(
        &self,
        bindings: ExpressionBindings,
        templates: Vec<ParamTemplate>,
        step_cancel: &CancellationToken,
    ) -> Result<StepExpressionsHandle, ExpressionError> {
        let id = self.next_step.fetch_add(1, Ordering::Relaxed);
        let cancel = CancelToken::new();
        let cancel_link = tokio::spawn({
            let step_cancel = step_cancel.clone();
            let cancel = cancel.clone();
            async move {
                step_cancel.cancelled().await;
                cancel.cancel();
            }
        });
        // Made before the job is sent, so a caller that stops waiting still closes the step.
        let handle = StepExpressionsHandle {
            evaluator: self.clone(),
            id,
            cancel_link,
        };
        let (answer, answered) = oneshot::channel();
        self.send(Box::new(move |open_steps: &mut OpenSteps| {
            // A caller that stopped waiting closed the step with its handle.
            if answer.is_closed() {
                return;
            }
            let opened = StepExpressions::new(bindings, &templates, cancel).map(|step| {
                open_steps.insert(id, step);
            });
            if answer.send(opened).is_err() {
                tracing::trace!(
                    "a step's opener stopped waiting; its handle's close drops the step"
                );
            }
        }))
        .await;
        answered.await??;
        Ok(handle)
    }

    /// Queues `job` once the channel has room, waiting on the channel's own reservation. A stopped
    /// thread drops the job, and its answer with it, which the caller reads as
    /// [`ExpressionError::EvaluatorStopped`].
    async fn send(&self, job: Job) {
        if let Ok(permit) = self.jobs.reserve().await {
            permit.send(job);
        }
    }
}

/// A step open on the expression thread; dropping it closes the step there and frees its data.
pub(crate) struct StepExpressionsHandle {
    /// The thread the step is open on.
    evaluator: ExpressionEvaluator,
    /// The step's id on the thread.
    id: u64,
    /// The task that cancels the evaluations once the step is canceled.
    cancel_link: JoinHandle<()>,
}

impl StepExpressionsHandle {
    /// Each of the step's templates evaluated for input item `item_index`, in the order the step
    /// opened with. The job is queued once the channel has room; the future borrows the handle,
    /// so the step stays open while it waits. Fails as [`StepExpressions::evaluate_item`] does.
    pub(crate) async fn evaluate_item(
        &self,
        item_index: usize,
    ) -> Result<Vec<Value>, ExpressionError> {
        let id = self.id;
        let (answer, answered) = oneshot::channel();
        self.evaluator
            .send(Box::new(move |open_steps: &mut OpenSteps| {
                // A caller that stopped waiting needs no value; only such a caller's step can have
                // been closed ahead of its job.
                if answer.is_closed() {
                    return;
                }
                if let Some(step) = open_steps.get(&id)
                    && answer.send(step.evaluate_item(item_index)).is_err()
                {
                    tracing::trace!("an evaluation's caller stopped waiting before its value");
                }
            }))
            .await;
        answered.await?
    }
}

impl Drop for StepExpressionsHandle {
    fn drop(&mut self) {
        self.cancel_link.abort();
        let id = self.id;
        match self
            .evaluator
            .jobs
            .try_send(Box::new(move |open_steps: &mut OpenSteps| {
                open_steps.remove(&id);
            })) {
            // A stopped thread holds no step.
            Ok(()) | Err(TrySendError::Closed(_)) => {}
            // A full channel runs a job soon, and the thread drops the step before it.
            Err(TrySendError::Full(_)) => {
                if self.evaluator.closed_steps.send(id).is_err() {
                    tracing::trace!("the expression thread had stopped, holding no step");
                }
            }
        }
    }
}

/// A param's `=` template, owned so it crosses to the thread: literal text never does.
pub(crate) struct ParamTemplate {
    /// Whether the value is the one expression's or the parts joined.
    shape: TemplateShape,
    /// The parts in text order.
    parts: Vec<OwnedTemplatePart>,
}

impl From<&ExpressionTemplate<'_>> for ParamTemplate {
    fn from(template: &ExpressionTemplate<'_>) -> Self {
        Self {
            shape: template.shape(),
            parts: template
                .parts()
                .iter()
                .map(|part| match part {
                    TemplatePart::Text(text) => OwnedTemplatePart::Text((*text).to_owned()),
                    TemplatePart::Expression(text) => {
                        OwnedTemplatePart::Expression((*text).to_owned())
                    }
                })
                .collect(),
        }
    }
}

/// One piece of a [`ParamTemplate`].
enum OwnedTemplatePart {
    /// Literal text between parts.
    Text(String),
    /// An expression's text.
    Expression(String),
}

/// A param template on the thread, its expressions parsed.
struct ParsedTemplate {
    /// Whether the value is the one expression's or the parts joined.
    shape: TemplateShape,
    /// The parts in text order.
    parts: Vec<ParsedPart>,
}

/// One piece of a [`ParsedTemplate`].
enum ParsedPart {
    /// Literal text between parts.
    Text(String),
    /// A parsed expression.
    Expression(AstNode),
}

/// A step's expressions on the thread: its bindings, its templates parsed once, and the one set
/// of options and cancel token every evaluation of the step runs under.
struct StepExpressions {
    /// What the step's expressions read.
    bindings: StepBindings,
    /// The step's templates.
    templates: Vec<ParsedTemplate>,
    /// The options each evaluation's evaluator is built with.
    options: EvaluatorOptions,
    /// The step's cancel, which the options carry.
    cancel: CancelToken,
}

impl StepExpressions {
    /// The step's expressions, its bindings built and each template part parsed. An evaluator
    /// built with a canceled token fails every evaluation, which a canceled step wants. Fails with
    /// [`ExpressionError::TemplateUnparsable`] for a part the parser refuses.
    fn new(
        bindings: ExpressionBindings,
        templates: &[ParamTemplate],
        cancel: CancelToken,
    ) -> Result<Self, ExpressionError> {
        let templates = templates
            .iter()
            .map(|template| {
                let parts = template
                    .parts
                    .iter()
                    .map(|part| match part {
                        OwnedTemplatePart::Text(text) => Ok(ParsedPart::Text(text.clone())),
                        OwnedTemplatePart::Expression(text) => parse(text)
                            .map(ParsedPart::Expression)
                            .map_err(|error| ExpressionError::TemplateUnparsable {
                                part: text.clone(),
                                error,
                            }),
                    })
                    .collect::<Result<_, _>>()?;
                Ok(ParsedTemplate {
                    shape: template.shape,
                    parts,
                })
            })
            .collect::<Result<_, ExpressionError>>()?;
        Ok(Self {
            bindings: StepBindings::new(bindings),
            templates,
            options: EvaluatorOptions {
                cancel: Some(cancel.clone()),
                max_stack_depth: Some(MAX_STACK_DEPTH),
                max_sequence_length: Some(MAX_SEQUENCE_LENGTH),
                ..Default::default()
            },
            cancel,
        })
    }

    /// Each template's value for input item `item_index`. Fails with
    /// [`ExpressionError::Canceled`] once the step is canceled, and as [`StepBindings::evaluate`]
    /// fails otherwise.
    fn evaluate_item(&self, item_index: usize) -> Result<Vec<Value>, ExpressionError> {
        self.templates
            .iter()
            .map(|template| self.evaluate_template(template, item_index))
            .collect()
    }

    /// `template`'s value: a whole template keeps its expression's JSON type, an undefined value
    /// reading as null; a joined one is a string of its parts, each value as `$string` writes it
    /// and an undefined one as nothing, as the `&` operator joins.
    fn evaluate_template(
        &self,
        template: &ParsedTemplate,
        item_index: usize,
    ) -> Result<Value, ExpressionError> {
        if template.shape == TemplateShape::Whole
            && let [ParsedPart::Expression(expression)] = template.parts.as_slice()
        {
            return Ok(Value::from(&self.evaluate_part(expression, item_index)?));
        }
        let mut joined = String::new();
        for part in &template.parts {
            match part {
                ParsedPart::Text(text) => joined.push_str(text),
                ParsedPart::Expression(expression) => {
                    let value = self.evaluate_part(expression, item_index)?;
                    if let JValue::String(text) = string(&value, None)
                        .map_err(|error| ExpressionError::Evaluation(error.into()))?
                    {
                        joined.push_str(&text);
                    }
                }
            }
        }
        Ok(Value::String(joined))
    }

    /// `expression`'s value for input item `item_index`. A built-in call over a large input
    /// finishes before it sees the cancel, so the step's token is read after every call too.
    fn evaluate_part(
        &self,
        expression: &AstNode,
        item_index: usize,
    ) -> Result<JValue, ExpressionError> {
        let value = self
            .bindings
            .evaluate(expression, item_index, self.options.clone());
        if self.cancel.is_cancelled() {
            return Err(ExpressionError::Canceled);
        }
        value
    }
}

#[cfg(test)]
mod tests;
