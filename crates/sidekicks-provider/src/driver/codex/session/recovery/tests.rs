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
use sidekicks_std::port_registration::PortRegistration;
use tokio_util::task::TaskTracker;

use super::{CodexServiceRecovery, CodexServiceRecoveryDependencies};
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::run::turn_end_waiters::CodexRecordExit;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::events::CodexServiceRecoveryCause;
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service_whose_start_waits;
use crate::driver::codex::session::errors::{CodexError, CodexSessionSlotState};
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::codex::session::test_fixture::{
    RefusedRelaunchStep, TEST_THREAD, TakenRelaunches, TestCodexSession, TestCodexTask, fork_reply,
    no_turns,
};
use crate::driver::codex::thread::settings::CodexThreadSettings;
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::ports::{ProcessGoneListener, SessionRelaunchListener};
use crate::driver::session_control::ProviderBuildChange;
use crate::driver::test_registry::new_run_id;
use crate::port::reviewer_denial::{ProviderReviewerDenial, ReviewerDenialPort};
use crate::port::run_host::test_host::{EngineCall, RecordingRunEngine};

// What the stand-ins for the reviewer denials and the queue heard, in order, each with the turn
// ends the run engine took before it, and what held each gone session's slot as the queue heard.
struct Steps {
    engine: Arc<RecordingRunEngine>,
    slots: Arc<CodexSessionSlots>,
    heard: Mutex<Vec<(String, Vec<EngineCall>)>>,
    holders_at_gone: Mutex<Vec<Option<CodexSessionSlotState>>>,
}

impl Steps {
    fn new(session: &TestCodexSession) -> Self {
        Self {
            engine: Arc::clone(&session.engine),
            slots: Arc::clone(&session.slots),
            heard: Mutex::default(),
            holders_at_gone: Mutex::default(),
        }
    }

    fn push(&self, step: String) {
        lock(&self.heard).push((step, self.engine.turn_ends()));
    }

    fn read(&self) -> Vec<(String, Vec<EngineCall>)> {
        lock(&self.heard).clone()
    }

    fn holders_at_gone(&self) -> Vec<Option<CodexSessionSlotState>> {
        lock(&self.holders_at_gone).clone()
    }
}

// How many times the queue heard `session_id`'s process gone.
fn gone_steps(steps: &Steps, session_id: SessionId) -> usize {
    let gone = format!("gone {session_id}");
    steps
        .read()
        .iter()
        .filter(|(step, _)| *step == gone)
        .count()
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
        lock(&self.0.holders_at_gone).push(self.0.slots.describe_holder(session_id));
        self.0.push(format!("gone {session_id}"));
    }
}

