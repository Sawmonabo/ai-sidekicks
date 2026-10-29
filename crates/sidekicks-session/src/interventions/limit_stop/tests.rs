//! The daemon's own interrupt of a run at a limit through the service, over the interventions'
//! test harness: its row, its bound and late outcome, its read before the dispatch, and the
//! hand of a limit a run owes once the provider runs again.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::control::{AgentRunPauseRequest, AgentRunResumeRequest};
use sidekicks_contracts::run::events::{DaemonInterventionActor, InterventionActor};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    InterventionId, InterventionType, LimitInterruptRecord, RunLimit,
};
use sidekicks_contracts::run::provider_choice::{
    AgentRunUsageCreditsChoiceRequestedPayload, AgentRunUsageCreditsChoiceResolveRequest,
    RunUsageCreditsChoice,
};
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::error_causes::unanswered;
use sidekicks_provider::driver::message_handing::MessageHanding;
use sidekicks_provider::driver::run_control::{AnswerProviderChoiceResult, WaitingMessage};
use sidekicks_provider::port::run_pause::{ContinuedMessages, ContinuedMessagesError};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_provider::run::turn_end::{ProviderTurnEnd, TurnOutcome};
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::statement::DATABASE_NOW_SQL;
use sidekicks_store::events::session::appender::SessionEventDraft;
use tokio::runtime::Handle;
use tokio::sync::oneshot;

use super::AcceptedLimitInterrupt;
use crate::interventions::service::InterventionTarget;
use crate::interventions::service::tests::{Harness, applied, harness};
use crate::run::engine::test_fixture::stored_run_state;
use crate::run::engine::tests::{SETTLE_WAIT, hold_cut};
use crate::run::limit_interrupter::{HandedCut, LimitInterruptFailure, LimitInterrupter};
use crate::run::pause::{RunPauseControl, RunPauseError};
use crate::run::provider_choice::{
    PROVIDER_CHOICE_STATEMENT_CAPACITY, ProviderChoiceAnswerOrigin, ProviderChoiceResolver,
};
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions};

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
    assert_eq!(harness.stored_event_types(), Vec::<String>::new());
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
    assert_eq!(harness.engine.held_cut_limit(harness.run_id, turn), None);

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

// A step limit's hand the provider got with no answer back answers with its row pending, never
// failed, so the stop's cut stays; the provider's `interrupted` end then ends the cut turn with
// the step limit's cause and settles the row `applied` in the run's own end. Killed by recording
// the unanswered hand as failed, which leaves no row and withdraws the cut.
#[tokio::test]
async fn an_unanswered_step_hand_keeps_its_cut_until_the_providers_end() {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_apply_intervention()
        .times(1)
        .returning(|_| async { Err(unanswered()) }.boxed());
    let harness = harness(driver).await;
    hand_service_to_engine(&harness);
    let turn = SafeInt::new(3).expect("3 is a turn number");
    let cut = hold_cut(&harness.engine, harness.run_id, turn, RunLimit::StepLimit);

    let handed = harness
        .service
        .interrupt_for_limit(harness.run_id, RunLimit::StepLimit, Some(cut))
        .await;
    let row_while_pending = harness.stored_rows()[0].0.clone();
    let cut_while_pending = harness.engine.held_cut_limit(harness.run_id, turn);
    let ended = harness
        .engine
        .apply_provider_state_change(
            RunStateChange::new(
                harness.run_id,
                RunStateEntry::Interrupted {
                    intended_close: None,
                    trigger: None,
                },
            ),
            Some(ProviderTurnEnd {
                turn_number: turn,
                outcome: TurnOutcome::Interrupted(None),
            }),
        )
        .await
        .expect("the provider's end is written");

    assert!(
        matches!(handed, Err(LimitInterruptFailure::RowPending { .. })),
        "{handed:?}"
    );
    assert!(ended.resend_failure.is_none(), "{:?}", ended.resend_failure);
    assert_eq!(row_while_pending, "accepted");
    assert_eq!(cut_while_pending, Some(RunLimit::StepLimit));
    assert_eq!(harness.stored_rows()[0].0, "applied");
    let cause: String = harness
        .database
        .reader()
        .query_row(
            "SELECT json_extract(payload, '$.cause') FROM session_events
             WHERE session_id = ?1 AND type = 'agent.turn.interrupted'",
            [harness.session_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the turn's end is stored");
    assert_eq!(cause, "stepLimit");
}

/// What became of the run between a limit's accept and its dispatch.
#[derive(Clone, Copy, Debug)]
enum RunAfterAccept {
    /// A person's interrupt ended it and a continue runs it again.
    EndedAndContinued,
    /// It cannot be read.
    Unreadable,
}

// An accepted limit's interrupt reads the run before it dispatches. The person's interrupt that
// ended the run applied the limit's row in that end's write; a step limit that end discharged
// answers handed with no dispatch and leaves the continued run running, and a token or spend
// limit answers with no row pending, so the continued run's own stop cuts it; a read that fails
// ends the row failed. Killed by dispatching at the new version (the driver is never to be
// called), the step arm dispatching, a token or spend limit answering handed, or a failed read
// leaving the row accepted.
#[rstest]
#[case::step_discharged(
    RunLimit::StepLimit,
    RunAfterAccept::EndedAndContinued,
    "applied",
    true
)]
#[case::token_left_to_the_continued_run(
    RunLimit::TokenLimit,
    RunAfterAccept::EndedAndContinued,
    "applied",
    false
)]
#[case::spend_left_to_the_continued_run(
    RunLimit::SpendLimit,
    RunAfterAccept::EndedAndContinued,
    "applied",
    false
)]
#[case::unreadable_run(RunLimit::TokenLimit, RunAfterAccept::Unreadable, "failed", false)]
#[tokio::test]
async fn an_accepted_limit_reads_the_run_before_it_dispatches(
    #[case] limit: RunLimit,
    #[case] run_after_accept: RunAfterAccept,
    #[case] row_state: &str,
    #[case] is_handed: bool,
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

    match (is_handed, &carried) {
        (true, Ok(())) | (false, Err(LimitInterruptFailure::NoRow { .. })) => {}
        _ => panic!("expected handed {is_handed}, got {carried:?}"),
    }
    assert_eq!(harness.stored_rows()[0].0, row_state);
    if let RunAfterAccept::EndedAndContinued = run_after_accept {
        assert_eq!(
            stored_run_state(&harness.database, &harness.run_id).0,
            "running"
        );
    }
}

