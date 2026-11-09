use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
use sidekicks_provider::driver::session_control::HeldCallsSettle;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::test_run_id;
use tokio_util::sync::CancellationToken;

use super::resume::{resumed_on, still_running};
use crate::stop_intent::StopIntent;
use crate::test_pass::{PassFixture, insert_runs};

// Each session the driver was asked to settle the held calls of, with how it was settled.
type Settles = Vec<(SessionId, HeldCallsSettle)>;

// Each resumed session, in the order resumed, with the settles asked before its resume, sorted.
type ResumesAfterSettles = Arc<Mutex<Vec<(SessionId, Settles)>>>;

impl PassFixture {
    // Moves `run_id`'s call `tool_call_id` to the background in `session_id`, with no close after.
    async fn hold_in_background(&self, session_id: SessionId, run_id: RunId, tool_call_id: &str) {
        self.append(
            session_id,
            json!({
                "type": "agent.toolCall.backgrounded",
                "payload": {"sessionId": session_id, "runId": run_id, "toolName": "Bash",
                            "toolCallId": tool_call_id, "taskId": format!("task-of-{tool_call_id}"),
                            "survivesRestart": true},
            }),
        )
        .await;
    }

    // A new session whose one run completed on a binding of the first provider holding its
    // conversation; answers the session and the run.
    async fn resting_session(&self) -> (SessionId, RunId) {
        let session_id = self.new_session();
        let run_id = test_run_id();
        insert_runs(&self.store.database, session_id, &[(run_id, "completed")]);
        self.bind_resumable(run_id, 0).await;
        (session_id, run_id)
    }

    // Closes `session_id`.
    fn close_session(&self, session_id: SessionId) {
        self.store
            .database
            .reader()
            .execute(
                "UPDATE sessions SET state = ?1 WHERE id = ?2",
                params![
                    <&'static str>::from(SessionState::Closed),
                    session_id.text().as_str()
                ],
            )
            .expect("the test closes the session");
    }
}

// Four sessions each hold a call moved to the background with no close: one at rest, one with a
// run in progress, one closed and one stale with a run in progress; the pass resumes the two with
// work. Each is settled through its driver once: the two open ones that are not stale before any
// resume, the stale one after its rebuild, before its own resume, and the closed one, as closed,
// after every resume, since it never resumes. Killed by the listing without the held-call read
// (no settle at all), by the settle moved after the resumes (at the first resume, none settled
// yet), by the stale loop's settle dropped (none for the stale session), by the stale session
// settled in the first step too (two settles, one before the first resume), by the closed one
// settled before the resumes (it is in their snapshots), and by the closed state not read (it
// reads restarted).
#[tokio::test]
async fn a_held_call_settles_before_its_sessions_resume_and_a_closed_sessions_after_all() {
    let settled: Arc<Mutex<Settles>> = Arc::default();
    let resumes: ResumesAfterSettles = Arc::default();
    let mut driver = MockProviderDriver::new();
    driver.expect_settle_held_tool_calls().times(4).returning({
        let settled = Arc::clone(&settled);
        move |params| {
            lock(&settled).push((params.session_id, params.settle));
            async { Ok(()) }.boxed()
        }
    });
    driver.expect_resume_session().times(2).returning({
        let settled = Arc::clone(&settled);
        let resumes = Arc::clone(&resumes);
        move |params| {
            let mut settled_before = lock(&settled).clone();
            settled_before.sort_by_key(|(session_id, _)| *session_id);
            lock(&resumes).push((params.session_id, settled_before));
            let resumed = resumed_on(&params, params.binding_id.clone(), still_running);
            async move { Ok(resumed) }.boxed()
        }
    });
    let fixture =
        PassFixture::over_drivers(vec![Arc::new(driver) as Arc<dyn ProviderDriver>]).await;
    fixture.end_seeded_run();
    let (resting, resting_run) = fixture.resting_session().await;
    fixture
        .hold_in_background(resting, resting_run, "call-1")
        .await;
    let (resumed, resumed_run, _) = fixture.running_session(0).await;
    fixture
        .hold_in_background(resumed, resumed_run, "call-2")
        .await;
    let (closed, closed_run) = fixture.resting_session().await;
    fixture
        .hold_in_background(closed, closed_run, "call-3")
        .await;
    fixture.close_session(closed);
    let (stale, stale_run) = fixture.stale_session(1, None).await;
    fixture.bind_resumable(stale_run, 0).await;
    fixture.hold_in_background(stale, stale_run, "call-4").await;

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;

    let mut before_any_resume = vec![
        (resting, HeldCallsSettle::Restarted),
        (resumed, HeldCallsSettle::Restarted),
    ];
    before_any_resume.sort_by_key(|(session_id, _)| *session_id);
    let mut before_the_stale_resume = [
        before_any_resume.clone(),
        vec![(stale, HeldCallsSettle::Restarted)],
    ]
    .concat();
    before_the_stale_resume.sort_by_key(|(session_id, _)| *session_id);
    let mut every_session = [
        before_the_stale_resume.clone(),
        vec![(closed, HeldCallsSettle::Closed)],
    ]
    .concat();
    every_session.sort_by_key(|(session_id, _)| *session_id);
    assert_eq!(
        *lock(&resumes),
        [
            (resumed, before_any_resume),
            (stale, before_the_stale_resume)
        ]
    );
    let mut settled = lock(&settled).clone();
    settled.sort_by_key(|(session_id, _)| *session_id);
    assert_eq!(settled, every_session);
}

