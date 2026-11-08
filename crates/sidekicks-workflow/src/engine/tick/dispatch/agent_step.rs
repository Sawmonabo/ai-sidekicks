//! An agent step's driver: the step's params are evaluated into its agent run's request, the run is
//! created in the step's turn in the entry line, taken once the evaluation has finished and every
//! sibling readied before it has taken its own, which is the step's one entry to the memory gate,
//! and the run is followed through its admission, its start and its progress to its outcome.

use std::sync::Arc;

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::run::execute;
use super::{StepDispatch, fill_step_failure, scrub_outputs, settle_launch_failure};
use crate::engine::event_record::EngineFault;
use crate::engine::ports::AgentStepOutcome;
use crate::engine::tick::admission::{GateWaitEnd, SiblingEntry, wait_at_gate};
use crate::engine::tick::node_settings::{
    main_input_lengths, main_output_count, place_on_first_output, shape_outputs,
};
use crate::engine::tick::{ReadyStep, RunScope, RunSnapshot, StepReportKind, StepSettlement};
use crate::kinds::{StepFailure, StepOutcome, uncoded_step_error};

/// What a step reads whose agent run left the memory gate's line unadmitted yet read as completed.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
const WITHDRAWN_RUN_COMPLETED: &str = concat!(
    "the step's agent run left the memory gate's line before it was admitted, ",
    "yet read as completed"
);

