//! The engine's record of its own decisions: one newline-delimited JSON line per decision, an
//! intent line before work the engine dispatches, paired with that work's outcome line, and a fault
//! line for a failure the engine meets with no caller to answer. Nothing reads the record back and
//! it never fails a run; it carries typed values and a fault's error chain only, never a step's
//! message, log line, output, prompt or completion, and every string in it passes the run's
//! redaction before the sink takes it.
//!
//! Each line carries the daemon life's id, the run, a sequence counted from 1 per run within that
//! life, and the step where one is named, so filtering by run and life rebuilds a run's history.

use std::borrow::Cow;
use std::collections::HashMap;
use std::error::Error;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::{UuidTextForm, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_std::mutex_lock::lock;

use crate::engine::ports::EngineRecordSink;
use crate::engine::tick::{BranchCancelReason, StepSettlement};
use crate::kinds::StepFailure;
use crate::secrets::redaction::RunRedaction;

/// Work the engine is about to dispatch, recorded before it is handed off and paired with its
/// outcome; it says the work is being dispatched, never that it runs.
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the engine's tick and waits, which record the work they dispatch"
    )
)]
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
pub(crate) enum EngineIntent {
    /// The step is being handed to its driver.
    DispatchingStep,
    /// A resume is being dispatched onto a session.
    DispatchingResume {
        /// The session the resume goes to.
        session_id: SessionId,
    },
    /// A person wait's approval card is being raised.
    RaisingCard {
        /// The wait the card answers.
        wait_id: UuidTextForm,
    },
    /// A person wait's question is being opened.
    OpeningQuestion {
        /// The wait the question answers.
        wait_id: UuidTextForm,
    },
}

/// How dispatched work ended, recorded against its intent.
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
pub(crate) enum EngineOutcome {
    /// The dispatch went through.
    Done,
    /// The dispatch failed.
    Failed {
        /// The refusal it failed with, where it had one.
        code: Option<RefusalCode>,
    },
}

/// A decision the engine took, recorded once as it is taken.
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the engine's tick and waits, which record every decision they take"
    )
)]
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
pub(crate) enum EngineDecision<'report> {
    /// A step's report moved it; a step's progress is no transition and is never recorded.
    StepReported(StepTransition<'report>),
    /// The run took a status.
    RunStatus(WorkflowRunStatus),
    /// A gate was answered.
    GateResolved {
        /// The answer.
        outcome: ApprovalDecision,
        /// The approval step answered; `None` for a chain's question.
        node_id: Option<WorkflowNodeId>,
    },
    /// A step was set waiting.
    WaitOpened {
        /// What it waits on.
        cause: WorkflowWaitCause,
        /// When the wait times out, where it does.
        deadline_at: Option<WireInstant>,
    },
    /// A deadline was armed at `at`.
    DeadlineArmed {
        /// Which deadline.
        deadline: EngineDeadline,
        /// The instant armed.
        at: WireInstant,
    },
    /// A deadline armed at `at` was cleared.
    DeadlineCleared {
        /// Which deadline.
        deadline: EngineDeadline,
        /// The instant it had been armed at.
        at: WireInstant,
    },
    /// A transition was refused.
    Refused(RefusalCode),
}

/// What a step's report did to it, as the record carries it: the typed values only.
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the engine's tick and waits, which record every report that moves a step"
    )
)]
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
pub(crate) enum StepTransition<'report> {
    /// The memory gate holds the step.
    WaitingOnPool {
        /// When the hold began.
        hold_started_at: &'report WireInstant,
    },
    /// The memory gate admitted the step.
    Admitted,
    /// The step started.
    Started,
    /// The step was asked to stop and is winding down.
    Canceling,
    /// The step's turn canceled a wave of its run's other branches.
    BranchesCanceled {
        /// Why they were canceled.
        reason: BranchCancelReason,
        /// How many running branches the wave canceled.
        count: usize,
    },
    /// The step ended; only how it ended and a failure's code are recorded.
    Settled(&'report StepSettlement),
}