// What the person's Stop left over a session at rest holding a background call.
#[derive(Clone, Copy, Debug)]
enum HeldCallsIntent {
    // A whole intent.
    Whole,
    // An intent naming another session.
    NamingAnother,
    // A whole intent over the session, closed.
    WholeOverClosed,
}

// The pass settles a resting session's held calls by the intent it read: as the Stop left them
// under a whole intent, as the restart left them where the intent names another session, and as
// closed for a closed session whatever the intent. Killed by the intent ignored (the whole case
// reads restarted), by any file read as covering every session (the other-session case reads
// stopped), and by a closed session read as stopped under the Stop (the closed case).
#[rstest]
#[case::a_whole_intent(HeldCallsIntent::Whole, HeldCallsSettle::Stopped)]
#[case::an_intent_naming_another_session(
    HeldCallsIntent::NamingAnother,
    HeldCallsSettle::Restarted
)]
#[case::a_closed_session_under_a_whole_intent(
    HeldCallsIntent::WholeOverClosed,
    HeldCallsSettle::Closed
)]
#[tokio::test]
async fn the_pass_settles_held_calls_by_its_intent(
    #[case] intent: HeldCallsIntent,
    #[case] expected: HeldCallsSettle,
) {
    let settled: Arc<Mutex<Settles>> = Arc::default();
    let mut driver = MockProviderDriver::new();
    driver.expect_settle_held_tool_calls().times(1).returning({
        let settled = Arc::clone(&settled);
        move |params| {
            lock(&settled).push((params.session_id, params.settle));
            async { Ok(()) }.boxed()
        }
    });
    let fixture =
        PassFixture::over_drivers(vec![Arc::new(driver) as Arc<dyn ProviderDriver>]).await;
    fixture.end_seeded_run();
    let (resting, resting_run) = fixture.resting_session().await;
    fixture
        .hold_in_background(resting, resting_run, "call-1")
        .await;
    let stop_intent = fixture.stop_intent();
    stop_intent.write_whole().await.expect("the Stop writes");
    match intent {
        HeldCallsIntent::Whole => {}
        HeldCallsIntent::NamingAnother => stop_intent
            .name_sessions(&StopIntent::Whole, [fixture.new_session()].into())
            .await
            .expect("the names are written"),
        HeldCallsIntent::WholeOverClosed => fixture.close_session(resting),
    }

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;

    assert_eq!(*lock(&settled), vec![(resting, expected)]);
}
