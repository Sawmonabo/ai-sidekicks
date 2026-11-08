//! The run's ending in the tick's loop: a run a stop ended is over once none of its steps runs,
//! is held, pending or waiting, and a run no stop touched once every step settled; the turn that
//! finds it over writes its ending.

use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;

use super::{ReadiedNext, RunTurn};
use crate::engine::tick::commit::RunEnding;
use crate::engine::tick::live_runs::LiveRun;

/// Adds the ending of the run of `live` to `turn` where the run is over: the ending a stop decided
/// once every step left live is a failed one with nothing winding down and nothing this turn
/// readied goes on, else `Completed` for a run no stop touched with no step left live or readied.
pub(super) fn end_when_over(live: &mut LiveRun, turn: &mut RunTurn) {
    let is_wound_down = live.steps.values().all(|live_step| {
        live_step.status == WorkflowStepStatus::Failed && !live_step.is_winding_down
    }) && turn
        .readied
        .iter()
        .all(|readied| matches!(readied.next, ReadiedNext::Canceled));
    if !is_wound_down {
        return;
    }
    if let Some(ending) = live.ending.take() {
        turn.commit.end(ending);
    } else if live.stop.is_none() && live.steps.is_empty() {
        turn.commit.end(RunEnding::Completed);
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use serde_json::{Value, json};

    use crate::engine::tick::turns::tests::harness::{
        Harness, QUIET, edge, item, node, step_column,
    };

    /// The run's status, end and error as its row stores them.
    fn run_row(rows: &Connection) -> (String, Option<String>, Option<String>) {
        rows.query_row(
            "SELECT status, finished_at, error_json FROM workflow_runs",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("the run's row reads")
    }

    /// Each run event of the log, as its type and payload, in sequence order.
    fn run_events(harness: &Harness) -> Vec<(String, Value)> {
        harness
            .events()
            .into_iter()
            .filter(|(_, event_type, _, _)| {
                event_type.starts_with("workflow.run.") || event_type == "workflow.results.posted"
            })
            .map(|(_, event_type, _, payload)| (event_type, payload))
            .collect()
    }

    /// A run whose steps all succeed reads `succeeded`, ended at the instant of its last event,
    /// with one `workflow.run.completed` as that write's last event, and leaves the live set.
    /// Mutations: write nothing for a run whose steps all settled, which leaves it `running`;
    /// stamp the end with a fresh clock read.
    #[tokio::test]
    async fn a_run_whose_steps_all_succeed_ends_succeeded() {
        let mut harness = Harness::new(None).await;
        harness
            .start(
                vec![
                    node("trigger", "test.trigger", 0, None),
                    node("A", "test.step", 1, None),
                ],
                &[edge("trigger", "A", 0)],
                vec![item(json!({}))],
                |_| {},
            )
            .await;
        harness
            .wait_until(|rows| run_row(rows).0 == "succeeded")
            .await;
        tokio::time::sleep(QUIET).await;

        let events = harness.events();
        let (_, last_type, last_at, _) = events.last().expect("the run wrote its events");
        assert_eq!(last_type, "workflow.run.completed");
        let (_, _, completed_at, _) = harness.event("workflow.step.completed", "A");
        assert_eq!(last_at, &completed_at, "the ending rides A's write");
        assert_eq!(
            run_row(&harness.rows),
            ("succeeded".to_owned(), Some(completed_at), None)
        );
        let completed: Vec<_> = run_events(&harness)
            .into_iter()
            .filter(|(event_type, _)| event_type == "workflow.run.completed")
            .collect();
        assert_eq!(completed.len(), 1);
        assert!(!harness.recorder.has_sequence(harness.scope.run_id));
    }

    /// `flow.stopError` ends the run `failed` with its error and `outcome: ended`, in the write
    /// that cancels its sibling waiting on a reply, whose wait columns empty, and the run leaves
    /// the live set though its failed step is still live. Mutations: leave the waiting sibling
    /// waiting; end the run only once no step is live, which never happens after a failure.
    #[tokio::test]
    async fn a_stop_error_ends_the_run_failed_and_cancels_its_waiting_sibling() {
        let mut harness = Harness::new(None).await;
        harness
            .start(
                vec![
                    node("trigger", "test.trigger", 0, None),
                    node("W", "test.ask", 1, None),
                    node("S", "test.gatedStop", 2, None),
                ],
                &[edge("trigger", "W", 0), edge("trigger", "S", 0)],
                vec![item(json!({}))],
                |_| {},
            )
            .await;
        harness
            .wait_until(|rows| step_column(rows, "W", "status").as_deref() == Some("waiting"))
            .await;
        harness.signal.go.notify_one();
        harness.wait_until(|rows| run_row(rows).0 == "failed").await;
        tokio::time::sleep(QUIET).await;

        let (stored_status, finished_at, error_json) = run_row(&harness.rows);
        assert_eq!(stored_status, "failed");
        assert!(finished_at.is_some(), "the ended run has its end");
        let (_, _, _, step_failed) = harness.event("workflow.step.failed", "S");
        let run_error: Value =
            serde_json::from_str(&error_json.expect("the run keeps its error")).expect("JSON");
        assert_eq!(run_error, step_failed["error"]);
        assert_eq!(harness.status("W").as_deref(), Some("canceled"));
        for column in [
            "wait_cause",
            "wait_id",
            "wait_started_at",
            "wait_deadline_at",
        ] {
            assert_eq!(step_column(&harness.rows, "W", column), None, "{column}");
        }
        let (canceled, ..) = harness.event("workflow.step.canceled", "W");
        let (failed, ..) = harness.event("workflow.step.failed", "S");
        assert!(canceled > failed, "S's failure write cancels W");
        let ended: Vec<Value> = run_events(&harness)
            .into_iter()
            .filter(|(event_type, _)| event_type == "workflow.run.failed")
            .map(|(_, payload)| payload["outcome"].clone())
            .collect();
        assert_eq!(ended, [json!("ended")]);
        assert!(
            !harness.recorder.has_sequence(harness.scope.run_id),
            "the ended run leaves the live set"
        );
    }
}
