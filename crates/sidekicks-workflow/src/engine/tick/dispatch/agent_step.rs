//! An agent step's driver: the step's params are evaluated into its agent run's request, the run is
//! created in the step's turn in the entry line, which is the step's one entry to the memory gate,
//! and the run is followed through its admission, its start and its progress to its outcome.

use std::sync::Arc;

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::run::execute;
use super::{StepDispatch, fill_step_failure, is_canceled_in_line, settle_launch_failure};
use crate::engine::ports::AgentStepOutcome;
use crate::engine::tick::admission::{GateEntryTurn, GateWaitEnd, wait_at_gate};
use crate::engine::tick::node_settings::{
    main_input_lengths, main_output_count, place_on_first_output, shape_outputs,
};
use crate::engine::tick::{ReadyStep, RunScope, RunSnapshot, StepReportKind, StepSettlement};
use crate::kinds::{StepFailure, StepOutcome, uncoded_step_error};

impl StepDispatch {
    /// Drives `ready`, an agent step of the run of `scope`, reading `snapshot`, to its settlement:
    /// launches it and evaluates its params into its run's request, creates the run in its `turn`
    /// in the entry line, then reports the run's hold, admission, start and progress and settles
    /// with its outcome. A step canceled before its run is created creates none; one canceled
    /// after settles canceled once its stopped run has ended.
    pub(super) async fn drive_agent_step(
        self,
        scope: Arc<RunScope>,
        snapshot: RunSnapshot,
        ready: ReadyStep,
        cancel: CancellationToken,
        turn: GateEntryTurn,
    ) {
        let (node, kind) = self.look_up_step(&scope, &ready.step);
        let step = ready.step.clone();
        let main_input_lengths = main_input_lengths(&kind.spec, &ready.inputs);
        let launched = self
            .launch(&scope, &snapshot, &ready, kind, cancel.clone(), None)
            .await;
        let context = match launched {
            Ok(context) => context,
            Err(failure) => {
                // Every path drops the turn before it reports, so a slow report channel never
                // holds up the line.
                drop(turn);
                let settlement =
                    settle_launch_failure(failure, &cancel, &node.id, &scope.redaction);
                self.report(&step, &cancel, StepReportKind::Settled(settlement))
                    .await;
                return;
            }
        };
        let answer = execute(kind, &context, ready.inputs).await;
        // Taken once: a progress mark made while the params evaluate sends nothing, since nothing
        // may come before `Started`.
        let records = context.take_records();
        // Closes the step's expressions before anything waits, so nothing of the evaluator stays
        // open for the run's life.
        drop(context);
        let fill = |failure| fill_step_failure(failure, &node.id, &scope.redaction);
        // `Err(None)` is a step canceled while its params evaluated.
        let evaluated = if cancel.is_cancelled() {
            Err(None)
        } else {
            match answer {
                Ok(StepOutcome::AgentRun(request)) => Ok(request),
                Ok(StepOutcome::Outputs(_) | StepOutcome::PersonWait(_)) => Err(Some(
                    StepFailure::Failed(Box::new(uncoded_step_error(format!(
                        "the agent step's kind {} answered no agent run",
                        kind.spec.kind.0.as_str()
                    )))),
                )),
                Err(failure) => Err(Some(failure)),
            }
        };
        let request = match evaluated {
            Ok(request) => request,
            Err(failure) => {
                drop(turn);
                let settlement = match failure {
                    None => StepSettlement::Canceled {
                        hold_started_at: None,
                        is_sibling_failure: false,
                    },
                    Some(failure) => StepSettlement::Failed {
                        failure: fill(failure),
                        log_lines: records.log_lines,
                    },
                };
                self.report(&step, &cancel, StepReportKind::Settled(settlement))
                    .await;
                return;
            }
        };
        if is_canceled_in_line(&turn, &cancel).await {
            drop(turn);
            let canceled = StepSettlement::Canceled {
                hold_started_at: None,
                is_sibling_failure: false,
            };
            self.report(&step, &cancel, StepReportKind::Settled(canceled))
                .await;
            return;
        }
        let created = self.ports.agent_steps.run(request).await;
        // The run holds its place in the gate's line now, so the turn behind this one may enter.
        drop(turn);
        let run = match created {
            Ok(run) => run,
            Err(error) => {
                let failure = StepFailure::Failed(Box::new(uncoded_step_error(format!(
                    "the step's agent run could not be created: {error}"
                ))));
                let failed = StepSettlement::Failed {
                    failure: fill(failure),
                    log_lines: records.log_lines,
                };
                self.report(&step, &cancel, StepReportKind::Settled(failed))
                    .await;
                return;
            }
        };
        let end = wait_at_gate(step.clone(), run.admission(), &cancel, &self.reports).await;
        let (is_start_watched, hold_started_at) = match end {
            GateWaitEnd::Admitted => (true, None),
            // The run's place closed before it was admitted; its outcome says how it ended.
            GateWaitEnd::Withdrawn { .. } => (false, None),
            // The step's cancel is set, so the loop below stops the run first.
            GateWaitEnd::Canceled { hold_started_at } => (false, hold_started_at),
            // Nothing is left to tell, but the run must still stop: the cancel stops it below, and
            // the settlement's send then fails, which ends the driver.
            GateWaitEnd::ReportsClosed => {
                cancel.cancel();
                (false, None)
            }
        };
        let mut input_ref = Some(ready.input_ref);
        let mut is_stopped = false;
        // Scoped so the futures borrowing the run end before a spent account keeps the run.
        let ended = {
            let mut outcome = run.outcome();
            let mut started = is_start_watched.then(|| run.started());
            let mut progressed: Option<watch::Receiver<u64>> = None;
            loop {
                tokio::select! {
                    biased;
                    () = cancel.cancelled(), if !is_stopped => {
                        is_stopped = true;
                        started = None;
                        progressed = None;
                        // A stop that cannot be sent has no sink yet; the outcome, awaited either
                        // way, still ends the step.
                        run.cancel().await.unwrap_or_else(drop);
                    }
                    start = async {
                        started.as_mut().expect("the branch runs only while the start is watched").await
                    }, if started.is_some() => {
                        started = None;
                        // A run that ended before starting sends nothing; its outcome follows.
                        if let Ok(start) = start {
                            // Subscribed before `Started` is sent, so no turn end after the start
                            // is missed.
                            let run_progressed = run.progressed();
                            let started_kind = StepReportKind::Started {
                                input_ref: input_ref.take().expect("a run starts once"),
                                permission_level: (start.permission_level
                                    != scope.permission_level)
                                    .then_some(start.permission_level),
                            };
                            if self.report(&step, &cancel, started_kind).await {
                                progressed = Some(run_progressed);
                            }
                        }
                    }
                    changed = async {
                        progressed
                            .as_mut()
                            .expect("the branch runs only while progress is watched")
                            .changed()
                            .await
                    }, if progressed.is_some() => {
                        match changed {
                            Ok(()) => {
                                self.report(&step, &cancel, StepReportKind::Progressed).await;
                            }
                            // A count that can no longer change would answer at once forever.
                            Err(_closed) => progressed = None,
                        }
                    }
                    ended = &mut outcome => break ended,
                }
            }
        };
        let settlement = if is_stopped {
            StepSettlement::Canceled {
                hold_started_at,
                is_sibling_failure: false,
            }
        } else {
            match ended {
                Ok(AgentStepOutcome::Completed { items, cost }) => {
                    let mut outputs = place_on_first_output(items, main_output_count(&kind.spec));
                    shape_outputs(node, &main_input_lengths, &mut outputs);
                    StepSettlement::Completed {
                        outputs,
                        cost,
                        log_lines: records.log_lines,
                        run_variables: records.run_variables,
                    }
                }
                Ok(AgentStepOutcome::AccountSpent {
                    provider_account_id,
                }) => StepSettlement::AccountSpent {
                    provider_account_id,
                    run,
                },
                Ok(AgentStepOutcome::Failed { error }) => StepSettlement::Failed {
                    failure: fill(StepFailure::Failed(Box::new(error))),
                    log_lines: records.log_lines,
                },
                Err(error) => {
                    let failure = StepFailure::Failed(Box::new(uncoded_step_error(format!(
                        "the step's agent run's end could not be read: {error}"
                    ))));
                    StepSettlement::Failed {
                        failure: fill(failure),
                        log_lines: records.log_lines,
                    }
                }
            }
        };
        self.report(&step, &cancel, StepReportKind::Settled(settlement))
            .await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use rstest::rstest;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::session::controls::methods::PermissionLevel;
    use sidekicks_contracts::workflow::definition::document::WorkflowNode;
    use sidekicks_contracts::workflow::run::step::record::WorkflowCost;
    use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use tokio::sync::mpsc;
    use tokio::time::timeout;

    use super::super::tests::{
        ExecutorProbe, Script, WAIT, next_report, report_json, scripted_kind, test_node,
    };
    use super::super::{StepDispatch, test_dispatch, test_ready_step, test_run_snapshot};
    use crate::engine::ports::{
        AgentStepOutcome, AgentStepRequest, AgentStepRunner, ScriptedAgentRunner, ScriptedGate,
        StepAdmission, StepAdmissionOutcome, WorkflowNodeKey,
    };
    use crate::engine::tick::{StepReport, test_run_scope};
    use crate::kinds::{NodeKind, StepAdmissionNeed, StepAdmissionShape, uncoded_step_error};
    use crate::schema::schema_parts;

    /// How long a test waits to see that nothing happens.
    const QUIET: Duration = Duration::from_millis(50);

    /// A dispatch over `database` of the agent kind, `test.step`, and `more_kinds`, whose agent
    /// runs `runner` makes, with the receiving end of its report channel.
    fn agent_dispatch(
        database: &TestDatabase,
        runner: &Arc<ScriptedAgentRunner>,
        more_kinds: Vec<NodeKind>,
    ) -> (StepDispatch, mpsc::Receiver<StepReport>) {
        let probe = Arc::new(ExecutorProbe::default());
        let mut kinds = vec![scripted_kind(
            Script::AskAgentRun,
            StepAdmissionNeed::OwnRun,
            &probe,
            false,
        )];
        kinds.extend(more_kinds);
        let (mut dispatch, received) = test_dispatch(database, kinds);
        dispatch.ports.agent_steps = Arc::clone(runner) as Arc<dyn AgentStepRunner>;
        (dispatch, received)
    }

    /// The agent step's node, whose `prompt` is its item's name.
    fn agent_node() -> WorkflowNode {
        test_node(&json!({ "params": { "prompt": "={{ $json.name }}" } }))
    }

    /// The account every test run is billed to.
    const ACCOUNT: &str = "account-a";

    /// What a test run cost.
    fn test_cost() -> WorkflowCost {
        serde_json::from_value(json!({ "usdMicros": 1500, "providerAccountId": ACCOUNT }))
            .expect("the test's cost reads")
    }

    /// A run that completed with one item, `{ answer: 1 }`, and the test's cost.
    fn completed_run() -> AgentStepOutcome {
        AgentStepOutcome::Completed {
            items: vec![
                serde_json::from_value(json!({ "json": { "answer": 1 } }))
                    .expect("the test's item reads"),
            ],
            cost: Some(test_cost()),
        }
    }

    /// A run whose account is spent.
    fn spent_run() -> AgentStepOutcome {
        AgentStepOutcome::AccountSpent {
            provider_account_id: serde_json::from_value(json!(ACCOUNT))
                .expect("the test's account id reads"),
        }
    }

    /// The `Started` an agent step sends, carrying `permission_level`.
    fn started_at(permission_level: &Value) -> Value {
        json!({ "started": {
            "inputRef": { "kind": "inline", "items": [] }, "permissionLevel": permission_level,
        } })
    }

    /// An agent step's run joins the gate once, by its creation, and the step reports the run's
    /// hold and admission, starts only when the run does, carrying the run's level only where it
    /// differs from the workflow run's, reports the run's progress, and settles with its outcome:
    /// its items shaped with lineage and its cost, or its spent account. Mutations: answer
    /// `Admitted` at dispatch; send `Started` at the admission; always send the level; drop the
    /// cost; leave the outputs unshaped; settle a spent account as a failure; enqueue the step at
    /// the gate itself.
    #[rstest]
    #[case::held_at_another_level(
        None,
        PermissionLevel::Reviewed,
        json!("reviewed"),
        true,
        completed_run(),
        json!({ "completed": {
            "outputs": [[{ "json": { "answer": 1 }, "pairedItem": { "item": 0 } }]],
            "cost": { "usdMicros": 1500, "providerAccountId": ACCOUNT },
            "logLines": [],
            "runVariables": {},
        } })
    )]
    #[case::admitted_at_the_runs_level(
        Some(StepAdmissionOutcome::Admitted),
        PermissionLevel::Ask,
        Value::Null,
        false,
        spent_run(),
        json!({ "accountSpent": { "providerAccountId": ACCOUNT } })
    )]
    #[tokio::test]
    async fn an_agent_steps_run_joins_the_gate_once_and_the_step_starts_when_the_run_does(
        #[case] admission: Option<StepAdmissionOutcome>,
        #[case] start_level: PermissionLevel,
        #[case] reported_level: Value,
        #[case] is_progressed: bool,
        #[case] outcome: AgentStepOutcome,
        #[case] settlement: Value,
    ) {
        let database = TestDatabase::new(schema_parts());
        let runner = Arc::new(ScriptedAgentRunner::new(admission, false));
        let (dispatch, mut received) = agent_dispatch(&database, &runner, Vec::new());
        let node = agent_node();
        let scope = Arc::new(test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]));
        let ready = test_ready_step(&scope, &node, vec![vec![json!({ "name": "Ada" })]]);
        let step = ready.step.clone();

        let dispatched = dispatch.dispatch(&scope, &test_run_snapshot(&node), ready);
        drop(dispatch);

        let answered: Vec<Value> = dispatched
            .reports
            .iter()
            .map(|report| report_json(report, &step))
            .collect();
        assert_eq!(answered, Vec::<Value>::new());
        let first = next_report(&mut received, &step)
            .await
            .expect("the run's place is reported");
        if admission.is_none() {
            let hold = first["waitingOnPool"].clone();
            assert!(hold.is_string(), "the first report is not a hold: {first}");
            runner.admit();
            assert_eq!(
                next_report(&mut received, &step).await,
                Some(json!({ "admitted": hold }))
            );
        } else {
            assert_eq!(first, json!({ "admitted": null }));
        }
        let params: Map<String, Value> =
            serde_json::from_value(json!({ "prompt": "Ada" })).expect("the test's params read");
        assert_eq!(
            runner.requests(),
            vec![AgentStepRequest {
                session_id: scope.session_id,
                step: step.clone(),
                node_key: WorkflowNodeKey::new(scope.workflow_id, &node.id),
                permission_level: scope.permission_level,
                params,
            }]
        );
        tokio::time::sleep(QUIET).await;
        assert!(
            received.try_recv().is_err(),
            "the step reported before its run started"
        );

        runner.start(start_level);
        assert_eq!(
            next_report(&mut received, &step).await,
            Some(started_at(&reported_level))
        );
        if is_progressed {
            runner.progress();
            assert_eq!(
                next_report(&mut received, &step).await,
                Some(json!("progressed"))
            );
        }
        runner.end(outcome);
        assert_eq!(next_report(&mut received, &step).await, Some(settlement));
        assert_eq!(next_report(&mut received, &step).await, None);
    }

    /// Where an agent step is when its cancel comes.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum CancelPoint {
        /// Waiting for its turn in the entry line, its run not yet created.
        InLine,
        /// Its run held at the gate.
        AtGate,
        /// Its run started.
        Running,
    }

    /// A canceled agent step creates no run while it waits in the line, and once its run exists
    /// it stops the run and settles canceled only once the run has ended, whatever the run
    /// answered, carrying the run's hold where the gate held it. Mutations: never pass the cancel
    /// to the run; send the settlement before the run ends; settle as completed a run that
    /// completed after the cancel; drop the hold's instant; create a run after a cancel in the
    /// line.
    #[rstest]
    #[case::in_line(CancelPoint::InLine)]
    #[case::at_gate(CancelPoint::AtGate)]
    #[case::running(CancelPoint::Running)]
    #[tokio::test]
    async fn a_canceled_agent_step_stops_its_run_and_settles_once_the_run_has_ended(
        #[case] point: CancelPoint,
    ) {
        let database = TestDatabase::new(schema_parts());
        let admission = (point != CancelPoint::AtGate).then_some(StepAdmissionOutcome::Admitted);
        let runner = Arc::new(ScriptedAgentRunner::new(admission, false));
        let (dispatch, mut received) = agent_dispatch(&database, &runner, Vec::new());
        let node = agent_node();
        let scope = Arc::new(test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]));
        let ready = test_ready_step(&scope, &node, vec![vec![json!({ "name": "Ada" })]]);
        let step = ready.step.clone();
        let earlier_turn =
            (point == CancelPoint::InLine).then(|| dispatch.gate_entries.take_turn());
        let dispatched = dispatch.dispatch(&scope, &test_run_snapshot(&node), ready);
        drop(dispatch);

        let hold = match point {
            CancelPoint::InLine => {
                tokio::time::sleep(QUIET).await;
                assert!(
                    received.try_recv().is_err(),
                    "the step reported before its turn"
                );
                dispatched.cancel.cancel();
                Value::Null
            }
            CancelPoint::AtGate => {
                let held = next_report(&mut received, &step)
                    .await
                    .expect("the hold is reported");
                let hold = held["waitingOnPool"].clone();
                assert!(hold.is_string(), "the first report is not a hold: {held}");
                hold
            }
            CancelPoint::Running => {
                assert_eq!(
                    next_report(&mut received, &step).await,
                    Some(json!({ "admitted": null }))
                );
                runner.start(PermissionLevel::Ask);
                assert_eq!(
                    next_report(&mut received, &step).await,
                    Some(started_at(&Value::Null))
                );
                Value::Null
            }
        };
        if point != CancelPoint::InLine {
            dispatched.cancel.cancel();
            timeout(WAIT, runner.wait_for_cancel())
                .await
                .expect("the step's cancel stops its run");
            tokio::time::sleep(QUIET).await;
            assert!(
                received.try_recv().is_err(),
                "the step settled before its run ended"
            );
            runner.end(if point == CancelPoint::AtGate {
                AgentStepOutcome::Failed {
                    error: uncoded_step_error("the run was stopped".to_owned()),
                }
            } else {
                completed_run()
            });
        }

        assert_eq!(
            next_report(&mut received, &step).await,
            Some(json!({ "canceled": { "holdStartedAt": hold, "isSiblingFailure": false } }))
        );
        assert_eq!(next_report(&mut received, &step).await, None);
        let request_count = usize::from(point != CancelPoint::InLine);
        assert_eq!(runner.requests().len(), request_count);
        drop(earlier_turn);
    }

    /// An agent step and a gate step share one entry line: the gate step readied after the agent
    /// step enters the gate only once the agent step's run is created. Mutations: create the run
    /// without the turn; drop the turn before the creation returns.
    #[tokio::test]
    async fn an_agent_steps_creation_holds_the_entry_line_across_kinds() {
        let database = TestDatabase::new(schema_parts());
        let runner = Arc::new(ScriptedAgentRunner::new(
            Some(StepAdmissionOutcome::Admitted),
            true,
        ));
        let probe = Arc::new(ExecutorProbe::default());
        let need = StepAdmissionNeed::Gate(StepAdmissionShape::QuickCode {
            budget_bytes: 1024,
            output_max_bytes: 2048,
        });
        let mut quick_kind = scripted_kind(Script::Progress, need, &probe, false);
        let mut spec = serde_json::to_value(&quick_kind.spec).expect("a kind's spec writes");
        spec["kind"] = json!("test.quick");
        quick_kind.spec = serde_json::from_value(spec).expect("the renamed spec reads");
        let (mut dispatch, _received) = agent_dispatch(&database, &runner, vec![quick_kind]);
        let gate = Arc::new(ScriptedGate::new(None));
        dispatch.ports.admission = Arc::clone(&gate) as Arc<dyn StepAdmission>;
        let agent_node = agent_node();
        let quick_node = test_node(&json!({ "id": "quick", "kind": "test.quick" }));
        let scope = Arc::new(test_run_scope(
            WorkflowRunMode::Manual,
            vec![agent_node.clone(), quick_node.clone()],
        ));

        for node in [&agent_node, &quick_node] {
            let ready = test_ready_step(&scope, node, vec![vec![json!({ "name": "Ada" })]]);
            dispatch.dispatch(&scope, &test_run_snapshot(node), ready);
        }
        tokio::time::sleep(QUIET).await;
        assert_eq!(
            gate.enqueued(),
            Vec::new(),
            "the gate step entered before the agent step's run was created"
        );

        runner.release_creation();
        timeout(WAIT, gate.wait_for_entry())
            .await
            .expect("the gate step enters once the agent step's run is created");
        assert_eq!(gate.enqueued().len(), 1);
        assert_eq!(runner.requests().len(), 1);
    }
}
