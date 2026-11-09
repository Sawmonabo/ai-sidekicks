//! A session's held tool-server calls once its process is gone for good: the surviving tasks a
//! person's close stops, live or at rest, the calls settled at its close and at the start after a
//! restart, by what Claude Code kept, and left alone while the daemon stops or a fork takes the
//! session.

use std::path::PathBuf;
use std::pin::pin;
use std::sync::Arc;

use rstest::rstest;
use serde_json::{Map, json};
use sidekicks_contracts::event::declared_variants::ToolCallEndCause;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::PathRules;
use tokio::sync::oneshot;

use crate::bounded_poll::poll_until;
use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::claude::session::frame_observation::ClaudeStreamFrameRead;
use crate::driver::claude::session::process::ClaudeStreamFrame;
use crate::driver::claude::session::restart::ClaudeSessionStanding;
use crate::driver::claude::session::scripted::channel::{
    ScriptedAnswer, ScriptedChannel, ScriptedWrite,
};
use crate::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::driver::claude::session::scripted::held_calls::{
    Ending, closes, export_calls, held_call, helper_started, init, logged_held_calls, record,
    stand_in, write_kept_files,
};
use crate::driver::claude::session::scripted::starts::ScriptedStartRecord;
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, binding_id, hand_scripted_frame, settle,
};
use crate::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::driver::claude::spawn::environment::claude_config_folder;
use crate::driver::daemon_stop::{DaemonStopIntent, daemon_stop_deadline};
use crate::driver::session_control::{
    CloseSessionParams, HeldCallsSettle, MoveSessionToForkParams, SessionCloseCause,
    SettleHeldToolCallsParams,
};
use crate::driver::test_registry::{new_run_id, new_session_id};

/// The conversation a resting session's stored leg names.
const STORED_CONVERSATION: &str = "0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5d";

/// How a call ends with its process.
const ENDED_WITH_THE_PROCESS: Ending = Ending::Failed(Some(ToolCallEndCause::ProcessExit));

/// A live session of `fixture`'s driver on `channel` whose process holds each of `calls`, a call
/// and its task, in the background, all opened by one lead run on `lead`; the log answers each
/// open. Answers the session, the run and the process's start.
pub(super) async fn holding_session(
    fixture: &ScriptedDriver,
    channel: &Arc<ScriptedChannel>,
    calls: &[(&str, &str)],
) -> (SessionId, RunId, ScriptedStartRecord) {
    let session_id = fixture.create(channel).await;
    let start = fixture.next_start().await;
    let routes = &fixture
        .driver
        .composed_parts()
        .expect("composed")
        .run_start
        .routes;
    let run_id = new_run_id();
    routes
        .hold_turn(run_id, session_id, binding_id("lead"))
        .expect("the session's turn is free");
    let call_ids: Vec<&str> = calls.iter().map(|(call_id, _)| *call_id).collect();
    let mut frames = vec![init(), export_calls(&call_ids)];
    frames.extend(
        calls
            .iter()
            .map(|(call_id, task_id)| helper_started(task_id, "mcp_task", call_id)),
    );
    frames.extend(
        call_ids
            .iter()
            .map(|call_id| stand_in(call_id, "Running in the background")),
    );
    for frame in &frames {
        hand_scripted_frame(&*start.listener, routes, session_id, frame);
    }
    settle().await;
    let logged = calls
        .iter()
        .map(|(call_id, task_id)| held_call(call_id, task_id, (run_id, "lead"), None, None))
        .collect();
    fixture
        .services
        .ports
        .held_tool_calls
        .register(logged_held_calls(logged, &fixture.engine))
        .expect("the read registers once");
    (session_id, run_id, start)
}

/// Writes the record of `call_id`, of the task `task_id`, beside the conversation `session_id`'s
/// live process runs.
pub(super) fn keep_record(
    fixture: &ScriptedDriver,
    session_id: SessionId,
    call_id: &str,
    task_id: &str,
) {
    let live = fixture
        .driver
        .composed_parts()
        .expect("composed")
        .slots()
        .live_session(session_id)
        .expect("the session is live");
    let config_folder =
        claude_config_folder(&live.spawn_bound_legs.spawn_environment, PathRules::NATIVE)
            .expect("the scripted session's home is known");
    let record_file = format!("mcp-task-{task_id}.meta.json");
    write_kept_files(
        &config_folder,
        &live.provider_session_id,
        &[(record_file.as_str(), record(call_id))],
    );
}

