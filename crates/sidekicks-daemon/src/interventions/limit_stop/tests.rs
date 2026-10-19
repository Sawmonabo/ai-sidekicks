//! The daemon's own interrupt of a run at a limit through the service, over the interventions'
//! test harness: its row, its bound and late outcome, its read before the dispatch, and the
//! hand of a limit a run owes once the provider runs again.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::events::{DaemonInterventionActor, InterventionActor};
use sidekicks_contracts::run::intervention::{
    InterventionId, InterventionType, LimitInterruptRecord, RunLimit,
};
use sidekicks_contracts::run::provider_choice::{
    AgentRunUsageCreditsChoiceRequestedPayload, AgentRunUsageCreditsChoiceResolveRequest,
    RunUsageCreditsChoice,
};
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::sync::oneshot;

use super::AcceptedLimitInterrupt;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::statement::DATABASE_NOW_SQL;
use crate::events::session::appender::SessionEventDraft;
use crate::interventions::service::InterventionTarget;
use crate::interventions::service::tests::{Harness, applied, harness};
use crate::provider::driver::contract::{DriverError, MockProviderDriver};
use crate::provider::driver::run_control::AnswerProviderChoiceResult;
use crate::session::run::engine::tests::{held_cut_limit, hold_cut, stored_run_state};
use crate::session::run::limit_interrupter::{HandedCut, LimitInterruptFailure, LimitInterrupter};
use crate::session::run::provider_choice::{
    PROVIDER_CHOICE_STATEMENT_CAPACITY, ProviderChoiceAnswerOrigin, ProviderChoiceResolver,
};
use crate::session::run::state_change::{RunStateChange, RunStateChangeCompanions, RunStateEntry};
use crate::uuid_v7::mint_uuid_v7;

// Records an `accepted` interrupt of the harness's run at `limit`, accepted at version 1, as
// its write would, and answers its id.
fn record_accepted_row(harness: &Harness, limit: RunLimit) -> InterventionId {
    let record = serde_json::to_string(&LimitInterruptRecord {
        limit,
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
    InterventionId::new(&id).expect("a minted UUID is an intervention id")
}

// Hands the harness's engine its service, as the daemon's start does.
fn hand_service_to_engine(harness: &Harness) {
    let interrupter: Arc<dyn LimitInterrupter> = harness.service.clone();
    let interrupter: Weak<dyn LimitInterrupter> = Arc::downgrade(&interrupter);
    assert!(harness.engine.set_limit_interrupter(interrupter).is_ok());
}

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
                            connection.execute("UPDATE interventions SET state = 'requested'", [])
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

    let cut = cut_turn.map(|turn_number| HandedCut {
        turn_number,
        stop_id: 0,
    });
    let handed = harness
        .service
        .interrupt_for_limit(harness.run_id, RunLimit::TokenLimit, cut)
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
    record_accepted_row(&harness, RunLimit::SpendLimit);

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

/// What the driver answers a hand past its bound.
#[derive(Clone, Copy, Debug)]
enum LateAnswer {
    /// It throws.
    Throws,
    /// It cuts the turn.
    Applies,
}

// A hand past its bound answers with its row pending and records its late outcome: a late
// failure withdraws the stop's own cut and owes the limit again, so the run's return from a wait
// hands it once more and that hand ends the run, and a late apply ends the run with the limit's
// cause itself. Killed by answering past the bound with no row, dropping the late record, not
// handing the late failure its cut, not re-arming, or a late apply that leaves the run running.
#[rstest]
#[case::late_failure(LateAnswer::Throws)]
#[case::late_apply(LateAnswer::Applies)]
#[tokio::test]
async fn a_hand_past_its_bound_answers_pending_and_records_its_late_outcome(
    #[case] late: LateAnswer,
) {
    let (release, released) = oneshot::channel::<()>();
    let released = Mutex::new(Some(released));
    let calls = AtomicUsize::new(0);
    let mut driver = MockProviderDriver::new();
    driver
        .expect_apply_intervention()
        .times(match late {
            LateAnswer::Throws => 2,
            LateAnswer::Applies => 1,
        })
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
                match late {
                    LateAnswer::Throws => {
                        Err(DriverError::Internal("the provider never answered".into()))
                    }
                    LateAnswer::Applies => Ok(applied()),
                }
            }
            .boxed()
        });
    let harness = harness(driver).await;
    hand_service_to_engine(&harness);
    // Only a late failure leaves the run live with a turn to cut; a late apply's end reads none.
    let turn = SafeInt::new(3).expect("3 is a turn number");
    let cut = match late {
        LateAnswer::Throws => Some(hold_cut(
            &harness.engine,
            harness.run_id,
            turn,
            RunLimit::TokenLimit,
        )),
        LateAnswer::Applies => None,
    };

    let handed = harness
        .service
        .interrupt_for_limit(harness.run_id, RunLimit::TokenLimit, cut)
        .await;
    assert!(
        matches!(handed, Err(LimitInterruptFailure::RowPending { .. })),
        "{handed:?}"
    );
    assert_eq!(harness.stored_rows()[0].0, "accepted");
    release.send(()).expect("the hand waits on the driver");
    // The hand holds the run's interrupt lock until its late outcome is recorded.
    drop(harness.service.interrupt_lock.acquire(harness.run_id).await);
    if let LateAnswer::Applies = late {
        assert_eq!(harness.stored_rows()[0].0, "applied");
        assert_eq!(
            stored_run_state(&harness.database, &harness.run_id).0,
            "stopped"
        );
        return;
    }
    assert_eq!(harness.stored_rows()[0].0, "failed");
    assert_eq!(held_cut_limit(&harness.engine, harness.run_id, turn), None);

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

