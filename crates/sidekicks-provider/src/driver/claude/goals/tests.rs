use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_std::mutex_lock::lock;
use tokio::task::JoinHandle;

use futures::FutureExt;
use rstest::rstest;

use super::degraded;
use crate::driver::claude::goals::endings::GoalEndingInput;
use crate::driver::claude::goals::records::tests::record;
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::claude::session::scripted::driver::{ScriptedDriver, create_params};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, hand_scripted_frame, settle,
};
use crate::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::driver::claude::session::transport::declarations::{
    ClaudeHandshakeDeclaration, ClaudeInitializeDeclaration, ClaudeOfferedModel,
};
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::{DriverGoalResult, SetSessionGoalParams};
use crate::driver::test_registry::new_session_id;

// A live session whose handshake lists `/goal`.
async fn goal_session() -> Arc<ScriptedSession> {
    let session = ScriptedSession::new().await;
    session.start.handshakes.observe_handshake_declaration(
        session.session_id,
        &session.live.provider_session_id,
        ClaudeHandshakeDeclaration {
            slash_commands: vec!["goal".to_owned()],
            ..ClaudeHandshakeDeclaration::default()
        },
    );
    Arc::new(session)
}

// Sets the goal `ship it` on the session, in a task of its own.
fn set_goal(session: &Arc<ScriptedSession>) -> JoinHandle<Result<DriverGoalResult, DriverError>> {
    let session = Arc::clone(session);
    tokio::spawn(async move {
        session
            .parts
            .establishment
            .task_services
            .goals
            .send(
                session.session_id,
                Some(&session.live),
                &session.parts.run_controls,
                Some("ship it"),
            )
            .await
    })
}

// The set's answer, bounded past the request deadline so a set that never answers fails.
async fn answer(setting: JoinHandle<Result<DriverGoalResult, DriverError>>) -> DriverGoalResult {
    tokio::time::timeout(Duration::from_secs(600), setting)
        .await
        .expect("the set answers")
        .expect("the set's task ends")
        .expect("the goal is written")
}

// The uuid of the one user frame written, the goal command unmarked, as the person's own.
fn written_goal(session: &ScriptedSession) -> String {
    let frames = session.channel.user_frames();
    assert_eq!(frames.len(), 1, "one user frame is written: {frames:?}");
    let frame = &frames[0];
    assert_eq!(frame["message"]["content"], "/goal ship it");
    assert_eq!(frame.get("client_composed"), None);
    frame["uuid"]
        .as_str()
        .expect("the frame carries its uuid")
        .to_owned()
}

fn command_lifecycle(command_uuid: &str, state: &str) -> Value {
    json!({
        "type": "command_lifecycle",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "command_uuid": command_uuid,
        "state": state,
    })
}

fn turn_result() -> Value {
    result("done")
}

fn result(text: &str) -> Value {
    json!({
        "type": "result",
        "subtype": "success",
        "is_error": false,
        "result": text,
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
    })
}

fn local_command_output(content: &str) -> Value {
    json!({
        "type": "system",
        "subtype": "local_command_output",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "content": content,
    })
}

// Sets `ship it` while the lead works and lets Claude Code start it, give no answer within
// the request deadline, then start the bare `/goal` written after it; answers the set's task.
async fn set_goal_unanswered(
    session: &Arc<ScriptedSession>,
) -> JoinHandle<Result<DriverGoalResult, DriverError>> {
    session.hold_lead_turn("lead");
    let setting = set_goal(session);
    settle().await;
    let message_uuid = written_goal(session);
    session.frame(&command_lifecycle(&message_uuid, "started"));
    tokio::time::sleep(CLAUDE_REQUEST_DEADLINE + Duration::from_secs(1)).await;
    let frames = session.channel.user_frames();
    assert_eq!(frames.len(), 2, "the goal is read back: {frames:?}");
    assert_eq!(frames[1]["message"]["content"], "/goal");
    let read_back_uuid = frames[1]["uuid"]
        .as_str()
        .expect("the read-back carries its uuid");
    session.frame(&command_lifecycle(read_back_uuid, "started"));
    setting
}