// Recovery on the test session's service and database, its ports the stand-ins above, the session
// directory's refusing what `refused` names.
fn test_recovery(
    session: &TestCodexSession,
    folder: &Path,
    steps: &Arc<Steps>,
    refused: RefusedRelaunchStep,
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
    let heard = Arc::clone(steps);
    let relaunches: Arc<dyn SessionRelaunchListener> = Arc::new(TakenRelaunches {
        heard: Box::new(move |step| heard.push(step)),
        refused,
    });
    session_relaunched
        .register(relaunches)
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
            rate_limits: CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage"))),
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

// Serves, as the service, every conversation it is asked to resume, with no turns on it, each
// resume a step of `steps`.
async fn serve_resumes(
    mut script: ScriptedService,
    settings: CodexThreadSettings,
    steps: Arc<Steps>,
) {
    loop {
        let sent = script.next_sent().await;
        let answer = match sent["method"].as_str() {
            Some("thread/resume") => {
                steps.push("resume".to_owned());
                fork_reply(TEST_THREAD, &settings)
            }
            Some("thread/turns/list") => no_turns(),
            Some("thread/settings/update") => json!({}),
            Some("account/rateLimits/read") => json!({"rateLimits": null}),
            method => panic!("the service was not asked {method:?}"),
        };
        script.answer(&sent, &answer);
    }
}

// The steps of each relaunch: its opening, its resume and its report.
fn relaunch_steps(steps: &Steps) -> Vec<String> {
    steps
        .read()
        .into_iter()
        .map(|(step, _)| step)
        .filter(|step| {
            step.starts_with("opened") || step == "resume" || step.starts_with("relaunched")
        })
        .collect()
}

fn exit_code(code: u8) -> ProcessExit {
    serde_json::from_value(json!({"exitCode": code, "outputTail": "the service ended"}))
        .expect("the test writes an exit")
}

fn silent_end() -> ProcessExit {
    serde_json::from_value(json!({"silentSeconds": 120, "outputTail": "(no output)"}))
        .expect("the test writes a silent end")
}

// Killed by telling the queue the process is gone before the paused run's turns end, which has
// the queue settle the continue it kept against a run still live, and before the held presses of
// `Allow once` are released.
#[tokio::test(start_paused = true)]
async fn a_process_exit_ends_the_paused_run_and_releases_its_presses_before_the_queue_hears() {
    let mut session = TestCodexSession::start().await;
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let steps = Arc::new(Steps::new(&session));
    let recovery = test_recovery(
        &session,
        folder.path(),
        &steps,
        RefusedRelaunchStep::Nothing,
    );
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
// brought back, by a crash loop naming an exit older than its newest, by one naming its restart's
// failure where it read an exit, and by a silent end's loop naming anything but its silence. Runs
// in real time under a bound, the service answering on its own task.
#[tokio::test]
async fn a_crash_loop_names_its_newest_exit_and_only_the_persons_restart_tells_the_session() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut session = TestCodexSession::start().await;
        session.scripted.report_version("codex-cli 0.163.0");
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let steps = Arc::new(Steps::new(&session));
        let recovery = test_recovery(
            &session,
            folder.path(),
            &steps,
            RefusedRelaunchStep::Nothing,
        );
        let service = Arc::clone(&session.scripted.service);
        let settings = session.task.record.thread_settings.clone();
        let session_id = session.task.record.session_id;
        let service_side = tokio::spawn(serve_resumes(
            session.scripted.script,
            settings,
            Arc::clone(&steps),
        ));
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
                        notice["silentSeconds"].as_i64(),
                    )
                })
                .collect::<Vec<_>>()
        };
        session
            .task
            .drive(async {
                let _ended = recovery.take_exit(&service);
                let generation = recovery.owe_resumes(&service);
                recovery
                    .recover(&service, CodexServiceRecoveryCause::Crash, generation, None)
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
                // The exit read wins over the failure of the restart that filled the window, and
                // the queue hears the session's process gone at the crash loop itself.
                let gone_before = gone_steps(&steps, session_id);
                recovery
                    .crash_loop(&service, Some(&restart_failure()))
                    .await;
                assert_eq!(gone_steps(&steps, session_id), gone_before + 1);
                let _ended = recovery.take_exit(&service);
                let generation = recovery.owe_resumes(&service);
                recovery
                    .recover(
                        &service,
                        CodexServiceRecoveryCause::PersonRestart,
                        generation,
                        None,
                    )
                    .await;
            })
            .await;
        assert_eq!(
            notices(),
            [
                ("providerCrashLoop".to_owned(), Some(137), None),
                ("providerRestarted".to_owned(), None, None),
            ]
        );
        // Each relaunch's binding is opened before its resume and is the one it reports.
        let relaunch_steps = relaunch_steps(&steps);
        assert_eq!(relaunch_steps.len(), 6, "{relaunch_steps:?}");
        for relaunch in relaunch_steps.chunks(3) {
            let opened = relaunch[0]
                .strip_prefix("opened ")
                .expect("a relaunch opens its binding first");
            assert_eq!(relaunch[1], "resume", "{relaunch:?}");
            assert_eq!(relaunch[2], format!("relaunched Some({opened})"));
        }

        // The daemon ended the service for its silence, and five such ends left it down.
        session
            .task
            .drive(async {
                recovery.remember_exit(&service, silent_end());
                recovery
                    .end_turns_on_exit(&service, Some(silent_end()))
                    .await;
                recovery.crash_loop(&service, None).await;
            })
            .await;
        assert_eq!(
            notices().last(),
            Some(&("providerCrashLoop".to_owned(), None, Some(120)))
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
        session.scripted.report_version("codex-cli 0.163.0");
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let steps = Arc::new(Steps::new(&session));
        let recovery = test_recovery(
            &session,
            folder.path(),
            &steps,
            RefusedRelaunchStep::Nothing,
        );
        let service = Arc::clone(&session.scripted.service);
        let session_id = session.task.record.session_id;
        let settings = session.task.record.thread_settings.clone();
        let service_side = tokio::spawn(serve_resumes(
            session.scripted.script,
            settings,
            Arc::clone(&steps),
        ));

        session
            .task
            .drive(async {
                recovery.remember_exit(&service, exit_code(1));
                recovery
                    .end_turns_on_exit(&service, Some(exit_code(1)))
                    .await;
                let _ended = recovery.take_exit(&service);
                let generation = recovery.owe_resumes(&service);
                recovery
                    .recover(&service, CodexServiceRecoveryCause::Crash, generation, None)
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

// Killed by a crash loop that leaves a resume its service owed: the session reads restarting at
// the notice, so the queue keeps a process that stays down.
#[tokio::test(start_paused = true)]
async fn a_crash_loop_while_resumes_are_owed_reads_down_at_the_notice() {
    let session = TestCodexSession::start().await;
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let steps = Arc::new(Steps::new(&session));
    let recovery = test_recovery(
        &session,
        folder.path(),
        &steps,
        RefusedRelaunchStep::Nothing,
    );
    let service = Arc::clone(&session.scripted.service);
    let session_id = session.task.record.session_id;
    recovery.owe_resumes(&service);
    assert_eq!(
        session.slots.describe_holder(session_id),
        Some(CodexSessionSlotState::Establishing)
    );

    recovery
        .crash_loop(&service, Some(&restart_failure()))
        .await;

    assert_eq!(steps.holders_at_gone(), [Some(CodexSessionSlotState::Live)]);
}

// Killed by a recovery that settles the resumes a later one owes: the session reads live before
// the later recovery claimed its slot, so a move or a run reaches a conversation not yet resumed.
#[tokio::test]
async fn a_recovery_s_end_leaves_the_resumes_a_later_recovery_owes() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut session = TestCodexSession::start().await;
        session.scripted.report_version("codex-cli 0.163.0");
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let steps = Arc::new(Steps::new(&session));
        let recovery = test_recovery(
            &session,
            folder.path(),
            &steps,
            RefusedRelaunchStep::Nothing,
        );
        let service = Arc::clone(&session.scripted.service);
        let session_id = session.task.record.session_id;
        let slots = Arc::clone(&session.slots);
        let settings = session.task.record.thread_settings.clone();
        let service_side = tokio::spawn(serve_resumes(
            session.scripted.script,
            settings,
            Arc::clone(&steps),
        ));

        let first = recovery.owe_resumes(&service);
        let second = recovery.owe_resumes(&service);
        session
            .task
            .drive(async {
                recovery
                    .recover(&service, CodexServiceRecoveryCause::Crash, first, None)
                    .await;
            })
            .await;
        assert_eq!(
            slots.describe_holder(session_id),
            Some(CodexSessionSlotState::Establishing)
        );

        session
            .task
            .drive(async {
                recovery
                    .recover(&service, CodexServiceRecoveryCause::Crash, second, None)
                    .await;
            })
            .await;
        assert_eq!(
            slots.describe_holder(session_id),
            Some(CodexSessionSlotState::Live)
        );
        service_side.abort();
    })
    .await
    .expect("both recoveries end within the bound");
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

// Killed by a resume sent after the relaunch's binding could not be opened: the relaunch is
// reported failed, the service is asked no `thread/resume`, and the failure is taken as a refusal,
// the record let go and the queue told once. Real time under a bound, the service answering on its
// own task.
#[tokio::test]
async fn a_relaunch_whose_binding_cannot_open_resumes_nothing() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut session = TestCodexSession::start().await;
        session.scripted.report_version("codex-cli 0.163.0");
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let steps = Arc::new(Steps::new(&session));
        let recovery = test_recovery(
            &session,
            folder.path(),
            &steps,
            RefusedRelaunchStep::Opening,
        );
        let service = Arc::clone(&session.scripted.service);
        let settings = session.task.record.thread_settings.clone();
        let service_side = tokio::spawn(serve_resumes(
            session.scripted.script,
            settings,
            Arc::clone(&steps),
        ));

        session
            .task
            .drive(async {
                let _ended = recovery.take_exit(&service);
                let generation = recovery.owe_resumes(&service);
                recovery
                    .recover(&service, CodexServiceRecoveryCause::Crash, generation, None)
                    .await;
            })
            .await;

        let relaunch = relaunch_steps(&steps);
        assert_eq!(relaunch.len(), 2, "{relaunch:?}");
        assert!(relaunch[0].starts_with("opened "), "{relaunch:?}");
        assert_eq!(relaunch[1], "relaunched None");
        assert_eq!(
            session.task.let_go_exits,
            [CodexRecordExit::SessionContinues],
            "the conversation is let go"
        );
        assert_eq!(
            steps.holders_at_gone(),
            [None],
            "the queue hears once, the slot empty"
        );
        service_side.abort();
    })
    .await
    .expect("the recovery ends within the bound");
}

