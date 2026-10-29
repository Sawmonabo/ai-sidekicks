use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::daemon::recovery::DaemonRecoveryHaltedRun;
use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
use sidekicks_provider::driver::session_control::{
    DriverResumeResult, ProviderTurnAnswer, ResumeSessionParams, ResumedRunAnswer,
};
use sidekicks_provider::runtime_binding::test_store::spawned_build;
use sidekicks_session::run::engine::test_fixture::{insert_running_run, stored_run_state};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::test_run_id;
use tokio_util::sync::CancellationToken;

use crate::test_pass::PassFixture;

/// The words a refused resume's provider gives.
const REFUSED_DETAIL: &str = "The conversation could not be found";

// A resume that went on under `binding_id`, answered from the resume's own params: every run it
// names still holds its turn.
fn resumed_on(params: &ResumeSessionParams, binding_id: RuntimeBindingId) -> DriverResumeResult {
    DriverResumeResult::Resumed {
        binding_id,
        session_position: SafeInt::ZERO,
        resume_handle: NonEmptyText::new(params.resume_handle.clone()).expect("a resume handle"),
        spawned_version: spawned_build("1.0.1", "/opt/provider/bin"),
        runs: params
            .live_runs
            .iter()
            .map(|run| ResumedRunAnswer {
                run_id: run.run_id,
                turn: ProviderTurnAnswer::StillRunning,
            })
            .collect(),
    }
}

// A driver that resumes once, answering from the resume's params through `answer`.
fn resuming_driver(
    answer: impl Fn(&ResumeSessionParams) -> DriverResumeResult + Send + Sync + 'static,
) -> MockProviderDriver {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_resume_session()
        .times(1)
        .returning(move |params| {
            let answered = answer(&params);
            async move { Ok(answered) }.boxed()
        });
    driver
}

impl PassFixture {
    // Ends the store's seeded run, so only the test's sessions hold work in progress.
    fn end_seeded_run(&self) {
        self.store
            .database
            .reader()
            .execute(
                "UPDATE runs SET state = 'completed' WHERE run_id = ?1",
                [self.store.run_id.text().as_str()],
            )
            .expect("the seeded run ended");
    }

    // A new session with a running run on the table's provider at `provider_index`, its
    // conversation held by a binding of the run; answers the session, the run and the binding.
    async fn running_session(&self, provider_index: usize) -> (SessionId, RunId, RuntimeBindingId) {
        let session_id = self.new_session();
        let run_id = test_run_id();
        insert_running_run(&self.store.database, session_id, run_id);
        let binding_id = self.bind_resumable(run_id, provider_index).await;
        (session_id, run_id, binding_id)
    }

    // The runs the status read lists under `session_id` as needing the person.
    async fn halted_runs(&self, session_id: SessionId) -> Option<Vec<DaemonRecoveryHaltedRun>> {
        self.status
            .read(&self.store.reads)
            .await
            .sessions
            .into_iter()
            .find(|session| session.session_id == session_id)
            .and_then(|session| session.halted_runs)
    }

