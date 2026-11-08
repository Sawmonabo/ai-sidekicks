//! The recovery pass over the pass fixture; the resume of a session's conversation is in
//! `resume`, the settle of the calls each session held in the background in `held_calls`, and the
//! settle of the sessions the person's Stop left in the stop intent in `stop_intent`.

mod held_calls;
mod resume;
mod stop_intent;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};
use sidekicks_approval::service::test_fixture::SETTLE_WAIT;
use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::event_cursor::{START_OF_LOG_POSITION, encode_event_cursor};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::port::plan::{ProviderPlan, mint_plan_id};
use sidekicks_provider::port::question::mint_tool_server_request_id;
use sidekicks_session::run::engine::test_fixture::{insert_run, stored_run_state};
use sidekicks_store::database::writer::test_file::{test_run_id, test_session_id};
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;
use tokio_util::sync::CancellationToken;

use crate::projection_rebuild::mark_stale_statement;
use crate::restart_settle::RESTART_FAILURE_DETAIL;
use crate::session_write_refusal::{refuse_call_naming_session, refuse_session_event};
use crate::status::RecoveryStatusTracker;
use crate::test_pass::{PassFixture, insert_runs};

// The folders the store's files were copied aside into.
fn aside_copies(data_folder: &Path) -> Vec<PathBuf> {
    fs::read_dir(data_folder.join("damaged"))
        .map(|entries| {
            entries
                .map(|entry| entry.expect("a copy's entry reads").path())
                .collect()
        })
        .unwrap_or_default()
}

// One session holds two runs the restart left: one running with a pending ask and a faster-model
// retry sent and one not, and one ended with an open turn a token limit's accepted row cuts, a
// person's interrupt never sent, a pending ask, an open refusal choice and a held plan. Killed by
// the retries settled after their run (the accepted one reads `expired`); by step 4 before step 3
// (the turn ends `daemonRestart`); by any step left out; and by `mark_pass_ended` missing (a call
// naming no session is refused).
#[tokio::test]
async fn a_pass_settles_what_a_restart_left_in_a_session_in_order() {
    let fixture = PassFixture::new().await;
    let session_id = fixture.store.session_id;
    let ended_run = fixture.store.run_id;
    let plan_id = mint_plan_id();
    fixture
        .plans()
        .take_plan(ProviderPlan {
            plan_id,
            session_id,
            run_id: ended_run,
            text: "# The plan\n\nBuild it.".to_owned(),
            plan_file_path: None,
            holds_request: true,
        })
        .await
        .expect("the plan is held");
    fixture
        .append(
            session_id,
            json!({
                "type": "agent.turn.started",
                "payload": {"sessionId": session_id, "runId": ended_run, "runVersion": 0,
                            "turnNumber": 1},
            }),
        )
        .await;
    fixture
        .append(
            session_id,
            json!({
                "type": "agent.run.refusalChoice.requested",
                "payload": {"sessionId": session_id, "runId": ended_run,
                            "refusedModel": "model-a", "fallbackModel": "model-b"},
            }),
        )
        .await;
    let token_cut = fixture.record_intervention(
        ended_run,
        "interrupt",
        "accepted",
        r#"{"limit":"tokenLimit","turnNumber":1}"#,
    );
    let unsent_interrupt = fixture.record_intervention(
        ended_run,
        "interrupt",
        "requested",
        r#"{"pending":"nextTurn"}"#,
    );
    let ended_ask = fixture.record_pending_ask(session_id, ended_run);
    fixture
        .store
        .database
        .reader()
        .execute(
            "UPDATE runs SET state = 'completed', run_version = 1 WHERE run_id = ?1",
            [ended_run.text().as_str()],
        )
        .expect("the run ended before the restart");
    let running_run = test_run_id();
    insert_run(&fixture.store.database, session_id, running_run, "running");
    let running_ask = fixture.record_pending_ask(session_id, running_run);
    let sent_retry = fixture.record_intervention(running_run, "fasterModelRetry", "accepted", "{}");
    let unsent_retry =
        fixture.record_intervention(running_run, "fasterModelRetry", "requested", "{}");

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;

    let retry_reason: (String, Option<String>) = fixture
        .store
        .database
        .reader()
        .query_row(
            "SELECT state, failure_reason FROM interventions WHERE id = ?1",
            [sent_retry.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the sent retry reads");
    assert_eq!(
        retry_reason,
        (
            "failed".to_owned(),
            Some(
                "The background service restarted before the retry's outcome was known".to_owned()
            )
        )
    );
    assert_eq!(fixture.state("interventions", &unsent_retry), "expired");
    let settled_ids = |event_type| -> Vec<Value> {
        fixture
            .payloads(&session_id, event_type)
            .into_iter()
            .map(|payload| payload["interventionId"].clone())
            .collect()
    };
    assert!(settled_ids(SessionEventType::AgentInterventionFailed).contains(&json!(sent_retry)));
    assert!(settled_ids(SessionEventType::AgentInterventionExpired).contains(&json!(unsent_retry)));
    assert_eq!(
        stored_run_state(&fixture.store.database, &running_run).0,
        "failed"
    );
    let failed = fixture.payloads(&session_id, SessionEventType::AgentRunFailed);
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0]["runId"], json!(running_run));
    assert_eq!(
        failed[0]["providerFailureDetail"],
        json!(RESTART_FAILURE_DETAIL)
    );
    assert_eq!(failed[0]["recoveryCondition"], json!("recoveryNeeded"));
    for ask in [&running_ask, &ended_ask] {
        assert_eq!(fixture.state("approval_requests", ask), "canceled");
    }
    assert_eq!(
        fixture
            .payloads(&session_id, SessionEventType::ApprovalCanceled)
            .len(),
        2
    );
    let turn_ends = fixture.payloads(&session_id, SessionEventType::AgentTurnInterrupted);
    assert_eq!(turn_ends.len(), 1);
    assert_eq!(turn_ends[0]["runId"], json!(ended_run));
    assert_eq!(turn_ends[0]["cause"], json!("tokenLimit"));
    assert_eq!(fixture.state("interventions", &unsent_interrupt), "expired");
    assert_ne!(fixture.state("interventions", &token_cut), "accepted");
    let choices = fixture.payloads(&session_id, SessionEventType::AgentRunRefusalChoiceResolved);
    assert_eq!(choices.len(), 1);
    assert!(
        choices[0].to_string().contains("\"runEnded\""),
        "{}",
        choices[0]
    );
    let hold_ends = fixture.payloads(&session_id, SessionEventType::PlanHoldEnded);
    assert_eq!(hold_ends.len(), 1);
    assert_eq!(hold_ends[0]["planId"], json!(plan_id));
    assert_eq!(hold_ends[0]["reason"], json!("runEnded"));
    assert_eq!(fixture.state("plans", &plan_id.to_string()), "open");
    let succeeded = fixture.payloads(
        &DAEMON_SCOPE_SENTINEL_SESSION_ID,
        SessionEventType::DaemonRecoverySucceeded,
    );
    assert_eq!(succeeded.len(), 1);
    assert_eq!(succeeded[0]["runsFailedDeterministically"], json!(1));
    assert_eq!(fixture.status.read_daemon_write_refusal(false), None);
    assert!(refuse_call_naming_session(&fixture.status, &session_id, "session.pin").is_ok());
}

