use std::time::{Duration, SystemTime};

use jiff::{SignedDuration, Timestamp};
use rstest::rstest;
use rusqlite::params;
use serde_json::{Map, Value, json};
use sidekicks_contracts::daemon::config::RunTimeLimitMinutes;
use sidekicks_contracts::wire::instant::WireInstant;
use tokio::time::timeout;

use crate::engine::ports::AgentStepOutcome;
use crate::engine::tick::turns::resuming::tests::resume;
use crate::engine::tick::turns::tests::harness::{
    Harness, QUIET, WAIT, attempt_column, edge, item, node, retried, step_column,
};
use crate::engine::tick::turns::{EngineTickInput, RunResumeRefusal};

/// The sequence and instant of the event of `event_type` on attempt `attempt` of `node_id`.
fn attempt_event(
    harness: &Harness,
    event_type: &str,
    node_id: &str,
    attempt: i64,
) -> (i64, String) {
    harness
        .events()
        .into_iter()
        .find(|(_, stored_type, _, payload)| {
            stored_type == event_type
                && payload["nodeId"] == json!(node_id)
                && payload["attempt"] == json!(attempt)
        })
        .map_or_else(
            || panic!("{node_id} attempt {attempt} has its {event_type}"),
            |(sequence, _, occurred_at, _)| (sequence, occurred_at),
        )
}

/// The record lines of each wave on `node_id`, as its reason and count.
fn waves_recorded(harness: &Harness, node_id: &str) -> Vec<(Value, Value)> {
    harness
        .records
        .lines()
        .into_iter()
        .filter(|line| {
            line.get("report") == Some(&json!("branchesCanceled"))
                && line.get("nodeId") == Some(&json!(node_id))
        })
        .map(|line| (line["reason"].clone(), line["count"].clone()))
        .collect()
}

/// F fails its first try and is retried after 1 s. Mutations: the wait skipped; the attempt
/// never dispatched; a timer that outlives its run's cancel.
#[rstest]
#[case::waits(false)]
#[case::canceled_run(true)]
#[tokio::test]
async fn a_retry_runs_its_next_attempt_after_its_wait(#[case] is_run_canceled: bool) {
    let mut harness = Harness::new(None).await;
    let cancel = harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                retried(node("F", "test.flaky", 1, None), 2, 1_000),
            ],
            &[edge("trigger", "F", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    if is_run_canceled {
        harness
            .wait_until(|rows| attempt_column(rows, "F", 1, "status").as_deref() == Some("failed"))
            .await;
        cancel.cancel();
        tokio::time::sleep(Duration::from_millis(1_500)).await;

        assert_eq!(
            attempt_column(&harness.rows, "F", 2, "status").as_deref(),
            Some("pending")
        );
        let named: Vec<String> = harness
            .events()
            .into_iter()
            .filter(|(_, _, _, payload)| {
                payload["nodeId"] == json!("F") && payload["attempt"] == json!(2)
            })
            .map(|(_, event_type, _, _)| event_type)
            .collect();
        assert_eq!(named, ["workflow.phase.retried"]);
        return;
    }
    harness
        .wait_until(|rows| attempt_column(rows, "F", 2, "status").as_deref() == Some("succeeded"))
        .await;

    let (_, failed_at) = attempt_event(&harness, "workflow.step.failed", "F", 1);
    let (_, admitted_at) = attempt_event(&harness, "workflow.phase.admitted", "F", 2);
    let failed_at: jiff::Timestamp = failed_at.parse().expect("an instant reads");
    let admitted_at: jiff::Timestamp = admitted_at.parse().expect("an instant reads");
    assert!(
        admitted_at.duration_since(failed_at) >= jiff::SignedDuration::from_secs(1),
        "attempt 2 is admitted {admitted_at}, a second after attempt 1 failed {failed_at}"
    );
}

/// M takes A's items first while B still runs: A settles only once B runs, so the cancel lands on
/// a running step. Mutations: the wave written before B settles; B's own completion written; a
/// `siblingFailure` on a merge loser; the wave's event dropped because M settled first.
#[tokio::test]
async fn a_won_merge_cancels_its_running_loser_in_one_wave() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.gated", 1, None),
                node("B", "test.linger", 2, None),
                node("M", "test.first", 3, None),
            ],
            &[
                edge("trigger", "A", 0),
                edge("trigger", "B", 0),
                edge("A", "M", 0),
                edge("B", "M", 1),
            ],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    timeout(WAIT, harness.signal.running.notified())
        .await
        .expect("B runs");
    harness.signal.go.notify_one();
    harness
        .wait_until(|rows| step_column(rows, "M", "status").as_deref() == Some("succeeded"))
        .await;
    timeout(WAIT, harness.signal.reached.notified())
        .await
        .expect("B's cancel reaches it");
    tokio::time::sleep(QUIET).await;

    let (completed, ..) = harness.event("workflow.step.completed", "A");
    let (canceling, ..) = harness.event("workflow.phase.canceling", "B");
    assert_eq!(
        canceling,
        completed + 1,
        "M's readying write holds B's cancel"
    );
    assert_eq!(harness.status("B").as_deref(), Some("running"));
    assert!(
        waves_recorded(&harness, "M").is_empty(),
        "the wave waits for B"
    );

    harness.signal.release.notify_one();
    harness
        .wait_until(|rows| step_column(rows, "B", "status").as_deref() == Some("canceled"))
        .await;

    let (wave, ..) = harness.event("workflow.parallelJoin.branchesCanceled", "M");
    let (canceled, ..) = harness.event("workflow.step.canceled", "B");
    assert_eq!(
        canceled,
        wave + 1,
        "one write holds the wave, then B's cancel"
    );
    assert_eq!(
        waves_recorded(&harness, "M"),
        [(json!("firstToArrive"), json!(1))]
    );
    let b_events: Vec<String> = harness
        .events()
        .into_iter()
        .filter(|(_, _, _, payload)| payload["nodeId"] == json!("B"))
        .map(|(_, event_type, _, _)| event_type)
        .collect();
    assert!(
        !b_events
            .iter()
            .any(|event_type| event_type == "workflow.phase.failed")
    );
    assert!(
        !b_events
            .iter()
            .any(|event_type| event_type == "workflow.step.completed")
    );
}