/// A deadline the engine arms or clears.
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the engine's tick and waits, which record each deadline they arm and clear"
    )
)]
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
pub(crate) enum EngineDeadline {
    /// A person wait's deadline.
    Wait {
        /// The wait.
        wait_id: UuidTextForm,
    },
    /// The run's cap.
    Cap,
    /// A parked step's resume.
    ResumeAt,
}

/// A failure the engine met where no caller can answer it, recorded with its error chain.
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
pub(crate) enum EngineFault {
    /// The stop of an agent step's run could not be sent; the run's outcome still ends the step.
    AgentRunStopFailed,
    /// A step's secret could not be read: the keychain failed, or the read of a secret's record.
    SecretReadFailed,
    /// A start held on its chain could not remove the run's own folder or its stored trigger input.
    HeldStartLeftBehind,
}

/// An intent recorded and not yet answered; its outcome names it by `sequence`.
#[must_use = "an intent is answered by its outcome"]
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
pub(crate) struct PendingIntent {
    /// The intent line's sequence.
    sequence: u64,
}

/// The engine's recorder for one daemon life: it hands each run its record under the life's id,
/// and keeps each run's sequence for the whole life.
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
pub(crate) struct EngineRecorder {
    /// Where the lines go.
    sink: Arc<dyn EngineRecordSink>,
    /// This daemon life's id, on every line.
    life_id: UuidTextForm,
    /// The next line's sequence of each run recorded in this life: one counter per run, so a record
    /// made again for a run carries on from its last line.
    sequences: Mutex<HashMap<WorkflowRunId, Arc<AtomicU64>>>,
}

impl EngineRecorder {
    /// A recorder writing to `sink` under a fresh life id.
    #[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
    pub(crate) fn new(sink: Arc<dyn EngineRecordSink>) -> Self {
        Self {
            sink,
            life_id: UuidTextForm::from(mint_uuid_v7()),
            sequences: Mutex::new(HashMap::new()),
        }
    }

    /// The record of `run_id`, scrubbed by `redaction`: its sequence starts at 1 the first time the
    /// life records the run and carries on from its last line every later time.
    #[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
    pub(crate) fn for_run(
        &self,
        run_id: WorkflowRunId,
        redaction: Arc<RunRedaction>,
    ) -> RunEngineRecord {
        let sequence = Arc::clone(
            lock(&self.sequences)
                .entry(run_id)
                .or_insert_with(|| Arc::new(AtomicU64::new(1))),
        );
        RunEngineRecord {
            sink: Arc::clone(&self.sink),
            life_id: self.life_id,
            run_id,
            redaction,
            sequence,
        }
    }
}

/// One run's record within one daemon life.
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
pub(crate) struct RunEngineRecord {
    /// Where the lines go.
    sink: Arc<dyn EngineRecordSink>,
    /// The daemon life's id.
    life_id: UuidTextForm,
    /// The run.
    run_id: WorkflowRunId,
    /// The run's redaction, which every string passes.
    redaction: Arc<RunRedaction>,
    /// The next line's sequence, shared with every record of the run in this life.
    sequence: Arc<AtomicU64>,
}

impl RunEngineRecord {
    /// Records `intent`, on `step` where one is named, before its work is dispatched.
    #[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
    pub(crate) async fn intent(
        &self,
        step: Option<&WorkflowStepKey>,
        intent: EngineIntent,
    ) -> PendingIntent {
        let sequence = self.next_sequence();
        let mut line = self.line(sequence, "intent", None, step);
        match intent {
            EngineIntent::DispatchingStep => {
                says(
                    &mut line,
                    "dispatchingStep",
                    "The engine is dispatching the step to its driver.",
                );
            }
            EngineIntent::DispatchingResume { session_id } => {
                says(
                    &mut line,
                    "dispatchingResume",
                    "The engine is dispatching a resume onto the session.",
                );
                line.insert("sessionId".to_owned(), json!(session_id));
            }
            EngineIntent::RaisingCard { wait_id } => {
                says(
                    &mut line,
                    "raisingCard",
                    "The engine is dispatching the wait's approval card.",
                );
                line.insert("waitId".to_owned(), json!(wait_id));
            }
            EngineIntent::OpeningQuestion { wait_id } => {
                says(
                    &mut line,
                    "openingQuestion",
                    "The engine is dispatching the wait's question.",
                );
                line.insert("waitId".to_owned(), json!(wait_id));
            }
        }
        self.write(line).await;
        PendingIntent { sequence }
    }