/// Where a closed session rests.
#[derive(Clone, Copy, Debug)]
enum Rest {
    /// Its process exited unasked twice and waits out its crash window, its conversation the
    /// ended one in memory, with no leg recorded.
    CrashWait,
    /// Only its stored leg names its conversation, and no session call composed the driver's
    /// pieces, as after a restart of the daemon.
    StoredLeg,
}

// Fails when a session closed at rest leaves its open held calls open, or settles them other than
// by what Claude Code kept. Mutations: the `Empty` arm breaking before any settle (no closes in the
// crash wait); the early return with no composed pieces left before the settle, or the settle
// taking `composed_parts()` (no closes from the stored leg); `ProcessExit` passed at the close, a
// record read as still running (no close for call-3); the ended conversation read after
// `forget_session` (call-2 reads `processExit` in the crash wait).
#[rstest]
#[case::in_its_crash_wait(Rest::CrashWait)]
#[case::from_its_stored_leg(Rest::StoredLeg)]
#[tokio::test(start_paused = true)]
async fn a_closed_session_at_rest_settles_its_held_calls_by_what_claude_code_kept(
    #[case] rest: Rest,
) {
    let fixture = ScriptedDriver::new();
    let (session_id, config_folder, conversation, driver): (_, PathBuf, String, Arc<ClaudeDriver>) =
        match rest {
            Rest::CrashWait => {
                let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
                let start = fixture.next_start().await;
                let parts = fixture.driver.composed_parts().expect("composed");
                // The first exit restarts at once; the second waits out its crash window, held.
                fixture
                    .starts
                    .script_session(Arc::new(ScriptedChannel::default()));
                ScriptedDriver::exit(&start);
                let relaunched = fixture.next_start().await;
                while !matches!(
                    parts.restarts.standing(session_id),
                    ClaudeSessionStanding::Live(_)
                ) {
                    settle().await;
                }
                ScriptedDriver::exit(&relaunched);
                while !matches!(
                    parts.restarts.standing(session_id),
                    ClaudeSessionStanding::Held { .. }
                ) {
                    tokio::task::yield_now().await;
                }
                let ended = parts
                    .restarts
                    .ended_conversation(session_id)
                    .expect("the ended process's conversation is kept");
                let config_folder =
                    claude_config_folder(&ended.spawn_environment, PathRules::NATIVE)
                        .expect("the scripted session's home is known");
                (
                    session_id,
                    config_folder,
                    ended.provider_session_id,
                    Arc::clone(&fixture.driver),
                )
            }
            Rest::StoredLeg => {
                let session_id = new_session_id();
                let account =
                    ProviderAccountId::new("account-1".to_owned()).expect("an account id");
                fixture.record_session_leg(session_id, account, STORED_CONVERSATION, Map::new());
                let driver = Arc::new(ClaudeDriver::with_starts(
                    &fixture.services,
                    fixture.starts.clone(),
                    fixture.starts.keychain.sign_in_move(),
                ));
                (
                    session_id,
                    fixture.home.join(".claude"),
                    STORED_CONVERSATION.to_owned(),
                    driver,
                )
            }
        };
    // Set up only now, at rest: earlier, the first exit's settle and the restart's rebuild would
    // close call-1 and call-2 themselves.
    let runs: Vec<RunId> = (0..4).map(|_| new_run_id()).collect();
    fixture
        .services
        .ports
        .held_tool_calls
        .register(logged_held_calls(
            vec![
                held_call(
                    "call-4",
                    "task-4",
                    (runs[3], "binding-4"),
                    None,
                    Some(ToolCallEndCause::DaemonRestart),
                ),
                held_call("call-3", "task-3", (runs[2], "binding-3"), None, None),
                held_call("call-2", "task-2", (runs[1], "binding-2"), None, None),
                held_call("call-1", "task-1", (runs[0], "binding-1"), None, None),
            ],
            &fixture.engine,
        ))
        .expect("the read registers once");
    write_kept_files(
        &config_folder,
        &conversation,
        &[
            (
                "mcp-task-task-2.outcome.json",
                json!({
                    "toolUseId": "call-2",
                    "status": "completed",
                    "statusMessage": "Exported",
                    "serverName": "files",
                    "toolName": "export",
                }),
            ),
            ("mcp-task-task-3.meta.json", record("call-3")),
        ],
    );

    driver
        .close_session(CloseSessionParams {
            session_id,
            cause: SessionCloseCause::Person,
        })
        .await
        .expect("the session closes");
    settle().await;

    let mut closed: Vec<_> = closes(fixture.engine.deliveries())
        .into_iter()
        .map(|close| {
            (
                close.tool_call_id,
                close.kind,
                close.binding_id,
                close.run_id,
                close.ending,
                close.content,
            )
        })
        .collect();
    closed.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(
        closed,
        [
            (
                "call-1".to_owned(),
                "afterRunRow",
                Some(binding_id("binding-1")),
                runs[0],
                ENDED_WITH_THE_PROCESS,
                None,
            ),
            (
                "call-2".to_owned(),
                "afterRunRow",
                Some(binding_id("binding-2")),
                runs[1],
                Ending::Completed,
                Some("Exported".to_owned()),
            ),
            (
                "call-3".to_owned(),
                "afterRunRow",
                Some(binding_id("binding-3")),
                runs[2],
                ENDED_WITH_THE_PROCESS,
                None,
            ),
        ]
    );
}

