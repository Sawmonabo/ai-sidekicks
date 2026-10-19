//! The daemon's own interrupt of a run the engine stopped at a limit, carried by the one path a
//! person's takes. Its row is written and accepted at once, since a limit's interrupt is never
//! refused or outdated, and a second interrupt of one limit is refused while one is pending. The
//! hand runs on its own task, which holds the run's interrupt lock and records the outcome
//! however late it comes; the engine's stop waits on it for a bounded time.

use std::pin::Pin;
use std::time::Duration;

use futures::future::BoxFuture;
use sidekicks_contracts::run::events::{DaemonInterventionActor, InterventionActor};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    InterruptInterventionRecord, InterventionType, LimitInterruptRecord, RunLimit,
};
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::oneshot;
use tracing::Instrument as _;

use crate::bounded_wait::wait_within;
use crate::interventions::interrupt_queue::InterruptCause;
use crate::interventions::service::reached_state::{ReachedState, draft};
use crate::interventions::service::{
    DispatchError, InterventionError, InterventionService, InterventionTarget, RunEndOfVerdict,
    Verdict, mint_intervention_id,
};
use crate::interventions::store::{
    InterventionTransition, RequestedIntervention, insert_requested_intervention_statement,
    move_intervention_statement, no_pending_limit_interrupt_statement,
};
use crate::provider::driver::run_control::{InterruptPayload, InterruptPendingChoice};
use crate::session::run::engine::{InterruptRoute, RunEngineError};
use crate::session::run::limit_interrupter::{LimitInterruptFailure, LimitInterrupter, StopCut};
use crate::session::run::read::safe_run_version;
use crate::session::run::state_change::refused_statement_index;
use crate::uuid_v7::mint_uuid_v7;

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
        cut: Option<StopCut>,
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