/// Y is readied in the walk turn that X's completion wins M on, on M's losing input. Mutations: Y
/// dispatched; Y with no row; Y kept live, so the run never goes quiet and leaves the live set.
#[tokio::test]
async fn a_step_on_a_losing_branch_readied_with_the_win_never_runs() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("X", "test.step", 1, None),
                node("Y", "test.step", 2, None),
                node("M", "test.first", 3, None),
            ],
            &[
                edge("trigger", "X", 0),
                edge("X", "M", 0),
                edge("X", "Y", 0),
                edge("Y", "M", 1),
            ],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    harness
        .wait_until(|rows| step_column(rows, "M", "status").as_deref() == Some("succeeded"))
        .await;
    tokio::time::sleep(QUIET).await;

    assert_eq!(harness.status("Y").as_deref(), Some("canceled"));
    let (completed, _, _, completed_payload) = harness.event("workflow.step.completed", "X");
    let readied: Vec<Value> = completed_payload["readied"]
        .as_array()
        .expect("the completion names what it readied")
        .iter()
        .map(|readied| readied["nodeId"].clone())
        .collect();
    assert!(readied.contains(&json!("M")) && readied.contains(&json!("Y")));
    let (canceled, _, _, canceled_payload) = harness.event("workflow.step.canceled", "Y");
    assert_eq!(
        canceled,
        completed + 1,
        "Y is canceled in the write that readied M"
    );
    assert_eq!(canceled_payload["readied"], json!([]));
    assert!(
        harness
            .events()
            .iter()
            .all(
                |(_, event_type, _, payload)| event_type != "workflow.phase.admitted"
                    || payload["nodeId"] != json!("Y")
            )
    );
    assert!(
        !harness.recorder.has_sequence(harness.scope.run_id),
        "the run goes quiet and leaves the live set"
    );
}