// A driver whose first interrupt throws and whose second applies, the second's call sent to the
// receiver, so a test can wait for a hand that runs on a task of its own.
fn driver_failing_once() -> (MockProviderDriver, oneshot::Receiver<()>) {
    let (dispatched, dispatch) = oneshot::channel();
    let dispatched = Mutex::new(Some(dispatched));
    let calls = AtomicUsize::new(0);
    let mut driver = MockProviderDriver::new();
    driver
        .expect_apply_intervention()
        .times(2)
        .returning(move |_| {
            let is_first = calls.fetch_add(1, Ordering::SeqCst) == 0;
            if !is_first {
                dispatched
                    .lock()
                    .expect("the signal is not poisoned")
                    .take()
                    .expect("the second call takes the signal")
                    .send(())
                    .expect("the test waits for the hand");
            }
            async move {
                if is_first {
                    Err(DriverError::Internal("the provider's socket closed".into()))
                } else {
                    Ok(applied())
                }
            }
            .boxed()
        });
    (driver, dispatch)
}

// Puts the harness's run in `state` and has its token limit's first hand fail there, so the run
// owes that limit.
async fn owe_token_limit(harness: &Harness, state: &str) {
    harness.set_run(state, 1);
    let stopped = harness
        .engine
        .stop_at_token_limit(
            harness.run_id,
            TokensPerRun(SafeInt::new(500_000).expect("the test's limit is a safe integer")),
        )
        .await;
    assert!(stopped.is_err(), "the first hand fails");
}

// Waits for the owed limit's hand to reach the driver, then for its outcome, which it records
// under the run's interrupt lock, and checks that the hand ended the run at the limit.
async fn assert_owed_hand_ends_the_run(harness: &Harness, dispatch: oneshot::Receiver<()>) {
    tokio::time::timeout(SETTLE_WAIT, dispatch)
        .await
        .expect("the owed limit is handed again")
        .expect("the driver signals its call");
    drop(harness.service.interrupt_lock.acquire(harness.run_id).await);
    let rows = harness.stored_rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].0, "applied");
    assert_eq!(
        stored_run_state(&harness.database, &harness.run_id).0,
        "stopped"
    );
}