// Fails when a person's close settles before the process's own exit settled what it held, or
// leaves the call only Claude Code's record keeps open. Mutations: the close's settle moved before
// `close_channel` (call-A closed twice, call-B first); the close's settle removed (no close for
// call-B).
#[tokio::test(start_paused = true)]
async fn a_persons_close_ends_the_record_only_call_after_the_exit_settle() {
    let fixture = ScriptedDriver::new();
    let (session_id, run_id, _) = holding_session(
        &fixture,
        &Arc::new(ScriptedChannel::default()),
        &[("call-A", "task-A"), ("call-B", "task-B")],
    )
    .await;
    keep_record(&fixture, session_id, "call-B", "task-B");

    fixture
        .driver
        .close_session(CloseSessionParams {
            session_id,
            cause: SessionCloseCause::Person,
        })
        .await
        .expect("the session closes");
    settle().await;

    let closed: Vec<_> = closes(fixture.engine.deliveries())
        .into_iter()
        .map(|close| {
            (
                close.tool_call_id,
                close.kind,
                close.binding_id,
                close.run_id,
                close.ending,
                close.content,
            )
        })
        .collect();
    let lead = Some(binding_id("lead"));
    assert_eq!(
        closed,
        [
            (
                "call-A".to_owned(),
                "afterRunRow",
                lead.clone(),
                run_id,
                ENDED_WITH_THE_PROCESS,
                None,
            ),
            (
                "call-B".to_owned(),
                "afterRunRow",
                lead,
                run_id,
                ENDED_WITH_THE_PROCESS,
                None,
            ),
        ]
    );
}

// Fails when a restart of the daemon writes a close for a call its process held, which the next
// start's pass settles instead. Mutations: the stop-flag check dropped from the close's settle
// (both calls read `processExit`); the exit settle's check dropped (call-A reads `processExit`).
#[tokio::test(start_paused = true)]
async fn a_restart_of_the_daemon_writes_no_held_call_close() {
    let fixture = ScriptedDriver::new();
    let (session_id, ..) = holding_session(
        &fixture,
        &Arc::new(ScriptedChannel::default()),
        &[("call-A", "task-A"), ("call-B", "task-B")],
    )
    .await;
    keep_record(&fixture, session_id, "call-B", "task-B");

    fixture
        .driver
        .shutdown(DaemonStopIntent::Restart, daemon_stop_deadline())
        .await;
    settle().await;

    assert_eq!(closes(fixture.engine.deliveries()), []);
}

