use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio_util::task::TaskTracker;

use super::{CodexServiceRecovery, CodexServiceRecoveryDependencies};
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::events::CodexServiceRecoveryCause;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, TestCodexSession, fork_reply, no_turns, one_folder_spawn_contexts,
};
use crate::driver::codex::thread::settings::CodexThreadSettings;
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::ports::{ProcessGoneListener, SessionRelaunchListener};
use crate::driver::session_control::DriverResumeResult;
use crate::driver::test_registry::new_run_id;
use crate::port::reviewer_denial::{ProviderReviewerDenial, ReviewerDenialPort};
use crate::port::run_host::test_host::{EngineCall, RecordingRunEngine};
use sidekicks_std::port_registration::PortRegistration;

// What the stand-ins for the reviewer denials and the queue heard, in order, each with the turn
// ends the run engine took before it.
struct Steps {
    engine: Arc<RecordingRunEngine>,
    heard: Mutex<Vec<(String, Vec<EngineCall>)>>,
}

impl Steps {
    fn new(engine: &Arc<RecordingRunEngine>) -> Self {
        Self {
            engine: Arc::clone(engine),
            heard: Mutex::default(),
        }
    }

    fn push(&self, step: String) {
        lock(&self.heard).push((step, self.engine.turn_ends()));
    }

    fn read(&self) -> Vec<(String, Vec<EngineCall>)> {
        lock(&self.heard).clone()
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
            run_ends: Arc::clone(&session.engine) as _,
            dispatch: Arc::clone(&session.engine) as _,
            reviewer_denials,
            process_gone,
            session_relaunched,
            rate_limits: CodexRateLimitFiling::new(
                Arc::clone(&session.engine) as _,
                one_folder_spawn_contexts(folder.join("work")),
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

// Serves, as the service, every conversation it is asked to resume, with no turns on it.
async fn serve_resumes(mut script: ScriptedService, settings: CodexThreadSettings) {
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
    let steps = Arc::new(Steps::new(&session.engine));
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

    let ended = vec![EngineCall::EndTurnOnProcessExit(run_id)];
    assert_eq!(session.engine.turn_ends(), ended);
    assert_eq!(
        steps.read(),
        [
            (format!("release {binding_id:?}"), ended.clone()),
            (format!("gone {session_id}"), ended),
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
// restart's failure where it read an exit. Runs in real time under a bound, the service answering
// on its own task.
#[tokio::test]
async fn a_crash_loop_names_its_newest_exit_and_only_the_persons_restart_tells_the_session() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut session = TestCodexSession::start().await;
        session.scripted.report_version("codex-cli 0.163.0");
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let steps = Arc::new(Steps::new(&session.engine));
        let recovery = test_recovery(&session, folder.path(), &steps);
        let service = Arc::clone(&session.scripted.service);
        let settings = session.task.record.thread_settings.clone();
        let session_id = session.task.record.session_id;
        let service_side = tokio::spawn(serve_resumes(session.scripted.script, settings));
        let notices = || {
            notices_on(&session.engine, session_id)
                .into_iter()
                .map(|notice| {
                    (
                        notice["kind"]
                            .as_str()
                            .expect("a notice names its kind")
                            .to_owned(),
                        notice["exitCode"].as_i64(),
                    )
                })
                .collect::<Vec<_>>()
        };
        session
            .task
            .drive(async {
                recovery.forget_exit(&service);
                recovery
                    .recover(&service, CodexServiceRecoveryCause::Crash)
                    .await;
            })
            .await;
        assert_eq!(notices(), Vec::new());

        // Each exit is remembered and forgotten as the service's own events do it.
        session
            .task
            .drive(async {
                for code in [1, 137] {
                    recovery.remember_exit(&service, exit_code(code));
                    recovery
                        .end_turns_on_exit(&service, Some(exit_code(code)))
                        .await;
                }
                // The exit read wins over the failure of the restart that filled the window.
                recovery
                    .crash_loop(&service, Some(&restart_failure()))
                    .await;
                recovery.forget_exit(&service);
                recovery
                    .recover(&service, CodexServiceRecoveryCause::PersonRestart)
                    .await;
            })
            .await;
        assert_eq!(
            notices(),
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
// it once logged instead, and by naming an ending the daemon never read, among them one read before
// a restart that succeeded. Real time under a bound, the service answering on its own task.
#[tokio::test]
async fn a_loop_of_failed_restarts_after_an_unread_end_names_the_restarts_failure() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut session = TestCodexSession::start().await;
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let steps = Arc::new(Steps::new(&session.engine));
        let recovery = test_recovery(&session, folder.path(), &steps);
        let service = Arc::clone(&session.scripted.service);
        let session_id = session.task.record.session_id;
        let settings = session.task.record.thread_settings.clone();
        let service_side = tokio::spawn(serve_resumes(session.scripted.script, settings));

        session
            .task
            .drive(async {
                recovery.remember_exit(&service, exit_code(1));
                recovery
                    .end_turns_on_exit(&service, Some(exit_code(1)))
                    .await;
                recovery.forget_exit(&service);
                recovery
                    .recover(&service, CodexServiceRecoveryCause::Crash)
                    .await;
                recovery.end_turns_on_exit(&service, None).await;
                recovery
                    .crash_loop(&service, Some(&restart_failure()))
                    .await;
            })
            .await;

        let notices: Vec<_> = notices_on(&session.engine, session_id)
            .into_iter()
            .map(|notice| {
                (
                    notice["kind"]
                        .as_str()
                        .expect("a notice names its kind")
                        .to_owned(),
                    notice["startFailure"].as_str().map(str::to_owned),
                    notice["exitCode"].is_null() && notice["signal"].is_null(),
                )
            })
            .collect();
        assert_eq!(
            notices,
            [(
                "providerCrashLoop".to_owned(),
                Some(restart_failure().to_string()),
                true
            )]
        );
        service_side.abort();
    })
    .await
    .expect("the crash loop is told within the bound");
}

// The payload of each notice delivered on `session_id`, in order.
fn notices_on(engine: &RecordingRunEngine, session_id: SessionId) -> Vec<Value> {
    engine
        .deliveries()
        .into_iter()
        .filter(|delivery| {
            delivery.kind == "sessionNotice" && delivery.session_id == Some(session_id)
        })
        .map(|delivery| delivery.payload.expect("a notice carries its payload"))
        .collect()
}