// Killed by a resumed conversation left running when its record is refused: the conversation is
// let go and the queue told its process is gone. Real time under a bound, the service answering
// on its own task.
#[tokio::test]
async fn a_relaunch_whose_record_is_refused_lets_its_conversation_go() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut session = TestCodexSession::start().await;
        session.scripted.report_version("codex-cli 0.163.0");
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let steps = Arc::new(Steps::new(&session));
        let recovery = test_recovery(&session, folder.path(), &steps, RefusedRelaunchStep::Record);
        let service = Arc::clone(&session.scripted.service);
        let session_id = session.task.record.session_id;
        let settings = session.task.record.thread_settings.clone();
        let service_side = tokio::spawn(serve_resumes(
            session.scripted.script,
            settings,
            Arc::clone(&steps),
        ));

        session
            .task
            .drive(async {
                let _ended = recovery.take_exit(&service);
                let generation = recovery.owe_resumes(&service);
                recovery
                    .recover(&service, CodexServiceRecoveryCause::Crash, generation, None)
                    .await;
            })
            .await;

        let heard: Vec<String> = steps.read().into_iter().map(|(step, _)| step).collect();
        let relaunched = heard
            .iter()
            .position(|step| step.starts_with("relaunched Some"))
            .expect("the relaunch resumed and was reported");
        assert!(
            heard[relaunched + 1..].contains(&format!("gone {session_id}")),
            "the queue hears the process gone after the report: {heard:?}"
        );
        assert_eq!(
            session.task.let_go_exits,
            [CodexRecordExit::SessionContinues],
            "the conversation is let go"
        );
        assert!(
            session.slots.require_live(session_id).is_err(),
            "the slot holds no live record"
        );
        service_side.abort();
    })
    .await
    .expect("the recovery ends within the bound");
}