// Two sessions with running runs, one stale with a broken row mid-log: it opens at the event
// before the row with no event appended, and alone refuses its writes; the other's run is
// settled, the pass records its failure, and the writer counts no live run. Killed by a pass that
// settles a damaged session (its head moves), and by the count's cursor clause deleted (reads 1).
#[tokio::test]
async fn a_session_whose_log_cannot_be_rebuilt_opens_at_its_last_good_point_alone() {
    let fixture = PassFixture::new().await;
    let (damaged, damaged_run) = fixture.stale_session(3, Some(1)).await;
    let healthy_run = fixture.store.run_id;

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;

    let point = fixture
        .status
        .read_last_good_point(&damaged)
        .expect("the damaged session opens at a point");
    assert_eq!(
        (point.last_sequence.get(), point.damaged_from_sequence.get()),
        (0, 1)
    );
    assert_eq!(fixture.head(&damaged), Some(2));
    assert_eq!(
        stored_run_state(&fixture.store.database, &damaged_run).0,
        "running"
    );
    assert_eq!(
        refuse_call_naming_session(&fixture.status, &damaged, "session.pin")
            .expect_err("the damaged session takes no write")
            .code,
        RefusalCode::SessionHistoryDamaged
    );
    assert_eq!(
        stored_run_state(&fixture.store.database, &healthy_run).0,
        "failed"
    );
    let failed = fixture.payloads(
        &DAEMON_SCOPE_SENTINEL_SESSION_ID,
        SessionEventType::DaemonRecoveryFailed,
    );
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0]["failureKind"], json!("projectionRebuildFailed"));
    assert_eq!(*fixture.live_runs.borrow(), 0);
}