// Fails when the predecessor a fork replaced settles a call the fork's rebuild already closed.
// The rebuild closes call-A before the fork stops the predecessor, so the order is the code's.
// Mutation: the superseded check in the session task's end removed (a second close of call-A).
#[tokio::test(start_paused = true)]
async fn a_forks_predecessor_exit_settles_none_of_its_held_calls() {
    let fixture = ScriptedDriver::new();
    let (session_id, ..) = holding_session(
        &fixture,
        &Arc::new(ScriptedChannel::default()),
        &[("call-A", "task-A")],
    )
    .await;
    let conversation = fixture
        .driver
        .composed_parts()
        .expect("composed")
        .slots()
        .live_session(session_id)
        .expect("the session is live")
        .provider_session_id
        .clone();
    // Two turns, so a fork after the first has a later turn to discard.
    let project_folder = fixture.home.join(".claude/projects/work");
    std::fs::create_dir_all(&project_folder).expect("the project folder is made");
    std::fs::write(
        project_folder.join(format!("{conversation}.jsonl")),
        concat!(
            r#"{"type":"user","uuid":"u1","message":{"content":"first"}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"a1","message":{"content":"one"}}"#,
            "\n",
            r#"{"type":"user","uuid":"u2","message":{"content":"second"}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"a2","message":{"content":"two"}}"#,
            "\n",
        ),
    )
    .expect("the conversation is written");
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    fixture
        .driver
        .move_session_to_fork(MoveSessionToForkParams {
            session_id,
            position: SafeInt::new(1).expect("1 is a position"),
            binding_id: binding_id("lead"),
        })
        .await
        .expect("the fork is answered");
    // The predecessor's process may answer its stop before its task ended.
    settle().await;

    let closed: Vec<_> = closes(fixture.engine.deliveries())
        .into_iter()
        .map(|close| (close.tool_call_id, close.ending))
        .collect();
    assert_eq!(closed, [("call-A".to_owned(), ENDED_WITH_THE_PROCESS)]);
}

/// The `stop_task` requests written to `channel`, each by the task it names.
pub(super) fn stopped_tasks(channel: &ScriptedChannel) -> Vec<String> {
    channel
        .control_requests()
        .into_iter()
        .filter(|request| request["subtype"] == "stop_task")
        .map(|request| request["task_id"].as_str().expect("a task id").to_owned())
        .collect()
}

// Each close the run engine recorded on `fixture`, by call, how it ended and its body.
fn closed_calls(fixture: &ScriptedDriver) -> Vec<(String, Ending, Option<String>)> {
    closes(fixture.engine.deliveries())
        .into_iter()
        .map(|close| (close.tool_call_id, close.ending, close.content))
        .collect()
}

/// How a person's close of a session holding a surviving task meets the task's stop.
#[derive(Clone, Copy, Debug)]
enum PersonsClose {
    /// Claude Code takes the stop and reports the task stopped.
    StopAnswered,
    /// The daemon's stop began before the person's close.
    UnderTheDaemonStop,
    /// Claude Code never answers the stop.
    StopUnanswered,
}

// Fails when a person's close leaves a surviving task running on its server, stops a call that
// ended with its process, stops it once the channel closed or not at a close racing the daemon's
// stop, or fails when the stop goes unanswered. Mutations: the send dropped (no `stop_task`,
// call-A reads `processExit` once the stop is answered); a send for every held call (task-B
// stopped); the send after `close_channel` (nothing written while the close is held); the send
// gated on the stop flag (none under the daemon's stop); an unanswered stop failing the close.
#[rstest]
#[case::stop_answered(PersonsClose::StopAnswered)]
#[case::under_the_daemon_stop(PersonsClose::UnderTheDaemonStop)]
#[case::stop_unanswered(PersonsClose::StopUnanswered)]
#[tokio::test(start_paused = true)]
async fn a_persons_close_stops_each_surviving_task_before_its_process_ends(
    #[case] persons_close: PersonsClose,
) {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let (session_id, _, start) = holding_session(
        &fixture,
        &channel,
        &[("call-A", "task-A"), ("call-B", "task-B")],
    )
    .await;
    keep_record(&fixture, session_id, "call-A", "task-A");
    let parts = fixture.driver.composed_parts().expect("composed");
    match persons_close {
        PersonsClose::StopAnswered => {}
        PersonsClose::UnderTheDaemonStop => parts.restarts.stop(),
        PersonsClose::StopUnanswered => channel.answer("stop_task", ScriptedAnswer::Deadline),
    }
    let release = channel.hold_next_close();

    let close = fixture.driver.close_session(CloseSessionParams {
        session_id,
        cause: SessionCloseCause::Person,
    });
    let while_held = async {
        poll_until(
            || channel.writes(),
            |writes| writes.contains(&ScriptedWrite::Terminate),
        )
        .await;
        assert_eq!(stopped_tasks(&channel), ["task-A"]);
        if !matches!(persons_close, PersonsClose::StopUnanswered) {
            hand_scripted_frame(
                &*start.listener,
                &parts.run_start.routes,
                session_id,
                &json!({
                    "type": "system",
                    "subtype": "task_notification",
                    "session_id": SCRIPTED_PROVIDER_SESSION_ID,
                    "task_id": "task-A",
                    "tool_use_id": "call-A",
                    "status": "stopped",
                }),
            );
            settle().await;
        }
        release.send(()).expect("the close is held");
    };
    let (closed, ()) = tokio::join!(close, while_held);
    closed.expect("the session closes");
    settle().await;

    let stopped = (
        "call-A".to_owned(),
        Ending::Failed(Some(ToolCallEndCause::Stopped)),
        None,
    );
    let ended = |call_id: &str| (call_id.to_owned(), ENDED_WITH_THE_PROCESS, None);
    let expected: Vec<(String, Ending, Option<String>)> = match persons_close {
        PersonsClose::StopAnswered => vec![stopped, ended("call-B")],
        PersonsClose::UnderTheDaemonStop => vec![stopped],
        PersonsClose::StopUnanswered => vec![ended("call-B"), ended("call-A")],
    };
    assert_eq!(closed_calls(&fixture), expected);
}

