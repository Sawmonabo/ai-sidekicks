//! The run's ending in the tick's loop: a person's cancel routed to its run and winding it down;
//! the run cap ending a run on its earliest running or parked step; and the turn that finds a run
//! over writing its ending, a run a stop ended once none of its steps runs, is held, pending or
//! waiting, and a run no stop touched once every step settled.

use std::collections::HashMap;

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::run::control::WorkflowCancelReason;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use tokio::sync::oneshot;

use super::reports::{stop_agent_run, stop_steps};
use super::{EngineTick, ReadiedNext, RunTurn};
use crate::engine::tick::commit::RunEnding;
use crate::engine::tick::live_runs::{LiveRun, LiveStep};
use crate::engine::tick::step_failure::{RunStop, step_failure_error};
use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
use crate::kinds::StepFailure;

/// The reply to a person's cancel: the sequence of the run's `workflow.run.canceled` once the
/// write of the run's ending commits, or why the tick did not take it.
pub(crate) type RunCancelReply = oneshot::Sender<Result<SafeInt<0>, RunCancelRefusal>>;

/// A person's cancel of a run, as it reaches the tick.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the run cancel handler, which sends it")
)]
pub(crate) struct RunCancelIntake {
    /// The run.
    pub(crate) run_id: WorkflowRunId,
    /// The person's reason, where one was given.
    pub(crate) reason: Option<WorkflowCancelReason>,
    /// The run's error the cancel stores, carrying the reason as its message.
    pub(crate) error: Option<WorkflowStepError>,
    /// Where the answer goes.
    pub(crate) reply: RunCancelReply,
}

/// Why the tick did not take a person's cancel.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RunCancelRefusal {
    /// The tick does not hold the run, so its cancel writes the run's rows itself.
    NotHeld,
    /// A step's failure already decided the run's ending, which stands.
    Ending,
}

impl EngineTick {
    /// Routes `intake` to the live run it names, the run added to `order` where it is not there
    /// yet; a run the tick does not hold is answered [`RunCancelRefusal::NotHeld`] at once.
    pub(super) fn route_cancel(
        &self,
        intake: RunCancelIntake,
        order: &mut Vec<WorkflowRunId>,
        cancels: &mut HashMap<WorkflowRunId, Vec<RunCancelIntake>>,
    ) {
        if self.runs.contains_key(&intake.run_id) {
            if !order.contains(&intake.run_id) {
                order.push(intake.run_id);
            }
            cancels.entry(intake.run_id).or_default().push(intake);
        } else {
            let _unheard = intake.reply.send(Err(RunCancelRefusal::NotHeld));
        }
    }

    /// Takes the person's cancel `intake` of the run of `live` in `turn`: the run's ending becomes
    /// `canceled` with the cancel's reason and error, and every step stops as an end's, the
    /// earliest running one carrying the wave; the reply waits for the ending's write. A second
    /// cancel waits with the first, and a run whose ending a failure decided refuses it.
    pub(super) async fn apply_cancel(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        intake: RunCancelIntake,
    ) {
        let RunCancelIntake {
            reason,
            error,
            reply,
            ..
        } = intake;
        match live.ending {
            Some(RunEnding::Canceled { .. }) => {
                live.cancel_replies.push(reply);
                return;
            }
            Some(RunEnding::Completed | RunEnding::Failed { .. }) => {
                let _unheard = reply.send(Err(RunCancelRefusal::Ending));
                return;
            }
            None => {}
        }
        live.ending = Some(RunEnding::Canceled { reason, error });
        live.cancel_replies.push(reply);
        stop_steps(live, turn, None, &WireInstant::now(), RunStop::End).await;
    }

