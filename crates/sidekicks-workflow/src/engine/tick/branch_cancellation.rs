//! The wind-down of branches canceled together: a `firstToArrive` merge taking its winner, or a
//! park or an end stopping the run's other branches. The running losers settle as one wave; a loser
//! still in the entry line or held at the gate is canceled at once and settles on its own. A
//! member whose agent run settled on a spent account before its cancel landed hands that run back,
//! since the cancel no longer reaches it.

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseCancellationReason;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use tokio_util::sync::CancellationToken;

use crate::engine::ports::AgentStepRun;
use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};

/// A step on a losing branch, with its cancel.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct BranchLoser {
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// Whether the step runs; false for a step still in the entry line or held at the gate.
    pub(crate) is_running: bool,
    /// The step's cancel.
    pub(crate) cancel: CancellationToken,
}

/// The running losers of one cancel, which settle together once the last of them has settled.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct BranchWave {
    /// The step whose turn decided the cancel.
    deciding: WorkflowStepKey,
    /// Why the branches were canceled.
    reason: WorkflowPhaseCancellationReason,
    /// The running losers, in loser order.
    members: Vec<WorkflowStepKey>,
    /// How many members have not settled yet.
    unsettled: usize,
}

/// What a wave answers for one report; a member's agent run handed back must be stopped.
#[must_use = "an agent run handed back keeps running until it is stopped"]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum WaveSettle {
    /// A member settled and others are still winding down.
    Pending {
        /// The member's agent run, where it settled on a spent account, for the tick to stop.
        run_to_stop: Option<Box<dyn AgentStepRun>>,
    },
    /// The last member settled.
    Closed {
        /// The wave's `BranchesCanceled` on the deciding step, then each member's cancel in loser
        /// order.
        reports: Vec<StepReport>,
        /// The member's agent run, where it settled on a spent account, for the tick to stop.
        run_to_stop: Option<Box<dyn AgentStepRun>>,
    },
    /// The report is no member's settlement, handed back for the tick to write as it is.
    Passed(StepReport),
}

/// Cancels every loser of `deciding`'s turn for `reason`, answering a `Canceling` for each running
/// loser, and the wave of the running losers when there is one.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn cancel_branches(
    deciding: WorkflowStepKey,
    reason: WorkflowPhaseCancellationReason,
    losers: Vec<BranchLoser>,
) -> (Vec<StepReport>, Option<BranchWave>) {
    let mut reports = Vec::new();
    let mut members = Vec::new();
    let canceled_at = WireInstant::now();
    for loser in losers {
        loser.cancel.cancel();
        if loser.is_running {
            reports.push(StepReport {
                step: loser.step.clone(),
                at: canceled_at.clone(),
                kind: StepReportKind::Canceling,
            });
            members.push(loser.step);
        }
    }
    let wave = (!members.is_empty()).then_some(BranchWave {
        deciding,
        reason,
        unsettled: members.len(),
        members,
    });
    (reports, wave)
}