impl StepDispatch {
    /// Drives `ready`, an agent step of the run of `scope`, reading `snapshot`, to its settlement:
    /// launches it and evaluates its params into its run's request, then takes its turn in the
    /// entry line through its sibling `entry` and creates the run in it, then reports the run's
    /// hold, admission, start and progress and settles with its outcome. A step canceled before
    /// its run is created creates none; one canceled after settles canceled once its stopped run
    /// has ended, and a stop that cannot be sent goes to the engine's record.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) async fn drive_agent_step(
        self,
        scope: Arc<RunScope>,
        snapshot: RunSnapshot,
        ready: ReadyStep,
        entry: SiblingEntry,
        cancel: CancellationToken,
    ) {
        let (node, kind) = self.look_up_step(&scope, &ready.step);
        let step = ready.step.clone();
        let main_input_lengths = main_input_lengths(&kind.spec, &ready.inputs);
        let launched = self
            .launch(&scope, &snapshot, &ready, kind, cancel.clone())
            .await;
        let context = match launched {
            Ok(context) => context,
            Err(failure) => {
                // Every path gives its place up before it reports, so a slow report channel never
                // holds up a sibling.
                drop(entry);
                let settlement =
                    settle_launch_failure(failure, &cancel, &node.id, &scope.redaction);
                self.report(&step, &cancel, StepReportKind::Settled(settlement))
                    .await;
                return;
            }
        };
        let answer = execute(node, kind, &context, ready.inputs).await;
        // Taken once: a progress mark made while the params evaluate sends nothing, since nothing
        // may come before `Started`.
        let records = context.finish_records();
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
                drop(entry);
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
        // A step canceled before its turn came holds no turn when it reports, so a slow report
        // channel never holds up the line.
        let Some(turn) = entry.wait_for_turn(&cancel).await else {
            let canceled = StepSettlement::Canceled {
                hold_started_at: None,
                is_sibling_failure: false,
            };
            self.report(&step, &cancel, StepReportKind::Settled(canceled))
                .await;
            return;
        };
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
        let is_withdrawn = matches!(end, GateWaitEnd::Withdrawn { .. });
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
                        // The outcome, awaited either way, still ends the step.
                        if let Err(error) = run.cancel().await {
                            self.record_fault(
                                &scope,
                                &step,
                                EngineFault::AgentRunStopFailed,
                                error.as_ref(),
                            )
                            .await;
                        }
                    }
                    start = async {
                        started
                            .as_mut()
                            .expect("the branch runs only while the start is watched")
                            .await
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
                                    != snapshot.permission_level)
                                    .then_some(start.permission_level),
                                pin_hash: None,
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
                // A run that left the gate's line unadmitted never ran, whatever its end reads.
                Ok(AgentStepOutcome::Completed { .. }) if is_withdrawn => StepSettlement::Failed {
                    failure: fill(StepFailure::Failed(Box::new(uncoded_step_error(
                        WITHDRAWN_RUN_COMPLETED.to_owned(),
                    )))),
                    log_lines: records.log_lines,
                },
                Ok(AgentStepOutcome::Completed { items, cost }) => {
                    let mut outputs = place_on_first_output(
                        items,
                        main_output_count(kind.spec.outputs.as_slice()),
                    );
                    shape_outputs(node, &main_input_lengths, &mut outputs);
                    scrub_outputs(&mut outputs, &scope.redaction);
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

    use rstest::rstest;
    use secrecy::SecretString;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::session::controls::methods::PermissionLevel;
    use sidekicks_contracts::workflow::definition::document::WorkflowNode;
    use sidekicks_contracts::workflow::run::step::record::WorkflowCost;
    use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use tokio::sync::mpsc;
    use tokio::time::timeout;

    use super::super::tests::{
        ExecutorProbe, QUIET, SECRET, Script, WAIT, assert_masked, next_report, report_json,
        scripted_kind, secret_item, test_node,
    };
    use super::super::{StepDispatch, test_dispatch, test_ready_step, test_run_snapshot};
    use super::WITHDRAWN_RUN_COMPLETED;
    use crate::engine::event_record::EngineRecorder;
    use crate::engine::ports::{
        AgentStepOutcome, AgentStepRequest, AgentStepRunner, EngineRecordSink, KeptEngineRecords,
        ScriptedAgentRunner, ScriptedGate, StepAdmission, StepAdmissionOutcome, WorkflowNodeKey,
    };
    use crate::engine::tick::{RunSnapshot, StepReport, test_run_scope};
    use crate::expressions::lineage::StepOutputs;
    use crate::kinds::{NodeKind, StepAdmissionNeed, StepAdmissionShape, uncoded_step_error};
    use crate::schema::schema_parts;
    use crate::secrets::redaction::RunRedaction;

    /// A dispatch over `database` of the agent kind, `test.step`, whose agent runs `runner` makes,
    /// with the receiving end of its report channel.
    fn agent_dispatch(
        database: &TestDatabase,
        runner: &Arc<ScriptedAgentRunner>,
    ) -> (StepDispatch, mpsc::Receiver<StepReport>) {
        let probe = Arc::new(ExecutorProbe::default());
        let kinds = vec![scripted_kind(
            Script::AskAgentRun,
            StepAdmissionNeed::OwnRun,
            &probe,
            false,
        )];
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
        let (dispatch, mut received) = agent_dispatch(&database, &runner);
        let node = agent_node();
        let scope = Arc::new(test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]));
        let ready = test_ready_step(&scope, &node, vec![vec![json!({ "name": "Ada" })]]);
        let step = ready.step.clone();

        let dispatched = dispatch
            .dispatch(&scope, &test_run_snapshot(&node), vec![ready])
            .remove(0);
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
                permission_level: test_run_snapshot(&node).permission_level,
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

    /// An agent step whose run left the gate's line unadmitted reports no admission and fails
    /// when the run's end reads completed, since the run never ran; a spent account still waits.
    /// Mutations: settle the withdrawn run's items as completed; fail a withdrawn spent account.
    #[rstest]
    #[case::completed(completed_run(), true)]
    #[case::spent(spent_run(), false)]
    #[tokio::test]
    async fn a_withdrawn_agent_run_never_settles_completed(
        #[case] outcome: AgentStepOutcome,
        #[case] is_failed: bool,
    ) {
        let database = TestDatabase::new(schema_parts());
        let runner = Arc::new(ScriptedAgentRunner::new(
            Some(StepAdmissionOutcome::Withdrawn),
            false,
        ));
        let (dispatch, mut received) = agent_dispatch(&database, &runner);
        let node = agent_node();
        let scope = Arc::new(test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]));
        let ready = test_ready_step(&scope, &node, vec![vec![json!({ "name": "Ada" })]]);
        let step = ready.step.clone();
        dispatch.dispatch(&scope, &test_run_snapshot(&node), vec![ready]);
        drop(dispatch);
        timeout(WAIT, runner.wait_for_request())
            .await
            .expect("the step asks for its run");

        runner.end(outcome);
        let settled = next_report(&mut received, &step)
            .await
            .expect("the step settles");
        let expected = if is_failed {
            json!({ "failed": {
                "failure": { "message": WITHDRAWN_RUN_COMPLETED, "nodeId": "step" },
                "logLines": [],
            } })
        } else {
            json!({ "accountSpent": { "providerAccountId": ACCOUNT } })
        };
        assert_eq!(settled, expected);
        assert_eq!(next_report(&mut received, &step).await, None);
    }

    /// An agent run's items reach the tick with the run's secret masked wherever they carry it.
    /// Mutation: settle the run's items unscrubbed.
    #[tokio::test]
    async fn an_agent_runs_items_reach_the_tick_masked() {
        let database = TestDatabase::new(schema_parts());
        let runner = Arc::new(ScriptedAgentRunner::new(
            Some(StepAdmissionOutcome::Admitted),
            false,
        ));
        let (dispatch, mut received) = agent_dispatch(&database, &runner);
        let node = agent_node();
        let mut scope = test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]);
        scope.redaction = Arc::new(RunRedaction::new(&[SecretString::from(SECRET)]));
        let scope = Arc::new(scope);
        let ready = test_ready_step(&scope, &node, vec![vec![json!({ "name": "Ada" })]]);
        let step = ready.step.clone();
        dispatch.dispatch(&scope, &test_run_snapshot(&node), vec![ready]);
        drop(dispatch);
        assert_eq!(
            next_report(&mut received, &step).await,
            Some(json!({ "admitted": null }))
        );

        runner.start(PermissionLevel::Ask);
        runner.end(AgentStepOutcome::Completed {
            items: vec![secret_item()],
            cost: None,
        });

        assert_eq!(
            next_report(&mut received, &step).await,
            Some(started_at(&Value::Null))
        );
        let settlement = next_report(&mut received, &step)
            .await
            .expect("the step settles");
        assert!(settlement.get("completed").is_some(), "{settlement}");
        assert_masked(&settlement);
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
        let (dispatch, mut received) = agent_dispatch(&database, &runner);
        let node = agent_node();
        let scope = Arc::new(test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]));
        let ready = test_ready_step(&scope, &node, vec![vec![json!({ "name": "Ada" })]]);
        let step = ready.step.clone();
        let earlier_turn =
            (point == CancelPoint::InLine).then(|| dispatch.gate_entries.take_turn());
        let dispatched = dispatch
            .dispatch(&scope, &test_run_snapshot(&node), vec![ready])
            .remove(0);
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

    /// A quick Code kind, `test.quick`, whose steps the memory gate weighs.
    fn quick_kind(probe: &Arc<ExecutorProbe>) -> NodeKind {
        let need = StepAdmissionNeed::Gate(StepAdmissionShape::QuickCode {
            budget_bytes: 1024,
            output_max_bytes: 2048,
        });
        let mut quick_kind = scripted_kind(Script::Progress, need, probe, false);
        let mut spec = serde_json::to_value(&quick_kind.spec).expect("a kind's spec writes");
        spec["kind"] = json!("test.quick");
        quick_kind.spec = serde_json::from_value(spec).expect("the renamed spec reads");
        quick_kind
    }

    /// The entry line holds evaluated steps in the order their evaluation ended, across kinds: an
    /// agent step whose params are still evaluating holds no turn, so a gate step dispatched after
    /// it enters the gate first; once evaluated, the agent step takes its turn and holds it while
    /// its run is created, so a gate step dispatched after that enters only once the creation
    /// returns. Mutations: take the agent step's turn when it is dispatched; create the run
    /// without the turn; drop the turn before the creation returns.
    #[tokio::test]
    async fn the_entry_line_keeps_steps_in_the_order_their_evaluation_ended() {
        let database = TestDatabase::new(schema_parts());
        let runner = Arc::new(ScriptedAgentRunner::new(
            Some(StepAdmissionOutcome::Admitted),
            true,
        ));
        let agent_probe = Arc::new(ExecutorProbe::default());
        let held_agent_kind = scripted_kind(
            Script::AwaitReleaseThenAskAgentRun,
            StepAdmissionNeed::OwnRun,
            &agent_probe,
            false,
        );
        let quick_probe = Arc::new(ExecutorProbe::default());
        let (mut dispatch, _received) =
            test_dispatch(&database, vec![held_agent_kind, quick_kind(&quick_probe)]);
        dispatch.ports.agent_steps = Arc::clone(&runner) as Arc<dyn AgentStepRunner>;
        let gate = Arc::new(ScriptedGate::new(None));
        dispatch.ports.admission = Arc::clone(&gate) as Arc<dyn StepAdmission>;
        let agent_node = agent_node();
        let early_node = test_node(&json!({ "id": "early", "kind": "test.quick" }));
        let late_node = test_node(&json!({ "id": "late", "kind": "test.quick" }));
        let scope = Arc::new(test_run_scope(
            WorkflowRunMode::Manual,
            vec![agent_node.clone(), early_node.clone(), late_node.clone()],
        ));
        let dispatch_step = |node: &WorkflowNode| {
            let ready = test_ready_step(&scope, node, vec![vec![json!({ "name": "Ada" })]]);
            dispatch.dispatch(&scope, &test_run_snapshot(node), vec![ready]);
        };

        dispatch_step(&agent_node);
        dispatch_step(&early_node);
        timeout(WAIT, gate.wait_for_entry())
            .await
            .expect("the early gate step enters while the agent step evaluates");
        assert_eq!(runner.requests().len(), 0);

        agent_probe.release();
        timeout(WAIT, runner.wait_for_request())
            .await
            .expect("the agent step's run is asked for once its params evaluated");
        dispatch_step(&late_node);
        tokio::time::sleep(QUIET).await;
        assert_eq!(
            gate.enqueued().len(),
            1,
            "the late gate step entered before the agent step's run was created"
        );

        runner.release_creation();
        timeout(WAIT, gate.wait_for_entry())
            .await
            .expect("the late gate step enters once the agent step's run is created");
        assert_eq!(gate.enqueued().len(), 2);
        assert_eq!(runner.requests().len(), 1);
    }

    /// Siblings readied in one turn enter the line in their order, not in the order their launches
    /// end: a gate step readied after an agent step whose params are still evaluating launches
    /// first yet waits for the agent step to take its turn, and enters once the agent step's run
    /// is created. Mutation: let each sibling take its turn as its launch ends.
    #[tokio::test]
    async fn siblings_readied_together_enter_the_line_in_their_order() {
        let database = TestDatabase::new(schema_parts());
        let runner = Arc::new(ScriptedAgentRunner::new(
            Some(StepAdmissionOutcome::Admitted),
            false,
        ));
        let agent_probe = Arc::new(ExecutorProbe::default());
        let held_agent_kind = scripted_kind(
            Script::AwaitReleaseThenAskAgentRun,
            StepAdmissionNeed::OwnRun,
            &agent_probe,
            false,
        );
        let quick_probe = Arc::new(ExecutorProbe::default());
        let (mut dispatch, _received) =
            test_dispatch(&database, vec![held_agent_kind, quick_kind(&quick_probe)]);
        dispatch.ports.agent_steps = Arc::clone(&runner) as Arc<dyn AgentStepRunner>;
        let gate = Arc::new(ScriptedGate::new(None));
        dispatch.ports.admission = Arc::clone(&gate) as Arc<dyn StepAdmission>;
        let agent_node = agent_node();
        let quick_node = test_node(&json!({ "id": "quick", "kind": "test.quick" }));
        let scope = Arc::new(test_run_scope(
            WorkflowRunMode::Manual,
            vec![agent_node.clone(), quick_node.clone()],
        ));
        let snapshot = RunSnapshot {
            outputs: Arc::new(StepOutputs::new(
                [&agent_node, &quick_node]
                    .map(|node| (node.id.clone(), node.name.as_str().to_owned())),
            )),
            run_variables: Arc::new(Map::new()),
            permission_level: PermissionLevel::Ask,
        };
        let readied = [&agent_node, &quick_node]
            .map(|node| test_ready_step(&scope, node, vec![vec![json!({ "name": "Ada" })]]));

        dispatch.dispatch(&scope, &snapshot, readied.into());
        tokio::time::sleep(QUIET).await;
        assert_eq!(
            gate.enqueued().len(),
            0,
            "the later sibling entered before the first took its turn"
        );

        agent_probe.release();
        timeout(WAIT, gate.wait_for_entry())
            .await
            .expect("the later sibling enters once the first has taken its turn");
        assert_eq!(runner.requests().len(), 1);
    }

    /// A stop of an agent step's run that cannot be sent goes to the engine's record with its
    /// error, and the step still settles canceled once its run ends. Mutation: drop the stop's
    /// error unrecorded.
    #[tokio::test]
    async fn a_failed_stop_of_an_agent_steps_run_goes_to_the_record() {
        let database = TestDatabase::new(schema_parts());
        let runner = Arc::new(ScriptedAgentRunner::new(
            Some(StepAdmissionOutcome::Admitted),
            false,
        ));
        runner.fail_stops();
        let (mut dispatch, mut received) = agent_dispatch(&database, &runner);
        let sink = Arc::new(KeptEngineRecords::default());
        dispatch.recorder = Arc::new(EngineRecorder::new(
            Arc::clone(&sink) as Arc<dyn EngineRecordSink>
        ));
        let node = agent_node();
        let scope = Arc::new(test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]));
        let ready = test_ready_step(&scope, &node, vec![vec![json!({ "name": "Ada" })]]);
        let step = ready.step.clone();
        let dispatched = dispatch
            .dispatch(&scope, &test_run_snapshot(&node), vec![ready])
            .remove(0);
        drop(dispatch);
        assert_eq!(
            next_report(&mut received, &step).await,
            Some(json!({ "admitted": null }))
        );

        dispatched.cancel.cancel();
        timeout(WAIT, runner.wait_for_cancel())
            .await
            .expect("the step's cancel stops its run");
        runner.end(completed_run());

        assert_eq!(
            next_report(&mut received, &step).await,
            Some(json!({ "canceled": { "holdStartedAt": null, "isSiblingFailure": false } }))
        );
        let lines = sink.lines();
        let [fault] = lines.as_slice() else {
            panic!("one fault is recorded: {lines:?}");
        };
        assert_eq!(fault["record"], json!("agentRunStopFailed"));
        assert_eq!(
            fault["error"],
            json!("the run's process did not take the stop")
        );
        assert_eq!(fault["nodeId"], json!(node.id));
    }
}
