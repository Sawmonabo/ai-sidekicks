//! The ports of the tick loop's test harness that keep what the loop calls: the approval cards
//! and questions it asks, the snapshot points its runs take, and the one order log of both.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use rusqlite::{Connection, params};
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::wire::id::{UuidTextForm, mint_uuid_v7};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;

use crate::engine::ports::{
    ApprovalCardRaiser, FormQuestionRequest, PersonWaitQuestions, PortError, REFUSED_PORT_CALL,
    ReplyQuestionRequest, RunSnapshotPoints, WorkflowApprovalCardRequest,
    WorkflowRunSnapshotPointRequest,
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

/// One call the test's asks took: what it raised or opened, for which step and wait, and the
/// step's row, its status and wait id, as the call read it.
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
}

/// The approval cards and questions of a test, over their own connection to its database: each
/// call is kept with what the step's row reads at the call, and every call fails while told to.
pub(in crate::engine::tick::turns) struct RecordingAsks {
    rows: Mutex<Connection>,
    calls: Mutex<Vec<RecordedAsk>>,
    is_refusing: AtomicBool,
    order: Arc<OrderLog>,
}

impl RecordingAsks {
    /// The asks over `rows`, a connection to the test's database, logging each call in `order`.
    pub(in crate::engine::tick::turns) fn new(rows: Connection, order: Arc<OrderLog>) -> Self {
        Self {
            rows: Mutex::new(rows),
            calls: Mutex::new(Vec::new()),
            is_refusing: AtomicBool::new(false),
            order,
        }
    }

    /// Makes every later call fail, as a card or question that cannot be written.
    pub(in crate::engine::tick::turns) fn refuse_every_call(&self) {
        self.is_refusing.store(true, Ordering::SeqCst);
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
        let (row_status, row_wait_id) = lock(&self.rows)
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
        self.order
            .send_modify(|calls| calls.push(OrderedCall::Ask { kind, wait_id }));
        lock(&self.calls).push(RecordedAsk {
            kind,
            step,
            wait_id,
            row_status,
            row_wait_id,
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

    fn reattach<'call>(
        &'call self,
        _wait_id: &'call UuidTextForm,
    ) -> BoxFuture<'call, Result<(), PortError>> {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }
}

fn fresh_question_id() -> QuestionId {
    QuestionId::try_from(mint_uuid_v7()).expect("a minted id is a UUID")
}

/// The snapshot points of a test, each logged in the order log as it is taken: a capture ends
/// once the test's gate is open, which it is until the test shuts it, and fails while told to.
pub(in crate::engine::tick::turns) struct RecordingSnapshotPoints {
    order: Arc<OrderLog>,
    gate: watch::Sender<bool>,
    is_refusing: AtomicBool,
}

impl RecordingSnapshotPoints {
    /// The points, logging each call in `order`, their gate open.
    pub(in crate::engine::tick::turns) fn new(order: Arc<OrderLog>) -> Self {
        Self {
            order,
            gate: watch::Sender::new(true),
            is_refusing: AtomicBool::new(false),
        }
    }

    /// Opens the gate when `is_open`, ending every capture held at it, or shuts it.
    pub(in crate::engine::tick::turns) fn set_gate(&self, is_open: bool) {
        self.gate.send_replace(is_open);
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
        self.order
            .send_modify(|calls| calls.push(OrderedCall::Point(request)));
        let mut gate = self.gate.subscribe();
        let is_refusing = self.is_refusing.load(Ordering::SeqCst);
        Box::pin(async move {
            let is_open = gate.wait_for(|is_open| *is_open).await.is_ok();
            if is_refusing || !is_open {
                return Err("the test's capture fails".into());
            }
            Ok(())
        })
    }
}