impl BranchWave {
    /// Takes `report` into the wave. A member's settlement counts as canceled whatever it says, and
    /// its outputs are dropped, but an agent run kept on a spent account comes back to be stopped;
    /// every other report comes back as `Passed`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn settle(&mut self, report: StepReport) -> WaveSettle {
        let is_member_settlement = matches!(report.kind, StepReportKind::Settled(_))
            && self.members.contains(&report.step);
        if !is_member_settlement {
            return WaveSettle::Passed(report);
        }
        let run_to_stop = if let StepReportKind::Settled(StepSettlement::AccountSpent {
            run, ..
        }) = report.kind
        {
            Some(run)
        } else {
            None
        };
        self.unsettled -= 1;
        if self.unsettled > 0 {
            return WaveSettle::Pending { run_to_stop };
        }
        let members = std::mem::take(&mut self.members);
        let branches_canceled = StepReport {
            step: self.deciding.clone(),
            at: report.at.clone(),
            kind: StepReportKind::BranchesCanceled {
                reason: self.reason,
                count: members.len(),
            },
        };
        let closed_at = report.at;
        let canceled = members.into_iter().map(|step| StepReport {
            step,
            at: closed_at.clone(),
            kind: StepReportKind::Settled(StepSettlement::Canceled {
                hold_started_at: None,
                cancellation_reason: Some(self.reason),
            }),
        });
        WaveSettle::Closed {
            reports: std::iter::once(branches_canceled).chain(canceled).collect(),
            run_to_stop,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::Duration;

    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseCancellationReason;
    use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
    use tokio::time::timeout;
    use tokio_util::sync::CancellationToken;

    use super::{BranchLoser, WaveSettle, cancel_branches};
    use crate::engine::ports::scripted_agent_runs::ScriptedAgentRunner;
    use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
    use crate::kinds::step_context::StepRecords;

    /// The first execution of node `node_id`.
    fn step(node_id: &str) -> WorkflowStepKey {
        serde_json::from_value(json!({
            "workflowRunId": "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7c",
            "nodeId": node_id, "attempt": 1, "executionIndex": 0,
        }))
        .expect("the test's step key reads")
    }

    /// `report` as its node id and kind, reading every member a wave's report carries.
    fn report_json(report: &StepReport) -> Value {
        let kind = match &report.kind {
            StepReportKind::Progressed => json!("progressed"),
            StepReportKind::Canceling => json!("canceling"),
            StepReportKind::BranchesCanceled { reason, count } => {
                json!({ "branchesCanceled": { "reason": format!("{reason:?}"), "count": count } })
            }
            StepReportKind::Settled(StepSettlement::Canceled {
                hold_started_at,
                cancellation_reason,
            }) => json!({ "canceled": {
                "holdStartedAt": hold_started_at, "cancellationReason": cancellation_reason,
            } }),
            StepReportKind::WaitingOnMemory { .. }
            | StepReportKind::Admitted { .. }
            | StepReportKind::Started { .. }
            | StepReportKind::ResumeDue { .. }
            | StepReportKind::RunCapped { .. }
            | StepReportKind::Settled(
                StepSettlement::Completed { .. }
                | StepSettlement::Failed { .. }
                | StepSettlement::PersonWait { .. }
                | StepSettlement::AccountSpent { .. },
            ) => panic!("no wave answers another kind"),
        };
        json!([report.step.node_id, kind])
    }

    /// `report` of `node_id`, made now.
    fn report(node_id: &str, kind: StepReportKind) -> StepReport {
        StepReport {
            step: step(node_id),
            at: WireInstant::now(),
            kind,
        }
    }

    /// Two running losers and one held between them wind down as one wave of the two running ones:
    /// each running one gets a `Canceling` at once, every token is canceled, the held one's own
    /// settlement and a member's progress pass through, the first settlement leaves the wave open,
    /// and the last closes it with one `BranchesCanceled` carrying the wave's reason and size and
    /// each member canceled in loser order, the raced `Completed` included, all at the closing
    /// settlement's instant. Mutations: write `BranchesCanceled` per member, or with another reason
    /// or count; stamp the closing reports with fresh clock reads; close the wave at its first
    /// settlement; write a raced `Completed` as completed; put the held loser in the wave or give
    /// it a `Canceling`; answer `Pending` for a report that is no member's settlement; drop
    /// the wave's reason from its members, or give them another; order the members by
    /// settlement.
    #[rstest]
    #[case::merge_first_to_arrive(
        WorkflowPhaseCancellationReason::MergeFirstToArrive,
        "mergeFirstToArrive"
    )]
    #[case::sibling_failure(WorkflowPhaseCancellationReason::SiblingFailure, "siblingFailure")]
    #[case::run_canceled(WorkflowPhaseCancellationReason::RunCanceled, "runCanceled")]
    fn running_losers_settle_as_one_wave(
        #[case] reason: WorkflowPhaseCancellationReason,
        #[case] cancellation_reason: &str,
    ) {
        let tokens = [
            CancellationToken::new(),
            CancellationToken::new(),
            CancellationToken::new(),
        ];
        let losers = [("a", true), ("held", false), ("b", true)]
            .into_iter()
            .zip(&tokens)
            .map(|((node_id, is_running), cancel)| BranchLoser {
                step: step(node_id),
                is_running,
                cancel: cancel.clone(),
            })
            .collect();

        let (reports, wave) = cancel_branches(step("merge"), reason, losers);
        let reports: Vec<Value> = reports.iter().map(report_json).collect();
        assert_eq!(
            reports,
            vec![json!(["a", "canceling"]), json!(["b", "canceling"])]
        );
        assert!(tokens.iter().all(CancellationToken::is_cancelled));
        let mut wave = wave.expect("two running losers make a wave");

        let held_since = WireInstant::now();
        let held_canceled = StepReportKind::Settled(StepSettlement::Canceled {
            hold_started_at: Some(held_since.clone()),
            cancellation_reason: None,
        });
        for (passing, expected) in [
            (
                report("held", held_canceled),
                json!(["held", { "canceled": {
                    "holdStartedAt": held_since, "cancellationReason": null,
                } }]),
            ),
            (
                report("a", StepReportKind::Progressed),
                json!(["a", "progressed"]),
            ),
        ] {
            let WaveSettle::Passed(passed) = wave.settle(passing) else {
                panic!("a report that is no member's settlement comes back");
            };
            assert_eq!(report_json(&passed), expected);
        }

        let completed = StepReportKind::Settled(StepSettlement::Completed {
            outputs: vec![vec![]],
            cost: None,
            log_lines: Vec::new(),
            run_variables: BTreeMap::new(),
        });
        assert!(matches!(
            wave.settle(report("b", completed)),
            WaveSettle::Pending { run_to_stop: None }
        ));
        let a_canceled = StepReportKind::Settled(StepSettlement::Canceled {
            hold_started_at: None,
            cancellation_reason: None,
        });
        // A past instant, so a closing report stamped with a fresh clock read cannot match it.
        let closed_at = WireInstant::try_from("2025-03-04T15:00:00.000Z".to_owned())
            .expect("the test's instant reads");
        let last = StepReport {
            at: closed_at.clone(),
            ..report("a", a_canceled)
        };
        let WaveSettle::Closed {
            reports: closing,
            run_to_stop: None,
        } = wave.settle(last)
        else {
            panic!("the last member's settlement closes the wave");
        };
        assert!(closing.iter().all(|closed| closed.at == closed_at));
        let canceled = json!({ "canceled": {
            "holdStartedAt": null, "cancellationReason": cancellation_reason,
        } });
        assert_eq!(
            closing.iter().map(report_json).collect::<Vec<_>>(),
            vec![
                json!(["merge", { "branchesCanceled": {
                    "reason": format!("{reason:?}"), "count": 2,
                } }]),
                json!(["a", canceled]),
                json!(["b", canceled]),
            ]
        );
    }

    /// A member whose agent run settled on a spent account before its cancel landed counts as
    /// canceled and hands its run back to be stopped, both while the wave stays open and when it
    /// closes it. Mutation: drop a spent member's run with its settlement.
    #[tokio::test]
    async fn a_spent_members_run_comes_back_to_be_stopped() {
        let runner = ScriptedAgentRunner::new(None, false);
        let losers = ["a", "b"]
            .into_iter()
            .map(|node_id| BranchLoser {
                step: step(node_id),
                is_running: true,
                cancel: CancellationToken::new(),
            })
            .collect();
        let (_reports, wave) = cancel_branches(
            step("merge"),
            WorkflowPhaseCancellationReason::MergeFirstToArrive,
            losers,
        );
        let mut wave = wave.expect("two running losers make a wave");
        let spent = |node_id| {
            report(
                node_id,
                StepReportKind::Settled(StepSettlement::AccountSpent {
                    provider_account_id: serde_json::from_value(json!("account-a"))
                        .expect("the test's account id reads"),
                    run: runner.made_run(),
                    resets_at: None,
                    records: StepRecords::default(),
                }),
            )
        };

        let WaveSettle::Pending {
            run_to_stop: Some(pending_run),
        } = wave.settle(spent("a"))
        else {
            panic!("the first spent member's run comes back with the wave open");
        };
        let WaveSettle::Closed {
            reports,
            run_to_stop: Some(closing_run),
        } = wave.settle(spent("b"))
        else {
            panic!("the last spent member's run comes back with the wave closed");
        };
        assert_eq!(reports.len(), 3);
        for run in [pending_run, closing_run] {
            run.cancel().await.expect("the run takes the stop");
            timeout(Duration::from_secs(10), runner.wait_for_cancel())
                .await
                .expect("the stop reaches the member's run");
        }
    }
}