// Fails when a close the person did not begin stops a surviving task. Mutation: the send on every
// cause (a `stop_task` for task-A).
#[rstest]
#[case::unrecorded_opening(SessionCloseCause::UnrecordedOpening)]
#[case::daemon_stop(SessionCloseCause::DaemonStop)]
#[tokio::test(start_paused = true)]
async fn only_a_persons_close_stops_the_surviving_tasks(#[case] cause: SessionCloseCause) {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let (session_id, ..) = holding_session(
        &fixture,
        &channel,
        &[("call-A", "task-A"), ("call-B", "task-B")],
    )
    .await;
    keep_record(&fixture, session_id, "call-A", "task-A");

    fixture
        .driver
        .close_session(CloseSessionParams { session_id, cause })
        .await
        .expect("the session closes");
    settle().await;

    assert_eq!(stopped_tasks(&channel), Vec::<String>::new());
    assert_eq!(
        closed_calls(&fixture),
        [
            ("call-B".to_owned(), ENDED_WITH_THE_PROCESS, None),
            ("call-A".to_owned(), ENDED_WITH_THE_PROCESS, None),
        ]
    );
}

// Fails when the start after a restart or a Stop settles a resting session's held calls other than
// by what Claude Code kept: a call kept nowhere reads ended by the restart or the Stop, and one
// only recorded stays open for the next resume, while a closed session, with no process scripted to
// stop its surviving task in, ends every call kept nowhere or only recorded with its process. The
// driver is new and no session call composed its pieces, as at a real start. Mutations: the
// `Restart` column's `Unkept` cell answering `processExit` (call-1 reads it after a restart); the
// record ignored after a restart (call-3 closed); `Restart` passed for a closed session (no close
// for call-3 when closed); `Stop` read as `Restart` (call-1 reads `daemonRestart` after a Stop); a
// recorded call ended under a Stop (call-3 closed); `Stopped` mapped to another settle (call-1's
// cause, or call-3 closed).
#[rstest]
#[case::restarted(HeldCallsSettle::Restarted)]
#[case::closed(HeldCallsSettle::Closed)]
#[case::stopped(HeldCallsSettle::Stopped)]
#[tokio::test(start_paused = true)]
async fn the_start_after_a_restart_settles_a_resting_sessions_held_calls(
    #[case] held_calls_settle: HeldCallsSettle,
) {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
    fixture.record_session_leg(session_id, account.clone(), STORED_CONVERSATION, Map::new());
    let runs: Vec<RunId> = (0..3).map(|_| new_run_id()).collect();
    fixture
        .services
        .ports
        .held_tool_calls
        .register(logged_held_calls(
            vec![
                held_call("call-3", "task-3", (runs[2], "binding-3"), None, None),
                held_call("call-2", "task-2", (runs[1], "binding-2"), None, None),
                held_call("call-1", "task-1", (runs[0], "binding-1"), None, None),
            ],
            &fixture.engine,
        ))
        .expect("the read registers once");
    write_kept_files(
        &fixture.home.join(".claude"),
        STORED_CONVERSATION,
        &[
            (
                "mcp-task-task-2.outcome.json",
                json!({
                    "toolUseId": "call-2",
                    "status": "completed",
                    "statusMessage": "Exported",
                    "serverName": "files",
                    "toolName": "export",
                }),
            ),
            ("mcp-task-task-3.meta.json", record("call-3")),
        ],
    );
    let driver = ClaudeDriver::with_starts(
        &fixture.services,
        fixture.starts.clone(),
        fixture.starts.keychain.sign_in_move(),
    );

    driver
        .settle_held_tool_calls(SettleHeldToolCallsParams {
            session_id,
            provider_account_id: account,
            conversation: STORED_CONVERSATION.to_owned(),
            runtime_metadata: Map::new(),
            settle: held_calls_settle,
        })
        .await
        .expect("the held calls are settled");
    settle().await;

    let mut closed = closed_calls(&fixture);
    closed.sort_by(|left, right| left.0.cmp(&right.0));
    let completed = (
        "call-2".to_owned(),
        Ending::Completed,
        Some("Exported".to_owned()),
    );
    let ended_unkept = |cause| ("call-1".to_owned(), Ending::Failed(Some(cause)), None);
    let expected = match held_calls_settle {
        HeldCallsSettle::Closed => vec![
            ("call-1".to_owned(), ENDED_WITH_THE_PROCESS, None),
            completed,
            ("call-3".to_owned(), ENDED_WITH_THE_PROCESS, None),
        ],
        HeldCallsSettle::Restarted => {
            vec![ended_unkept(ToolCallEndCause::DaemonRestart), completed]
        }
        HeldCallsSettle::Stopped => vec![ended_unkept(ToolCallEndCause::DaemonStop), completed],
    };
    assert_eq!(closed, expected);
}

