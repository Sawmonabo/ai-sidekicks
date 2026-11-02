//! A Codex helper's stop against the scripted service, on paused time: no binding is recorded, so
//! nothing waits on the database's writer, and the stop's deadline passes without a real wait.

use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;

use crate::driver::codex::session::detached_conversation::CODEX_DETACHED_INTERRUPT_DEADLINE;
use crate::driver::codex::session::errors::{CodexError, CodexUnansweredCause};
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::run_control::{HelperStopOutcome, HelperStopParams};
use crate::driver::test_registry::new_run_id;

/// The helper's own conversation, which is its id.
const HELPER_THREAD: &str = "helper-thread";

/// The helper's newest turn.
const HELPER_TURN: &str = "helper-turn";

/// Past the stop's own deadline, so a stop with none fails the test rather than hanging it.
const DEADLOCK_BOUND: Duration = Duration::from_secs(60);

// How the scripted service answers the stop's requests.
#[derive(Clone, Copy)]
enum ServiceAnswer {
    // Lists the newest turn with this status; a running one's interrupt is answered `{}`, then
    // its commands are listed as none.
    Newest(&'static str),
    // Refuses the turn list with `-32600` and these words.
    ListRefused(&'static str),
    // Lists a running turn and refuses its interrupt with this code and these words.
    InterruptRefused(i64, &'static str),
    // Reads the turn list and never answers it.
    Silent,
}

// What the stop answers.
#[derive(Clone, Copy, Debug)]
enum StopAnswer {
    Outcome(HelperStopOutcome),
    Refused,
    PastDeadline,
}

// The stop of the helper on `HELPER_THREAD` in `session`, whose own run is `run_id`.
fn helper_stop(session: &TestCodexSession, run_id: RunId) -> HelperStopParams {
    HelperStopParams {
        session_id: session.task.record.session_id,
        run_id,
        subagent_id: SubagentId::new(HELPER_THREAD.to_owned()).expect("a helper id"),
    }
}

// A helper's stop reads its newest turn: a running one is interrupted and its commands ended, an
// interrupted one is left so, and an ended one, a helper no message reached, a conversation Codex
// does not hold and an interrupt racing the turn's own end all read as ended; a refused interrupt
// and a service that never answers fail. Kills: the status not read (the interrupted case), a
// conversation Codex does not hold read as a failure (both `thread not found` cases), no deadline
// (the silent case outlives the test's bound), and the commands not ended (the running case's third
// request never comes).
#[rstest]
#[case::running(
    ServiceAnswer::Newest("inProgress"),
    StopAnswer::Outcome(HelperStopOutcome::Interrupted)
)]
#[case::interrupted(
    ServiceAnswer::Newest("interrupted"),
    StopAnswer::Outcome(HelperStopOutcome::AlreadyInterrupted)
)]
#[case::completed(
    ServiceAnswer::Newest("completed"),
    StopAnswer::Outcome(HelperStopOutcome::AlreadyEnded)
)]
#[case::no_turn_yet(
    ServiceAnswer::ListRefused("thread helper-thread is not materialized yet"),
    StopAnswer::Outcome(HelperStopOutcome::AlreadyEnded)
)]
#[case::thread_not_found(
    ServiceAnswer::ListRefused("thread not found: helper-thread"),
    StopAnswer::Outcome(HelperStopOutcome::AlreadyEnded)
)]
#[case::turn_ended_first(
    ServiceAnswer::InterruptRefused(-32600, "no active turn to interrupt"),
    StopAnswer::Outcome(HelperStopOutcome::AlreadyEnded)
)]
#[case::interrupt_failed(
    ServiceAnswer::InterruptRefused(-32603, "internal error"),
    StopAnswer::Refused
)]
#[case::silent(ServiceAnswer::Silent, StopAnswer::PastDeadline)]
#[tokio::test(start_paused = true)]
async fn a_helpers_stop_answers_from_its_newest_turn(
    #[case] service: ServiceAnswer,
    #[case] expected: StopAnswer,
) {
    let mut session = TestCodexSession::start().await;
    let params = helper_stop(&session, new_run_id());
    let control = Arc::clone(&session.task.run_control);
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let service_side = async {
        let listed = script.next_sent().await;
        assert_eq!(listed["method"], "thread/turns/list");
        assert_eq!(listed["params"]["threadId"], HELPER_THREAD);
        let (status, interrupt_refusal) = match service {
            ServiceAnswer::Silent => return,
            ServiceAnswer::ListRefused(message) => {
                script.send(&json!({
                    "jsonrpc": "2.0",
                    "id": listed["id"],
                    "error": {"code": -32600, "message": message},
                }));
                return;
            }
            ServiceAnswer::Newest(status) => (status, None),
            ServiceAnswer::InterruptRefused(code, message) => ("inProgress", Some((code, message))),
        };
        script.answer(
            &listed,
            &json!({"data": [{"id": HELPER_TURN, "status": status}]}),
        );
        if status != "inProgress" {
            return;
        }
        let interrupt = script.next_sent().await;
        assert_eq!(interrupt["method"], "turn/interrupt");
        assert_eq!(
            interrupt["params"],
            json!({"threadId": HELPER_THREAD, "turnId": HELPER_TURN})
        );
        if let Some((code, message)) = interrupt_refusal {
            script.send(&json!({
                "jsonrpc": "2.0",
                "id": interrupt["id"],
                "error": {"code": code, "message": message},
            }));
            return;
        }
        script.answer(&interrupt, &json!({}));
        let commands = script.next_sent().await;
        assert_eq!(commands["method"], "thread/backgroundTerminals/list");
        assert_eq!(commands["params"]["threadId"], HELPER_THREAD);
        script.answer(&commands, &json!({"data": []}));
    };
    let (stopped, ()) = tokio::time::timeout(
        DEADLOCK_BOUND,
        Box::pin(async { tokio::join!(task.drive(control.stop_child_run(&params)), service_side) }),
    )
    .await
    .expect("the helper's stop is answered within its deadline");

    match expected {
        StopAnswer::Outcome(outcome) => {
            assert_eq!(stopped.expect("the helper's stop is answered"), outcome);
        }
        StopAnswer::Refused => assert!(
            matches!(
                stopped,
                Err(CodexError::ProviderRequest { code: -32603, .. })
            ),
            "{stopped:?}"
        ),
        StopAnswer::PastDeadline => assert!(
            matches!(
                stopped,
                Err(CodexError::Unanswered {
                    cause: CodexUnansweredCause::Deadline { timeout },
                    ..
                }) if timeout == CODEX_DETACHED_INTERRUPT_DEADLINE
            ),
            "{stopped:?}"
        ),
    }
    assert!(
        session.scripted.script.sent.try_recv().is_err(),
        "nothing more was sent"
    );
}