    /// Ends the run of `live` on the run cap's `failure` at `at`, with its `log_lines`, whichever
    /// step reported it: the run's earliest running or parked step takes it, the run's error is
    /// the cap's, and every other step winds down as the end's siblings. A parked step keeps its
    /// failed row and its own error; a step still running fails now and is canceled, and the
    /// run's ending waits for its own settlement. A run whose ending is decided takes nothing more.
    pub(super) async fn cap_run(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        at: WireInstant,
        failure: StepFailure,
        log_lines: Vec<String>,
    ) {
        if live.ending.is_some() {
            return;
        }
        let capped = capped_step(live);
        let step = capped.step.clone();
        if capped.status == WorkflowStepStatus::Failed {
            let error = step_failure_error(&step.node_id, &failure);
            live.ending = Some(RunEnding::Failed { error });
            self.stop_run(live, turn, &step, &at, RunStop::End).await;
            return;
        }
        let driver = matches!(
            capped.status,
            WorkflowStepStatus::Running
                | WorkflowStepStatus::Pending
                | WorkflowStepStatus::WaitingMemory
        )
        .then(|| capped.cancel.clone())
        .flatten();
        let parked_agent_run = live
            .steps
            .get_mut(&step.execution_index.get())
            .and_then(|live_step| live_step.parked_agent_run.take());
        stop_agent_run(live, &step, parked_agent_run).await;
        let failed = StepReport {
            step: step.clone(),
            at: at.clone(),
            kind: StepReportKind::Settled(StepSettlement::Failed { failure, log_lines }),
        };
        let answer = self.report_settlement(live, &mut turn.commit, failed).await;
        self.follow_settlement(live, turn, &step, at, answer).await;
        if let Some(cancel) = driver {
            cancel.cancel();
            live.steps
                .get_mut(&step.execution_index.get())
                .expect("a failure that ends its run keeps its step live")
                .is_winding_down = true;
        }
    }
}

