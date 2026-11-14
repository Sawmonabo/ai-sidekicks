//! The daemon's own interrupt of a run the engine stopped at a limit, carried by the one path a
//! person's takes. Its row is written and accepted at once, since a limit's interrupt is never
//! refused or outdated, and a second interrupt of one limit is refused while one is pending. The
//! hand runs as one of the engine's interrupt hands: it holds the run's interrupt lock and records
//! the outcome however late it comes, unless the daemon's stop cuts it, and the engine's stop waits
//! on it for a bounded time. Once its row's write is queued, the stop's cut is kept whatever cuts
//! the stop, until that write fails. A hand the provider got with no answer back leaves its row
//! pending and the stop's cut kept, for the run's end to settle: applied when the run ended
//! `interrupted`, else expired with the limit still owed. A restart's hand carries out once a row
//! the old process left `accepted`, its outcome recorded as a hand no stop awaits.

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
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_std::bounded_wait::wait_within;
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

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
use crate::run::engine::errors::RunEngineError;
use crate::run::limit_interrupter::{HandedCut, LimitInterruptFailure, LimitInterrupter};
use crate::run::read::safe_run_version;

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

/// The hand's task ended without an answer, cut by the daemon's stop or its runtime shutting
/// down.
#[derive(Debug, thiserror::Error)]
#[error("the hand of run {run_id}'s interrupt at a limit ended without an answer")]
pub(super) struct HandCanceled {
    run_id: RunId,
}

/// The daemon's stop came before the hand started, so no row was written.
#[derive(Debug, thiserror::Error)]
#[error("the daemon is stopping, so run {run_id}'s interrupt at a limit was not handed")]
struct HandNotStarted {
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
            let hand = self.engine.hand_interrupt(run_id, async move {
                // The hold lasts until the outcome is recorded, a late one included.
                let _hold = service.interrupt_lock.acquire(run_id).await;
                let handed = service.hand_limit_interrupt(run_id, limit, cut).await;
                // A failed send is an answer past the bound, which the stop no longer awaits.
                if let Err(late) = answer_sender.send(handed) {
                    service
                        .record_unawaited_hand(run_id, limit, cut, late)
                        .await;
                }
            });
            let Some(hand) = hand else {
                return Err(no_row(HandNotStarted { run_id }));
            };
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
// re-raised in the stop, while one that panics past it reaches only the panic hook; a hand the
// daemon's stop cut, or a task canceled by the runtime's shutdown, leaves whatever row it wrote
// pending, and a hand that ran to its end after the stop's close has recorded its outcome late.
async fn ended_without_answer(
    run_id: RunId,
    hand: JoinHandle<Option<()>>,
) -> LimitInterruptFailure {
    match hand.await {
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(_) | Ok(None) => LimitInterruptFailure::RowPending {
            source: Box::new(HandCanceled { run_id }),
        },
        Ok(Some(())) => LimitInterruptFailure::RowPending {
            source: Box::new(HandPastBound { run_id }),
        },
    }
}

impl InterventionService {
    // Records and accepts the interrupt of `run_id` at `limit`, its row naming the turn of `cut`,
    // in one write, has the engine keep that cut from the poll that queues the write until the
    // write fails, then carries it out; the caller holds the run's interrupt lock.
    async fn hand_limit_interrupt(
        &self,
        run_id: RunId,
        limit: RunLimit,
        cut: Option<HandedCut>,
    ) -> Result<(), LimitInterruptFailure> {
        let cut_turn = cut.map(|cut| cut.turn_number);
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
        let accepted_event = draft(&accepted.target, &ReachedState::Accepted).map_err(no_row)?;
        let requested_event = draft(&accepted.target, &ReachedState::Requested).map_err(no_row)?;
        let statements = vec![
            no_pending_limit_interrupt_statement(&run_id, limit),
            insert_requested_intervention_statement(&requested),
            move_intervention_statement(
                &accepted.target.intervention_id,
                &InterventionTransition::Accept,
            ),
        ];
        // Under the session's hold nothing is awaited from the mark to the write's queuing, so a
        // cut of this hand finds the cut marked exactly when the write is queued, which commits
        // anyway.
        let hold = SESSION_APPEND_LOCK
            .acquire(accepted.target.session_id)
            .await;
        if let Some(cut) = cut {
            self.engine.keep_cut_named_by_row(run_id, cut);
        }
        let recorded = self
            .engine
            .append(
                accepted_event,
                statements,
                vec![requested_event],
                Some(&hold),
            )
            .await;
        drop(hold);
        if let Err(error) = recorded {
            if let Some(cut) = cut {
                self.engine.forget_cut_named_by_row(cut);
            }
            return Err(match error.refused_statement_index() {
                Some(PENDING_GUARD_INDEX) => no_row(LimitInterruptPending { run_id, limit }),
                _ => no_row(error),
            });
        }
        self.carry_out_limit_interrupt(&accepted).await
    }

    /// Carries out once the limit's interrupt `target` names, whose `record` a restart found
    /// `accepted` at `accepted_run_version`, as its live hand would; a failure is recorded as a
    /// hand no stop awaits, with the cut the restart restored from the row. The caller holds the
    /// run's interrupt lock.
    pub(super) async fn hand_limit_interrupt_again(
        &self,
        target: InterventionTarget,
        record: LimitInterruptRecord,
        accepted_run_version: i64,
    ) {
        let run_id = target.target_run_id;
        let LimitInterruptRecord { limit, turn_number } = record;
        let accepted = AcceptedLimitInterrupt {
            target,
            limit,
            cut_turn: turn_number,
            accepted_run_version,
        };
        let handed = self.carry_out_limit_interrupt(&accepted).await;
        let cut = turn_number
            .and_then(|turn_number| self.engine.restored_cut(run_id, turn_number, limit));
        self.record_unawaited_hand(run_id, limit, cut, handed).await;
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
                canceled: Vec::new(),
            },
            LimitDispatch::LeftToContinuedRun => {
                return Err(self
                    .fail_limit_hand(target, DispatchError::RunContinued)
                    .await);
            }
            LimitDispatch::Cut => match self
                .interrupt_keeping_waiting(run_id, *accepted_run_version)
                .await
            {
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

    // The outcome of a hand no stop awaits, one past its bound or one a restart handed again: one
    // that left no row pending withdraws its `cut` and owes the limit again; one that applied has
    // ended the run, and one still pending keeps its cut for the run's end to settle.
    async fn record_unawaited_hand(
        &self,
        run_id: RunId,
        limit: RunLimit,
        cut: Option<HandedCut>,
        outcome: Result<(), LimitInterruptFailure>,
    ) {
        let Err(failure) = outcome else {
            return;
        };
        tracing::warn!(
            run_id = %run_id,
            limit = <&'static str>::from(limit),
            error = &failure as &(dyn std::error::Error + 'static),
            "a limit's interrupt failed with no stop awaiting it"
        );
        if let LimitInterruptFailure::NoRow { .. } = failure
            && let Err(error) = self.engine.forget_unawaited_hand(run_id, limit, cut).await
        {
            tracing::warn!(
                run_id = %run_id,
                limit = <&'static str>::from(limit),
                error = &error as &(dyn std::error::Error + 'static),
                "the unawaited failure of a limit's interrupt could not be forgotten"
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

/// A fresh key for a request the daemon makes itself, which no one retries.
pub(crate) fn mint_client_key() -> ClientUuid {
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
pub(crate) mod tests;
