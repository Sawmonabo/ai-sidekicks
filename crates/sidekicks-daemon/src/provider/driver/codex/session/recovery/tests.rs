use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::json;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use tokio_util::task::TaskTracker;

use super::{CodexRunEnds, CodexServiceRecovery, CodexServiceRecoveryDependencies};
use crate::provider::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::provider::driver::codex::service::registry::CodexServiceRegistry;
use crate::provider::driver::codex::service::supervisor::events::CodexServiceRecoveryCause;
use crate::provider::driver::codex::session::test_session::{
    OneFolder, TEST_THREAD, TestCodexSession, fork_reply, new_run_id, no_turns,
};
use crate::provider::driver::ports::{ProcessGoneListener, SessionRelaunchListener};
use crate::provider::driver::session_control::DriverResumeResult;
use crate::provider::port::registration::PortRegistration;
use crate::provider::port::reviewer_denial::{ProviderReviewerDenial, ReviewerDenialPort};
use crate::session::run::engine::RunEngineError;

// What the stand-ins for the run engine, the reviewer denials and the queue heard, in order.
#[derive(Default)]
struct Steps(Mutex<Vec<String>>);

impl Steps {
    fn push(&self, step: String) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(step);
    }

    fn read(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

struct HeardEnds(Arc<Steps>);

impl CodexRunEnds for HeardEnds {
    fn end_turn_on_process_exit(
        &self,
        run_id: RunId,
        _process_exit: ProcessExit,
    ) -> BoxFuture<'_, Result<(), RunEngineError>> {
        self.0.push(format!("end {run_id}"));
        async { Ok(()) }.boxed()
    }

    fn end_turn_on_close(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunEngineError>> {
        self.0.push(format!("close {run_id}"));
        async { Ok(()) }.boxed()
    }
}

struct HeardDenials(Arc<Steps>);

impl ReviewerDenialPort for HeardDenials {
    fn take_denial(
        &self,
        _denial: ProviderReviewerDenial,
    ) -> BoxFuture<'_, Result<(), Box<dyn std::error::Error + Send + Sync>>> {
        async { Ok(()) }.boxed()
    }

    fn release_held_presses(&self, binding_id: &RuntimeBindingId) {
        self.0.push(format!("release {binding_id:?}"));
    }
}

struct HeardGone(Arc<Steps>);

impl ProcessGoneListener for HeardGone {
    fn process_gone(&self, session_id: SessionId) {
        self.0.push(format!("gone {session_id}"));
    }
}

struct TakenRelaunches;

impl SessionRelaunchListener for TakenRelaunches {
    fn session_relaunched(
        &self,
        _session_id: SessionId,
        _result: DriverResumeResult,
    ) -> BoxFuture<'_, Result<(), Box<dyn std::error::Error + Send + Sync>>> {
        async { Ok(()) }.boxed()
    }
}

// Recovery on the test session's service and database, its ports the stand-ins above.
fn test_recovery(
    session: &TestCodexSession,
    folder: &Path,
    steps: &Arc<Steps>,
) -> Arc<CodexServiceRecovery> {
    let reviewer_denials = Arc::new(PortRegistration::new("reviewer denial"));
    reviewer_denials
        .register(Arc::new(HeardDenials(Arc::clone(steps))) as Arc<dyn ReviewerDenialPort>)
        .expect("the port registers once");
    let process_gone = Arc::new(PortRegistration::new("process gone"));
    process_gone
        .register(Arc::new(HeardGone(Arc::clone(steps))) as Arc<dyn ProcessGoneListener>)
        .expect("the port registers once");
    let session_relaunched = Arc::new(PortRegistration::new("session relaunched"));
    session_relaunched
        .register(Arc::new(TakenRelaunches) as Arc<dyn SessionRelaunchListener>)
        .expect("the port registers once");
    Arc::new(CodexServiceRecovery::new(
        CodexServiceRecoveryDependencies {
            slots: Arc::clone(&session.slots),
            establishment: Arc::new(session.establishment(folder)),
            services: CodexServiceRegistry::holding(&session.scripted),
            release: Arc::clone(&session.scripted.dependencies.release),
            run_ends: Arc::new(HeardEnds(Arc::clone(steps))),
            dispatch: Arc::clone(&session.dispatch),
            reviewer_denials,
            process_gone,
            session_relaunched,
            rate_limits: CodexRateLimitFiling {
                dispatch: Arc::clone(&session.dispatch),
                spawn_contexts: Arc::new(OneFolder(folder.join("work"))),
            },
            tasks: TaskTracker::new(),
        },
    ))
}

