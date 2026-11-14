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
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseCancellationReason;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_std::mutex_lock::lock;

use crate::engine::ports::EngineRecordSink;
use crate::kinds::StepFailure;
use crate::secrets::redaction::RunRedaction;

/// Work the engine is about to dispatch, recorded before it is handed off and paired with its
/// outcome; it says the work is being dispatched, never that it runs.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
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
    /// The approval card of a wait that ended unanswered is being withdrawn.
    WithdrawingCard {
        /// The wait the card answered.
        wait_id: UuidTextForm,
    },
}

/// How dispatched work ended, recorded against its intent.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
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
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
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
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum StepTransition<'report> {
    /// The memory gate holds the step.
    WaitingOnMemory {
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
        reason: WorkflowPhaseCancellationReason,
        /// How many running branches the wave canceled.
        count: usize,
    },
    /// The step ended; only how it ended and a failure's code are recorded.
    Settled(StepEnding<&'report StepFailure>),
}

/// How a step ended, carrying its failure where it failed.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum StepEnding<Failure> {
    /// It finished with its outputs.
    Completed,
    /// It failed.
    Failed(Failure),
    /// It waits on a person.
    PersonWait,
    /// It waits on its agent run's spent account.
    AccountSpent,
    /// It was canceled.
    Canceled,
}

/// A deadline the engine arms or clears.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
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
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum EngineFault {
    /// The stop of an agent step's run could not be sent; the run's outcome still ends the step.
    AgentRunStopFailed,
    /// A step's secret could not be read: the keychain failed, or the read of a secret's record.
    SecretReadFailed,
    /// A start held on its chain could not remove the run's own folder or its stored trigger input.
    HeldStartLeftBehind,
    /// A run's turn was not written; the run left the live set, and the restart settles what the
    /// log holds.
    TurnWriteFailed,
    /// An artifact a failed turn or settlement wrote, or a kept value a turn replaced named, which
    /// no record names, could not be deleted.
    TurnPayloadLeftBehind,
    /// A payload of a step could not be stored; the step failed in its place.
    SettlementWriteFailed,
    /// A `Keep going` could not be read or written; its sender reads it as not taken.
    KeepGoingFailed,
    /// A step's stored resume did not read at the restart; the step waits on the person's Resume.
    ResumeUnreadable,
    /// A wait the restart took back found its question unread or gone, or its agent run gone.
    WaitNotReattached,
    /// The run's session could not leave a tree removed while the run worked in it.
    RemovedTreeSweepFailed,
    /// A wait's approval card could not be read or withdrawn; the restart's settle closes it.
    CardWithdrawFailed,
}

/// An intent recorded and not yet answered; its outcome names it by `sequence`.
#[must_use = "an intent is answered by its outcome"]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct PendingIntent {
    /// The intent line's sequence.
    sequence: u64,
}

/// The engine's recorder for one daemon life: it hands each run its record under the life's id,
/// and keeps each run's sequence for the whole life.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick, its dispatch, the waits and the run start"
    )
)]
pub(crate) struct EngineRecorder {
    /// Where the lines go.
    sink: Arc<dyn EngineRecordSink>,
    /// This daemon life's id, on every line.
    life_id: UuidTextForm,
    /// The next line's sequence of each run recorded in this life and not yet ended: one counter
    /// per run, so a record made again for a run carries on from its last line.
    sequences: Mutex<HashMap<WorkflowRunId, Arc<AtomicU64>>>,
}

impl EngineRecorder {
    /// A recorder writing to `sink` under a fresh life id.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the tick, its dispatch, the waits and the run start"
        )
    )]
    pub(crate) fn new(sink: Arc<dyn EngineRecordSink>) -> Self {
        Self {
            sink,
            life_id: UuidTextForm::from(mint_uuid_v7()),
            sequences: Mutex::new(HashMap::new()),
        }
    }

    /// The record of `run_id`, scrubbed by `redaction`: its sequence starts at 1 the first time the
    /// life records the run and carries on from its last line every later time.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the tick, its dispatch, the waits and the run start"
        )
    )]
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

    /// Forgets `run_id`'s sequence once the run has ended and records nothing more, so the life
    /// keeps no counter for a run that is over.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the tick's run end and the run start's held start"
        )
    )]
    pub(crate) fn end_run(&self, run_id: WorkflowRunId) {
        lock(&self.sequences).remove(&run_id);
    }

    /// Whether the life still keeps a sequence for `run_id`, which a run's end forgets.
    #[cfg(test)]
    pub(crate) fn has_sequence(&self, run_id: WorkflowRunId) -> bool {
        lock(&self.sequences).contains_key(&run_id)
    }
}

