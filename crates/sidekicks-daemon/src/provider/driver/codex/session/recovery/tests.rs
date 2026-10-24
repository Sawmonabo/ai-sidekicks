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
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::test_session::{
    OneFolder, TEST_THREAD, TestCodexSession, fork_reply, no_turns,
};
use crate::provider::driver::ports::{ProcessGoneListener, SessionRelaunchListener};
use crate::provider::driver::session_control::DriverResumeResult;
use crate::provider::driver::test_registry::new_run_id;
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
            rate_limits: CodexRateLimitFiling::new(
                Arc::clone(&session.dispatch),
                Arc::new(OneFolder(folder.join("work"))),
            ),
            tasks: TaskTracker::new(),
        },
    ))
}

fn restart_failure() -> CodexError {
    CodexError::Transport {
        detail: "The Codex service could not be started.".to_owned(),
        cause: None,
    }
}

fn exit_code(code: u8) -> ProcessExit {
    serde_json::from_value(json!({"exitCode": code, "outputTail": "the service ended"}))
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
        .drive(recovery.end_turns_on_exit(&service, Some(exit_code(1))))
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

// Killed by a notice after a crash restart, by the person's restart telling no session it
// brought back, by a crash loop naming an exit older than its newest, and by one naming its
// restart's failure where it read an exit. Runs in real time under
// a bound, since the notices are written to the database.
#[tokio::test]
async fn a_crash_loop_names_its_newest_exit_and_only_the_persons_restart_tells_the_session() {
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
                    "SELECT json_extract(payload, '$.kind'), json_extract(payload, '$.exitCode')
                     FROM session_events
                     WHERE session_id = ?1 AND type = 'session.notice.posted' ORDER BY sequence",
                )
                .and_then(|mut statement| {
                    statement
                        .query_map([session_id.text().as_str()], |row| {
                            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
                        })?
                        .collect::<Result<Vec<_>, _>>()
                })
                .expect("the test reads the session's notices")
        };

        session
            .task
            .drive(recovery.recover(&service, CodexServiceRecoveryCause::Crash))
            .await;
        assert_eq!(notices(&session.database), Vec::new());

        session
            .task
            .drive(async {
                for code in [1, 137] {
                    recovery
                        .end_turns_on_exit(&service, Some(exit_code(code)))
                        .await;
                }
                // The exit read wins over the failure of the restart that filled the window.
                recovery
                    .crash_loop(&service, Some(&restart_failure()))
                    .await;
                recovery
                    .recover(&service, CodexServiceRecoveryCause::PersonRestart)
                    .await;
            })
            .await;
        assert_eq!(
            notices(&session.database),
            [
                ("providerCrashLoop".to_owned(), Some(137)),
                ("providerRestarted".to_owned(), None),
            ]
        );
        service_side.abort();
    })
    .await
    .expect("the recovery ends within the bound");
}

// Killed by posting nothing for a loop of failed restarts after an end no wait read, the warning
// it once logged instead, and by naming an ending the daemon never read. Real time under a bound,
// since the notice is written to the database.
#[tokio::test]
async fn a_loop_of_failed_restarts_after_an_unread_end_names_the_restarts_failure() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut session = TestCodexSession::start().await;
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let steps = Arc::new(Steps::default());
        let recovery = test_recovery(&session, folder.path(), &steps);
        let service = Arc::clone(&session.scripted.service);
        let session_id = session.task.record.session_id;

        session
            .task
            .drive(async {
                recovery.end_turns_on_exit(&service, None).await;
                recovery
                    .crash_loop(&service, Some(&restart_failure()))
                    .await;
            })
            .await;

        let notices = session
            .database
            .reader()
            .prepare(
                "SELECT json_extract(payload, '$.kind'), json_extract(payload, '$.startFailure'),
                        json_extract(payload, '$.exitCode') IS NULL
                           AND json_extract(payload, '$.signal') IS NULL
                 FROM session_events
                 WHERE session_id = ?1 AND type = 'session.notice.posted' ORDER BY sequence",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([session_id.text().as_str()], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, bool>(2)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()
            })
            .expect("the test reads the session's notices");
        assert_eq!(
            notices,
            [(
                "providerCrashLoop".to_owned(),
                Some(restart_failure().to_string()),
                true
            )]
        );
    })
    .await
    .expect("the crash loop is told within the bound");
}