/// What Claude Code keeps of a resting session's one open call when the person closes it.
#[derive(Clone, Copy, Debug)]
enum RestingCall {
    /// Its record: its task outlives the session's last process.
    Recorded,
    /// Nothing.
    Unkept,
}

/// A session of `fixture` at rest from its stored leg, its log holding call-A of task-A open, and
/// the call's record kept beside the conversation where `resting_call` is `Recorded`. Answers the
/// session and its account.
fn resting_session_holding_call_a(
    fixture: &ScriptedDriver,
    resting_call: RestingCall,
) -> (SessionId, ProviderAccountId) {
    let session_id = new_session_id();
    let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
    fixture.record_session_leg(session_id, account.clone(), STORED_CONVERSATION, Map::new());
    let run_id = new_run_id();
    fixture
        .services
        .ports
        .held_tool_calls
        .register(logged_held_calls(
            vec![held_call(
                "call-A",
                "task-A",
                (run_id, "binding-A"),
                None,
                None,
            )],
            &fixture.engine,
        ))
        .expect("the read registers once");
    if matches!(resting_call, RestingCall::Recorded) {
        write_kept_files(
            &fixture.home.join(".claude"),
            STORED_CONVERSATION,
            &[("mcp-task-task-A.meta.json", record("call-A"))],
        );
    }
    (session_id, account)
}

/// Plays Claude Code in the process `start` resumed on the stored conversation: names task-A
/// restored, waits for its `stop_task` on `channel`, saves the task's cancelled ending and then
/// answers the stop `release_stop` holds.
async fn stop_task_a_in_the_resumed_process(
    fixture: &ScriptedDriver,
    start: &ScriptedStartRecord,
    channel: &ScriptedChannel,
    release_stop: oneshot::Sender<()>,
) {
    assert!(matches!(
        &start.conversation,
        ClaudeConversationStart::Resume { resume_handle }
            if resume_handle == STORED_CONVERSATION
    ));
    let text = helper_started("task-A", "mcp_task", "call-A").to_string();
    let observation = ClaudeStreamFrameRead::read(&text)
        .expect("a test frame is an object")
        .into_observation();
    start
        .listener
        .take_frame(ClaudeStreamFrame { text, observation });
    poll_until(|| stopped_tasks(channel), |stopped| *stopped == ["task-A"]).await;
    write_kept_files(
        &fixture.home.join(".claude"),
        STORED_CONVERSATION,
        &[(
            "mcp-task-task-A.outcome.json",
            json!({
                "toolUseId": "call-A",
                "status": "cancelled",
                "serverName": "files",
                "toolName": "export",
            }),
        )],
    );
    release_stop.send(()).expect("the stop is held");
}

