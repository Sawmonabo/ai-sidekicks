//! An agent step runner for a test, whose runs read the gate place, progress, start and outcome
//! the test sets, and count and can fail each stop and resume.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use futures::future::BoxFuture;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use tokio::sync::watch;

use super::{
    AgentStepOutcome, AgentStepRequest, AgentStepRun, AgentStepRunner, AgentStepStart, PortError,
    REFUSED_PORT_CALL, StepAdmissionOutcome,
};

/// What a [`ScriptedAgentRunner`] shares with every run it answers, which the test sets.
struct ScriptedAgentRunControls {
    /// Where every run stands at the memory gate.
    admission: watch::Sender<Option<StepAdmissionOutcome>>,
    /// How many turn ends and tool calls every run has passed.
    progressed: watch::Sender<u64>,
    /// The level every run starts at, `None` until it starts.
    start: watch::Sender<Option<PermissionLevel>>,
    /// How every run ends, `None` until it ends.
    outcome: watch::Sender<Option<AgentStepOutcome>>,
    /// Woken at each run's `cancel()`; a wake with no waiter is kept for the next.
    canceled: tokio::sync::Notify,
    /// Woken at each run's `resume()`; a wake with no waiter is kept for the next.
    resumed: tokio::sync::Notify,
    /// Whether every run's `cancel()` fails.
    is_stop_failing: AtomicBool,
    /// How many times a run's `resume()` was called.
    resumes: AtomicUsize,
    /// Whether every run's `resume()` fails.
    is_resume_failing: AtomicBool,
    /// What the test reads at each `resume()` call, where it set a read.
    resume_read: std::sync::Mutex<Option<ResumeRead>>,
    /// What each `resume()` call read, in order.
    read_at_resumes: std::sync::Mutex<Vec<String>>,
}

/// A read the test makes at the moment a run's `resume()` is called.
type ResumeRead = Box<dyn Fn() -> String + Send>;

/// An agent step runner for a test: it records each request, holds each creation until the test
/// releases it when built to, and answers runs that read the controls the test sets.
pub(crate) struct ScriptedAgentRunner {
    /// What every run it answers reads.
    controls: Arc<ScriptedAgentRunControls>,
    /// The request each `run` was given, in order.
    requests: std::sync::Mutex<Vec<AgentStepRequest>>,
    /// Woken at each `run`; a wake with no waiter is kept for the next.
    requested: tokio::sync::Notify,
    /// Whether each creation waits for the test's release.
    is_holding_creations: bool,
    /// Lets a held creation go on; a release with no waiter is kept for the next.
    creation_released: tokio::sync::Notify,
}

impl ScriptedAgentRunner {
    /// A runner whose runs start at the gate at `admission`: `None` holds, `Some(Admitted)` admits
    /// at once. Each creation waits for [`Self::release_creation`] when `is_holding_creations`.
    pub(crate) fn new(admission: Option<StepAdmissionOutcome>, is_holding_creations: bool) -> Self {
        Self {
            controls: Arc::new(ScriptedAgentRunControls {
                admission: watch::Sender::new(admission),
                progressed: watch::Sender::new(0),
                start: watch::Sender::new(None),
                outcome: watch::Sender::new(None),
                canceled: tokio::sync::Notify::new(),
                resumed: tokio::sync::Notify::new(),
                is_stop_failing: AtomicBool::new(false),
                resumes: AtomicUsize::new(0),
                is_resume_failing: AtomicBool::new(false),
                resume_read: std::sync::Mutex::new(None),
                read_at_resumes: std::sync::Mutex::new(Vec::new()),
            }),
            requests: std::sync::Mutex::new(Vec::new()),
            requested: tokio::sync::Notify::new(),
            is_holding_creations,
            creation_released: tokio::sync::Notify::new(),
        }
    }

    /// Lets one held creation go on.
    pub(crate) fn release_creation(&self) {
        self.creation_released.notify_one();
    }

    /// The requests made so far, in order.
    pub(crate) fn requests(&self) -> Vec<AgentStepRequest> {
        sidekicks_std::mutex_lock::lock(&self.requests).clone()
    }

    /// Returns once a run was asked for, at once when one was since the last return.
    pub(crate) async fn wait_for_request(&self) {
        self.requested.notified().await;
    }

    /// Fails every run's `cancel()` from now on.
    pub(crate) fn fail_stops(&self) {
        self.controls.is_stop_failing.store(true, Ordering::SeqCst);
    }

    /// Fails every run's `resume()` from now on.
    pub(crate) fn fail_resumes(&self) {
        self.controls
            .is_resume_failing
            .store(true, Ordering::SeqCst);
    }

    /// How many times a run's `resume()` was called.
    pub(crate) fn resumes(&self) -> usize {
        self.controls.resumes.load(Ordering::SeqCst)
    }

