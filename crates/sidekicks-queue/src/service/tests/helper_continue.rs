//! A paused run the person continued while the daemon's restart held its lead, a helper beneath
//! the lead or the lead itself: the lead's continue, run on the queue's own task, that the
//! provider failed or whose read of the held lead failed, and the person's next continue once a
//! process holds the session.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::FutureExt as _;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::daemon::recovery::DaemonRecoveryHaltedRun;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::{AgentRunResumeRequest, RunFailureCategory};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::session_control::{
    DriverResumeResult, ProviderTurnAnswer, ResumedRunAnswer,
};
use sidekicks_provider::driver::test_registry::bind_run_to_first_provider;
use sidekicks_provider::process_identity::TEST_PROVIDER_PROCESS;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_session::queue_store::RecordedQueueItemState;
use sidekicks_session::run::engine::test_fixture::stored_run_state;
use sidekicks_std::mutex_lock::lock;
use tokio::time::timeout;

use super::{DriverCalls, Fixture, WAIT, fixture, recording_driver};

// A helper the restart cut, continued while its lead is held with no process, moves to `running`
// and hands the lead's continue to the queue's task; the provider failing that continue halts the
// helper in the recovery status as the provider's failure and moves it back to `paused`, its
// message given back to wait for the person's next continue. Killed by the restore dropped, which
// leaves it `running`, by its words kept, and by its message settled on the failure.
#[tokio::test]
async fn a_failed_helper_continue_halts_and_pauses_the_helper_with_its_message_waiting() {
    let calls = Arc::new(DriverCalls::default());
    let (driver, resumes) = deferring_then_failing_driver(&calls);
    let fixture = fixture(driver).await;
    let lead = fixture.insert_run("waitingForApproval").await;
    fixture.set_run_state(lead, "running");
    let binding_id = bind_run_to_first_provider(&fixture.database, lead);
    let reader = fixture.database.reader();
    reader
        .execute(
            "UPDATE runtime_bindings SET resume_handle = 'conversation-1' WHERE id = ?1",
            [binding_id.as_str()],
        )
        .expect("the test gives the lead's binding a conversation");
    let helper = fixture.insert_run("paused").await;
    reader
        .execute(
            "UPDATE runs SET parent_run_id = ?1, reached_by = 'providerSubagent' WHERE run_id = ?2",
            params![lead.text().as_str(), helper.text().as_str()],
        )
        .expect("the test makes the run the lead's helper");
    fixture.insert_event(
        lead,
        SessionEventType::AgentSubagentStarted,
        &json!({
            "sessionId": fixture.session_id.text().as_str(),
            "runId": lead.text().as_str(),
            "provider": PROVIDERS[0].id,
            "subagentId": "helper-1",
            "childRunId": helper.text().as_str(),
        }),
    );
    // The restart's cut of the helper's first turn, which a turn end row records with its turn.
    let turn_end = SessionEventType::AgentTurnInterrupted;
    reader
        .execute(
            "INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns,
               category, type, payload, run_id, run_version, turn_number)
             SELECT ?1, ?2, MAX(sequence) + 1, ?3, 0, ?4, ?5, ?6, ?7, 1, 1
             FROM session_events WHERE session_id = ?2",
            params![
                mint_uuid_v7().to_string(),
                fixture.session_id.text().as_str(),
                WireInstant::now().as_str(),
                turn_end.category().as_str(),
                turn_end.as_str(),
                json!({ "cause": "daemonRestart" }).to_string(),
                helper.text().as_str(),
            ],
        )
        .expect("the test writes the helper's cut");
    let item_id = fixture.queue_message(helper).await;

    timeout(
        WAIT,
        fixture.queue.pauses.resume(
            &AgentRunResumeRequest {
                target_run_id: helper,
                expected_run_version: SafeInt::new(1).expect("a version"),
            },
            &fixture.queue.delivery,
        ),
    )
    .await
    .expect("the continue answers")
    .expect("the helper is continued");
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the lead's continue ends");

    assert_eq!(resumes.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.run_state(helper), "paused");
    assert_eq!(
        lock(&fixture.halted_runs.0).clone(),
        [(
            fixture.session_id,
            DaemonRecoveryHaltedRun {
                run_id: helper,
                recovery_condition: RecoveryCondition::RecoveryNeeded,
                failure_category: Some(RunFailureCategory::ProviderFailure),
            }
        )]
    );
    assert!(!fixture.queue.delivery.is_handed(&item_id));
    assert_eq!(
        fixture.stored_state(item_id),
        RecordedQueueItemState::Queued
    );
}

// A lead the person continued while a helper beneath it waited on them moves to `running` with no
// process and its message kept; the provider failing the continue the helper's answer starts moves
// the helper back to its wait and the lead back to `paused`, its message given back, and the
// person's next continue, once a process holds the session, carries that message once. Killed by
// the lead's restore dropped (it stays `running` with no process), by its words kept, which the
// next continue then skips, and by its message settled on the failure.
#[tokio::test]
async fn a_failed_continue_of_a_held_lead_leaves_its_message_for_the_next_continue() {
    let calls = Arc::new(DriverCalls::default());
    let (driver, resumes) = deferring_then_failing_driver(&calls);
    let fixture = fixture(driver).await;
    let (lead, helper, item_id) = hold_continued_lead(&fixture).await;
    answer_the_helper(&fixture, helper).await;

    assert_eq!(resumes.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.run_state(lead), "paused");
    assert_eq!(fixture.run_state(helper), "waitingForApproval");
    assert!(!fixture.queue.delivery.is_handed(&item_id));
    assert_eq!(
        fixture.stored_state(item_id),
        RecordedQueueItemState::Queued
    );

    // A process comes up for the session, and the person continues the lead again.
    fixture.process.set(Some(TEST_PROVIDER_PROCESS));
    fixture
        .queue
        .provider_sessions
        .record_test_opening(fixture.session_id);
    let (_, version) = stored_run_state(&fixture.database, &lead);
    let version = u64::try_from(version).expect("a stored version is not negative");
    timeout(
        WAIT,
        fixture.queue.pauses.resume(
            &AgentRunResumeRequest {
                target_run_id: lead,
                expected_run_version: SafeInt::new(version).expect("a version"),
            },
            &fixture.queue.delivery,
        ),
    )
    .await
    .expect("the continue answers")
    .expect("the lead is continued");

    assert_eq!(calls.resumes(), [(lead, vec![item_id])]);
}