/// The step of `live` the run cap cuts: the earliest of its steps running, parked on a failure or
/// parked on a spent account that is not already winding down, else its earliest live step.
fn capped_step(live: &LiveRun) -> &LiveStep {
    let is_running_or_parked = |live_step: &&LiveStep| {
        !live_step.is_winding_down
            && match live_step.status {
                WorkflowStepStatus::Running | WorkflowStepStatus::Failed => true,
                WorkflowStepStatus::Waiting => {
                    live_step.wait_cause == Some(WorkflowWaitCause::Account)
                }
                WorkflowStepStatus::Pending
                | WorkflowStepStatus::WaitingMemory
                | WorkflowStepStatus::Succeeded
                | WorkflowStepStatus::Skipped
                | WorkflowStepStatus::Canceled => false,
            }
    };
    let execution_index = |live_step: &&LiveStep| live_step.step.execution_index.get();
    live.steps
        .values()
        .filter(is_running_or_parked)
        .min_by_key(execution_index)
        .or_else(|| live.steps.values().min_by_key(execution_index))
        .expect("a live run keeps a live step")
}

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

    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
    use tokio::time::timeout;

    use crate::engine::tick::step_failure::run_cap_failure;
    use crate::engine::tick::turns::tests::harness::{
        Harness, QUIET, WAIT, edge, item, node, step_column,
    };
    use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};

    /// The key of the step of `node_id`, read from its row.
    fn step_key(harness: &Harness, node_id: &str) -> WorkflowStepKey {
        let (attempt, execution_index): (i64, i64) = harness
            .rows
            .query_row(
                "SELECT attempt, execution_index FROM workflow_steps WHERE node_id = ?1",
                [node_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the step's row reads");
        serde_json::from_value(json!({
            "workflowRunId": harness.scope.run_id, "nodeId": node_id,
            "attempt": attempt, "executionIndex": execution_index,
        }))
        .expect("the step's key reads")
    }

    /// The run cap's failure, a 60 s cap, reported on the step of `node_id` as its clock would.
    async fn report_run_cap(harness: &Harness, node_id: &str) {
        let report = StepReport {
            step: step_key(harness, node_id),
            at: WireInstant::now(),
            kind: StepReportKind::Settled(StepSettlement::Failed {
                failure: run_cap_failure(SafeInt::new(60_000).expect("a cap")),
                log_lines: Vec::new(),
            }),
        };
        harness
            .reports
            .send(report)
            .await
            .unwrap_or_else(|_| panic!("the loop takes the report"));
    }

    /// The stored error of the step of `node_id`, as JSON.
    fn step_error(harness: &Harness, node_id: &str) -> Value {
        let error_json =
            step_column(&harness.rows, node_id, "error_json").expect("the step keeps its error");
        serde_json::from_str(&error_json).expect("a stored error is JSON")
    }

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

    /// The run cap reported on B fails A, the run's earliest running step, `timedOut` `runCap`
    /// whatever its `onError`, winds B down in one wave on A, and the run ends `failed` with A's
    /// error only once A's own cancel settles. Mutations: cap the step the report names; route the
    /// cap by `onError`, which passes A's input on; end the run before A settles.
    #[tokio::test]
    async fn the_run_cap_fails_the_earliest_running_step_and_ends_once_it_settles() {
        let mut harness = Harness::new(None).await;
        harness
            .start(
                vec![
                    node("trigger", "test.trigger", 0, None),
                    node("A", "test.linger", 1, Some("continue")),
                    node("B", "test.wait", 2, None),
                ],
                &[edge("trigger", "A", 0), edge("trigger", "B", 0)],
                vec![item(json!({}))],
                |_| {},
            )
            .await;
        timeout(WAIT, harness.signal.running.notified())
            .await
            .expect("A runs");
        harness
            .wait_until(|rows| step_column(rows, "B", "status").as_deref() == Some("running"))
            .await;
        report_run_cap(&harness, "B").await;
        harness
            .wait_until(|rows| step_column(rows, "B", "status").as_deref() == Some("canceled"))
            .await;
        tokio::time::sleep(QUIET).await;

        assert_eq!(harness.status("A").as_deref(), Some("failed"));
        let capped = step_error(&harness, "A");
        assert_eq!(
            (&capped["code"], &capped["details"]["cause"]),
            (&json!("workflow.step.timedOut"), &json!("runCap"))
        );
        assert_eq!(
            run_row(&harness.rows),
            ("running".to_owned(), None, None),
            "the ending waits for A's own cancel"
        );
        let (wave, ..) = harness.event("workflow.parallelJoin.branchesCanceled", "A");
        let (_, _, _, sibling) = harness.event("workflow.phase.failed", "B");
        let (canceled, ..) = harness.event("workflow.step.canceled", "B");
        assert_eq!(sibling["cancellationReason"], json!("siblingFailure"));
        assert!(canceled > wave);

        harness.signal.release.notify_one();
        harness.wait_until(|rows| run_row(rows).0 == "failed").await;

        let (_, finished_at, error_json) = run_row(&harness.rows);
        assert!(finished_at.is_some());
        let run_error: Value =
            serde_json::from_str(&error_json.expect("the run keeps its error")).expect("JSON");
        assert_eq!(run_error, capped);
        let waves = harness
            .events()
            .into_iter()
            .filter(|(_, event_type, _, _)| event_type == "workflow.parallelJoin.branchesCanceled")
            .count();
        assert_eq!(waves, 1);
    }

    /// The run cap on a run parked on F's failure ends it `failed` with the cap's error while F
    /// keeps its failed row and its own error. Mutations: write the cap's failure over F's row;
    /// put F's error on the run; leave the parked run going.
    #[tokio::test]
    async fn the_run_cap_ends_a_parked_run_and_keeps_its_failed_steps_error() {
        let mut harness = Harness::new(None).await;
        harness
            .start(
                vec![
                    node("trigger", "test.trigger", 0, None),
                    node("F", "test.gatedFailure", 1, None),
                ],
                &[edge("trigger", "F", 0)],
                vec![item(json!({}))],
                |_| {},
            )
            .await;
        harness.signal.go.notify_one();
        harness.wait_until(|rows| run_row(rows).0 == "failed").await;
        let parked_error = step_error(&harness, "F");
        assert_eq!(run_row(&harness.rows).1, None, "the run is parked");

        report_run_cap(&harness, "F").await;
        harness.wait_until(|rows| run_row(rows).1.is_some()).await;

        assert_eq!(harness.status("F").as_deref(), Some("failed"));
        assert_eq!(step_error(&harness, "F"), parked_error);
        let (_, _, error_json) = run_row(&harness.rows);
        let run_error: Value =
            serde_json::from_str(&error_json.expect("the run keeps its error")).expect("JSON");
        assert_eq!(
            (&run_error["code"], &run_error["details"]["cause"]),
            (&json!("workflow.step.timedOut"), &json!("runCap"))
        );
        let outcomes: Vec<Value> = run_events(&harness)
            .into_iter()
            .filter(|(event_type, _)| event_type == "workflow.run.failed")
            .map(|(_, payload)| payload["outcome"].clone())
            .collect();
        assert_eq!(outcomes, [json!("parked"), json!("ended")]);
    }

    /// A person's cancel of a run with A and B running and W waiting on a reply cancels W in its
    /// own turn and winds A and B down as one wave on A, the earliest: `canceled` is written, with
    /// the person's reason and error on the event and the error on the row, only in the turn the
    /// last of them settles, and the reply answers that event's sequence after that write. Every
    /// step reads `runCanceled`. Mutations: write `canceled` in the cancel's own turn while a
    /// branch runs; leave W waiting; drop the reason or the error; reply before the write.
    #[tokio::test]
    async fn a_cancel_winds_the_run_down_and_writes_canceled_with_its_last_branch() {
        let mut harness = Harness::new(None).await;
        harness
            .start(
                vec![
                    node("trigger", "test.trigger", 0, None),
                    node("A", "test.linger", 1, None),
                    node("B", "test.linger", 2, None),
                    node("W", "test.ask", 3, None),
                ],
                &[
                    edge("trigger", "A", 0),
                    edge("trigger", "B", 0),
                    edge("trigger", "W", 0),
                ],
                vec![item(json!({}))],
                |_| {},
            )
            .await;
        harness
            .wait_until(|rows| {
                ["A", "B"].iter().all(|node_id| {
                    step_column(rows, node_id, "status").as_deref() == Some("running")
                }) && step_column(rows, "W", "status").as_deref() == Some("waiting")
            })
            .await;
        let mut replied = harness.cancel("Not needed any more").await;
        harness
            .wait_until(|rows| step_column(rows, "W", "status").as_deref() == Some("canceled"))
            .await;
        // Each release must find its step waiting for it, since a release with none waiting keeps
        // only one.
        tokio::time::sleep(QUIET).await;
        harness.signal.release.notify_one();
        tokio::time::sleep(QUIET).await;

        assert_eq!(run_row(&harness.rows).0, "running", "a branch still runs");
        assert!(
            replied.try_recv().is_err(),
            "the reply waits for the ending"
        );

        harness.signal.release.notify_one();
        harness
            .wait_until(|rows| run_row(rows).0 == "canceled")
            .await;

        let sequence = timeout(WAIT, replied)
            .await
            .expect("the loop replies in time")
            .expect("the loop keeps the reply")
            .expect("the cancel is taken");
        let (canceled_sequence, _, _, canceled) = harness
            .events()
            .into_iter()
            .find(|(_, event_type, _, _)| event_type == "workflow.run.canceled")
            .expect("the run's cancel is written");
        assert_eq!(i64::try_from(sequence.get()).ok(), Some(canceled_sequence));
        let error = json!({ "message": "Not needed any more" });
        assert_eq!(canceled["reason"], json!("Not needed any more"));
        assert_eq!(canceled["error"], error);
        let (_, finished_at, error_json) = run_row(&harness.rows);
        assert!(finished_at.is_some());
        let stored: Value =
            serde_json::from_str(&error_json.expect("the run keeps its error")).expect("JSON");
        assert_eq!(stored, error);
        let (wave, ..) = harness.event("workflow.parallelJoin.branchesCanceled", "A");
        assert!(
            canceled_sequence > wave,
            "the ending rides the wave's write"
        );
        for node_id in ["A", "B", "W"] {
            let (_, _, _, phase_failed) = harness.event("workflow.phase.failed", node_id);
            assert_eq!(
                phase_failed["cancellationReason"],
                json!("runCanceled"),
                "{node_id}"
            );
            assert_eq!(harness.status(node_id).as_deref(), Some("canceled"));
        }
    }

    /// A cancel reaching a run whose approval pause is still being captured waits for that
    /// capture, then cancels the run before its card is raised. Mutations: take the cancel while
    /// the capture runs; raise the abandoned pause's card.
    #[tokio::test]
    async fn a_cancel_reaching_a_pausing_run_is_taken_when_its_capture_ends() {
        let mut harness = Harness::new(None).await;
        harness.points.set_gate(false);
        harness
            .start(
                vec![
                    node("trigger", "test.trigger", 0, None),
                    node("P", "test.approve", 1, None),
                ],
                &[edge("trigger", "P", 0)],
                vec![item(json!({}))],
                |_| {},
            )
            .await;
        harness
            .wait_until(|rows| step_column(rows, "P", "status").as_deref() == Some("waiting"))
            .await;
        assert_eq!(
            harness.ordered_calls(1).await.len(),
            1,
            "P's point is taken"
        );
        let mut replied = harness.cancel("Stop").await;
        tokio::time::sleep(QUIET).await;

        assert_eq!(harness.status("P").as_deref(), Some("waiting"));
        assert!(
            replied.try_recv().is_err(),
            "the cancel waits for the capture"
        );

        harness.points.set_gate(true);
        harness
            .wait_until(|rows| run_row(rows).0 == "canceled")
            .await;
        timeout(WAIT, replied)
            .await
            .expect("the loop replies in time")
            .expect("the loop keeps the reply")
            .expect("the cancel is taken");
        tokio::time::sleep(QUIET).await;

        assert_eq!(harness.status("P").as_deref(), Some("canceled"));
        assert_eq!(
            harness.ordered_calls(1).await.len(),
            1,
            "no card is raised for the abandoned pause"
        );
    }
}