// Runs a build move on `session`'s account service: the old process's connection, set aside as
// it leaves, serves the new one, which `serve` answers on its own task once the supervisor's start
// is under way. Answers the move and the session's task.
async fn move_account_service_build<Served>(
    session: TestCodexSession,
    recovery: &Arc<CodexServiceRecovery>,
    serve: impl FnOnce(ScriptedService) -> Served,
) -> (Result<(), CodexError>, TestCodexTask)
where
    Served: Future<Output = ()> + Send + 'static,
{
    let TestCodexSession {
        scripted, mut task, ..
    } = session;
    let service = Arc::clone(&scripted.service);
    let change = ProviderBuildChange {
        from_version: "0.163.0".to_owned(),
        to_version: "0.164.0".to_owned(),
    };
    let connection = scripted.publish_reconnecting();
    let mut restarting = std::pin::pin!(recovery.restart_service(&service, Some(change)));
    task.drive(async {
        tokio::select! {
            restarted = &mut restarting => {
                panic!("the restart waits for its new process: {restarted:?}")
            }
            () = scripted.publish_up_once_starting(connection) => {}
        }
    })
    .await;
    let service_side = tokio::spawn(serve(scripted.script));
    let moved = task.drive(restarting).await;
    service_side.abort();
    (moved, task)
}

