//! Which events raise, resolve or delete attention entries, the moment each entry speaks for and
//! its id, and the subject the banner merge and the seen mark group entries by.

use sidekicks_contracts::attention::{AttentionId, AttentionMomentTrigger, AttentionSeverity};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::orchestration::InterruptReason;
use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::AgentRunQueuedPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseSuspendedPayload;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;

/// The longest moment id: a banner's tag and a push's collapse id hold at most 64 bytes.
pub const MOMENT_ID_MAX_BYTES: usize = 64;

/// What one entry speaks for. Its id is the banner's tag and the push's collapse id, so a later
/// state of the same moment replaces what was posted for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttentionMoment {
    /// An agent run: its waits and its end share one moment.
    Run(RunId),
    /// A plan waiting on its card, apart from its run so the run's end never replaces it.
    Plan(PlanId),
    /// A workflow run: every waiting step and its end share one moment.
    WorkflowRun(WorkflowRunId),
    /// The session's own aggregate.
    Session(SessionId),
    /// One execution of a workflow's Notify step.
    Notify {
        /// The run.
        workflow_run_id: WorkflowRunId,
        /// The Notify node.
        node_id: WorkflowNodeId,
        /// Which execution of the node.
        execution_index: SafeInt<0>,
    },
}

impl AttentionMoment {
    /// The moment's id, at most [`MOMENT_ID_MAX_BYTES`]: a Notify step's is a fixed-length hash of
    /// its run, node and execution, since a node id has no bound.
    pub fn id(&self) -> AttentionId {
        let id = match self {
            Self::Run(run_id) => format!("run:{run_id}"),
            Self::Plan(plan_id) => format!("plan:{plan_id}"),
            Self::WorkflowRun(workflow_run_id) => format!("workflowRun:{workflow_run_id}"),
            Self::Session(session_id) => format!("session:{session_id}"),
            Self::Notify {
                workflow_run_id,
                node_id,
                execution_index,
            } => {
                // A run id is a UUID and the index a number, so neither holds the separator and
                // the node between them is read back unambiguously.
                let key = format!(
                    "{workflow_run_id}|{}|{}",
                    node_id.as_str(),
                    execution_index.get()
                );
                let hash = blake3::hash(key.as_bytes()).to_hex();
                format!("notify:{}", &hash[..32])
            }
        };
        FreeFormText::new(id).expect("every moment id is far below the attention id bound")
    }

    /// The subject whose entries merge into one banner and share one seen mark: the session for
    /// an agent run, a plan or the session itself, the workflow run for a workflow's entries.
    pub fn subject(&self, session_id: SessionId) -> AttentionSubject {
        match self {
            Self::Run(_) | Self::Plan(_) | Self::Session(_) => {
                AttentionSubject::Session(session_id)
            }
            Self::WorkflowRun(workflow_run_id)
            | Self::Notify {
                workflow_run_id, ..
            } => AttentionSubject::WorkflowRun(*workflow_run_id),
        }
    }
}

/// Whose entries merge into one banner and share one seen mark.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AttentionSubject {
    /// A session, for its agent runs' and plans' entries.
    Session(SessionId),
    /// A workflow run, for its own and its Notify steps' entries.
    WorkflowRun(WorkflowRunId),
}

/// A wait on the person that an entry stays open for until a later event resolves it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttentionWait {
    /// An agent run waiting on an approval or an answer.
    Run(RunId),
    /// A plan waiting on its card.
    Plan(PlanId),
    /// Every waiting step of a workflow run; it is only ever resolved, never raised.
    WorkflowRun(WorkflowRunId),
    /// One workflow step waiting on the person.
    Step(WorkflowStepKey),
}

impl AttentionWait {
    /// The moment an entry for this wait speaks for: a step's is its workflow run's.
    pub fn moment(&self) -> AttentionMoment {
        match self {
            Self::Run(run_id) => AttentionMoment::Run(*run_id),
            Self::Plan(plan_id) => AttentionMoment::Plan(*plan_id),
            Self::WorkflowRun(workflow_run_id) => AttentionMoment::WorkflowRun(*workflow_run_id),
            Self::Step(step) => AttentionMoment::WorkflowRun(step.workflow_run_id),
        }
    }
}

