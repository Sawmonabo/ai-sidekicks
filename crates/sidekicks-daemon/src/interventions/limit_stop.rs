//! The daemon's own interrupt of a run the engine stopped at a limit, carried by the one path a
//! person's takes. Its row is written and accepted at once, since a limit's interrupt is never
//! refused or outdated, and a second interrupt of one limit is refused while one is pending. The
//! hand runs on its own task, which holds the run's interrupt lock and records the outcome
//! however late it comes; the engine's stop waits on it for a bounded time. A hand the provider
//! got with no answer back leaves its row pending and the stop's cut kept, for the run's end to
//! settle: applied when the run ended `interrupted`, else expired with the limit still owed.

use std::pin::Pin;
use std::time::Duration;

use futures::future::BoxFuture;
use sidekicks_contracts::run::events::{DaemonInterventionActor, InterventionActor};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    InterruptInterventionRecord, InterventionState, InterventionType, LimitInterruptRecord,
    RunLimit,
};
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::oneshot;
use tracing::Instrument as _;

use crate::bounded_wait::wait_within;
use crate::interventions::interrupt_queue::InterruptCause;
use crate::interventions::service::errors::DispatchError;
use crate::interventions::service::reached_state::{ReachedState, draft};
use crate::interventions::service::{
    InterventionService, InterventionTarget, RecordedFailure, RowMove, RunEndOfVerdict, Verdict,
    mint_intervention_id,
};
use crate::interventions::store::{
    InterventionTransition, RequestedIntervention, insert_requested_intervention_statement,
    move_intervention_statement, no_pending_limit_interrupt_statement,
};
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::run_control::{InterruptPayload, InterruptPendingChoice};
use crate::session::run::engine::{InterruptRoute, RunEngineError};
use crate::session::run::limit_interrupter::{HandedCut, LimitInterruptFailure, LimitInterrupter};
use crate::session::run::read::safe_run_version;
use crate::session::run::state_change::refused_statement_index;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// How long the engine's stop waits on a limit's hand before it answers with the row pending.
const LIMIT_HAND_BOUND: Duration = Duration::from_secs(5);

// The pending guard is the first statement of the write that records a limit's interrupt.
const PENDING_GUARD_INDEX: usize = 0;

/// A second interrupt of one limit of a run while the first is still pending.
#[derive(Debug, thiserror::Error)]
#[error(
    "an interrupt of run {run_id} at its {} limit is already pending",
    <&'static str>::from(*.limit)
)]
struct LimitInterruptPending {
    run_id: RunId,
    limit: RunLimit,
}

/// The hand's task ended without an answer, its runtime shutting down.
#[derive(Debug, thiserror::Error)]
#[error("the hand of run {run_id}'s interrupt at a limit ended without an answer")]
struct HandCanceled {
    run_id: RunId,
}

/// The run's end or a turn's end settled the limit's interrupt unapplied while it was carried out.
#[derive(Debug, thiserror::Error)]
#[error("run {run_id}'s interrupt at a limit expired while it was carried out")]
struct LimitInterruptExpired {
    run_id: RunId,
}

/// The hand has not answered within its bound; it goes on and records its outcome.
#[derive(Debug, thiserror::Error)]
#[error("the hand of run {run_id}'s interrupt at a limit is still running past its bound")]
struct HandPastBound {
    run_id: RunId,
}