fn exit_code_one() -> ProcessExit {
    serde_json::from_value(json!({"exitCode": 1, "outputTail": "the service ended"}))
        .expect("the test writes an exit")
}

// Killed by telling the queue the process is gone before the paused run's turns end, which has
// the queue settle the continue it kept against a run still live, and before the held presses of
// `Allow once` are released.
#[tokio::test(start_paused = true)]
async fn a_process_exit_ends_the_paused_run_and_releases_its_presses_before_the_queue_hears() {
    let mut session = TestCodexSession::start().await;
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let steps = Arc::new(Steps::default());
    let recovery = test_recovery(&session, folder.path(), &steps);
    let binding_id = session.record_binding().await;
    let run_id = new_run_id();
    let session_id = session.task.record.session_id;
    session.task.record.binding_id = Some(binding_id.clone());
    session
        .task
        .record
        .paused_run_id_by_interrupted_turn_id
        .insert("turn-1".to_owned(), run_id);
    let service = Arc::clone(&session.scripted.service);

    session
        .task
        .drive(recovery.end_turns_on_exit(&service, Some(exit_code_one())))
        .await;

    assert_eq!(
        steps.read(),
        [
            format!("end {run_id}"),
            format!("release {binding_id:?}"),
            format!("gone {session_id}"),
        ]
    );
    assert!(
        session
            .task
            .record
            .paused_run_id_by_interrupted_turn_id
            .is_empty()
    );
}

// Killed by a notice after a crash restart, and by the person's restart telling no session it
// brought back. Runs in real time under a bound, since the notices are written to the database.
#[tokio::test]
async fn only_the_persons_restart_of_a_crash_loop_tells_the_session_it_brought_back() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut session = TestCodexSession::start().await;
        session.scripted.report_version("codex-cli 0.163.0");
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let steps = Arc::new(Steps::default());
        let recovery = test_recovery(&session, folder.path(), &steps);
        let service = Arc::clone(&session.scripted.service);
        let settings = session.task.record.thread_settings.clone();
        let session_id = session.task.record.session_id;
        let mut script = session.scripted.script;
        // The service resumes every conversation it is asked to, with no turns on it.
        let service_side = tokio::spawn(async move {
            loop {
                let sent = script.next_sent().await;
                let answer = match sent["method"].as_str() {
                    Some("thread/resume") => fork_reply(TEST_THREAD, &settings),
                    Some("thread/turns/list") => no_turns(),
                    Some("thread/settings/update") => json!({}),
                    Some("account/rateLimits/read") => json!({"rateLimits": null}),
                    method => panic!("the service was not asked {method:?}"),
                };
                script.answer(&sent, &answer);
            }
        });
        let notices = |database: &crate::database::writer::test_file::TestDatabase| {
            database
                .reader()
                .prepare(
                    "SELECT json_extract(payload, '$.kind') FROM session_events
                     WHERE session_id = ?1 AND type = 'session.notice.posted' ORDER BY sequence",
                )
                .and_then(|mut statement| {
                    statement
                        .query_map([session_id.text().as_str()], |row| row.get::<_, String>(0))?
                        .collect::<Result<Vec<String>, _>>()
                })
                .expect("the test reads the session's notices")
        };

        session
            .task
            .drive(recovery.recover(&service, CodexServiceRecoveryCause::Crash))
            .await;
        assert_eq!(notices(&session.database), Vec::<String>::new());

        session
            .task
            .drive(async {
                recovery
                    .end_turns_on_exit(&service, Some(exit_code_one()))
                    .await;
                recovery.crash_loop(&service).await;
                recovery
                    .recover(&service, CodexServiceRecoveryCause::PersonRestart)
                    .await;
            })
            .await;
        assert_eq!(
            notices(&session.database),
            ["providerCrashLoop", "providerRestarted"]
        );
        service_side.abort();
    })
    .await
    .expect("the recovery ends within the bound");
}