    /// Records how the work of `intent` ended.
    #[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
    pub(crate) async fn outcome(&self, intent: PendingIntent, outcome: EngineOutcome) {
        let mut line = self.line(self.next_sequence(), "outcome", Some(intent.sequence), None);
        match outcome {
            EngineOutcome::Done => {
                says(&mut line, "done", "The intent's dispatch went through.");
            }
            EngineOutcome::Failed { code } => {
                says(&mut line, "failed", "The intent's dispatch failed.");
                if let Some(code) = code {
                    line.insert("code".to_owned(), json!(code));
                }
            }
        }
        self.write(line).await;
    }

    /// Records `decision`, on `step` where one is named.
    #[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
    pub(crate) async fn decision(
        &self,
        step: Option<&WorkflowStepKey>,
        decision: EngineDecision<'_>,
    ) {
        let mut line = self.line(self.next_sequence(), "decision", None, step);
        match decision {
            EngineDecision::StepReported(transition) => step_reported(&mut line, &transition),
            EngineDecision::RunStatus(status) => {
                says(&mut line, "runStatus", "The run took a status.");
                line.insert("status".to_owned(), json!(status));
            }
            EngineDecision::GateResolved { outcome, node_id } => {
                says(&mut line, "gateResolved", "The engine resolved a gate.");
                line.insert("outcome".to_owned(), json!(outcome));
                if let Some(node_id) = node_id {
                    line.insert("gateNodeId".to_owned(), json!(node_id));
                }
            }
            EngineDecision::WaitOpened { cause, deadline_at } => {
                says(&mut line, "waitOpened", "The engine set the step waiting.");
                line.insert("waitCause".to_owned(), json!(cause));
                if let Some(deadline_at) = deadline_at {
                    line.insert("deadlineAt".to_owned(), json!(deadline_at));
                }
            }
            EngineDecision::DeadlineArmed { deadline, at } => {
                says(&mut line, "deadlineArmed", "The engine armed a deadline.");
                deadline_members(&mut line, &deadline, &at);
            }
            EngineDecision::DeadlineCleared { deadline, at } => {
                says(
                    &mut line,
                    "deadlineCleared",
                    "The engine cleared a deadline.",
                );
                deadline_members(&mut line, &deadline, &at);
            }
            EngineDecision::Refused(code) => {
                says(&mut line, "refused", "The engine refused a transition.");
                line.insert("code".to_owned(), json!(code));
            }
        }
        self.write(line).await;
    }