// Killed by refusing the set while the lead's run holds the turn, by taking the command as
// started at its write (the lead turn's own `result` would answer it), and by marking the
// command composed, which keeps Claude Code from running it.
#[tokio::test(start_paused = true)]
async fn a_goal_set_while_the_lead_works_is_written_onto_its_run_and_answered_once_started() {
    let session = goal_session().await;
    let run_id = session.hold_lead_turn("lead");
    let setting = set_goal(&session);
    settle().await;
    let message_uuid = written_goal(&session);
    assert!(lock(&session.start.prompts).has_untaken_steer(run_id));

    session.frame(&turn_result());
    settle().await;
    assert!(
        !setting.is_finished(),
        "the lead turn's own end answers no goal"
    );
    session.frame(&command_lifecycle(&message_uuid, "started"));
    session.frame(&local_command_output("Goal set: ship it"));

    assert_eq!(answer(setting).await, DriverGoalResult::Applied {});
    assert_eq!(session.ports.taken(), [(message_uuid, run_id)]);
}

// Killed by ignoring Claude Code's drop of the command: the set would wait for a start that
// never comes.
#[tokio::test(start_paused = true)]
async fn a_goal_claude_code_drops_before_starting_it_is_not_applied() {
    let session = goal_session().await;
    session.hold_lead_turn("lead");
    let setting = set_goal(&session);
    settle().await;
    let message_uuid = written_goal(&session);

    session.frame(&command_lifecycle(&message_uuid, "cancelled"));

    assert_eq!(answer(setting).await, degraded());
}

// Killed by answering `Degraded` on every set left unanswered: the read-back shows the goal
// set.
#[tokio::test(start_paused = true)]
async fn an_unanswered_goal_the_read_back_shows_set_is_applied() {
    let session = goal_session().await;
    let setting = set_goal_unanswered(&session).await;

    session.frame(&local_command_output(
        "Goal active: ship it (not yet evaluated)",
    ));

    assert_eq!(answer(setting).await, DriverGoalResult::Applied {});
}

// Killed by taking the goal before the set as none, and by answering `Applied` on any
// read-back showing a goal active: the read-back shows the goal the set would have replaced.
#[tokio::test(start_paused = true)]
async fn an_unanswered_goal_the_read_back_shows_as_before_is_not_applied() {
    let session = goal_session().await;
    session
        .parts
        .establishment
        .task_services
        .goal_endings
        .seed(session.session_id, Some("keep going".to_owned()));
    let setting = set_goal_unanswered(&session).await;

    session.frame(&local_command_output(
        "Goal active: keep going (2 turns)\nLast check: the tests still fail",
    ));

    assert_eq!(answer(setting).await, degraded());
}

// With no goal held before, a read-back showing none is `Applied` only where the conversation
// file recorded the goal set after the command: Claude Code set it and met it before the
// read-back ran. Killed by answering `Degraded` whenever the read-back shows the goal before,
// and by reading a set recorded before the command as this one's.
#[rstest]
#[case::recorded_after_the_command(Some(false), DriverGoalResult::Applied {})]
#[case::recorded_before_the_command(Some(true), degraded())]
#[case::never_recorded(None, degraded())]
#[tokio::test(start_paused = true)]
async fn an_unanswered_goal_met_before_the_read_back_is_applied_where_recorded_set(
    #[case] recorded_set_before: Option<bool>,
    #[case] expected: DriverGoalResult,
) {
    let session = goal_session().await;
    let endings = Arc::clone(&session.parts.establishment.task_services.goal_endings);
    let record_set = || {
        endings.classify(
            session.session_id,
            session.live.agent_id,
            GoalEndingInput::Record(&record(false, false, true, Some("ship it"))),
        );
        endings.classify(
            session.session_id,
            session.live.agent_id,
            GoalEndingInput::Record(&record(true, false, false, Some("ship it"))),
        );
    };
    if recorded_set_before == Some(true) {
        record_set();
    }
    let setting = set_goal_unanswered(&session).await;
    if recorded_set_before == Some(false) {
        record_set();
    }

    session.frame(&local_command_output("No goal set"));

    assert_eq!(answer(setting).await, expected);
}