/// How call-A ends once Claude Code saved its task's stopped ending.
fn call_a_stopped() -> (String, Ending, Option<String>) {
    (
        "call-A".to_owned(),
        Ending::Failed(Some(ToolCallEndCause::Stopped)),
        None,
    )
}

// Fails when a person's close of a session no process runs leaves a surviving task running on its
// server, resumes anything but the session's own conversation, starts a process with no task to
// stop, or settles the stopped call before reading Claude Code's ending. Mutations: the person's
// gate at rest passed as `false` (the close ends with no process resumed); `Unkept` in place of
// `Resume` (the start's conversation); the recorded filter dropped (a start for the unkept call);
// the read after the process closed dropped (call-A reads `processExit`).
#[rstest]
#[case::recorded(RestingCall::Recorded)]
#[case::unkept(RestingCall::Unkept)]
#[tokio::test(start_paused = true)]
async fn a_persons_close_at_rest_stops_each_surviving_task_in_a_resumed_process(
    #[case] resting_call: RestingCall,
) {
    let fixture = ScriptedDriver::new();
    let (session_id, _) = resting_session_holding_call_a(&fixture, resting_call);
    let channel = Arc::new(ScriptedChannel::default());
    fixture.starts.script_session(Arc::clone(&channel));
    let release_stop = channel.hold_next_control("stop_task");
    let driver = ClaudeDriver::with_starts(
        &fixture.services,
        fixture.starts.clone(),
        fixture.starts.keychain.sign_in_move(),
    );

    let mut close = pin!(driver.close_session(CloseSessionParams {
        session_id,
        cause: SessionCloseCause::Person,
    }));
    let closed = match resting_call {
        RestingCall::Recorded => {
            let start = tokio::select! {
                start = fixture.next_start() => start,
                _ = &mut close => panic!("the close ended with no process resumed"),
            };
            let stopped =
                stop_task_a_in_the_resumed_process(&fixture, &start, &channel, release_stop);
            let (closed, ()) = tokio::join!(&mut close, stopped);
            closed
        }
        RestingCall::Unkept => close.await,
    };
    closed.expect("the session closes");
    settle().await;

    assert!(fixture.starts.take_started().is_empty());
    let expected = match resting_call {
        RestingCall::Recorded => {
            assert_eq!(stopped_tasks(&channel), ["task-A"]);
            call_a_stopped()
        }
        RestingCall::Unkept => {
            assert_eq!(stopped_tasks(&channel), Vec::<String>::new());
            ("call-A".to_owned(), ENDED_WITH_THE_PROCESS, None)
        }
    };
    assert_eq!(closed_calls(&fixture), [expected]);
}

// Fails when the start after a restart, finishing a close the restart cut short, leaves a closed
// session's surviving task running on its server. Mutation: `false` passed for `Closed` at the
// start's settle (the settle ends with no process resumed).
#[tokio::test(start_paused = true)]
async fn the_start_after_a_restart_stops_a_closed_sessions_surviving_task() {
    let fixture = ScriptedDriver::new();
    let (session_id, account) = resting_session_holding_call_a(&fixture, RestingCall::Recorded);
    let channel = Arc::new(ScriptedChannel::default());
    fixture.starts.script_session(Arc::clone(&channel));
    let release_stop = channel.hold_next_control("stop_task");
    let driver = ClaudeDriver::with_starts(
        &fixture.services,
        fixture.starts.clone(),
        fixture.starts.keychain.sign_in_move(),
    );

    let mut settled = pin!(driver.settle_held_tool_calls(SettleHeldToolCallsParams {
        session_id,
        provider_account_id: account,
        conversation: STORED_CONVERSATION.to_owned(),
        runtime_metadata: Map::new(),
        settle: HeldCallsSettle::Closed,
    }));
    let start = tokio::select! {
        start = fixture.next_start() => start,
        _ = &mut settled => panic!("the settle ended with no process resumed"),
    };
    let stopped = stop_task_a_in_the_resumed_process(&fixture, &start, &channel, release_stop);
    let (settled, ()) = tokio::join!(&mut settled, stopped);
    settled.expect("the held calls are settled");
    settle().await;

    assert!(fixture.starts.take_started().is_empty());
    assert_eq!(stopped_tasks(&channel), ["task-A"]);
    assert_eq!(closed_calls(&fixture), [call_a_stopped()]);
}