/// What became of the run between a limit's accept and its dispatch.
#[derive(Clone, Copy, Debug)]
enum RunAfterAccept {
    /// A person's interrupt ended it and a continue runs it again.
    EndedAndContinued,
    /// It cannot be read.
    Unreadable,
}

// An accepted limit's interrupt reads the run before it dispatches. A step limit the run's
// end discharged applies with no dispatch and leaves the continued run running; a token or
// spend limit whose run ended and continued fails with no dispatch, so the continued run's
// own stop cuts it; a read that fails ends the row failed. Killed by dispatching at the new
// version (the driver is never to be called), the step arm dispatching, or a failed read
// leaving the row accepted.
#[rstest]
#[case::step_discharged(
    RunLimit::StepLimit,
    RunAfterAccept::EndedAndContinued,
    "applied",
    None
)]
#[case::token_left_to_the_continued_run(
    RunLimit::TokenLimit,
    RunAfterAccept::EndedAndContinued,
    "failed",
    Some("the run ended and was continued before the dispatch")
)]
#[case::spend_left_to_the_continued_run(
    RunLimit::SpendLimit,
    RunAfterAccept::EndedAndContinued,
    "failed",
    Some("the run ended and was continued before the dispatch")
)]
#[case::unreadable_run(RunLimit::TokenLimit, RunAfterAccept::Unreadable, "failed", None)]
#[tokio::test]
async fn an_accepted_limit_reads_the_run_before_it_dispatches(
    #[case] limit: RunLimit,
    #[case] run_after_accept: RunAfterAccept,
    #[case] row_state: &str,
    #[case] failure_reason: Option<&str>,
) {
    let harness = harness(MockProviderDriver::new()).await;
    let intervention_id = record_accepted_row(&harness, limit);
    match run_after_accept {
        RunAfterAccept::EndedAndContinued => {
            let ended = harness
                .engine
                .end_run_for_interrupt(
                    harness.run_id,
                    1,
                    None,
                    None,
                    RunStateChangeCompanions::default(),
                )
                .await
                .expect("the person's interrupt ends the run");
            assert!(ended);
            harness.set_run("running", 3);
        }
        RunAfterAccept::Unreadable => harness
            .service
            .pool
            .close()
            .await
            .expect("the service's read pool closes"),
    }
    let accepted = AcceptedLimitInterrupt {
        target: InterventionTarget {
            session_id: harness.session_id,
            intervention_id,
            target_run_id: harness.run_id,
            intervention_type: InterventionType::Interrupt,
            actor: InterventionActor::Daemon(DaemonInterventionActor::Value),
        },
        limit,
        cut_turn: None,
        accepted_run_version: 1,
    };

    let carried = harness.service.carry_out_limit_interrupt(&accepted).await;

    match (row_state, &carried) {
        ("applied", Ok(())) | ("failed", Err(LimitInterruptFailure::NoRow { .. })) => {}
        _ => panic!("expected the row {row_state}, got {carried:?}"),
    }
    assert_eq!(harness.stored_rows()[0].0, row_state);
    if let Some(failure_reason) = failure_reason {
        let stored: String = harness
            .database
            .reader()
            .query_row(
                "SELECT failure_reason FROM interventions WHERE target_run_id = ?1",
                [harness.run_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the failed row holds its reason");
        assert_eq!(stored, failure_reason);
    }
    if let RunAfterAccept::EndedAndContinued = run_after_accept {
        assert_eq!(
            stored_run_state(&harness.database, &harness.run_id).0,
            "running"
        );
    }
}

// A limit whose hand failed while the run waited on a person's choice is handed again once
// their answer returns the run to running, and that hand ends the run. Killed by dropping the
// resend from the engine's move of the run.
#[tokio::test]
async fn a_limit_owed_through_a_choice_is_handed_once_the_answer_returns_the_run() {
    let calls = AtomicUsize::new(0);
    let mut driver = MockProviderDriver::new();
    driver
        .expect_apply_intervention()
        .times(2)
        .returning(move |_| {
            let is_first = calls.fetch_add(1, Ordering::SeqCst) == 0;
            async move {
                if is_first {
                    Err(DriverError::Internal("the provider's socket closed".into()))
                } else {
                    Ok(applied())
                }
            }
            .boxed()
        });
    let harness = harness(driver).await;
    hand_service_to_engine(&harness);
    harness.set_run("waitingForInput", 1);
    let stopped = harness
        .engine
        .stop_at_token_limit(
            harness.run_id,
            TokensPerRun(SafeInt::new(500_000).expect("the test's limit is a safe integer")),
        )
        .await;
    assert!(stopped.is_err(), "the first hand fails");
    let requested = SessionEvent::AgentRunUsageCreditsChoiceRequested(
        AgentRunUsageCreditsChoiceRequestedPayload {
            session_id: harness.session_id,
            run_id: harness.run_id,
            model_name: FreeFormText::new("a model".to_owned()).expect("a model name"),
            overages_enabled: false,
            balance_cents: None,
            currency: None,
            fallback_model: None,
        },
    );
    harness
        .service
        .append(
            SessionEventDraft::of_session(harness.session_id, &requested)
                .expect("the choice's request drafts"),
            Vec::new(),
            Vec::new(),
        )
        .await
        .expect("the provider asks the choice");
    let mut choice_driver = MockProviderDriver::new();
    choice_driver
        .expect_answer_provider_choice()
        .times(1)
        .returning(|_| async { Ok(AnswerProviderChoiceResult::Answered {}) }.boxed());
    let resolver = ProviderChoiceResolver::new(
        Arc::new(DatabaseReadPool::new(
            harness.database.path(),
            PROVIDER_CHOICE_STATEMENT_CAPACITY,
        )),
        Arc::clone(&harness.engine),
    );

    resolver
        .resolve_usage_credits_choice(
            &AgentRunUsageCreditsChoiceResolveRequest {
                run_id: harness.run_id,
                choice: RunUsageCreditsChoice::Consent,
            },
            ProviderChoiceAnswerOrigin { device_id: None },
            &choice_driver,
        )
        .await
        .expect("the answer returns the run to running");

    let rows = harness.stored_rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].0, "applied");
    assert_eq!(
        stored_run_state(&harness.database, &harness.run_id).0,
        "stopped"
    );
}