    /// Calls `read` at each run's `resume()`, before the call answers, keeping what it read.
    pub(crate) fn read_at_resume(&self, read: impl Fn() -> String + Send + 'static) {
        *sidekicks_std::mutex_lock::lock(&self.controls.resume_read) = Some(Box::new(read));
    }

    /// What each `resume()` call read, in order.
    pub(crate) fn read_at_resumes(&self) -> Vec<String> {
        sidekicks_std::mutex_lock::lock(&self.controls.read_at_resumes).clone()
    }

    /// Admits every run at the gate.
    pub(crate) fn admit(&self) {
        self.controls
            .admission
            .send_replace(Some(StepAdmissionOutcome::Admitted));
    }

    /// Starts every run at `permission_level`.
    pub(crate) fn start(&self, permission_level: PermissionLevel) {
        self.controls.start.send_replace(Some(permission_level));
    }

    /// Counts one more turn end on every run.
    pub(crate) fn progress(&self) {
        self.controls.progressed.send_modify(|count| *count += 1);
    }

    /// Ends every run with `outcome`.
    pub(crate) fn end(&self, outcome: AgentStepOutcome) {
        self.controls.outcome.send_replace(Some(outcome));
    }

    /// Returns once a run's `cancel()` was called, at once when one was since the last return.
    pub(crate) async fn wait_for_cancel(&self) {
        self.controls.canceled.notified().await;
    }

    /// Returns once a run's `resume()` was called, at once when one was since the last return.
    pub(crate) async fn wait_for_resume(&self) {
        self.controls.resumed.notified().await;
    }

    /// A run reading the controls, as each creation answers.
    pub(crate) fn made_run(&self) -> Box<dyn AgentStepRun> {
        Box::new(ScriptedAgentRun {
            controls: Arc::clone(&self.controls),
        })
    }
}

impl AgentStepRunner for ScriptedAgentRunner {
    fn run(
        &self,
        request: AgentStepRequest,
    ) -> BoxFuture<'_, Result<Box<dyn AgentStepRun>, PortError>> {
        Box::pin(async move {
            sidekicks_std::mutex_lock::lock(&self.requests).push(request);
            self.requested.notify_one();
            if self.is_holding_creations {
                self.creation_released.notified().await;
            }
            Ok(self.made_run())
        })
    }

    fn reattach<'call>(
        &'call self,
        _step: &'call WorkflowStepKey,
    ) -> BoxFuture<'call, Result<Box<dyn AgentStepRun>, PortError>> {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }
}

/// A run of a [`ScriptedAgentRunner`], reading the controls the test sets.
struct ScriptedAgentRun {
    /// The runner's controls.
    controls: Arc<ScriptedAgentRunControls>,
}

impl AgentStepRun for ScriptedAgentRun {
    fn admission(&self) -> watch::Receiver<Option<StepAdmissionOutcome>> {
        self.controls.admission.subscribe()
    }

    fn progressed(&self) -> watch::Receiver<u64> {
        self.controls.progressed.subscribe()
    }

    fn started(&self) -> BoxFuture<'_, Result<AgentStepStart, PortError>> {
        let mut start = self.controls.start.subscribe();
        Box::pin(async move {
            let permission_level = (*start.wait_for(Option::is_some).await?)
                .expect("the wait answers once a level is set");
            Ok::<_, PortError>(AgentStepStart { permission_level })
        })
    }

    fn outcome(&self) -> BoxFuture<'_, Result<AgentStepOutcome, PortError>> {
        let mut outcome = self.controls.outcome.subscribe();
        Box::pin(async move {
            let ended = Option::clone(&*outcome.wait_for(Option::is_some).await?)
                .expect("the wait answers once an outcome is set");
            Ok::<_, PortError>(ended)
        })
    }

    fn cancel(&self) -> BoxFuture<'_, Result<(), PortError>> {
        self.controls.canceled.notify_one();
        let is_failing = self.controls.is_stop_failing.load(Ordering::SeqCst);
        Box::pin(async move {
            if is_failing {
                return Err("the run's process did not take the stop".into());
            }
            Ok(())
        })
    }

    /// Counts the call, keeps what the test's read answers at it, and clears the outcome, so the
    /// test ends the resumed run again; the run's place at the gate stays as the test set it.
    fn resume(&self) -> BoxFuture<'_, Result<(), PortError>> {
        self.controls.resumes.fetch_add(1, Ordering::SeqCst);
        if let Some(read) = &*sidekicks_std::mutex_lock::lock(&self.controls.resume_read) {
            let value = read();
            sidekicks_std::mutex_lock::lock(&self.controls.read_at_resumes).push(value);
        }
        if self.controls.is_resume_failing.load(Ordering::SeqCst) {
            return Box::pin(async { Err("the run's provider did not take the turn".into()) });
        }
        self.controls.outcome.send_replace(None);
        self.controls.resumed.notify_one();
        Box::pin(async { Ok(()) })
    }
}