/// F fails with no error route, so it parks its run while B runs: F fails only once B runs, so
/// the cancel lands on a running step. Mutations: B's absorbed completion readying C; no
/// `siblingFailure` on B; the wave written before B settles.
#[tokio::test]
async fn a_park_winds_down_its_running_sibling_and_starts_nothing_after_it() {
    let mut harness = Harness::new(None).await;
    let run_id = harness.scope.run_id.text().as_str().to_owned();
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("F", "test.gatedFailure", 1, None),
                node("B", "test.linger", 2, None),
                node("C", "test.step", 3, None),
            ],
            &[
                edge("trigger", "F", 0),
                edge("trigger", "B", 0),
                edge("B", "C", 0),
            ],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    timeout(WAIT, harness.signal.running.notified())
        .await
        .expect("B runs");
    harness.signal.go.notify_one();
    harness
        .wait_until(|rows| step_column(rows, "F", "status").as_deref() == Some("failed"))
        .await;
    timeout(WAIT, harness.signal.reached.notified())
        .await
        .expect("B's cancel reaches it");
    tokio::time::sleep(QUIET).await;

    let (failed, ..) = harness.event("workflow.step.failed", "F");
    let (canceling, ..) = harness.event("workflow.phase.canceling", "B");
    assert_eq!(canceling, failed + 1, "F's failure write holds B's cancel");
    let (_, _, _, run_failed) = harness
        .events()
        .into_iter()
        .find(|(_, event_type, _, _)| event_type == "workflow.run.failed")
        .expect("the run's park is written");
    assert_eq!(run_failed["outcome"], json!("parked"));
    let run_status: String = harness
        .rows
        .query_row(
            "SELECT status FROM workflow_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .expect("the run's row reads");
    assert_eq!(run_status, "failed");
    assert_eq!(harness.status("B").as_deref(), Some("running"));
    assert!(
        waves_recorded(&harness, "F").is_empty(),
        "the wave waits for B"
    );

    harness.signal.release.notify_one();
    harness
        .wait_until(|rows| step_column(rows, "B", "status").as_deref() == Some("canceled"))
        .await;

    let (wave, ..) = harness.event("workflow.parallelJoin.branchesCanceled", "F");
    let (phase_failed, _, _, phase_failed_payload) = harness.event("workflow.phase.failed", "B");
    let (canceled, ..) = harness.event("workflow.step.canceled", "B");
    assert_eq!(
        (phase_failed, canceled),
        (wave + 1, wave + 2),
        "one write holds the wave, then B's sibling failure and cancel"
    );
    assert_eq!(
        phase_failed_payload["cancellationReason"],
        json!("siblingFailure")
    );
    assert_eq!(
        waves_recorded(&harness, "F"),
        [(json!("siblingFailure"), json!(1))]
    );
    assert_eq!(harness.status("C"), None);
}

/// The run time limit the account tests set, 30 minutes.
fn half_hour() -> Option<RunTimeLimitMinutes> {
    RunTimeLimitMinutes::new(30)
}

/// `at` moved on by `milliseconds`, as a stored instant.
fn instant_after(at: Timestamp, milliseconds: i64) -> WireInstant {
    let later = at
        .checked_add(SignedDuration::from_millis(milliseconds))
        .expect("the test's instant is in range");
    WireInstant::from_timestamp(later).expect("the test's instant is after year 0000")
}