// An account service's session on a service whose own start waits, its recovery's ports the
// stand-ins above.
async fn account_build_move_session() -> (
    TestCodexSession,
    tempfile::TempDir,
    Arc<Steps>,
    Arc<CodexServiceRecovery>,
) {
    let session =
        TestCodexSession::start_on(start_scripted_codex_service_whose_start_waits()).await;
    session.scripted.report_version("codex-cli 0.163.0");
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let steps = Arc::new(Steps::new(&session));
    let recovery = test_recovery(
        &session,
        folder.path(),
        &steps,
        RefusedRelaunchStep::Nothing,
    );
    (session, folder, steps, recovery)
}

// Killed by a build move whose in-place resume on an account's service records no relaunch: the
// conversation resumes under a binding the session directory opened first, and that binding is
// the one recorded. Real time under a bound.
#[tokio::test]
async fn an_account_service_s_build_move_records_its_resume_under_the_binding_it_opened() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (session, _folder, steps, recovery) = Box::pin(account_build_move_session()).await;
        let settings = session.task.record.thread_settings.clone();
        let serving = Arc::clone(&steps);

        let (moved, _task) = Box::pin(move_account_service_build(session, &recovery, |script| {
            serve_resumes(script, settings, serving)
        }))
        .await;

        moved.expect("the build move resumes the conversation");
        let relaunch = relaunch_steps(&steps);
        assert_eq!(relaunch.len(), 3, "{relaunch:?}");
        let opened = relaunch[0]
            .strip_prefix("opened ")
            .expect("the relaunch opens its binding first");
        assert_eq!(relaunch[1], "resume", "{relaunch:?}");
        assert_eq!(relaunch[2], format!("relaunched Some({opened})"));
    })
    .await
    .expect("the build move ends within the bound");
}

// Killed by a build move that leaves a resume the new build refused unsettled: the session's
// record stays, so it reads live on a conversation no service holds, and the queue is never told
// its process is gone. The record is let go and the queue told once, the slot empty. Real time
// under a bound.
#[tokio::test]
async fn an_account_service_s_build_move_its_new_build_refuses_lets_the_record_go() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (session, _folder, steps, recovery) = account_build_move_session().await;

        let (moved, task) = move_account_service_build(session, &recovery, refuse_resumes).await;

        moved.expect("the build move ends");
        assert_eq!(task.let_go_exits, [CodexRecordExit::SessionContinues]);
        assert_eq!(
            steps.holders_at_gone(),
            [None],
            "the queue hears once, the slot empty"
        );
    })
    .await
    .expect("the build move ends within the bound");
}

// Refuses, as the service, every conversation it is asked to resume, as Codex refuses one it has
// no rollout of.
async fn refuse_resumes(mut script: ScriptedService) {
    loop {
        let sent = script.next_sent().await;
        match sent["method"].as_str() {
            Some("thread/resume") => script.send(&json!({
                "jsonrpc": "2.0",
                "id": sent["id"],
                "error": {"code": -32600, "message": "no rollout found for the thread"},
            })),
            Some("account/rateLimits/read") => script.answer(&sent, &json!({"rateLimits": null})),
            _ => script.answer(&sent, &json!({})),
        }
    }
}
