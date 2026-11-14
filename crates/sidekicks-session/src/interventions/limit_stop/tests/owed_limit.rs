//! The hand of a limit a run owes, handed again once its provider runs: after a person's choice,
//! a resume or a refused pause, and a refused resume leaving it to the provider's own report.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::Connection;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::control::{AgentRunPauseRequest, AgentRunResumeRequest};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::provider_choice::{
    AgentRunUsageCreditsChoiceRequestedPayload, AgentRunUsageCreditsChoiceResolveRequest,
    RunUsageCreditsChoice,
};
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::message_handing::MessageHanding;
use sidekicks_provider::driver::run_control::{AnswerProviderChoiceResult, ResumeRunOutcome};
use sidekicks_provider::port::run_pause::{
    ContinuedMessages, ContinuedMessagesError, ContinuedRead, SessionOpening,
};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::events::session::appender::SessionEventDraft;
use tokio::runtime::Handle;
use tokio::sync::oneshot;

use super::hand_service_to_engine;
use crate::interventions::service::tests::{Harness, applied, harness};
use crate::run::engine::test_fixture::stored_run_state;
use crate::run::engine::tests::SETTLE_WAIT;
use crate::run::pause::{RunPauseControl, RunPauseError};
use crate::run::provider_choice::{
    PROVIDER_CHOICE_STATEMENT_CAPACITY, ProviderChoiceAnswerOrigin, ProviderChoiceResolver,
};
use crate::run::state_change::RunStateChange;

// A driver whose first interrupt throws and whose second applies, the second's call sent to the
// receiver, so a test can wait for a hand that runs on a task of its own.
pub(super) fn driver_failing_once() -> (MockProviderDriver, oneshot::Receiver<()>) {
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
pub(crate) async fn owe_token_limit(harness: &Harness, state: &str) {
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
pub(super) async fn assert_owed_hand_ends_the_run(
    harness: &Harness,
    dispatch: oneshot::Receiver<()>,
) {
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
        .engine
        .append(
            SessionEventDraft::of_session(harness.session_id, &requested)
                .expect("the choice's request drafts"),
            Vec::new(),
            Vec::new(),
            None,
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

/// No messages wait for the run.
pub(crate) struct NoWaitingMessages(
    /// The queue's lock on each session.
    pub(crate) KeyedLock<SessionId>,
);

impl ContinuedMessages for NoWaitingMessages {
    fn open_session(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<SessionOpening, ContinuedMessagesError>> {
        async { Ok(SessionOpening::Opened) }.boxed()
    }

    fn continue_held_lead(&self, _session_id: SessionId, _helper_run_id: RunId) {}

    fn hold_session(&self, session_id: SessionId) -> BoxFuture<'_, KeyHold<'_, SessionId>> {
        self.0.acquire(session_id).boxed()
    }

    fn read(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
        _handing: MessageHanding,
    ) -> BoxFuture<'_, Result<ContinuedRead, ContinuedMessagesError>> {
        async { Ok(ContinuedRead::Messages(Vec::new())) }.boxed()
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
                async { Ok(ResumeRunOutcome::default()) }.boxed()
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