impl LimitInterrupter for InterventionService {
    fn interrupt_for_limit(
        &self,
        run_id: RunId,
        limit: RunLimit,
        cut: Option<HandedCut>,
    ) -> BoxFuture<'_, Result<(), LimitInterruptFailure>> {
        let service = self.clone();
        Box::pin(async move {
            let (answer_sender, mut answer) = oneshot::channel();
            let hand = tokio::spawn(
                async move {
                    // The hold lasts until the outcome is recorded, a late one included.
                    let _hold = service.interrupt_lock.acquire(run_id).await;
                    let cut_turn = cut.map(|cut| cut.turn_number);
                    let handed = service.hand_limit_interrupt(run_id, limit, cut_turn).await;
                    // A failed send is an answer past the bound, which the stop no longer awaits.
                    if let Err(late) = answer_sender.send(handed) {
                        service.record_late_hand(run_id, limit, cut, late).await;
                    }
                }
                .instrument(tracing::Span::current()),
            );
            if let Some(received) = wait_within(Pin::new(&mut answer), LIMIT_HAND_BOUND, None).await
            {
                return match received {
                    Ok(handed) => handed,
                    Err(_closed) => Err(ended_without_answer(run_id, hand).await),
                };
            }
            // Closing first makes the hand's send fail from here on, so an answer either lands
            // now or is recorded late by the hand itself.
            answer.close();
            match answer.try_recv() {
                Ok(handed) => handed,
                // Once closed, the channel reads closed with no answer whether the hand goes on or
                // has ended, so only a finished hand is awaited.
                Err(_) if hand.is_finished() => Err(ended_without_answer(run_id, hand).await),
                Err(_) => Err(LimitInterruptFailure::RowPending {
                    source: Box::new(HandPastBound { run_id }),
                }),
            }
        })
    }
}

// The failure of a hand that gave the stop no answer: a hand that panics within the bound is
// re-raised in the stop, while one that panics past it reaches only the panic hook; a task
// canceled by the runtime's shutdown leaves whatever row it wrote pending, and a hand that ran to
// its end after the stop's close has recorded its outcome late.
async fn ended_without_answer(
    run_id: RunId,
    hand: tokio::task::JoinHandle<()>,
) -> LimitInterruptFailure {
    match hand.await {
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(_) => LimitInterruptFailure::RowPending {
            source: Box::new(HandCanceled { run_id }),
        },
        Ok(()) => LimitInterruptFailure::RowPending {
            source: Box::new(HandPastBound { run_id }),
        },
    }
}

impl InterventionService {
    // Records and accepts the interrupt of `run_id` at `limit` in one write, then carries it out;
    // the caller holds the run's interrupt lock.
    async fn hand_limit_interrupt(
        &self,
        run_id: RunId,
        limit: RunLimit,
        cut_turn: Option<SafeInt<1>>,
    ) -> Result<(), LimitInterruptFailure> {
        let run = self.require_run(run_id).await.map_err(no_row)?;
        let accepted = AcceptedLimitInterrupt {
            target: InterventionTarget {
                session_id: run.session_id,
                intervention_id: mint_intervention_id(),
                target_run_id: run_id,
                intervention_type: InterventionType::Interrupt,
                actor: InterventionActor::Daemon(DaemonInterventionActor::Value),
            },
            limit,
            cut_turn,
            accepted_run_version: run.version,
        };
        let requested = RequestedIntervention {
            intervention_id: accepted.target.intervention_id,
            target_run_id: run_id,
            intervention_type: InterventionType::Interrupt,
            payload: serde_json::to_string(&InterruptInterventionRecord::Limit(
                LimitInterruptRecord {
                    limit,
                    turn_number: cut_turn,
                },
            ))
            .expect("a limit's interrupt record serializes"),
            expected_run_version: safe_run_version(accepted.accepted_run_version),
            client_idempotency_key: mint_client_key(),
            device_id: None,
        };
        let recorded = self
            .append(
                draft(&accepted.target, &ReachedState::Accepted).map_err(no_row)?,
                vec![
                    no_pending_limit_interrupt_statement(&run_id, limit),
                    insert_requested_intervention_statement(&requested),
                    move_intervention_statement(
                        &accepted.target.intervention_id,
                        &InterventionTransition::Accept,
                    ),
                ],
                vec![draft(&accepted.target, &ReachedState::Requested).map_err(no_row)?],
            )
            .await;
        if let Err(error) = recorded {
            return Err(match refused_statement_index(&error) {
                Some(PENDING_GUARD_INDEX) => no_row(LimitInterruptPending { run_id, limit }),
                _ => no_row(error),
            });
        }
        self.carry_out_limit_interrupt(&accepted).await
    }