    // The runtime bindings recorded for `run_id`.
    fn binding_count(&self, run_id: RunId) -> i64 {
        self.store
            .database
            .reader()
            .query_row(
                "SELECT COUNT(*) FROM runtime_bindings WHERE run_id = ?1",
                [run_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the bindings read")
    }
}

// Two sessions with a run in progress at the restart: one whose provider kept its process across
// the restart and answers on the binding that brought it up, as a lasting service does, and one
// whose conversation is relaunched under the binding the resume minted. Each run is named to its
// provider, still running after the pass with no end written, the relaunched one under a binding
// recorded for it; a completed session is not opened, and the pass counts one binding restored and
// two runs resumed. Killed by the settle failing a resumed run (a run reads `failed`), by the
// resume skipped (each driver's one resume is missed), and by the counts left zero.
#[tokio::test]
async fn a_pass_resumes_each_session_with_work_in_progress_and_counts_it() {
    let kept_leg: Arc<Mutex<Option<RuntimeBindingId>>> = Arc::default();
    let kept = resuming_driver({
        let kept_leg = Arc::clone(&kept_leg);
        move |params| {
            let leg = lock(&kept_leg)
                .clone()
                .expect("the kept session's leg is recorded");
            resumed_on(params, leg)
        }
    });
    let relaunched = resuming_driver(|params| resumed_on(params, params.binding_id.clone()));
    let fixture = PassFixture::over_drivers(vec![
        Arc::new(kept) as Arc<dyn ProviderDriver>,
        Arc::new(relaunched),
    ])
    .await;
    fixture.end_seeded_run();
    let (kept_session, kept_run, kept_binding) = fixture.running_session(0).await;
    *lock(&kept_leg) = Some(kept_binding);
    let (relaunched_session, relaunched_run, _) = fixture.running_session(1).await;

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;

    for (session_id, run_id) in [
        (kept_session, kept_run),
        (relaunched_session, relaunched_run),
    ] {
        assert_eq!(
            stored_run_state(&fixture.store.database, &run_id).0,
            "running"
        );
        for ended in [
            SessionEventType::AgentRunFailed,
            SessionEventType::AgentRunInterrupted,
        ] {
            assert!(fixture.payloads(&session_id, ended).is_empty(), "{ended:?}");
        }
    }
    assert_eq!(fixture.binding_count(kept_run), 1);
    assert_eq!(fixture.binding_count(relaunched_run), 2);
    let succeeded = fixture.payloads(
        &DAEMON_SCOPE_SENTINEL_SESSION_ID,
        SessionEventType::DaemonRecoverySucceeded,
    );
    let [succeeded] = succeeded.as_slice() else {
        panic!("one pass succeeded: {succeeded:?}");
    };
    assert_eq!(succeeded["bindingsRestored"], json!(1));
    assert_eq!(succeeded["runsResumed"], json!(2));
    assert_eq!(succeeded["runsFailedDeterministically"], json!(0));
}

// A resume the provider refuses fails the session's running run with the provider's own words, and
// the status read lists the run under its session with what its recovery needs and a provider
// failure; once the session's next run starts, the entry is gone. Killed by `mark_run_halted` not
// called (no entry), by the restart's own words written (the detail differs), and by the entry
// never cleared.
#[tokio::test]
async fn a_refused_resume_fails_its_run_and_lists_it_until_the_sessions_next_run() {
    let refusing = resuming_driver(|_params| DriverResumeResult::Failed {
        recovery_condition: RecoveryCondition::RecoveryNeeded,
        provider_failure_detail: FreeFormText::new(REFUSED_DETAIL.to_owned())
            .expect("the refusal's words"),
    });
    let fixture =
        PassFixture::over_drivers(vec![Arc::new(refusing) as Arc<dyn ProviderDriver>]).await;
    let _run_starts = fixture.status.follow_run_starts(&fixture.followers);
    fixture.end_seeded_run();
    let (session_id, run_id, _) = fixture.running_session(0).await;

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;

    assert_eq!(
        stored_run_state(&fixture.store.database, &run_id).0,
        "failed"
    );
    let failed = fixture.payloads(&session_id, SessionEventType::AgentRunFailed);
    let [failed] = failed.as_slice() else {
        panic!("the run failed once: {failed:?}");
    };
    assert_eq!(failed["providerFailureDetail"], json!(REFUSED_DETAIL));
    assert_eq!(
        fixture.halted_runs(session_id).await,
        Some(vec![DaemonRecoveryHaltedRun {
            run_id,
            recovery_condition: RecoveryCondition::RecoveryNeeded,
            failure_category: Some(RunFailureCategory::ProviderFailure),
        }])
    );

    let next_run = test_run_id();
    fixture
        .append(
            session_id,
            json!({
                "type": "agent.run.starting",
                "payload": {"sessionId": session_id, "runId": next_run, "runVersion": 1,
                            "previousState": "queued", "newState": "starting"},
            }),
        )
        .await;

    assert_eq!(fixture.halted_runs(session_id).await, None);
}