// A lead the person's continue moved to `running` with no process, whose read as the held lead
// then fails: the continue the helper's answer starts halts the helper as the daemon's own failure
// before any provider call and moves it back to its wait, and the session's lead that reads
// `running` with no turn open moves back to `paused` with its message given back. A helper start
// whose id reads blank fails the read of the session's live runs. Killed by the lead's move back
// to `paused` dropped, which leaves it `running` with no process.
#[tokio::test]
async fn a_failed_read_of_the_held_lead_moves_the_running_lead_back_to_paused() {
    let calls = Arc::new(DriverCalls::default());
    let (driver, resumes) = deferring_then_failing_driver(&calls);
    let fixture = fixture(driver).await;
    let (lead, helper, item_id) = hold_continued_lead(&fixture).await;
    fixture.insert_event(
        lead,
        SessionEventType::AgentSubagentStarted,
        &json!({
            "sessionId": fixture.session_id.text().as_str(),
            "runId": lead.text().as_str(),
            "provider": PROVIDERS[0].id,
            "subagentId": " ",
            "childRunId": helper.text().as_str(),
        }),
    );
    answer_the_helper(&fixture, helper).await;

    assert_eq!(resumes.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.run_state(lead), "paused");
    assert_eq!(fixture.run_state(helper), "waitingForApproval");
    assert_eq!(
        lock(&fixture.halted_runs.0).clone(),
        [(
            fixture.session_id,
            DaemonRecoveryHaltedRun {
                run_id: helper,
                recovery_condition: RecoveryCondition::RecoveryNeeded,
                failure_category: Some(RunFailureCategory::LocalPersistenceFailure),
            }
        )]
    );
    assert!(!fixture.queue.delivery.is_handed(&item_id));
    assert_eq!(
        fixture.stored_state(item_id),
        RecordedQueueItemState::Queued
    );
}

// A driver whose first resume finds the lead held and opens no process, and whose every later
// resume fails, with the count of resumes it took.
fn deferring_then_failing_driver(
    calls: &Arc<DriverCalls>,
) -> (MockProviderDriver, Arc<AtomicUsize>) {
    let mut driver = recording_driver(calls);
    let resumes = Arc::new(AtomicUsize::new(0));
    driver.expect_resume_session().returning({
        let resumes = Arc::clone(&resumes);
        move |params| {
            let opening = resumes.fetch_add(1, Ordering::SeqCst) == 0;
            let runs = params
                .live_runs
                .iter()
                .map(|run| ResumedRunAnswer {
                    run_id: run.run_id,
                    turn: ProviderTurnAnswer::Waiting,
                })
                .collect();
            async move {
                if opening {
                    Ok(DriverResumeResult::Deferred { runs })
                } else {
                    Err(DriverError::Internal("the test's resume fails".into()))
                }
            }
            .boxed()
        }
    });
    (driver, resumes)
}

// A paused lead with a conversation, its helper waiting on the person and its message queued,
// which the person continues: the continue finds the helper waiting and holds the lead `running`
// with no process. Answers the lead, the helper and the message.
async fn hold_continued_lead(fixture: &Fixture) -> (RunId, RunId, QueueItemId) {
    let lead = fixture.insert_run("paused").await;
    let binding_id = bind_run_to_first_provider(&fixture.database, lead);
    let reader = fixture.database.reader();
    reader
        .execute(
            "UPDATE runtime_bindings SET resume_handle = 'conversation-1' WHERE id = ?1",
            [binding_id.as_str()],
        )
        .expect("the test gives the lead's binding a conversation");
    let helper = fixture.insert_run("waitingForApproval").await;
    reader
        .execute(
            "UPDATE runs SET parent_run_id = ?1, reached_by = 'providerSubagent' WHERE run_id = ?2",
            params![lead.text().as_str(), helper.text().as_str()],
        )
        .expect("the test makes the run the lead's helper");
    let item_id = fixture.queue_message(lead).await;
    timeout(
        WAIT,
        fixture.queue.pauses.resume(
            &AgentRunResumeRequest {
                target_run_id: lead,
                expected_run_version: SafeInt::new(1).expect("a version"),
            },
            &fixture.queue.delivery,
        ),
    )
    .await
    .expect("the continue answers")
    .expect("the lead is held for the helper's answer");
    assert_eq!(fixture.run_state(lead), "running");
    (lead, helper, item_id)
}

// The person's answer moves `helper` on from its wait and hands the lead's continue over; waits
// for the continue's task alone, so the queue still takes the next Continue.
async fn answer_the_helper(fixture: &Fixture, helper: RunId) {
    fixture.set_run_state(helper, "running");
    fixture.queue.continue_after_answer(
        fixture.session_id,
        helper,
        RunStateEntry::WaitingForApproval,
    );
    fixture.queue.continues.close();
    timeout(WAIT, fixture.queue.continues.wait())
        .await
        .expect("the lead's continue ends");
}