    // Dispatches an accepted limit's interrupt unless the run's read says its end is already done
    // or left to the continued run's own stop, and records the outcome.
    async fn carry_out_limit_interrupt(
        &self,
        accepted: &AcceptedLimitInterrupt,
    ) -> Result<(), LimitInterruptFailure> {
        let AcceptedLimitInterrupt {
            target,
            limit,
            cut_turn,
            accepted_run_version,
        } = accepted;
        let run_id = target.target_run_id;
        let dispatch = match self
            .decide_limit_dispatch(run_id, *limit, *accepted_run_version)
            .await
        {
            Ok(dispatch) => dispatch,
            Err(error) => return Err(self.fail_limit_hand(target, error.into()).await),
        };
        let verdict = match dispatch {
            LimitDispatch::NothingToCut => Verdict::Applied {
                cancelled: Vec::new(),
            },
            LimitDispatch::LeftToContinuedRun => {
                return Err(self
                    .fail_limit_hand(target, DispatchError::RunContinued)
                    .await);
            }
            LimitDispatch::Cut => match self.dispatch_limit(run_id, *accepted_run_version).await {
                Ok(verdict) => verdict,
                Err(dispatch) => return Err(self.fail_limit_hand(target, dispatch).await),
            },
        };
        let recorded = self
            .record_verdict(
                target,
                verdict,
                Some(RunEndOfVerdict {
                    accepted_run_version: *accepted_run_version,
                    cause: InterruptCause::Limit {
                        limit: *limit,
                        cut_turn: *cut_turn,
                    },
                }),
            )
            .await
            .map_err(row_pending)?;
        match recorded {
            RowMove::Made(_) => Ok(()),
            RowMove::SettledSince => self.answer_settled_limit_hand(target).await,
        }
    }

    // What the run's read once the interrupt is accepted says of its dispatch: nothing to cut when
    // the run ended since the accepted version or a person's end discharged a step limit and the
    // run's continue counts afresh, the continued run's own stop when a token or spend limit's run
    // ended and continued since, else the cut of the run at the accepted version.
    async fn decide_limit_dispatch(
        &self,
        run_id: RunId,
        limit: RunLimit,
        accepted_run_version: i64,
    ) -> Result<LimitDispatch, RunEngineError> {
        let run = self.require_run(run_id).await?;
        if run.state.is_terminal() {
            return Ok(LimitDispatch::NothingToCut);
        }
        if run.version == accepted_run_version
            || !self
                .engine
                .has_ended_since(run_id, accepted_run_version)
                .await?
        {
            return Ok(LimitDispatch::Cut);
        }
        Ok(match limit {
            RunLimit::StepLimit => LimitDispatch::NothingToCut,
            RunLimit::SpendLimit | RunLimit::TokenLimit => LimitDispatch::LeftToContinuedRun,
        })
    }

    // Cuts the run's turn: none for a run the engine claimed or that ended meanwhile, else the
    // driver's interrupt, the waiting messages left waiting.
    async fn dispatch_limit(
        &self,
        run_id: RunId,
        run_version: i64,
    ) -> Result<Verdict, DispatchError> {
        match self.engine.route_interrupt(run_id).await? {
            InterruptRoute::Claimed | InterruptRoute::Ended => Ok(Verdict::Applied {
                cancelled: Vec::new(),
            }),
            InterruptRoute::Driver => {
                self.interrupt_through_driver(
                    run_id,
                    safe_run_version(run_version),
                    mint_client_key(),
                    InterruptPayload {
                        pending: InterruptPendingChoice::KeepWaiting,
                        reason: None,
                    },
                )
                .await
            }
        }
    }