// Killed by answering `Degraded` on a read-back that shows neither goal: Claude Code's answer
// names no goal, so the set may stand and fails instead.
#[tokio::test(start_paused = true)]
async fn an_unanswered_goal_whose_read_back_shows_neither_goal_fails() {
    let session = goal_session().await;
    let setting = set_goal_unanswered(&session).await;

    session.frame(&result("Unknown command: /goal"));

    let answered = tokio::time::timeout(Duration::from_secs(600), setting)
        .await
        .expect("the set answers")
        .expect("the set's task ends");
    assert!(
        matches!(answered, Err(DriverError::Unanswered(_))),
        "{answered:?}"
    );
}

// A read-back Claude Code never starts, queued behind the process that left the set
// unanswered, fails the set `provider.timeout` once the request deadline passes again. Killed
// by the timeout answering `Degraded`, which says the goal was not set where Claude Code may
// have set it, and by leaving the read-back queued, which Claude Code would run later.
#[tokio::test(start_paused = true)]
async fn an_unanswered_goal_whose_read_back_never_starts_times_out() {
    let session = goal_session().await;
    session.hold_lead_turn("lead");
    let setting = set_goal(&session);
    settle().await;
    let message_uuid = written_goal(&session);
    session.frame(&command_lifecycle(&message_uuid, "started"));

    tokio::time::sleep(2 * CLAUDE_REQUEST_DEADLINE + Duration::from_secs(2)).await;

    let answered = tokio::time::timeout(Duration::from_secs(600), setting)
        .await
        .expect("the set answers")
        .expect("the set's task ends");
    assert!(
        matches!(
            &answered,
            Err(DriverError::Unanswered(unanswered))
                if unanswered.refusal.code == RefusalCode::ProviderTimeout
        ),
        "{answered:?}"
    );
    let read_back_uuid = session.channel.user_frames()[1]["uuid"].clone();
    let taken_back: Vec<Value> = session
        .channel
        .control_requests()
        .into_iter()
        .filter(|request| request["subtype"] == "cancel_async_message")
        .collect();
    assert_eq!(taken_back.len(), 1, "{taken_back:?}");
    assert_eq!(taken_back[0]["message_uuid"], read_back_uuid);
}

// Killed by taking the command as started before Claude Code started it: the stray `result`
// would answer it.
#[tokio::test(start_paused = true)]
async fn a_goal_set_on_a_free_turn_opens_the_sessions_run_and_is_answered_once_started() {
    let session = goal_session().await;
    let setting = set_goal(&session);
    settle().await;
    let message_uuid = written_goal(&session);
    let run_id = session
        .engine
        .first_daemon_turn_run()
        .expect("the goal opens the session's own run");
    assert_eq!(
        session
            .start
            .routes
            .lead_run_on(session.session_id)
            .map(|lead| lead.run_id),
        Some(run_id)
    );

    session.frame(&turn_result());
    settle().await;
    assert!(
        !setting.is_finished(),
        "a result before the start answers no goal"
    );
    session.frame(&command_lifecycle(&message_uuid, "started"));
    session.frame(&turn_result());

    assert_eq!(answer(setting).await, DriverGoalResult::Applied {});
}