    /// Records `fault`, on `step` where one is named, with `error`'s message and each of its
    /// sources' in order.
    #[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
    pub(crate) async fn fault(
        &self,
        step: Option<&WorkflowStepKey>,
        fault: EngineFault,
        error: &(dyn Error + Send + Sync + 'static),
    ) {
        let mut line = self.line(self.next_sequence(), "fault", None, step);
        match fault {
            EngineFault::AgentRunStopFailed => says(
                &mut line,
                "agentRunStopFailed",
                "The stop of the step's agent run could not be sent.",
            ),
            EngineFault::SecretReadFailed => says(
                &mut line,
                "secretReadFailed",
                "A secret of the step could not be read.",
            ),
            EngineFault::HeldStartLeftBehind => says(
                &mut line,
                "heldStartLeftBehind",
                "A start held on its chain left its folder or its stored input behind.",
            ),
        }
        line.insert("error".to_owned(), json!(error_chain(error)));
        self.write(line).await;
    }

    /// Takes the next line's sequence.
    #[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
    fn next_sequence(&self) -> u64 {
        self.sequence.fetch_add(1, Ordering::Relaxed)
    }

    /// A line's leading members: the life, the run, the sequence and phase, the intent an outcome
    /// answers, and the step where one is named.
    #[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
    fn line(
        &self,
        sequence: u64,
        phase: &str,
        intent_sequence: Option<u64>,
        step: Option<&WorkflowStepKey>,
    ) -> Map<String, Value> {
        let mut line = Map::new();
        line.insert("lifeId".to_owned(), json!(self.life_id));
        line.insert("workflowRunId".to_owned(), json!(self.run_id));
        line.insert("sequence".to_owned(), json!(sequence));
        line.insert("phase".to_owned(), json!(phase));
        if let Some(intent_sequence) = intent_sequence {
            line.insert("intentSequence".to_owned(), json!(intent_sequence));
        }
        if let Some(step) = step {
            line.insert("nodeId".to_owned(), json!(step.node_id));
            line.insert("attempt".to_owned(), json!(step.attempt));
            line.insert("executionIndex".to_owned(), json!(step.execution_index));
        }
        line
    }

    /// Scrubs every string of `line` with the run's redaction and hands it to the sink.
    #[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
    async fn write(&self, mut line: Map<String, Value>) {
        for value in line.values_mut() {
            if let Value::String(text) = value
                && let Cow::Owned(scrubbed) = self.redaction.scrub(text)
            {
                *text = scrubbed;
            }
        }
        self.sink.record(line).await;
    }
}

/// `error`'s message followed by each of its sources' in order, joined by `: `.
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
fn error_chain(error: &(dyn Error + 'static)) -> String {
    let mut chain = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        chain.push_str(": ");
        chain.push_str(&cause.to_string());
        source = cause.source();
    }
    chain
}

/// Writes the case's `record` word and its fixed engine sentence.
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
fn says(line: &mut Map<String, Value>, record: &str, sentence: &str) {
    line.insert("record".to_owned(), json!(record));
    line.insert("says".to_owned(), json!(sentence));
}

/// Writes a step report's case: the report's word and its typed values.
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
fn step_reported(line: &mut Map<String, Value>, transition: &StepTransition<'_>) {
    says(line, "stepReported", "A step's report moved it.");
    match transition {
        StepTransition::WaitingOnPool { hold_started_at } => {
            line.insert("report".to_owned(), json!("waitingOnPool"));
            line.insert("holdStartedAt".to_owned(), json!(hold_started_at));
        }
        StepTransition::Admitted => {
            line.insert("report".to_owned(), json!("admitted"));
        }
        StepTransition::Started => {
            line.insert("report".to_owned(), json!("started"));
        }
        StepTransition::Canceling => {
            line.insert("report".to_owned(), json!("canceling"));
        }
        StepTransition::BranchesCanceled { reason, count } => {
            line.insert("report".to_owned(), json!("branchesCanceled"));
            let reason = match reason {
                BranchCancelReason::FirstToArrive => "firstToArrive",
                BranchCancelReason::SiblingFailure => "siblingFailure",
            };
            line.insert("reason".to_owned(), json!(reason));
            line.insert("count".to_owned(), json!(count));
        }
        StepTransition::Settled(settlement) => {
            line.insert("report".to_owned(), json!("settled"));
            let word = match settlement {
                StepSettlement::Completed { .. } => "completed",
                StepSettlement::Failed { failure, .. } => {
                    line.insert("failure".to_owned(), failure_code(failure));
                    "failed"
                }
                StepSettlement::PersonWait { .. } => "personWait",
                StepSettlement::AccountSpent { .. } => "accountSpent",
                StepSettlement::Canceled { .. } => "canceled",
            };
            line.insert("settlement".to_owned(), json!(word));
        }
    }
}

/// A failure as the record carries it: its code, `uncoded` for a failure with none, or
/// `declined` for a person's decline, whose words stay out.
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
fn failure_code(failure: &StepFailure) -> Value {
    match failure {
        StepFailure::Failed(error) | StepFailure::EndsRun(error) => match error.as_ref() {
            WorkflowStepError::Uncoded(_) => json!("uncoded"),
            WorkflowStepError::Coded(coded) => json!(coded.code),
            WorkflowStepError::AgentResolution(resolution) => json!(resolution.code),
        },
        StepFailure::Declined { .. } => json!("declined"),
    }
}

/// Writes which deadline and its instant.
#[cfg_attr(not(test), expect(dead_code, reason = "the engine's decision record"))]
fn deadline_members(line: &mut Map<String, Value>, deadline: &EngineDeadline, at: &WireInstant) {
    match deadline {
        EngineDeadline::Wait { wait_id } => {
            line.insert("deadline".to_owned(), json!("wait"));
            line.insert("waitId".to_owned(), json!(wait_id));
        }
        EngineDeadline::Cap => {
            line.insert("deadline".to_owned(), json!("cap"));
        }
        EngineDeadline::ResumeAt => {
            line.insert("deadline".to_owned(), json!("resumeAt"));
        }
    }
    line.insert("at".to_owned(), json!(at));
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use secrecy::SecretString;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::UuidTextForm;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::workflow::run::id::WorkflowRunId;
    use sidekicks_contracts::workflow::run::status::WorkflowWaitCause;
    use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;

    use super::{
        EngineDecision, EngineIntent, EngineOutcome, EngineRecorder, RunEngineRecord,
        StepTransition,
    };
    use crate::engine::ports::{EngineRecordSink, KeptEngineRecords};
    use crate::engine::tick::StepSettlement;
    use crate::kinds::{StepFailure, coded_step_error};
    use crate::secrets::redaction::RunRedaction;

    /// The run of `uuid`'s text.
    fn run_id(uuid: &str) -> WorkflowRunId {
        WorkflowRunId::new(uuid).expect("the test's run id is a UUID")
    }

    /// The first execution of node `node_id` in the run of `run_uuid`.
    fn step(run_uuid: &str, node_id: &str) -> WorkflowStepKey {
        serde_json::from_value(json!({
            "workflowRunId": run_uuid, "nodeId": node_id, "attempt": 1, "executionIndex": 0,
        }))
        .expect("the test's step key reads")
    }

    /// A run's record on `recorder` with no secrets.
    fn record(recorder: &EngineRecorder, run_uuid: &str) -> RunEngineRecord {
        recorder.for_run(run_id(run_uuid), Arc::new(RunRedaction::new(&[])))
    }

    /// Two runs interleaved on one recorder each number their lines from 1, a record made again
    /// for a run carries on from its last line, an outcome names its intent's sequence, one life id
    /// marks every line, and a second recorder starts a new life at 1. Mutations: one counter for
    /// every run; a fresh counter per record; an outcome without its intent's sequence; the life id
    /// dropped or shared between recorders.
    #[tokio::test]
    async fn each_run_numbers_its_lines_from_one_and_an_outcome_names_its_intent() {
        const RUN_A: &str = "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7a";
        const RUN_B: &str = "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7b";
        let sink = Arc::new(KeptEngineRecords::default());
        let recorder = EngineRecorder::new(Arc::clone(&sink) as Arc<dyn EngineRecordSink>);
        let run_a = record(&recorder, RUN_A);
        let run_b = record(&recorder, RUN_B);
        let step_a = step(RUN_A, "build");
        let wait_id = UuidTextForm::new("0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7e")
            .expect("the test's wait id is a UUID");

        let dispatch = run_a
            .intent(Some(&step_a), EngineIntent::DispatchingStep)
            .await;
        let question = run_b
            .intent(None, EngineIntent::OpeningQuestion { wait_id })
            .await;
        run_a
            .decision(
                Some(&step_a),
                EngineDecision::StepReported(StepTransition::Started),
            )
            .await;
        run_b
            .outcome(
                question,
                EngineOutcome::Failed {
                    code: Some(RefusalCode::WorkflowStepNotWaiting),
                },
            )
            .await;
        run_a.outcome(dispatch, EngineOutcome::Done).await;
        drop(run_a);
        record(&recorder, RUN_A)
            .decision(
                None,
                EngineDecision::Refused(RefusalCode::WorkflowRunNotCancelable),
            )
            .await;

        let lines = sink.lines();
        let of_run = |run: &str| -> Vec<&Map<String, Value>> {
            lines
                .iter()
                .filter(|line| line["workflowRunId"] == json!(run))
                .collect()
        };
        let sequences = |run: &str| -> Vec<Value> {
            of_run(run)
                .iter()
                .map(|line| line["sequence"].clone())
                .collect()
        };
        assert_eq!(sequences(RUN_A), [json!(1), json!(2), json!(3), json!(4)]);
        assert_eq!(sequences(RUN_B), [json!(1), json!(2)]);
        assert_eq!(of_run(RUN_A)[2]["intentSequence"], json!(1));
        assert_eq!(of_run(RUN_B)[1]["intentSequence"], json!(1));
        assert_eq!(of_run(RUN_A)[0]["nodeId"], json!("build"));
        let life_id = lines[0]["lifeId"].clone();
        assert!(life_id.is_string(), "every line carries the life id");
        assert!(lines.iter().all(|line| line["lifeId"] == life_id));

        let next_sink = Arc::new(KeptEngineRecords::default());
        let next_life = EngineRecorder::new(Arc::clone(&next_sink) as Arc<dyn EngineRecordSink>);
        record(&next_life, RUN_A)
            .decision(
                None,
                EngineDecision::WaitOpened {
                    cause: WorkflowWaitCause::Approval,
                    deadline_at: Some(WireInstant::now()),
                },
            )
            .await;
        let next_lines = next_sink.lines();
        assert_eq!(next_lines[0]["sequence"], json!(1));
        assert!(next_lines[0]["lifeId"].is_string());
        assert_ne!(next_lines[0]["lifeId"], life_id);
    }

    /// A failed step's line carries its code and none of its message or log lines, and the run's
    /// secret, here inside the step's node id, reaches no line. Mutations: the message recorded;
    /// the log lines recorded; the scrub skipped.
    #[tokio::test]
    async fn a_line_carries_no_secret_and_no_step_text() {
        const RUN: &str = "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7c";
        const SECRET: &str = "correct-horse-battery-staple";
        const PROMPT: &str = "Summarize the quarterly numbers for the board";
        let sink = Arc::new(KeptEngineRecords::default());
        let recorder = EngineRecorder::new(Arc::clone(&sink) as Arc<dyn EngineRecordSink>);
        let run = recorder.for_run(
            run_id(RUN),
            Arc::new(RunRedaction::new(&[SecretString::from(SECRET)])),
        );
        let node_id = format!("deploy-{SECRET}");
        let step = step(RUN, &node_id);
        let settlement = StepSettlement::Failed {
            failure: StepFailure::Failed(Box::new(coded_step_error(
                RefusalCode::WorkflowStepTimedOut,
                format!("the call with token {SECRET} timed out"),
                json!({}),
                None,
            ))),
            log_lines: vec![format!("prompt: {PROMPT}")],
        };

        run.decision(
            Some(&step),
            EngineDecision::StepReported(StepTransition::Settled(&settlement)),
        )
        .await;
        run.decision(
            Some(&step),
            EngineDecision::Refused(RefusalCode::WorkflowRunNotCancelable),
        )
        .await;
        let resume = run
            .intent(
                Some(&step),
                EngineIntent::DispatchingResume {
                    session_id: SessionId::new("0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7d")
                        .expect("the test's session id is a UUID"),
                },
            )
            .await;
        run.outcome(resume, EngineOutcome::Done).await;

        let lines = sink.lines();
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0]["settlement"], json!("failed"));
        assert_eq!(lines[0]["failure"], json!("workflow.step.timedOut"));
        assert_eq!(lines[1]["code"], json!("workflow.run.notCancelable"));
        for line in &lines {
            let text = Value::Object(line.clone()).to_string();
            assert!(!text.contains(SECRET), "a line carries the secret: {text}");
            assert!(
                !text.contains("timed out"),
                "a line carries the message: {text}"
            );
            assert!(!text.contains(PROMPT), "a line carries a log line: {text}");
        }
        let recorded_node = lines[0]["nodeId"].as_str().expect("the node id is text");
        assert!(recorded_node.starts_with("deploy-") && recorded_node != node_id);
    }
}
