//! The ports of the tick loop's test harness that keep what the loop calls: the approval cards
//! and questions it asks, the cards it withdraws, the snapshot points its runs take, and the one
//! order log of the asks and the points.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use rusqlite::{Connection, params};
use sidekicks_contracts::git::local::WorkflowRunSnapshotPoint;
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::{UuidTextForm, mint_uuid_v7};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;

use crate::engine::ports::{
    ApprovalCardRaiser, FormQuestionRequest, PersonWaitQuestions, PortError, ReplyQuestionRequest,
    RunSnapshotPoints, WorkflowApprovalCardRequest, WorkflowRunSnapshotPointRequest,
};

/// Every call of the test's asks and snapshot points, in the order the loop made them.
pub(in crate::engine::tick::turns) type OrderLog = watch::Sender<Vec<OrderedCall>>;

/// One call the order log keeps.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::engine::tick::turns) enum OrderedCall {
    /// A snapshot point taken, as its request names it.
    Point(WorkflowRunSnapshotPointRequest),
    /// A card raised or a question opened.
    Ask {
        /// `approval`, `form` or `reply`.
        kind: &'static str,
        /// The wait the answer settles.
        wait_id: UuidTextForm,
    },
}

/// One call the test's asks took: what it raised or opened, for which step and wait, the step's
/// row, its status and wait id, and the status of each step of its run, as the call read them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::engine::tick::turns) struct RecordedAsk {
    /// `approval`, `form` or `reply`.
    pub(in crate::engine::tick::turns) kind: &'static str,
    /// The step that waits.
    pub(in crate::engine::tick::turns) step: WorkflowStepKey,
    /// The wait the answer settles.
    pub(in crate::engine::tick::turns) wait_id: UuidTextForm,
    /// The step row's status at the call, `None` with no row.
    pub(in crate::engine::tick::turns) row_status: Option<String>,
    /// The step row's wait id at the call.
    pub(in crate::engine::tick::turns) row_wait_id: Option<String>,
    /// Each step row of the step's run at the call, its node id and status, in execution order.
    pub(in crate::engine::tick::turns) run_statuses: Vec<(String, String)>,
}

/// A card the loop withdrew: its wait, and whether a step row still held the wait at the call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::engine::tick::turns) struct WithdrawnCard {
    /// The wait the card answered.
    pub(in crate::engine::tick::turns) wait_id: UuidTextForm,
    /// Whether a step row held the wait when the withdraw was called.
    pub(in crate::engine::tick::turns) is_wait_stored: bool,
}

/// The approval cards and questions of a test, over their own connection to its database: each
/// call is kept with what the step's row reads at the call, and every ask fails while told to.
pub(in crate::engine::tick::turns) struct RecordingAsks {
    rows: Mutex<Connection>,
    calls: Mutex<Vec<RecordedAsk>>,
    withdrawn: Mutex<Vec<WithdrawnCard>>,
    is_refusing: AtomicBool,
    order: Arc<OrderLog>,
}

impl RecordingAsks {
    /// The asks over `rows`, a connection to the test's database, logging each call in `order`.
    pub(in crate::engine::tick::turns) fn new(rows: Connection, order: Arc<OrderLog>) -> Self {
        Self {
            rows: Mutex::new(rows),
            calls: Mutex::new(Vec::new()),
            withdrawn: Mutex::new(Vec::new()),
            is_refusing: AtomicBool::new(false),
            order,
        }
    }

    /// Every card withdrawn, in order.
    pub(in crate::engine::tick::turns) fn withdrawn(&self) -> Vec<WithdrawnCard> {
        lock(&self.withdrawn).clone()
    }

    /// Makes every later call fail, as a card or question that cannot be written.
    pub(in crate::engine::tick::turns) fn refuse_every_call(&self) {
        self.is_refusing.store(true, Ordering::SeqCst);
    }

    /// Forgets every call taken, so no question asked so far reads as open, as a stop that lost
    /// its open questions leaves them.
    pub(in crate::engine::tick::turns) fn forget_questions(&self) {
        lock(&self.calls).clear();
    }

    /// Every call taken, in order.
    pub(in crate::engine::tick::turns) fn calls(&self) -> Vec<RecordedAsk> {
        lock(&self.calls).clone()
    }