/// A new entry an event raises.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttentionRaise {
    /// A wait on the person opens; a later event resolves it.
    Wait {
        /// What waits.
        wait: AttentionWait,
        /// `pendingApproval` or `pendingInput`.
        trigger: AttentionMomentTrigger,
    },
    /// A run or a workflow run ended. An agent run's end is raised only for a lead run, which the
    /// statement writing it checks, since the event does not say whether the run has a parent.
    End {
        /// The run or workflow run.
        moment: AttentionMoment,
        /// `runCompleted` or `runFailed`.
        trigger: AttentionMomentTrigger,
    },
}

impl AttentionRaise {
    /// The moment the entry speaks for.
    pub fn moment(&self) -> AttentionMoment {
        match self {
            Self::Wait { wait, .. } => wait.moment(),
            Self::End { moment, .. } => moment.clone(),
        }
    }

    /// What raised the entry.
    pub fn trigger(&self) -> AttentionMomentTrigger {
        match self {
            Self::Wait { trigger, .. } | Self::End { trigger, .. } => *trigger,
        }
    }

    /// Whether the entry blocks on the person: a wait does, an end does not, since its remedy is a
    /// new run.
    pub fn severity(&self) -> AttentionSeverity {
        match self {
            Self::Wait { .. } => AttentionSeverity::Actionable,
            Self::End { .. } => AttentionSeverity::Informational,
        }
    }
}

/// What one event does to the attention entries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttentionChange {
    /// A new entry.
    Raise(AttentionRaise),
    /// The open entries of a wait resolve, then an end may raise a new entry.
    Resolve {
        /// The wait whose open entries resolve.
        wait: AttentionWait,
        /// The end the same event raises.
        then: Option<AttentionRaise>,
    },
    /// A deleted workflow run takes its entries, its Notify steps' included.
    DeleteWorkflowRun(WorkflowRunId),
    /// A muted session's undelivered ends are withdrawn.
    WithdrawMuted(SessionId),
    /// A name the entries read changed: no entry changes, but their readers are told.
    NameChanged(SessionId),
    /// Nothing changes.
    Nothing,
}