// A stop while a stale session's rebuild waits on its log: the pass ends, its cursor is left
// rebuilding for the next start, the store is not read as failed and no failure is recorded.
// Killed by `Stopped` read as a store failure.
#[tokio::test]
async fn a_stop_during_a_rebuild_ends_the_pass_without_failing_the_store() {
    let fixture = PassFixture::new().await;
    let (stale, _run_id) = fixture.stale_session(2, None).await;
    let pass = Arc::new(fixture.pass(Arc::clone(&fixture.status)));
    let stop = CancellationToken::new();
    let held = SESSION_APPEND_LOCK.acquire(stale).await;
    let held_alone = SESSION_APPEND_LOCK.queue_handle_count(stale);
    let running = tokio::spawn({
        let pass = Arc::clone(&pass);
        let stop = stop.clone();
        async move { pass.run(&stop).await }
    });
    tokio::time::timeout(
        SETTLE_WAIT,
        SESSION_APPEND_LOCK.wait_for_queue_past(stale, held_alone),
    )
    .await
    .expect("the rebuild waits on the session's log");

    stop.cancel();
    drop(held);
    tokio::time::timeout(SETTLE_WAIT, running)
        .await
        .expect("the pass ends")
        .expect("the pass's task ends");

    assert_eq!(fixture.status.read_daemon_write_refusal(false), None);
    let cursor: String = fixture
        .store
        .database
        .reader()
        .query_row(
            "SELECT state FROM projection_cursors WHERE session_id = ?1",
            [stale.text().as_str()],
            |row| row.get(0),
        )
        .expect("the cursor reads");
    assert_eq!(cursor, "rebuilding");
    assert_eq!(
        fixture.payloads(
            &DAEMON_SCOPE_SENTINEL_SESSION_ID,
            SessionEventType::DaemonRecoveryFailed
        ),
        Vec::<Value>::new()
    );
}

// While a stale session's rebuild waits, and again while its run's settle waits, only that
// session refuses the calls naming it; a call naming no session waits for the pass's end. Killed
// by `mark_pass_listed` after the rebuilds, and by a listed session marked healthy before its
// settle.
#[tokio::test]
async fn a_session_the_pass_rebuilds_refuses_its_calls_alone_until_settled() {
    let fixture = PassFixture::new().await;
    let other = fixture.new_session();
    fixture
        .store
        .database
        .reader()
        .execute(
            "UPDATE runs SET state = 'completed' WHERE run_id = ?1",
            [fixture.store.run_id.text().as_str()],
        )
        .expect("the seeded run ended");
    let (stale, stale_run) = fixture.stale_session(2, None).await;
    let pass = Arc::new(fixture.pass(Arc::clone(&fixture.status)));
    let held = SESSION_APPEND_LOCK.acquire(stale).await;
    let held_alone = SESSION_APPEND_LOCK.queue_handle_count(stale);
    let settle_paused = fixture.engine.restart_facts_pause().arm();
    let running = tokio::spawn({
        let pass = Arc::clone(&pass);
        async move { pass.run(&CancellationToken::new()).await }
    });
    tokio::time::timeout(
        SETTLE_WAIT,
        SESSION_APPEND_LOCK.wait_for_queue_past(stale, held_alone),
    )
    .await
    .expect("the rebuild waits on the session's log");
    let status = &fixture.status;
    let refusal_of = |session_id: &SessionId| {
        refuse_call_naming_session(status, session_id, "session.pin")
            .err()
            .map(|refusal| refusal.code)
    };
    assert_eq!(status.read_daemon_write_refusal(true), None);
    assert_eq!(refusal_of(&other), None);
    assert_eq!(refusal_of(&stale), Some(RefusalCode::SessionRebuilding));
    assert!(status.read_daemon_write_refusal(false).is_some());

    drop(held);
    tokio::time::timeout(SETTLE_WAIT, settle_paused.reached)
        .await
        .expect("the stale session's run is settled")
        .expect("the pause reports");
    assert_eq!(refusal_of(&stale), Some(RefusalCode::SessionRebuilding));
    assert!(refuse_session_event(status, &stale, "agent.run.failed").is_ok());
    settle_paused
        .release
        .send(())
        .expect("the settle is let go");
    tokio::time::timeout(SETTLE_WAIT, running)
        .await
        .expect("the pass ends")
        .expect("the pass's task ends");

    assert_eq!(status.read_daemon_write_refusal(false), None);
    assert_eq!(refusal_of(&other), None);
    assert_eq!(refusal_of(&stale), None);
    assert_eq!(
        stored_run_state(&fixture.store.database, &stale_run).0,
        "failed"
    );
}