/// One run's record within one daemon life; a copy writes on the same sequence, after the run's end
/// too.
#[derive(Clone)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick, its dispatch, the waits and the run start"
    )
)]
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
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
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
            EngineIntent::WithdrawingCard { wait_id } => {
                says(
                    &mut line,
                    "withdrawingCard",
                    "The engine is withdrawing the wait's approval card.",
                );
                line.insert("waitId".to_owned(), json!(wait_id));
            }
        }
        self.write(line).await;
        PendingIntent { sequence }
    }

    /// Records how the work of `intent` ended.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
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
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
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
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
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
            EngineFault::TurnWriteFailed => says(
                &mut line,
                "turnWriteFailed",
                "A turn of the run was not written; the run left the live set.",
            ),
            EngineFault::TurnPayloadLeftBehind => says(
                &mut line,
                "turnPayloadLeftBehind",
                "A stored payload no record names could not be deleted.",
            ),
            EngineFault::SettlementWriteFailed => says(
                &mut line,
                "settlementWriteFailed",
                "A payload of the step could not be stored; the step failed in its place.",
            ),
            EngineFault::KeepGoingFailed => says(
                &mut line,
                "keepGoingFailed",
                "A Keep going of the run's chain could not be read or written.",
            ),
            EngineFault::ResumeUnreadable => says(
                &mut line,
                "resumeUnreadable",
                "The step's stored resume did not read; it waits on the person's Resume.",
            ),
            EngineFault::WaitNotReattached => says(
                &mut line,
                "waitNotReattached",
                "The step's wait could not be taken back after the restart.",
            ),
            EngineFault::RemovedTreeSweepFailed => says(
                &mut line,
                "removedTreeSweepFailed",
                "The session could not leave a tree removed while the run worked in it.",
            ),
            EngineFault::CardWithdrawFailed => says(
                &mut line,
                "cardWithdrawFailed",
                "A wait's approval card could not be withdrawn; the restart's settle closes it.",
            ),
        }
        line.insert("error".to_owned(), json!(error_chain(error)));
        self.write(line).await;
    }

    /// Takes the next line's sequence.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the tick, its dispatch, the waits and the run start"
        )
    )]
    fn next_sequence(&self) -> u64 {
        self.sequence.fetch_add(1, Ordering::Relaxed)
    }

    /// A line's leading members: the life, the run, the sequence and phase, the intent an outcome
    /// answers, and the step where one is named.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the tick, its dispatch, the waits and the run start"
        )
    )]
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
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the tick, its dispatch, the waits and the run start"
        )
    )]
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
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick's dispatch and the run start, which record what no caller answers"
    )
)]
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
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick, its dispatch, the waits and the run start"
    )
)]
fn says(line: &mut Map<String, Value>, record: &str, sentence: &str) {
    line.insert("record".to_owned(), json!(record));
    line.insert("says".to_owned(), json!(sentence));
}

/// Writes a step report's case: the report's word and its typed values.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn step_reported(line: &mut Map<String, Value>, transition: &StepTransition<'_>) {
    says(line, "stepReported", "A step's report moved it.");
    match transition {
        StepTransition::WaitingOnMemory { hold_started_at } => {
            line.insert("report".to_owned(), json!("waitingOnMemory"));
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
            line.insert("reason".to_owned(), json!(reason));
            line.insert("count".to_owned(), json!(count));
        }
        StepTransition::Settled(ending) => {
            line.insert("report".to_owned(), json!("settled"));
            let word = match ending {
                StepEnding::Completed => "completed",
                StepEnding::Failed(failure) => {
                    line.insert("failure".to_owned(), failure_code(failure));
                    "failed"
                }
                StepEnding::PersonWait => "personWait",
                StepEnding::AccountSpent => "accountSpent",
                StepEnding::Canceled => "canceled",
            };
            line.insert("settlement".to_owned(), json!(word));
        }
    }
}

/// A failure as the record carries it: its code, `uncoded` for a failure with none, or
/// `declined` for a person's decline, whose words stay out.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn failure_code(failure: &StepFailure) -> Value {
    match failure {
        StepFailure::Failed(error) | StepFailure::EndsRun(error) | StepFailure::Crashed(error) => {
            match error.as_ref() {
                WorkflowStepError::Uncoded(_) => json!("uncoded"),
                WorkflowStepError::Coded(coded) => json!(coded.code),
                WorkflowStepError::AgentResolution(resolution) => json!(resolution.code),
            }
        }
        StepFailure::Declined { .. } => json!("declined"),
    }
}

/// Writes which deadline and its instant.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
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
mod tests;