/// The scope's run, its trigger feeding the agent step `A`, started and its run asked for.
async fn start_agent_run(harness: &Harness) {
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.agent", 1, None),
            ],
            &[edge("trigger", "A", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    timeout(WAIT, harness.agents.wait_for_request())
        .await
        .expect("A asks for its run");
}

/// An agent run's end on a spent account, resetting at `resets_at` where the provider stated it.
fn spent(resets_at: Option<WireInstant>) -> AgentStepOutcome {
    AgentStepOutcome::AccountSpent {
        provider_account_id: serde_json::from_value(json!("account-a"))
            .expect("the test's account id reads"),
        resets_at,
    }
}

/// The record lines of `record` on an armed resume.
fn resume_lines(harness: &Harness, record: &str) -> Vec<Map<String, Value>> {
    harness
        .record_lines(record)
        .into_iter()
        .filter(|line| line.get("deadline") == Some(&json!("resumeAt")))
        .collect()
}

/// When the scope's run started, as its row stores it.
fn run_started_at(harness: &Harness) -> Timestamp {
    let started_at: String = harness
        .rows
        .query_row(
            "SELECT started_at FROM workflow_runs WHERE id = ?1",
            params![harness.scope.run_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the run's row reads");
    started_at.parse().expect("a stored instant reads")
}

/// A spent account whose stated reset falls before the run's cap parks its step `waiting` with
/// its resume at the reset itself, on the row and on `workflow.phase.suspended`, and records the
/// arm once. Kills: an offset on the boundary; the event's `resumeAt` left off; the resume never
/// armed.
#[tokio::test]
async fn a_reset_before_the_cap_arms_the_parked_steps_resume_at_the_boundary() {
    let mut harness = Harness::new(None).await;
    harness.limits.set_run_time_limit(half_hour());
    start_agent_run(&harness).await;
    let resets_at = instant_after(Timestamp::now(), 60_000);

    harness.agents.end(spent(Some(resets_at.clone())));
    harness
        .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("waiting"))
        .await;
    harness.wait_for_earlier_turns().await;

    assert_eq!(
        step_column(&harness.rows, "A", "resume_at").as_deref(),
        Some(resets_at.as_str())
    );
    let (_, _, _, suspended) = harness.event("workflow.phase.suspended", "A");
    assert_eq!(suspended["resumeAt"], json!(resets_at));
    let armed = resume_lines(&harness, "deadlineArmed");
    assert_eq!(armed.len(), 1, "the resume is armed once");
    assert_eq!(armed[0]["at"], json!(resets_at));
    assert_eq!(harness.armed(), Some(wall_instant(&resets_at)));
}

/// A spent account whose stated reset falls at the run's cap deadline or past it parks its step
/// unscheduled: no resume on the row or the event, and no arm recorded. Kills: the cap comparison
/// dropped; a reset at the deadline read as before it.
#[rstest]
#[case::at_the_cap(0)]
#[case::past_the_cap(1)]
#[tokio::test]
async fn a_reset_at_or_past_the_cap_parks_the_step_unscheduled(#[case] past_cap_ms: i64) {
    let mut harness = Harness::new(None).await;
    harness.limits.set_run_time_limit(half_hour());
    start_agent_run(&harness).await;
    let cap_ms = 30 * 60_000;
    let resets_at = instant_after(run_started_at(&harness), cap_ms + past_cap_ms);

    harness.agents.end(spent(Some(resets_at)));
    harness
        .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("waiting"))
        .await;
    harness.wait_for_earlier_turns().await;

    assert_eq!(step_column(&harness.rows, "A", "resume_at"), None);
    let (_, _, _, suspended) = harness.event("workflow.phase.suspended", "A");
    assert_eq!(suspended.get("resumeAt"), None);
    assert_eq!(
        resume_lines(&harness, "deadlineArmed"),
        Vec::<Map<String, Value>>::new()
    );
    let cap_at = instant_after(run_started_at(&harness), cap_ms);
    assert_eq!(
        harness.armed(),
        Some(wall_instant(&cap_at)),
        "only the cap is armed"
    );
}

/// `at` on the wall clock.
fn wall_instant(at: &WireInstant) -> SystemTime {
    SystemTime::from(at.timestamp().expect("a stored instant reads"))
}

/// The record lines of `record` on the run's cap.
fn cap_lines(harness: &Harness, record: &str) -> Vec<Map<String, Value>> {
    harness
        .record_lines(record)
        .into_iter()
        .filter(|line| line.get("deadline") == Some(&json!("cap")))
        .collect()
}

/// The run cap passing while A waits on its spent account fails A `timedOut` `runCap`, stops its
/// kept run, ends the run `failed` with the cap's error, records the cap's clear, and leaves
/// nothing of the run armed; a Resume after it is not taken, so A's run is never taken again.
/// Kills: caps read only for running runs; the ending leaving the cap armed; the ended run kept
/// live, its account wait lifted by the Resume.
#[tokio::test]
async fn the_cap_passing_during_an_account_park_ends_the_run() {
    let mut harness = Harness::new(None).await;
    harness.limits.set_run_time_limit(half_hour());
    start_agent_run(&harness).await;
    harness.agents.end(spent(None));
    harness
        .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("waiting"))
        .await;
    harness.wait_for_earlier_turns().await;
    let cap_at = instant_after(run_started_at(&harness), 30 * 60_000);
    assert_eq!(harness.armed(), Some(wall_instant(&cap_at)));
    assert_eq!(cap_lines(&harness, "deadlineArmed").len(), 1);

    harness
        .clock
        .set_now(wall_instant(&cap_at) + Duration::from_secs(1));
    timeout(WAIT, harness.agents.wait_for_cancel())
        .await
        .expect("A's kept run is stopped");
    let run_id = harness.scope.run_id.text().as_str().to_owned();
    harness
        .wait_until(|rows| {
            rows.query_row(
                "SELECT finished_at IS NOT NULL FROM workflow_runs WHERE id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .unwrap_or(false)
        })
        .await;
    harness.wait_for_earlier_turns().await;

    assert_eq!(harness.status("A").as_deref(), Some("failed"));
    let step_error: Value = serde_json::from_str(
        &step_column(&harness.rows, "A", "error_json").expect("A's error is stored"),
    )
    .expect("the error is JSON");
    assert_eq!(step_error["code"], json!("workflow.step.timedOut"));
    assert_eq!(step_error["details"]["cause"], json!("runCap"));
    let (status, run_error): (String, String) = harness
        .rows
        .query_row(
            "SELECT status, error_json FROM workflow_runs WHERE id = ?1",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the run's row reads");
    assert_eq!(status, "failed");
    let run_error: Value = serde_json::from_str(&run_error).expect("the run's error is JSON");
    assert_eq!(run_error["details"]["cause"], json!("runCap"));
    let cleared = cap_lines(&harness, "deadlineCleared");
    assert_eq!(cleared.len(), 1, "the ending clears the cap");
    assert_eq!(cleared[0]["at"], json!(cap_at));
    assert_eq!(resume(&harness).await, Err(RunResumeRefusal::NotHeld));
    assert_eq!(harness.agents.resumes(), 0);
    assert_eq!(harness.armed(), None, "nothing of the run stays armed");
}

/// A, parked on its spent account until a reset a minute away, its resume armed.
async fn park_until_a_minute_from_now(harness: &mut Harness) -> WireInstant {
    start_agent_run(harness).await;
    let resets_at = instant_after(Timestamp::now(), 60_000);
    harness.agents.end(spent(Some(resets_at.clone())));
    harness
        .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("waiting"))
        .await;
    harness.wait_for_earlier_turns().await;
    assert_eq!(harness.armed(), Some(wall_instant(&resets_at)));
    resets_at
}

/// A resumes when its reset passes: its row back to `running` with no resume, the step's and the
/// run's resume in one write, its kept run taken again once after that write, the row read at
/// the call, with the clear recorded, and its next outcome settling it. Kills: the resume never
/// fired; `resume()` before the write; a second driver; the clear line missing.
#[tokio::test]
async fn a_parked_step_resumes_once_its_reset_passes() {
    let mut harness = Harness::new(None).await;
    let resets_at = park_until_a_minute_from_now(&mut harness).await;
    let reader = std::sync::Mutex::new(harness.reader());
    harness.agents.read_at_resume(move || {
        step_column(&sidekicks_std::mutex_lock::lock(&reader), "A", "status").unwrap_or_default()
    });

    harness
        .clock
        .set_now(wall_instant(&resets_at) + Duration::from_secs(1));
    timeout(WAIT, harness.agents.wait_for_resume())
        .await
        .expect("A's kept run is taken again");
    assert_eq!(
        harness.agents.read_at_resumes(),
        ["running"],
        "the resume is written before the run is taken again"
    );
    assert_eq!(step_column(&harness.rows, "A", "resume_at"), None);
    let (phase_resumed, ..) = harness.event("workflow.phase.resumed", "A");
    let (run_resumed, ..) = harness
        .events()
        .into_iter()
        .find(|(_, event_type, _, _)| event_type == "workflow.run.resumed")
        .expect("the run resumes");
    assert_eq!(
        run_resumed,
        phase_resumed + 1,
        "one write resumes the step and the run"
    );
    let cleared = resume_lines(&harness, "deadlineCleared");
    assert_eq!(cleared.len(), 1, "the resume is cleared once");
    assert_eq!(cleared[0]["at"], json!(resets_at));

    harness.agents.end(AgentStepOutcome::Completed {
        items: vec![item(json!({ "answer": 1 }))],
        cost: None,
    });
    harness
        .wait_until(|rows| step_column(rows, "A", "status").as_deref() == Some("succeeded"))
        .await;
    tokio::time::sleep(QUIET).await;
    assert_eq!(
        harness.agents.resumes(),
        1,
        "one driver takes the run again"
    );
}

/// A person's Resume while A waits on its spent account, its reset a minute away, and W waits on
/// a reply lifts A's wait now: its row back to `running` with its resume cleared, its kept run
/// taken again, while W keeps waiting. Kills: the Resume refused until the reset passes; W's wait
/// lifted with A's; the kept run never taken again.
#[tokio::test]
async fn a_resume_lifts_an_account_park_ahead_of_its_reset_and_leaves_a_person_wait() {
    let mut harness = Harness::new(None).await;
    harness
        .start(
            vec![
                node("trigger", "test.trigger", 0, None),
                node("A", "test.agent", 1, None),
                node("W", "test.ask", 2, None),
            ],
            &[edge("trigger", "A", 0), edge("trigger", "W", 0)],
            vec![item(json!({}))],
            |_| {},
        )
        .await;
    timeout(WAIT, harness.agents.wait_for_request())
        .await
        .expect("A asks for its run");
    harness
        .agents
        .end(spent(Some(instant_after(Timestamp::now(), 60_000))));
    harness
        .wait_until(|rows| {
            step_column(rows, "A", "status").as_deref() == Some("waiting")
                && step_column(rows, "W", "status").as_deref() == Some("waiting")
        })
        .await;
    harness.wait_for_earlier_turns().await;

    assert_eq!(resume(&harness).await, Ok(()));
    timeout(WAIT, harness.agents.wait_for_resume())
        .await
        .expect("A's kept run is taken again");

    assert_eq!(harness.status("A").as_deref(), Some("running"));
    assert_eq!(step_column(&harness.rows, "A", "resume_at"), None);
    assert_eq!(harness.status("W").as_deref(), Some("waiting"));
    assert_eq!(resume_lines(&harness, "deadlineCleared").len(), 1);
    assert_eq!(harness.agents.resumes(), 1);
}

/// A person's cancel of the run while A's resume is armed cancels A, stops its kept run, empties
/// its resume and disarms the clock. Kills: the account wait's clear skipped when A leaves it.
#[tokio::test]
async fn a_cancel_while_the_resume_is_armed_disarms_it() {
    let mut harness = Harness::new(None).await;
    let resets_at = park_until_a_minute_from_now(&mut harness).await;

    let replied = harness.cancel("not now").await;
    timeout(WAIT, replied)
        .await
        .expect("the loop replies in time")
        .expect("the reply is sent")
        .expect("the cancel is taken");
    timeout(WAIT, harness.agents.wait_for_cancel())
        .await
        .expect("A's kept run is stopped");
    harness.wait_for_earlier_turns().await;

    assert_eq!(harness.status("A").as_deref(), Some("canceled"));
    assert_eq!(step_column(&harness.rows, "A", "resume_at"), None);
    let cleared = resume_lines(&harness, "deadlineCleared");
    assert_eq!(cleared.len(), 1, "the cancel clears the resume");
    assert_eq!(cleared[0]["at"], json!(resets_at));
    assert_eq!(harness.armed(), None, "the clock is disarmed");
    assert_eq!(harness.agents.resumes(), 0);
}

/// A change of `Stop a run after` while a run is live moves its cap line and the clock to the new
/// limit. Kills: the change leaving the record naming the old cap.
#[tokio::test]
async fn a_run_limit_change_moves_a_live_runs_cap() {
    let harness = Harness::new(None).await;
    harness.limits.set_run_time_limit(half_hour());
    start_agent_run(&harness).await;
    harness.wait_for_earlier_turns().await;
    let first_cap = instant_after(run_started_at(&harness), 30 * 60_000);
    assert_eq!(harness.armed(), Some(wall_instant(&first_cap)));

    harness
        .limits
        .set_run_time_limit(RunTimeLimitMinutes::new(60));
    harness
        .inbox
        .send(EngineTickInput::RunLimitChanged)
        .await
        .unwrap_or_else(|_| panic!("the loop takes the change"));
    // The first answer can share the change's turn; the second lands after its clock read.
    harness.wait_for_earlier_turns().await;
    harness.wait_for_earlier_turns().await;

    let later_cap = instant_after(run_started_at(&harness), 60 * 60_000);
    let cleared = cap_lines(&harness, "deadlineCleared");
    assert_eq!(cleared.len(), 1, "the old cap is cleared");
    assert_eq!(cleared[0]["at"], json!(first_cap));
    let armed = cap_lines(&harness, "deadlineArmed");
    assert_eq!(armed.len(), 2, "the new cap is armed");
    assert_eq!(armed[1]["at"], json!(later_cap));
    assert_eq!(harness.armed(), Some(wall_instant(&later_cap)));
}