// The failure of a hand that gave the stop no answer: a panic goes on unwinding in the stop, a
// task canceled by the runtime's shutdown leaves whatever row it wrote pending, and a hand that
// ran to its end after the stop's close has recorded its outcome late.
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
    // Records and accepts the interrupt of `run_id` at `limit` in one write, dispatches it unless
    // the run's read says its end is already done, and records the outcome; the caller holds the
    // run's interrupt lock.
    async fn hand_limit_interrupt(
        &self,
        run_id: RunId,
        limit: RunLimit,
        cut_turn: Option<SafeInt<1>>,
    ) -> Result<(), LimitInterruptFailure> {
        let run = self.require_run(run_id).await.map_err(no_row)?;
        let accepted_run_version = run.version;
        let target = InterventionTarget {
            session_id: run.session_id,
            intervention_id: mint_intervention_id(),
            target_run_id: run_id,
            intervention_type: InterventionType::Interrupt,
            actor: InterventionActor::Daemon(DaemonInterventionActor::Value),
        };
        let requested = RequestedIntervention {
            intervention_id: target.intervention_id,
            target_run_id: run_id,
            intervention_type: InterventionType::Interrupt,
            payload: serde_json::to_string(&InterruptInterventionRecord::Limit(
                LimitInterruptRecord {
                    limit,
                    turn_number: cut_turn,
                },
            ))
            .expect("a limit's interrupt record serializes"),
            expected_run_version: safe_run_version(accepted_run_version),
            client_idempotency_key: mint_client_key(),
            device_id: None,
        };
        let recorded = self
            .append(
                draft(&target, &ReachedState::Accepted).map_err(no_row)?,
                vec![
                    no_pending_limit_interrupt_statement(&run_id, limit),
                    insert_requested_intervention_statement(&requested),
                    move_intervention_statement(
                        &target.intervention_id,
                        &InterventionTransition::Accept,
                    ),
                ],
                vec![draft(&target, &ReachedState::Requested).map_err(no_row)?],
            )
            .await;
        if let Err(error) = recorded {
            return Err(match refused_statement_index(&error) {
                Some(PENDING_GUARD_INDEX) => no_row(LimitInterruptPending { run_id, limit }),
                _ => no_row(error),
            });
        }
        let end_version = self
            .dispatching_version(run_id, limit, accepted_run_version)
            .await
            .map_err(row_pending)?;
        let verdict = match end_version {
            None => Verdict::Applied,
            Some(end_version) => match self.dispatch_limit(run_id, end_version).await {
                Ok(verdict) => verdict,
                Err(dispatch) => return Err(self.fail_limit_hand(&target, dispatch).await),
            },
        };
        self.record_verdict(
            &target,
            verdict,
            Some(RunEndOfVerdict {
                accepted_run_version: end_version.unwrap_or(accepted_run_version),
                cause: InterruptCause::Limit { limit, cut_turn },
            }),
        )
        .await
        .map_err(row_pending)?;
        Ok(())
    }

    // The run version a dispatch is made and the run ended against, read once the interrupt is
    // accepted; none when nothing is left to cut: the run ended since the accepted version, or a
    // person's end discharged a step limit and the run's continue counts afresh.
    async fn dispatching_version(
        &self,
        run_id: RunId,
        limit: RunLimit,
        accepted_run_version: i64,
    ) -> Result<Option<i64>, InterventionError> {
        let run = self.require_run(run_id).await?;
        if run.state.is_terminal() {
            return Ok(None);
        }
        if run.version == accepted_run_version
            || !self
                .engine
                .has_ended_since(run_id, accepted_run_version)
                .await?
        {
            return Ok(Some(accepted_run_version));
        }
        Ok(match limit {
            RunLimit::StepLimit => None,
            RunLimit::SpendLimit | RunLimit::TokenLimit => Some(run.version),
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
            InterruptRoute::Claimed | InterruptRoute::Ended => Ok(Verdict::Applied),
            InterruptRoute::Driver => {
                self.interrupt_through_driver(
                    run_id,
                    safe_run_version(run_version),
                    mint_client_key(),
                    InterruptPayload {
                        pending: InterruptPendingChoice::NextTurn,
                        reason: None,
                    },
                )
                .await
            }
        }
    }

    // Records the dispatch's failure: no row is left pending once the row is `failed`, and the
    // row stays `accepted` when that move did not land.
    async fn fail_limit_hand(
        &self,
        target: &InterventionTarget,
        dispatch: DispatchError,
    ) -> LimitInterruptFailure {
        match self.record_failure(target, dispatch).await {
            Ok(recorded) => no_row(recorded.dispatch),
            Err(unrecorded) => row_pending(unrecorded),
        }
    }

    // A hand that answers past its bound: one that left no row pending withdraws the stop's own
    // cut and owes the limit again; one that applied has ended the run, and one still pending
    // keeps its cut.
    async fn record_late_hand(
        &self,
        run_id: RunId,
        limit: RunLimit,
        cut: Option<StopCut>,
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
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, Weak};

    use futures::FutureExt as _;
    use rstest::rstest;
    use rusqlite::{Connection, params};
    use serde_json::{Value, json};
    use sidekicks_contracts::run::intervention::{LimitInterruptRecord, RunLimit};
    use sidekicks_contracts::wire::integer::SafeInt;
    use tokio::sync::oneshot;

    use crate::database::statement::DATABASE_NOW_SQL;
    use crate::interventions::service::tests::{applied, harness};
    use crate::provider::driver::contract::{DriverError, MockProviderDriver};
    use crate::session::run::engine::tests::stored_run_state;
    use crate::session::run::limit_interrupter::{LimitInterruptFailure, LimitInterrupter};
    use crate::session::run::state_change::{RunStateChange, RunStateEntry};
    use crate::uuid_v7::mint_uuid_v7;

    /// What the driver does with the limit's interrupt.
    #[derive(Clone, Copy, Debug)]
    enum DriverAnswer {
        /// It cuts the turn.
        Applies,
        /// It throws.
        Throws,
        /// It throws after the row was moved back to `requested`, so the move to `failed` is
        /// refused.
        ThrowsWithRowMoved,
        /// It is never called: the run has ended.
        NeverCalled,
    }

    // A limit's row carries no device and the limit's own payload, is accepted whatever the run's
    // state, and leaves no row pending when its failure is recorded, its row pending when that
    // record is refused. Killed by a guard on the limit's accept, a device on its row, or swapping
    // the two failures.
    #[rstest]
    #[case::applied(DriverAnswer::Applies, "running", Ok(()), "applied", "stopped")]
    #[case::failed(DriverAnswer::Throws, "running", Err("no row"), "failed", "running")]
    #[case::fail_refused(
        DriverAnswer::ThrowsWithRowMoved,
        "running",
        Err("row pending"),
        "requested",
        "running"
    )]
    #[case::run_ended(DriverAnswer::NeverCalled, "completed", Ok(()), "applied", "completed")]
    #[tokio::test]
    async fn a_limits_row_is_never_refused_and_its_failure_says_what_it_left(
        #[case] answer: DriverAnswer,
        #[case] run_state: &str,
        #[case] expected: Result<(), &str>,
        #[case] row_state: &str,
        #[case] run_end: &str,
    ) {
        let row_database: Arc<Mutex<Option<std::path::PathBuf>>> = Arc::default();
        let mut driver = MockProviderDriver::new();
        if !matches!(answer, DriverAnswer::NeverCalled) {
            let row_database = Arc::clone(&row_database);
            driver
                .expect_apply_intervention()
                .times(1)
                .returning(move |_| {
                    if let DriverAnswer::ThrowsWithRowMoved = answer {
                        let path = row_database
                            .lock()
                            .expect("the path is not poisoned")
                            .clone()
                            .expect("the test names its database");
                        Connection::open(path)
                            .and_then(|connection| {
                                connection
                                    .execute("UPDATE interventions SET state = 'requested'", [])
                            })
                            .expect("the test moves the row back");
                    }
                    async move {
                        match answer {
                            DriverAnswer::Applies => Ok(applied()),
                            DriverAnswer::Throws
                            | DriverAnswer::ThrowsWithRowMoved
                            | DriverAnswer::NeverCalled => {
                                Err(DriverError::Internal("the provider's socket closed".into()))
                            }
                        }
                    }
                    .boxed()
                });
        }
        let harness = harness(driver).await;
        *row_database.lock().expect("the path is not poisoned") = Some(harness.database.path());
        harness.set_run(run_state, 1);
        // A turn is cut only where the run's end does not need it, so the end reads no turn.
        let cut_turn = match answer {
            DriverAnswer::Applies | DriverAnswer::NeverCalled => None,
            DriverAnswer::Throws | DriverAnswer::ThrowsWithRowMoved => {
                Some(SafeInt::new(3).expect("3 is a turn number"))
            }
        };

        let handed = harness
            .service
            .interrupt_for_limit(harness.run_id, RunLimit::TokenLimit, cut_turn)
            .await;

        match (&handed, expected) {
            (Ok(()), Ok(()))
            | (Err(LimitInterruptFailure::NoRow { .. }), Err("no row"))
            | (Err(LimitInterruptFailure::RowPending { .. }), Err("row pending")) => {}
            _ => panic!("expected {expected:?}, got {handed:?}"),
        }
        let rows = harness.stored_rows();
        assert_eq!(rows.len(), 1);
        let (state, payload, device) = &rows[0];
        assert_eq!(state, row_state);
        assert_eq!(device, &None);
        let payload: Value = serde_json::from_str(payload).expect("the payload is JSON");
        let mut expected_payload = json!({ "limit": "tokenLimit" });
        if cut_turn.is_some() {
            expected_payload["turnNumber"] = json!(3);
        }
        assert_eq!(payload, expected_payload);
        assert_eq!(
            stored_run_state(&harness.database, &harness.run_id).0,
            run_end
        );
    }

    // A second interrupt of one limit is refused while the first is pending, with nothing written
    // and no dispatch. Killed by dropping the pending guard, which lets the second dispatch.
    #[tokio::test]
    async fn a_second_interrupt_of_one_limit_is_refused_while_one_is_pending() {
        let harness = harness(MockProviderDriver::new()).await;
        let record = serde_json::to_string(&LimitInterruptRecord {
            limit: RunLimit::SpendLimit,
            turn_number: None,
        })
        .expect("a limit's record serializes");
        let id = mint_uuid_v7().to_string();
        harness
            .database
            .reader()
            .execute(
                &format!(
                    "INSERT INTO interventions (id, target_run_id, type, state, payload,
                       expected_run_version, client_idempotency_key, created_at)
                     VALUES (?1, ?2, 'interrupt', 'accepted', ?3, 1, ?1, {DATABASE_NOW_SQL})"
                ),
                params![id, harness.run_id.text().as_str(), record],
            )
            .expect("the test records the pending interrupt");

        let handed = harness
            .service
            .interrupt_for_limit(harness.run_id, RunLimit::SpendLimit, None)
            .await;

        assert!(
            matches!(handed, Err(LimitInterruptFailure::NoRow { .. })),
            "{handed:?}"
        );
        assert_eq!(harness.stored_rows().len(), 1);
        assert!(harness.stored_event_types().is_empty());
    }

    // A hand past its bound answers with its row pending and records its late failure, which owes
    // the limit again: the run's return from a wait hands it once more, and that hand ends the run.
    // Killed by answering past the bound with no row, dropping the late record, or not re-arming.
    #[tokio::test]
    async fn a_hand_past_its_bound_answers_pending_and_its_late_failure_owes_the_limit_again() {
        let (release, released) = oneshot::channel::<()>();
        let released = Mutex::new(Some(released));
        let calls = AtomicUsize::new(0);
        let mut driver = MockProviderDriver::new();
        driver
            .expect_apply_intervention()
            .times(2)
            .returning(move |_| {
                let is_first = calls.fetch_add(1, Ordering::SeqCst) == 0;
                let released = released.lock().expect("the release is not poisoned").take();
                async move {
                    if !is_first {
                        return Ok(applied());
                    }
                    released
                        .expect("the first call takes the release")
                        .await
                        .expect("the test releases the driver");
                    Err(DriverError::Internal("the provider never answered".into()))
                }
                .boxed()
            });
        let harness = harness(driver).await;
        let interrupter: Arc<dyn LimitInterrupter> = harness.service.clone();
        let interrupter: Weak<dyn LimitInterrupter> = Arc::downgrade(&interrupter);
        assert!(harness.engine.set_limit_interrupter(interrupter).is_ok());

        let handed = harness
            .service
            .interrupt_for_limit(harness.run_id, RunLimit::TokenLimit, None)
            .await;
        assert!(
            matches!(handed, Err(LimitInterruptFailure::RowPending { .. })),
            "{handed:?}"
        );
        assert_eq!(harness.stored_rows()[0].0, "accepted");
        release.send(()).expect("the hand waits on the driver");
        // The hand holds the run's interrupt lock until its late outcome is recorded.
        drop(harness.service.interrupt_lock.acquire(harness.run_id).await);
        assert_eq!(harness.stored_rows()[0].0, "failed");

        harness.set_run("waitingForApproval", 2);
        let written = harness
            .engine
            .apply_provider_state_change(
                RunStateChange::new(
                    harness.run_id,
                    RunStateEntry::Running {
                        execution_posture: None,
                    },
                ),
                None,
            )
            .await
            .expect("the run returns to running");

        assert!(
            written.resend_failure.is_none(),
            "{:?}",
            written.resend_failure
        );
        let rows = harness.stored_rows();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].0, "applied");
        assert_eq!(
            stored_run_state(&harness.database, &harness.run_id).0,
            "stopped"
        );
    }
}
