//! A person's close of a session no process runs, and the start that finishes a close a
//! restart cut short: each surviving task stopped in a process resumed for that alone.

use std::pin::pin;
use std::sync::Arc;

use rstest::rstest;
use serde_json::{Map, json};
use sidekicks_contracts::event::declared_variants::ToolCallEndCause;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;

use crate::bounded_poll::poll_until;
use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::claude::lifecycle::held_calls::HELD_TASK_STOP_BOUND;
use crate::driver::claude::session::frame_observation::ClaudeStreamFrameRead;
use crate::driver::claude::session::process::ClaudeStreamFrame;
use crate::driver::claude::session::process::account::ClaudeProcessAccount;
use crate::driver::claude::session::scripted::channel::{ScriptedChannel, ScriptedWrite};
use crate::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::driver::claude::session::scripted::held_calls::{
    Ending, closes, held_call, helper_started, logged_held_calls, record, write_kept_files,
};
use crate::driver::claude::session::scripted::settle;
use crate::driver::claude::session::scripted::starts::ScriptedStartRecord;
use crate::driver::claude::session::transport::inbound::ClaudeControlFrameReader;
use crate::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::driver::session_control::{
    CloseSessionParams, HeldCallsSettle, SessionCloseCause, SettleHeldToolCallsParams,
};
use crate::driver::test_registry::{new_run_id, new_session_id};

use super::{ENDED_WITH_THE_PROCESS, STORED_CONVERSATION, closed_calls, stopped_tasks};

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
// stop, settles the stopped call before reading Claude Code's ending, or leaves a request the
// process sends while it closes unanswered. Mutations: the person's gate at rest passed as `false`
// (the close ends with no process resumed); `Unkept` in place of `Resume` (the start's
// conversation); the recorded filter dropped (a start for the unkept call); the read after the
// process closed dropped (call-A reads `processExit`); `close_answering` replaced by a plain
// `channel.close()` (the ask sent while closing gets no answer).
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
            let release_close = channel.hold_next_close();
            let asked_while_closing = async {
                stop_task_a_in_the_resumed_process(&fixture, &start, &channel, release_stop).await;
                poll_until(
                    || channel.writes(),
                    |w| w.contains(&ScriptedWrite::Terminate),
                )
                .await;
                let ask = json!({ "subtype": "can_use_tool", "tool_name": "Bash", "input": {} });
                let ask = json!({ "type": "control_request", "request_id": "ask", "request": ask });
                let mut reader = ClaudeControlFrameReader::new(
                    ClaudeProcessAccount::default(),
                    STORED_CONVERSATION.to_owned(),
                );
                let ask = reader
                    .read_request(&ask.to_string())
                    .expect("the ask reads");
                start.listener.take_request(ask);
                let answer = tokio::time::timeout(HELD_TASK_STOP_BOUND, channel.answer_to("ask"))
                    .await
                    .expect("the close answers an ask the process sends while it closes");
                release_close.send(()).expect("the close is held");
                answer
            };
            let (closed, answer) = tokio::join!(&mut close, asked_while_closing);
            assert_eq!(answer["behavior"], "deny");
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
