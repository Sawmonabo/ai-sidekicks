//! The end of a run that never left `queued`: stopped once the person removed every message it
//! waited for, or failed with every message not delivered, the messages' outcomes in the run's own
//! write; and a single message's move to not delivered.

use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::{RunFailureCategory, StopTrigger};
use sidekicks_contracts::run::failure_cause::{DaemonFailureOrigin, RunFailureCause};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemNotDeliveredReason;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_session::queue_store::{QueueItemOutcome, QueueItemRecord};
use sidekicks_session::run::state_change::RunStateChange;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::statement::WriteStatement;

use super::QueueAdmission;
use crate::delivery::run_end::outcome_companions;
use crate::error::QueueError;
use crate::recorder::QueueRecordError;

impl QueueAdmission {
    /// Ends the queued run `run_id` `stopped`, quietly, once the person removed every message it
    /// was queued for, with `outcomes` and `statements` in the same write. Called under `hold`;
    /// fails with the write's refusal when the run or one of the messages has left `queued`.
    pub(crate) async fn stop_emptied_run(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        outcomes: Vec<(QueueItemRecord, QueueItemOutcome)>,
        statements: Vec<WriteStatement>,
    ) -> Result<(), QueueError> {
        let stopped = RunStateEntry::Stopped {
            intended_close: None,
            trigger: Some(StopTrigger::MessagesRemoved),
        };
        let end = RunStateChange::new(run_id, stopped);
        self.end_queued_run(hold, end, outcomes, statements).await
    }

    /// Ends the queued run `run_id` failed in setup, `detail` saying why, with every message
    /// waiting for it not delivered for `reason` in the same write. Called under `hold`; fails as
    /// the read or the write fails.
    pub(super) async fn end_waiting_undelivered(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        reason: QueueItemNotDeliveredReason,
        detail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    ) -> Result<(), QueueError> {
        let outcomes = self
            .read_waiting(run_id)
            .await?
            .into_iter()
            .map(|item| {
                let outcome = QueueItemOutcome::NotDelivered {
                    reason: reason.clone(),
                };
                (item, outcome)
            })
            .collect();
        let failed = RunStateEntry::Failed {
            intended_close: None,
            failure_cause: Some(RunFailureCause::SetupFailed {
                origin: DaemonFailureOrigin::Value,
                code: None,
                message: detail,
            }),
            provider_failure_detail: None,
            process_exit: None,
        };
        let end = RunStateChange {
            failure_category: Some(RunFailureCategory::SetupFailure),
            ..RunStateChange::new(run_id, failed)
        };
        self.end_queued_run(hold, end, outcomes, Vec::new()).await
    }

    /// Moves `item` to not delivered for `reason`, in a write of its own. Fails as the write
    /// fails.
    pub(super) async fn record_not_delivered(
        &self,
        item: &QueueItemRecord,
        reason: QueueItemNotDeliveredReason,
    ) -> Result<(), QueueError> {
        self.deps
            .recorder
            .record_outcome(
                item,
                QueueItemOutcome::NotDelivered { reason },
                &WireInstant::now(),
            )
            .await?;
        Ok(())
    }

    // Writes `end`, expected from `queued`, with each of `outcomes` and then `statements` in the
    // same write, then releases the run's place and raises the messages' queues.
    async fn end_queued_run(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        mut end: RunStateChange,
        outcomes: Vec<(QueueItemRecord, QueueItemOutcome)>,
        statements: Vec<WriteStatement>,
    ) -> Result<(), QueueError> {
        end.expected_state = Some(RunState::Queued);
        let run_id = end.run_id;
        let mut companions = outcome_companions(
            outcomes.iter().map(|(item, outcome)| (item, outcome)),
            &WireInstant::now(),
        )
        .map_err(QueueRecordError::from)?;
        companions.statements.extend(statements);
        self.deps.engine.transition(end, companions).await?;
        self.release(run_id);
        let items: Vec<QueueItemRecord> = outcomes.into_iter().map(|(item, _)| item).collect();
        self.deps.recorder.raise_committed(&items, false);
        Ok(())
    }
}