// A limit whose hand failed while the run waited on a person's choice is handed again once
// their answer returns the run to running, and that hand ends the run. Killed by dropping the
// resend from the engine's move of the run.
#[tokio::test]
async fn a_limit_owed_through_a_choice_is_handed_once_the_answer_returns_the_run() {
    let (mut driver, dispatch) = driver_failing_once();
    driver
        .expect_answer_provider_choice()
        .times(1)
        .returning(|_| async { Ok(AnswerProviderChoiceResult::Answered {}) }.boxed());
    let harness = harness(driver).await;
    hand_service_to_engine(&harness);
    owe_token_limit(&harness, "waitingForInput").await;
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
    let resolver = ProviderChoiceResolver::new(
        Arc::new(DatabaseReadPool::new(
            harness.database.path(),
            PROVIDER_CHOICE_STATEMENT_CAPACITY,
        )),
        Arc::clone(&harness.engine),
        Arc::clone(&harness.service.providers),
        Arc::clone(harness.engine.held_choice_answers()),
    );

    resolver
        .resolve_usage_credits_choice(
            &AgentRunUsageCreditsChoiceResolveRequest {
                run_id: harness.run_id,
                choice: RunUsageCreditsChoice::Consent,
            },
            ProviderChoiceAnswerOrigin {
                device_id: DeviceId::new("device".to_owned()).expect("a device id"),
            },
        )
        .await
        .expect("the answer returns the run to running");

    assert_owed_hand_ends_the_run(&harness, dispatch).await;
}

/// How a person's call returns a run that owes a limit to `running`.
#[derive(Clone, Copy, Debug)]
enum ReturnToRunning {
    /// A resume of a paused run.
    ResumeFromPaused,
    /// A resume of a run still pausing.
    ResumeFromPausing,
    /// A pause the driver refuses, which moves the run back from `pausing`.
    RefusedPause,
}

/// No messages wait for the run; the lock is the queue's on each session.
struct NoWaitingMessages(KeyedLock<SessionId>);

impl ContinuedMessages for NoWaitingMessages {
    fn hold_session(&self, session_id: SessionId) -> BoxFuture<'_, KeyHold<'_, SessionId>> {
        self.0.acquire(session_id).boxed()
    }

    fn read(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
        _handing: MessageHanding,
    ) -> BoxFuture<'_, Result<Vec<WaitingMessage>, ContinuedMessagesError>> {
        async { Ok(Vec::new()) }.boxed()
    }

    fn admit(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        async { Ok(()) }.boxed()
    }

    fn release(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        async { Ok(()) }.boxed()
    }

    fn keep(&self, _hold: &KeyHold<'_, SessionId>, _run_id: RunId) {}

    fn kept(&self, _hold: &KeyHold<'_, SessionId>, _run_id: RunId) -> Vec<QueueItemId> {
        Vec::new()
    }

    fn kept_unheld(&self, _hold: &KeyHold<'_, SessionId>, _run_id: RunId) -> Vec<QueueItemId> {
        Vec::new()
    }

    fn settle_kept(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
        _settled: &[QueueItemId],
        _taken: &[QueueItemId],
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        async { Ok(()) }.boxed()
    }

    fn fail_kept(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
        _message_ids: &[QueueItemId],
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        async { Ok(()) }.boxed()
    }
}