// A goal sent with no live process goes as its own command run, which refuses a process whose
// handshake lists no `goal`: nothing is written and the goal is not applied. Killed by
// dropping the command check, which writes the frame and leaves the set waiting.
#[tokio::test(start_paused = true)]
async fn a_goal_the_opened_process_does_not_list_is_not_applied_and_writes_nothing() {
    let session = ScriptedSession::new().await;
    session.start.handshakes.observe_handshake_declaration(
        session.session_id,
        &session.live.provider_session_id,
        ClaudeHandshakeDeclaration {
            slash_commands: vec!["compact".to_owned()],
            ..ClaudeHandshakeDeclaration::default()
        },
    );

    let setting = session.parts.establishment.task_services.goals.send(
        session.session_id,
        None,
        &session.parts.run_controls,
        Some("ship it"),
    );
    let answered = tokio::time::timeout(Duration::from_secs(600), setting)
        .await
        .expect("the set answers")
        .expect("a goal the process does not list is answered, not failed");

    assert_eq!(answered, degraded());
    assert!(session.engine.first_daemon_turn_run().is_some());
    assert!(
        session.channel.user_frames().is_empty(),
        "nothing is written"
    );
}

// A set on a session that never ran starts its own run, whose binding brings the process up,
// and writes `/goal` as that run's opening on the commands the process's `initialize` reply
// listed, before any `system/init`. Killed by reading the live session first in the daemon
// turn's start (the set fails `NoLiveSession`), and by the reply's commands not seeded as the
// process's handshake (the set answers `Degraded` with nothing written).
#[tokio::test(start_paused = true)]
async fn a_goal_set_on_a_session_that_never_ran_opens_its_process_and_is_written() {
    let scripted = ScriptedDriver::new();
    scripted
        .starts
        .script_initialize(ClaudeInitializeDeclaration {
            models: vec![ClaudeOfferedModel {
                value: "opus".to_owned(),
                resolved_model: None,
                display_name: None,
                effort_levels: None,
            }],
            commands: vec!["goal".to_owned()],
            ..ClaudeInitializeDeclaration::default()
        });
    let channel = Arc::new(ScriptedChannel::default());
    scripted.starts.script_session(Arc::clone(&channel));
    let driver = Arc::clone(&scripted.driver);
    scripted
        .ports
        .open_processes_for_daemon_turns(Arc::new(move |session_id| {
            let driver = Arc::clone(&driver);
            async move {
                driver
                    .create_session(create_params(session_id))
                    .await
                    .expect("the turn's process opens");
            }
            .boxed()
        }));
    let session_id = new_session_id();
    let parts = Arc::clone(
        scripted
            .driver
            .composed_parts()
            .expect("the pieces are composed"),
    );
    assert!(parts.run_start.slots.live_session(session_id).is_none());

    let driver = Arc::clone(&scripted.driver);
    let setting = tokio::spawn(async move {
        driver
            .set_session_goal(SetSessionGoalParams::new(session_id, "ship it".to_owned()))
            .await
    });
    // The process comes up on threads outside the paused clock, so the write is waited for.
    let opened_by = std::time::Instant::now() + Duration::from_secs(10);
    while channel.user_frames().is_empty() && std::time::Instant::now() < opened_by {
        settle().await;
    }
    let frames = channel.user_frames();
    assert_eq!(frames.len(), 1, "only the goal is written: {frames:?}");
    assert_eq!(frames[0]["message"]["content"], "/goal ship it");
    let message_uuid = frames[0]["uuid"]
        .as_str()
        .expect("the frame carries its uuid")
        .to_owned();
    let run_id = scripted
        .engine
        .first_daemon_turn_run()
        .expect("the goal opens the session's own run");
    assert_eq!(
        parts
            .run_start
            .routes
            .lead_run_on(session_id)
            .map(|lead| lead.run_id),
        Some(run_id)
    );

    let listener = scripted
        .starts
        .take_started()
        .pop()
        .expect("the turn's process was started")
        .listener;
    let routes = &parts.run_start.routes;
    hand_scripted_frame(
        &*listener,
        routes,
        session_id,
        &command_lifecycle(&message_uuid, "started"),
    );
    hand_scripted_frame(&*listener, routes, session_id, &turn_result());

    assert_eq!(answer(setting).await, DriverGoalResult::Applied {});
}