// Two sessions whose rebuilds fail twice are copied aside in one copy, and the next start over
// the same damage takes none. Killed by `find_aside_copy_of_session` skipped, and by a copy per
// session.
#[tokio::test]
async fn the_store_is_copied_aside_once_for_one_damage() {
    let fixture = PassFixture::new().await;
    let (first, _) = fixture.stale_session(2, Some(1)).await;
    let (second, _) = fixture.stale_session(2, Some(0)).await;

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;
    let copies = aside_copies(fixture.data_folder.path());
    assert_eq!(copies.len(), 1, "{copies:?}");
    assert_eq!(fixture.status.read_damaged_from_sequence(&first), Some(1));
    assert_eq!(
        fixture.status.read_damaged_from_sequence(&second),
        Some(START_OF_LOG_POSITION)
    );

    let next_start = Arc::new(RecoveryStatusTracker::new());
    fixture
        .pass(Arc::clone(&next_start))
        .run(&CancellationToken::new())
        .await;

    assert_eq!(aside_copies(fixture.data_folder.path()), copies);
    assert!(next_start.read_session_write_refusal(&first).is_some());
    assert!(next_start.read_session_write_refusal(&second).is_some());
}

// The pass withdraws a settled session's questions the tool-server client asked, waiting for a
// paused run, and leaves a driver's question and the paused run as they were. Killed by the call
// left out of `settle_session`, and by a withdrawal that needs a held request (the pass's
// questions service holds none).
#[tokio::test]
async fn a_pass_withdraws_the_tool_server_questions_a_restart_left() {
    let fixture = PassFixture::new().await;
    let session_id = fixture.new_session();
    let paused_run = test_run_id();
    insert_runs(
        &fixture.store.database,
        session_id,
        &[(paused_run, "paused")],
    );
    let tool_server_question = fixture.record_question_waiting_for_run(
        session_id,
        paused_run,
        &mint_tool_server_request_id(),
    );
    let driver_question = fixture.record_question_waiting_for_run(
        session_id,
        paused_run,
        "toolu_01A09q90qw90lq917835lq9",
    );

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;

    assert_eq!(
        fixture.state("questions", &tool_server_question),
        "canceled"
    );
    let canceled = fixture.payloads(&session_id, SessionEventType::QuestionCanceled);
    assert_eq!(canceled.len(), 1);
    assert_eq!(canceled[0]["questionId"], json!(tool_server_question));
    assert_eq!(canceled[0]["reason"], json!("withdrawn"));
    assert_eq!(
        fixture.state("questions", &driver_question),
        "waitingForRun"
    );
    assert_eq!(
        stored_run_state(&fixture.store.database, &paused_run).0,
        "paused"
    );
}

// `session_id`'s `session.created`, naming `parent` when it is a fork.
fn session_created(session_id: SessionId, parent: Option<SessionId>) -> Value {
    let mut created = json!({
        "type": "session.created",
        "payload": {
            "sessionId": session_id,
            "shape": "chat",
            "mainAgent": {
                "agentId": mint_uuid_v7().to_string(),
                "name": "lead",
                "binding": {
                    "providerName": "test-provider",
                    "modelId": "test-model",
                    "providerAccountId": null,
                    "effort": null,
                },
                "ancestry": [],
                "createdAt": "2026-11-08T09:00:00.000Z",
            },
        },
    });
    if let Some(parent) = parent {
        created["payload"]["parent"] = json!({
            "sessionId": parent,
            "anchorCursor": encode_event_cursor(0).expect("the first position is a cursor"),
        });
    }
    created
}

// A parent and its fork whose directory rows a fresh file lost, both left stale, the fork logged
// first: the start rebuilds the parent's row before the fork's, which names a parent only while
// the parent's row exists, so the fork still names its parent. Killed by the listing's order
// reversed (`ORDER BY session_id DESC`), which rebuilds the fork while its parent has no row.
#[tokio::test]
async fn a_rebuilt_fork_still_names_its_rebuilt_parent() {
    let fixture = PassFixture::rebuilding_the_directory().await;
    let parent = test_session_id();
    let fork = test_session_id();
    fixture
        .append(fork, session_created(fork, Some(parent)))
        .await;
    fixture.append(parent, session_created(parent, None)).await;
    let reader = fixture.store.database.reader();
    reader
        .execute(
            "DELETE FROM sessions WHERE id IN (?1, ?2)",
            [parent.text().as_str(), fork.text().as_str()],
        )
        .expect("the rows are lost");
    fixture
        .store
        .writer
        .write(vec![
            mark_stale_statement(&fork),
            mark_stale_statement(&parent),
        ])
        .await
        .expect("both cursors are stale");

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;

    let named: Option<String> = reader
        .query_row(
            "SELECT parent_session_id FROM sessions WHERE id = ?1",
            [fork.text().as_str()],
            |row| row.get(0),
        )
        .expect("the fork's row is rebuilt");
    assert_eq!(named.as_deref(), Some(parent.text().as_str()));
}