/// What `event` does to the attention entries, read from the event alone.
pub fn entry_change_of(event: &SessionEvent) -> AttentionChange {
    let raise_wait = |wait, trigger| AttentionChange::Raise(AttentionRaise::Wait { wait, trigger });
    let resolve_run = |run_id: RunId, then| AttentionChange::Resolve {
        wait: AttentionWait::Run(run_id),
        then,
    };
    // A run's end raises an entry only when `is_raised`.
    let run_end = |is_raised: bool, run_id, trigger| {
        is_raised.then_some(AttentionRaise::End {
            moment: AttentionMoment::Run(run_id),
            trigger,
        })
    };
    let resolve_step = |step| AttentionChange::Resolve {
        wait: AttentionWait::Step(step),
        then: None,
    };
    let workflow_run_end = |workflow_run_id, trigger| AttentionChange::Resolve {
        wait: AttentionWait::WorkflowRun(workflow_run_id),
        then: Some(AttentionRaise::End {
            moment: AttentionMoment::WorkflowRun(workflow_run_id),
            trigger,
        }),
    };
    match event {
        SessionEvent::AgentRunWaitingForApproval(payload) => raise_wait(
            AttentionWait::Run(payload.run_id),
            AttentionMomentTrigger::PendingApproval,
        ),
        SessionEvent::AgentRunWaitingForInput(payload) => raise_wait(
            AttentionWait::Run(payload.run_id),
            AttentionMomentTrigger::PendingInput,
        ),
        SessionEvent::AgentRunQueued(queued) => {
            let run_id = match queued {
                AgentRunQueuedPayload::SessionAgent(payload) => payload.run_id,
                AgentRunQueuedPayload::ResolvedAgent(payload) => payload.run_id,
            };
            resolve_run(run_id, None)
        }
        SessionEvent::AgentRunStarting(payload) => resolve_run(payload.run_id, None),
        SessionEvent::AgentRunRunning(payload) => resolve_run(payload.run_id, None),
        SessionEvent::AgentRunPausing(payload) => resolve_run(payload.run_id, None),
        SessionEvent::AgentRunPaused(payload) => resolve_run(payload.run_id, None),
        // An end the daemon itself closed raises nothing.
        SessionEvent::AgentRunCompleted(payload) => resolve_run(
            payload.run_id,
            run_end(
                payload.intended_close.is_none(),
                payload.run_id,
                AttentionMomentTrigger::RunCompleted,
            ),
        ),
        SessionEvent::AgentRunFailed(payload) => resolve_run(
            payload.run_id,
            run_end(
                payload.intended_close.is_none(),
                payload.run_id,
                AttentionMomentTrigger::RunFailed,
            ),
        ),
        // Only a limit the daemon enforced fails the run; the person's own interrupt, a canceled
        // workflow phase and a restart raise nothing.
        SessionEvent::AgentRunInterrupted(payload) => {
            let is_limit = match payload.trigger {
                Some(InterruptReason::StepLimit | InterruptReason::SpendLimit) => true,
                Some(InterruptReason::WorkflowPhaseCanceled | InterruptReason::DaemonRestart)
                | None => false,
            };
            resolve_run(
                payload.run_id,
                run_end(
                    is_limit && payload.intended_close.is_none(),
                    payload.run_id,
                    AttentionMomentTrigger::RunFailed,
                ),
            )
        }
        SessionEvent::AgentRunStopped(payload) => {
            let is_limit = match payload.trigger {
                Some(StopTrigger::TokenLimit) => true,
                None => false,
            };
            resolve_run(
                payload.run_id,
                run_end(
                    is_limit && payload.intended_close.is_none(),
                    payload.run_id,
                    AttentionMomentTrigger::RunFailed,
                ),
            )
        }
        // A plan that holds its provider request waits as its run does, so the run's entry is its
        // one wait; a plan that holds none waits on its card under a moment of its own.
        SessionEvent::PlanProposed(payload) => {
            if payload.holds_request {
                AttentionChange::Nothing
            } else {
                raise_wait(
                    AttentionWait::Plan(payload.plan_id),
                    AttentionMomentTrigger::PendingInput,
                )
            }
        }
        SessionEvent::PlanAccepted(payload) => AttentionChange::Resolve {
            wait: AttentionWait::Plan(payload.plan_id),
            then: None,
        },
        SessionEvent::PlanKept(payload) => AttentionChange::Resolve {
            wait: AttentionWait::Plan(payload.plan_id),
            then: None,
        },
        SessionEvent::PlanHandedOff(payload) => AttentionChange::Resolve {
            wait: AttentionWait::Plan(payload.plan_id),
            then: None,
        },
        // Only a wait a person can answer is raised; a spent account's is nobody's to answer.
        SessionEvent::WorkflowPhaseSuspended(suspended) => match suspended {
            WorkflowPhaseSuspendedPayload::Account { .. } => AttentionChange::Nothing,
            WorkflowPhaseSuspendedPayload::Approval {
                workflow_run_id,
                node_id,
                attempt,
                execution_index,
                ..
            }
            | WorkflowPhaseSuspendedPayload::Form {
                workflow_run_id,
                node_id,
                attempt,
                execution_index,
                ..
            }
            | WorkflowPhaseSuspendedPayload::Reply {
                workflow_run_id,
                node_id,
                attempt,
                execution_index,
                ..
            }
            | WorkflowPhaseSuspendedPayload::Chain {
                workflow_run_id,
                node_id,
                attempt,
                execution_index,
                ..
            } => raise_wait(
                AttentionWait::Step(WorkflowStepKey {
                    workflow_run_id: *workflow_run_id,
                    node_id: node_id.clone(),
                    attempt: *attempt,
                    execution_index: *execution_index,
                }),
                AttentionMomentTrigger::PendingInput,
            ),
        },
        SessionEvent::WorkflowPhaseResumed(payload) => resolve_step(WorkflowStepKey {
            workflow_run_id: payload.workflow_run_id,
            node_id: payload.node_id.clone(),
            attempt: payload.attempt,
            execution_index: payload.execution_index,
        }),
        SessionEvent::WorkflowStepCompleted(payload) => resolve_step(WorkflowStepKey {
            workflow_run_id: payload.workflow_run_id,
            node_id: payload.node_id.clone(),
            attempt: payload.attempt,
            execution_index: payload.execution_index,
        }),
        SessionEvent::WorkflowStepFailed(payload) => resolve_step(WorkflowStepKey {
            workflow_run_id: payload.workflow_run_id,
            node_id: payload.node_id.clone(),
            attempt: payload.attempt,
            execution_index: payload.execution_index,
        }),
        SessionEvent::WorkflowStepCanceled(payload) => resolve_step(WorkflowStepKey {
            workflow_run_id: payload.workflow_run_id,
            node_id: payload.node_id.clone(),
            attempt: payload.attempt,
            execution_index: payload.execution_index,
        }),
        SessionEvent::WorkflowRunResumed(payload) => AttentionChange::Resolve {
            wait: AttentionWait::WorkflowRun(payload.workflow_run_id),
            then: None,
        },
        SessionEvent::WorkflowRunCanceled(payload) => AttentionChange::Resolve {
            wait: AttentionWait::WorkflowRun(payload.workflow_run_id),
            then: None,
        },
        SessionEvent::WorkflowRunCompleted(payload) => workflow_run_end(
            payload.workflow_run_id,
            AttentionMomentTrigger::RunCompleted,
        ),
        SessionEvent::WorkflowRunFailed(payload) => {
            workflow_run_end(payload.workflow_run_id, AttentionMomentTrigger::RunFailed)
        }
        SessionEvent::WorkflowRunDeleted(payload) => {
            AttentionChange::DeleteWorkflowRun(payload.workflow_run_id)
        }
        SessionEvent::SessionMuted(payload) => AttentionChange::WithdrawMuted(payload.session_id),
        // The name an entry shows is read from the session, its first message or its shape.
        SessionEvent::SessionRenamed(payload) => AttentionChange::NameChanged(payload.session_id),
        SessionEvent::SessionConverted(payload) => AttentionChange::NameChanged(payload.session_id),
        SessionEvent::UserMessageSent(payload) => AttentionChange::NameChanged(payload.session_id),
        // A run's own state change carries every wait these events open and close, and its
        // terminal carries the limit a limit event reports.
        SessionEvent::SessionCreated(_)
        | SessionEvent::WorkspacePreparing(_)
        | SessionEvent::WorkspacePrepared(_)
        | SessionEvent::WorkspaceRootLost(_)
        | SessionEvent::WorkspaceArchived(_)
        | SessionEvent::WorktreeCreated(_)
        | SessionEvent::WorktreeBound(_)
        | SessionEvent::WorktreeDirtied(_)
        | SessionEvent::WorktreeMerged(_)
        | SessionEvent::WorktreeRetired(_)
        | SessionEvent::SessionEventCompacted(_)
        | SessionEvent::AgentMessageSent(_)
        | SessionEvent::AgentThinkingUpdated(_)
        | SessionEvent::AgentToolCallInvoked(_)
        | SessionEvent::AgentToolCallCompleted(_)
        | SessionEvent::AgentToolCallFailed(_)
        | SessionEvent::AgentSubagentStarted(_)
        | SessionEvent::AgentSubagentCompleted(_)
        | SessionEvent::AgentRunProviderInitialized(_)
        | SessionEvent::AgentTurnStarted(_)
        | SessionEvent::AgentTurnCompleted(_)
        | SessionEvent::AgentTurnInterrupted(_)
        | SessionEvent::AgentTurnFailed(_)
        | SessionEvent::AgentRunWorkerShuttingDown(_)
        | SessionEvent::SessionProviderStatusReported(_)
        | SessionEvent::ApprovalRejected(_)
        | SessionEvent::ApprovalCanceled(_)
        | SessionEvent::ApprovalRuleRemembered(_)
        | SessionEvent::ApprovalRuleRevoked(_)
        | SessionEvent::ApprovalReviewerFlagged(_)
        | SessionEvent::PlanHoldEnded(_)
        | SessionEvent::QuestionAsked(_)
        | SessionEvent::QuestionOpened(_)
        | SessionEvent::QuestionCanceled(_)
        | SessionEvent::AgentQueueItemCreated(_)
        | SessionEvent::AgentQueueItemAdmitted(_)
        | SessionEvent::AgentQueueItemSuperseded(_)
        | SessionEvent::AgentQueueItemCanceled(_)
        | SessionEvent::AgentQueueItemNotDelivered(_)
        | SessionEvent::McpServerSignInCompleted(_)
        | SessionEvent::CloudTaskUpdated(_)
        | SessionEvent::SessionRestoreCompleted(_)
        | SessionEvent::SessionGoalCleared(_)
        | SessionEvent::SessionNoticePosted(_)
        | SessionEvent::SessionSideQuestionAnswered(_)
        | SessionEvent::SessionSpendLimitReached(_)
        | SessionEvent::GitSettled(_)
        | SessionEvent::RelayPinRefused(_)
        | SessionEvent::AgentCommandEnded(_)
        | SessionEvent::UsageTokenCountRecorded(_)
        | SessionEvent::UsageCostUpdated(_)
        | SessionEvent::UsageContextWindowUpdated(_)
        | SessionEvent::UsageRateLimitUpdated(_)
        | SessionEvent::UsageApiRequestRetried(_)
        | SessionEvent::AgentRunContextCompacted(_)
        | SessionEvent::AgentTurnRerouted(_)
        | SessionEvent::SessionActivated(_)
        | SessionEvent::SessionArchived(_)
        | SessionEvent::SessionReactivated(_)
        | SessionEvent::SessionClosed(_)
        | SessionEvent::SessionPinned(_)
        | SessionEvent::SessionUnpinned(_)
        | SessionEvent::SessionUnmuted(_)
        | SessionEvent::SessionBranchChanged(_)
        | SessionEvent::SessionSweptToCheckout(_)
        | SessionEvent::AgentProviderBindingChanged(_)
        | SessionEvent::AgentProviderBindingChangeFailed(_)
        | SessionEvent::ApprovalRequested(_)
        | SessionEvent::ApprovalApproved(_)
        | SessionEvent::ApprovalReviewerDenied(_)
        | SessionEvent::ApprovalDenialOverridden(_)
        | SessionEvent::AgentRunStepLimitReached(_)
        | SessionEvent::AgentRunTokenLimitReached(_)
        | SessionEvent::AgentRunRecoveryResolved(_)
        | SessionEvent::AgentRunRecoveryStepsAdded(_)
        | SessionEvent::SessionAdvisorChanged(_)
        | SessionEvent::SessionOutputStyleChanged(_)
        | SessionEvent::RepoMountHealthChanged(_)
        | SessionEvent::AgentRunRejected(_)
        | SessionEvent::ArtifactPublished(_)
        | SessionEvent::AgentRunRefusalChoiceRequested(_)
        | SessionEvent::AgentRunRefusalChoiceResolved(_)
        | SessionEvent::AgentRunUsageCreditsChoiceRequested(_)
        | SessionEvent::AgentRunUsageCreditsChoiceResolved(_)
        | SessionEvent::SessionGoalUpdated(_)
        | SessionEvent::TerminalControlChanged(_)
        | SessionEvent::WorkflowRunStarted(_)
        | SessionEvent::WorkflowResultsPosted(_)
        | SessionEvent::WorkflowPhaseFailed(_)
        | SessionEvent::WorkflowPhaseWaitingOnPool(_)
        | SessionEvent::WorkflowStepStarted(_)
        | SessionEvent::WorkflowStepSkipped(_)
        | SessionEvent::WorkflowGateResolved(_)
        | SessionEvent::WorkflowVersionCreated(_)
        | SessionEvent::WorkflowGateReached(_)
        | SessionEvent::WorkflowRunWaiting(_)
        | SessionEvent::WorkflowScheduleArmed(_)
        | SessionEvent::WorkflowScheduleFired(_)
        | SessionEvent::WorkflowTriggerArmed(_)
        | SessionEvent::WorkflowTriggerFired(_)
        | SessionEvent::WorkflowPhaseAdmitted(_)
        | SessionEvent::WorkflowPhaseStarted(_)
        | SessionEvent::WorkflowPhaseProgressed(_)
        | SessionEvent::WorkflowPhaseCanceling(_)
        | SessionEvent::WorkflowPhaseRetried(_)
        | SessionEvent::WorkflowPhaseCompleted(_)
        | SessionEvent::WorkflowParallelJoinBranchesCanceled(_)
        | SessionEvent::DaemonBackupCompleted(_)
        | SessionEvent::DaemonBackupFailed(_)
        | SessionEvent::DaemonBackupRestored(_)
        | SessionEvent::DaemonRecoveryAttempted(_)
        | SessionEvent::DaemonRecoverySucceeded(_)
        | SessionEvent::DaemonRecoveryFailed(_)
        | SessionEvent::SessionDamagedEventsSkipped(_)
        | SessionEvent::AgentRunRolledBack(_)
        | SessionEvent::AgentInterventionRequested(_)
        | SessionEvent::AgentInterventionAccepted(_)
        | SessionEvent::AgentInterventionApplied(_)
        | SessionEvent::AgentInterventionRejected(_)
        | SessionEvent::AgentInterventionDegraded(_)
        | SessionEvent::AgentInterventionExpired(_)
        | SessionEvent::AgentInterventionFailed(_) => AttentionChange::Nothing,
    }
}

#[cfg(test)]
mod tests;
