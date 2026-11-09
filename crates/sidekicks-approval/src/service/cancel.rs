//! The cancels of pending asks: a run's end, a session's close and a provider's take-back each
//! settle the asks they leave open with one `approval.canceled` apiece, and every wait on a
//! canceled run's card hears it; a workflow wait's card is canceled only with its wait.

use sidekicks_contracts::approval::events::ApprovalCanceledPayload;
use sidekicks_contracts::approval::holder::ApprovalHolder;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use sidekicks_store::events::session::appender::{SessionEventDraft, SessionEventLinkage};

use super::{
    ApprovalService, ApprovalServiceError, PENDING_GUARD_INDEX, RaisedCardKey,
    RaisedRequestSettlement,
};
use crate::store::{ApprovalSettlement, StoredApprovalRequest, settle_pending_statement};

impl ApprovalService {
    /// Cancels every ask the run still holds pending, one `approval.canceled` each and no
    /// resolution row, appending under `hold` where the caller already holds the session's
    /// appends; an ask answered meanwhile keeps its answer. A failed cancel does not stop the
    /// rest, and whatever the cancels returned, every wait on a card of the run settles canceled,
    /// a card whose row is gone among them. Fails with every cancel's failure once all have run.
    pub async fn cancel_pending_for_run(
        &self,
        run_id: RunId,
        hold: Option<&SessionAppendHold>,
    ) -> Result<(), SettleFailures<ApprovalServiceError>> {
        let canceled = match self
            .read(move |reader| reader.list_pending_for_run(&run_id))
            .await
        {
            Ok(pending) => self.cancel_all(&pending, hold).await,
            Err(failure) => Err(SettleFailures::One(failure)),
        };
        self.raised_cards.settle_where(
            |key| key.run_id == run_id,
            RaisedRequestSettlement::Canceled,
        );
        canceled
    }

    /// Cancels every ask the session's runs still hold pending, as
    /// [`ApprovalService::cancel_pending_for_run`] does for one run; its runs are not moved, since
    /// every provider leg of a closed session ended before its close. A workflow wait's card is
    /// left to its wait, which closes it with its answer, its withdraw or the restart settle.
    pub(crate) async fn cancel_pending_for_session(
        &self,
        session_id: SessionId,
    ) -> Result<(), SettleFailures<ApprovalServiceError>> {
        let pending = self
            .read(move |reader| reader.list_pending_for_session(&session_id))
            .await
            .map_err(SettleFailures::One)?;
        self.cancel_all(&pending, None).await
    }

    /// Cancels every pending card of the session whose workflow wait no one holds any more, its
    /// workflow run finished or gone, or, for a step's card, no step waiting on its wait, as a
    /// restart settles what a stop between a wait's end and its card's withdraw left. A failed
    /// cancel does not stop the rest; fails with every failure once all have run.
    pub async fn cancel_unheld_wait_asks(
        &self,
        session_id: SessionId,
    ) -> Result<(), SettleFailures<ApprovalServiceError>> {
        let unheld = self
            .read(move |reader| reader.list_unheld_wait_requests(&session_id))
            .await
            .map_err(SettleFailures::One)?;
        self.cancel_all(&unheld, None).await
    }

    async fn cancel_all(
        &self,
        pending: &[StoredApprovalRequest],
        hold: Option<&SessionAppendHold>,
    ) -> Result<(), SettleFailures<ApprovalServiceError>> {
        let mut outcomes = Vec::with_capacity(pending.len());
        for request in pending {
            outcomes.push(self.cancel(request, hold).await.map(drop));
        }
        settle_all(outcomes, "canceling pending approval requests").map(drop)
    }

    /// Cancels one pending ask with one `approval.canceled`, under `hold` where the caller holds
    /// the session's appends, and answers whether this cancel settled it; an answer that landed
    /// first keeps it. Fails when the cancel was not kept.
    pub(crate) async fn cancel(
        &self,
        request: &StoredApprovalRequest,
        hold: Option<&SessionAppendHold>,
    ) -> Result<bool, ApprovalServiceError> {
        let canceled_at = WireInstant::now();
        let payload = ApprovalCanceledPayload {
            session_id: request.session_id,
            holder: request.holder.clone(),
            approval_request_id: request.approval_request_id,
            category: request.category,
            scope: request.scope.clone(),
        };
        let draft = SessionEventDraft::new(payload, SessionEvent::ApprovalCanceled)?;
        let linkage = SessionEventLinkage {
            occurred_at: Some(canceled_at.clone()),
            transactional_prelude: vec![settle_pending_statement(
                &request.approval_request_id,
                ApprovalSettlement::Canceled,
                &canceled_at,
            )],
            ..SessionEventLinkage::default()
        };
        let appended = match hold {
            Some(hold) => self.events.append_held(hold, draft, linkage).await,
            None => self.events.append(draft, linkage).await,
        };
        match appended {
            Ok(_receipt) => {
                // Only a run's card is waited on in process; a wait's card closes with its wait.
                if let ApprovalHolder::Run { run_id } = request.holder {
                    self.raised_cards.settle_all(
                        &RaisedCardKey {
                            run_id,
                            approval_request_id: request.approval_request_id,
                        },
                        RaisedRequestSettlement::Canceled,
                    );
                }
                Ok(true)
            }
            Err(failure) if failure.refused_statement_index() == Some(PENDING_GUARD_INDEX) => {
                Ok(false)
            }
            Err(failure) => Err(ApprovalServiceError::Cancel(failure)),
        }
    }
}