// A limit owed through a pause is handed again once its provider runs: a resume, from `paused` or
// `pausing`, asks the provider before the run moves and hands it only once the provider took the
// resume, when no hand was in flight and no second row was written, and a refused pause hands it
// with the move back from `pausing`, since the provider never paused. Killed by moving the run or
// handing before the provider's resume, or by dropping `pausing` from the states whose move hands.
#[rstest]
#[case::resume_from_paused(ReturnToRunning::ResumeFromPaused)]
#[case::resume_from_pausing(ReturnToRunning::ResumeFromPausing)]
#[case::refused_pause(ReturnToRunning::RefusedPause)]
#[tokio::test]
async fn a_limit_owed_through_a_pause_is_handed_once_the_provider_runs(
    #[case] call: ReturnToRunning,
) {
    let (mut driver, dispatch) = driver_failing_once();
    let state_before = match call {
        ReturnToRunning::ResumeFromPaused => "paused",
        ReturnToRunning::ResumeFromPausing => "pausing",
        ReturnToRunning::RefusedPause => "running",
    };
    let database: Arc<Mutex<Option<std::path::PathBuf>>> = Arc::default();
    let tasks_before: Arc<AtomicUsize> = Arc::default();
    if let ReturnToRunning::RefusedPause = call {
        driver.expect_pause_run().times(1).returning(|_| {
            async { Err(DriverError::Internal("the provider would not pause".into())) }.boxed()
        });
    } else {
        let database = Arc::clone(&database);
        let tasks_before = Arc::clone(&tasks_before);
        driver
            .expect_resume_run()
            .times(1)
            .returning(move |params| {
                // No hand is in flight or done, and the run has not moved, when the provider is
                // asked to resume.
                assert_eq!(
                    Handle::current().metrics().num_alive_tasks(),
                    tasks_before.load(Ordering::SeqCst)
                );
                let path = database
                    .lock()
                    .expect("the path is not poisoned")
                    .clone()
                    .expect("the test names its database");
                let (rows, state): (i64, String) = Connection::open(path)
                    .and_then(|connection| {
                        connection.query_row(
                            "SELECT (SELECT count(*) FROM interventions WHERE target_run_id = ?1),
                           (SELECT state FROM runs WHERE run_id = ?1)",
                            [params.run_id.text().as_str()],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                    })
                    .expect("the test reads the run");
                assert_eq!((rows, state.as_str()), (1, state_before));
                async { Ok(()) }.boxed()
            });
    }
    let harness = harness(driver).await;
    *database.lock().expect("the path is not poisoned") = Some(harness.database.path());
    hand_service_to_engine(&harness);
    owe_token_limit(&harness, state_before).await;
    let control = RunPauseControl::new(
        Arc::clone(&harness.service.pool),
        Arc::clone(&harness.engine),
        Arc::clone(&harness.service.providers),
    );
    let expected_run_version = SafeInt::new(
        u64::try_from(stored_run_state(&harness.database, &harness.run_id).1)
            .expect("a run's version is not negative"),
    )
    .expect("the run's version is a safe integer");

    if let ReturnToRunning::RefusedPause = call {
        let paused = control
            .pause(&AgentRunPauseRequest {
                target_run_id: harness.run_id,
                expected_run_version,
            })
            .await;
        assert!(
            matches!(paused, Err(RunPauseError::Driver(_))),
            "{paused:?}"
        );
    } else {
        tasks_before.store(
            Handle::current().metrics().num_alive_tasks(),
            Ordering::SeqCst,
        );
        let resumed = control
            .resume(
                &AgentRunResumeRequest {
                    target_run_id: harness.run_id,
                    expected_run_version,
                },
                &NoWaitingMessages(KeyedLock::new()),
            )
            .await;
        assert!(resumed.is_ok(), "{resumed:?}");
    }

    assert_owed_hand_ends_the_run(&harness, dispatch).await;
}

// While the driver takes a resume, the provider's own `running` report waits; a resume the driver
// refuses hands no limit, and the held report then moves the run and hands the owed limit once,
// which ends it. Killed by resuming without holding the run, or by handing the limit on a refused
// resume.
#[tokio::test]
async fn a_refused_resume_leaves_the_owed_limit_to_the_providers_own_report() {
    let (mut driver, dispatch) = driver_failing_once();
    let (started, has_started) = oneshot::channel();
    let (answer, answered) = oneshot::channel::<()>();
    let held = Mutex::new(Some((started, answered)));
    driver.expect_resume_run().times(1).returning(move |_| {
        let (started, answered) = held
            .lock()
            .expect("the held call reads")
            .take()
            .expect("the driver is resumed once");
        started.send(()).expect("the test waits for the call");
        async move {
            answered.await.expect("the test answers the call");
            Err(DriverError::Internal(
                "the provider would not resume".into(),
            ))
        }
        .boxed()
    });
    let harness = harness(driver).await;
    hand_service_to_engine(&harness);
    owe_token_limit(&harness, "paused").await;
    let control = Arc::new(RunPauseControl::new(
        Arc::clone(&harness.service.pool),
        Arc::clone(&harness.engine),
        Arc::clone(&harness.service.providers),
    ));
    let request = AgentRunResumeRequest {
        target_run_id: harness.run_id,
        expected_run_version: SafeInt::new(
            u64::try_from(stored_run_state(&harness.database, &harness.run_id).1)
                .expect("a run's version is not negative"),
        )
        .expect("the run's version is a safe integer"),
    };

    let resuming = {
        let control = Arc::clone(&control);
        tokio::spawn(async move {
            control
                .resume(&request, &NoWaitingMessages(KeyedLock::new()))
                .await
        })
    };
    tokio::time::timeout(SETTLE_WAIT, has_started)
        .await
        .expect("the driver is asked to resume")
        .expect("the driver signals its call");
    let mut report = {
        let engine = Arc::clone(&harness.engine);
        let change = RunStateChange::new(
            harness.run_id,
            RunStateEntry::Running {
                execution_posture: None,
            },
        );
        tokio::spawn(async move { engine.apply_provider_state_change(change, None).await })
    };
    let is_report_held = tokio::time::timeout(Duration::from_millis(200), &mut report)
        .await
        .is_err();
    answer.send(()).expect("the resume waits for its answer");
    let resumed = resuming.await.expect("the resume ends");
    let reported = report.await.expect("the report ends");

    assert!(is_report_held);
    assert!(
        matches!(
            resumed,
            Err(RunPauseError::Driver(DriverError::Internal(_)))
        ),
        "{resumed:?}"
    );
    assert!(reported.is_ok(), "{reported:?}");
    assert_owed_hand_ends_the_run(&harness, dispatch).await;
}