    // Records the dispatch's failure: no row is left pending once the row is `failed`, and the
    // row stays `accepted` when that move did not land. A hand the provider got with no answer
    // back may still cut the turn, so its row stays `accepted` as the mark of the stop's cut, for
    // the run's end to settle, the run's end settling it here when it read the row too early.
    async fn fail_limit_hand(
        &self,
        target: &InterventionTarget,
        dispatch: DispatchError,
    ) -> LimitInterruptFailure {
        if let DispatchError::Driver(DriverError::Unanswered(_)) = &dispatch {
            let settled = self
                .engine
                .settle_unresolved_of_ended_run(target.target_run_id)
                .await;
            return match settled {
                Ok(_) => row_pending(dispatch),
                Err(error) => row_pending(error),
            };
        }
        match self.record_failure(target, dispatch).await {
            // A row the run's end settled first leaves nothing pending either, and a limit its
            // continued run still owes is cut by that run's own stop.
            Ok(
                RecordedFailure::Recorded { dispatch, .. }
                | RecordedFailure::SettledSince { dispatch },
            ) => no_row(dispatch),
            Err(unrecorded) => row_pending(unrecorded),
        }
    }

    // The outcome of a hand whose row the run's end or a turn's end settled while it was carried
    // out: done where it applied, and otherwise no row is left and the limit is owed again.
    async fn answer_settled_limit_hand(
        &self,
        target: &InterventionTarget,
    ) -> Result<(), LimitInterruptFailure> {
        match self.read_stored(target).await.map_err(no_row)?.state {
            InterventionState::Applied => Ok(()),
            InterventionState::Requested
            | InterventionState::Accepted
            | InterventionState::Degraded
            | InterventionState::Expired
            | InterventionState::Rejected
            | InterventionState::Failed => Err(no_row(LimitInterruptExpired {
                run_id: target.target_run_id,
            })),
        }
    }

    // A hand that answers past its bound: one that left no row pending withdraws the stop's own
    // cut and owes the limit again; one that applied has ended the run, and one still pending
    // keeps its cut.
    async fn record_late_hand(
        &self,
        run_id: RunId,
        limit: RunLimit,
        cut: Option<HandedCut>,
        late: Result<(), LimitInterruptFailure>,
    ) {
        let Err(failure) = late else {
            return;
        };
        tracing::warn!(
            run_id = %run_id,
            limit = <&'static str>::from(limit),
            error = &failure as &(dyn std::error::Error + 'static),
            "a limit's interrupt failed past its bound"
        );
        if let LimitInterruptFailure::NoRow { .. } = failure
            && let Err(error) = self.engine.forget_late_limit_hand(run_id, limit, cut).await
        {
            tracing::warn!(
                run_id = %run_id,
                limit = <&'static str>::from(limit),
                error = &error as &(dyn std::error::Error + 'static),
                "the late failure of a limit's interrupt could not be forgotten"
            );
        }
    }
}

// A limit's interrupt once its row is accepted, with what its dispatch and its end name.
struct AcceptedLimitInterrupt {
    target: InterventionTarget,
    limit: RunLimit,
    cut_turn: Option<SafeInt<1>>,
    accepted_run_version: i64,
}

// What an accepted limit's interrupt does, read from the run once it is accepted.
enum LimitDispatch {
    // Nothing is left to cut: the row moves to `applied` with no dispatch.
    NothingToCut,
    // The run ended and continued since: the row fails with no dispatch, and the continued run's
    // own stop cuts it.
    LeftToContinuedRun,
    // The dispatch cuts the run at the accepted version, which its end is written against.
    Cut,
}

// A fresh key for a request the daemon makes itself, which no one retries.
fn mint_client_key() -> ClientUuid {
    ClientUuid::new(mint_uuid_v7().to_string()).expect("a minted UUID is a client UUID")
}

fn no_row(source: impl std::error::Error + Send + Sync + 'static) -> LimitInterruptFailure {
    LimitInterruptFailure::NoRow {
        source: Box::new(source),
    }
}

fn row_pending(source: impl std::error::Error + Send + Sync + 'static) -> LimitInterruptFailure {
    LimitInterruptFailure::RowPending {
        source: Box::new(source),
    }
}

#[cfg(test)]
mod tests;