    // Keeps the call of `kind` for `step` under `wait_id`, failing it while told to.
    fn take(
        &self,
        kind: &'static str,
        step: WorkflowStepKey,
        wait_id: UuidTextForm,
    ) -> Result<(), PortError> {
        let rows = lock(&self.rows);
        let (row_status, row_wait_id) = rows
            .query_row(
                "SELECT status, wait_id FROM workflow_steps \
                 WHERE workflow_run_id = ?1 AND execution_index = ?2",
                params![
                    step.workflow_run_id.text().as_str(),
                    i64::try_from(step.execution_index.get()).expect("a test's index is small")
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_or((None, None), |(status, wait_id)| (Some(status), wait_id));
        let run_statuses = rows
            .prepare(
                "SELECT node_id, status FROM workflow_steps \
                 WHERE workflow_run_id = ?1 ORDER BY execution_index",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([step.workflow_run_id.text().as_str()], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()
            })
            .expect("the run's step rows read");
        drop(rows);
        self.order
            .send_modify(|calls| calls.push(OrderedCall::Ask { kind, wait_id }));
        lock(&self.calls).push(RecordedAsk {
            kind,
            step,
            wait_id,
            row_status,
            row_wait_id,
            run_statuses,
        });
        if self.is_refusing.load(Ordering::SeqCst) {
            return Err("the test's asks refuse every call".into());
        }
        Ok(())
    }
}

impl ApprovalCardRaiser for RecordingAsks {
    fn raise(&self, request: WorkflowApprovalCardRequest) -> BoxFuture<'_, Result<(), PortError>> {
        let step = request.step.expect("a step's approval names its step");
        let taken = self.take("approval", step, request.wait_id);
        Box::pin(async move { taken })
    }

    fn withdraw(
        &self,
        _session_id: SessionId,
        wait_ids: Vec<UuidTextForm>,
    ) -> BoxFuture<'_, Result<Vec<Result<(), PortError>>, PortError>> {
        let rows = lock(&self.rows);
        let mut withdrawn = lock(&self.withdrawn);
        for &wait_id in &wait_ids {
            let is_wait_stored = rows
                .query_row(
                    "SELECT EXISTS (SELECT 1 FROM workflow_steps WHERE wait_id = ?1)",
                    [wait_id.text().as_str()],
                    |row| row.get(0),
                )
                .expect("the step rows read");
            withdrawn.push(WithdrawnCard {
                wait_id,
                is_wait_stored,
            });
        }
        let answers = wait_ids.iter().map(|_| Ok(())).collect();
        Box::pin(async { Ok(answers) })
    }
}

impl PersonWaitQuestions for RecordingAsks {
    fn open_form(
        &self,
        request: FormQuestionRequest,
    ) -> BoxFuture<'_, Result<QuestionId, PortError>> {
        let taken = self.take("form", request.step, request.wait_id);
        Box::pin(async move { taken.map(|()| fresh_question_id()) })
    }

    fn open_reply(
        &self,
        request: ReplyQuestionRequest,
    ) -> BoxFuture<'_, Result<QuestionId, PortError>> {
        let taken = self.take("reply", request.step, request.wait_id);
        Box::pin(async move { taken.map(|()| fresh_question_id()) })
    }

    // A question asked earlier in the test is still open; any other is not.
    fn reattach(
        &self,
        _session_id: SessionId,
        wait_id: UuidTextForm,
    ) -> BoxFuture<'_, Result<Option<QuestionId>, PortError>> {
        let is_asked = lock(&self.calls).iter().any(|call| call.wait_id == wait_id);
        Box::pin(async move { Ok(is_asked.then(fresh_question_id)) })
    }
}

fn fresh_question_id() -> QuestionId {
    QuestionId::try_from(mint_uuid_v7()).expect("a minted id is a UUID")
}

/// The snapshot points of a test, each logged in the order log as it is taken: a capture ends
/// once the test's gate is open, which it is until the test shuts it, or once the test ends that
/// pause's capture alone, and fails while told to.
pub(in crate::engine::tick::turns) struct RecordingSnapshotPoints {
    order: Arc<OrderLog>,
    gate: watch::Sender<CaptureGate>,
    is_refusing: AtomicBool,
}

/// Whether every capture may end, and the pause numbers whose capture may end while it is shut.
struct CaptureGate {
    is_open: bool,
    ended_pauses: Vec<u64>,
}

impl RecordingSnapshotPoints {
    /// The points, logging each call in `order`, their gate open.
    pub(in crate::engine::tick::turns) fn new(order: Arc<OrderLog>) -> Self {
        Self {
            order,
            gate: watch::Sender::new(CaptureGate {
                is_open: true,
                ended_pauses: Vec::new(),
            }),
            is_refusing: AtomicBool::new(false),
        }
    }

    /// Opens the gate when `is_open`, ending every capture held at it, or shuts it.
    pub(in crate::engine::tick::turns) fn set_gate(&self, is_open: bool) {
        self.gate.send_modify(|gate| gate.is_open = is_open);
    }

    /// Ends the capture of pause `pause_number` of the run's execution, held at the shut gate.
    pub(in crate::engine::tick::turns) fn end_capture(&self, pause_number: u64) {
        self.gate
            .send_modify(|gate| gate.ended_pauses.push(pause_number));
    }

    /// Makes every later capture fail, as a checkout that cannot be recorded.
    pub(in crate::engine::tick::turns) fn refuse_every_capture(&self) {
        self.is_refusing.store(true, Ordering::SeqCst);
    }
}

impl RunSnapshotPoints for RecordingSnapshotPoints {
    fn take(
        &self,
        request: WorkflowRunSnapshotPointRequest,
    ) -> BoxFuture<'static, Result<(), PortError>> {
        let pause_number = match &request.point {
            WorkflowRunSnapshotPoint::Pause { pause_number, .. } => Some(pause_number.0.get()),
            WorkflowRunSnapshotPoint::Start { .. } | WorkflowRunSnapshotPoint::End { .. } => None,
        };
        self.order
            .send_modify(|calls| calls.push(OrderedCall::Point(request)));
        let mut gate = self.gate.subscribe();
        let is_refusing = self.is_refusing.load(Ordering::SeqCst);
        Box::pin(async move {
            let is_open = gate
                .wait_for(|gate| {
                    gate.is_open
                        || pause_number.is_some_and(|number| gate.ended_pauses.contains(&number))
                })
                .await
                .is_ok();
            if is_refusing || !is_open {
                return Err("the test's capture fails".into());
            }
            Ok(())
        })
    }
}
