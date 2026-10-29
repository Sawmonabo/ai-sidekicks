//! Which events raise, resolve or delete attention entries, the moment each entry speaks for and
//! its id, and the subject the banner merge and the seen mark group entries by.

use sidekicks_contracts::attention::{AttentionId, AttentionMomentTrigger, AttentionSeverity};
use sidekicks_contracts::event::registry::SessionEventType;
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

/// What one entry speaks for. Its id is the banner's tag and the push's collapse id, so a later
/// state of the same moment replaces what was posted for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AttentionMoment {
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
    /// The moment's id, at most 64 bytes, the bound of a banner's tag and a push's collapse id: a
    /// Notify step's is a fixed-length hash of its run, node and execution, since a node id has no
    /// bound.
    pub(crate) fn id(&self) -> AttentionId {
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
                // A run id is a UUID and the index a number, so neither holds the separator and no
                // two (run, node, execution) triples give the same text.
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
    /// an agent run or a plan of `session_id`, or for the session itself, and the workflow run for
    /// a workflow's entries.
    #[expect(dead_code, reason = "the attention projection")]
    pub(crate) fn subject(&self, session_id: SessionId) -> AttentionSubject {
        match self {
            Self::Run(_) | Self::Plan(_) => AttentionSubject::Session(session_id),
            Self::Session(own_session_id) => AttentionSubject::Session(*own_session_id),
            Self::WorkflowRun(workflow_run_id)
            | Self::Notify {
                workflow_run_id, ..
            } => AttentionSubject::WorkflowRun(*workflow_run_id),
        }
    }
}

/// Whose entries merge into one banner and share one seen mark.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum AttentionSubject {
    /// A session, for its agent runs' and plans' entries.
    Session(SessionId),
    /// A workflow run, for its own and its Notify steps' entries.
    WorkflowRun(WorkflowRunId),
}

/// A wait on the person that an event opens and a later event resolves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AttentionWait {
    /// An agent run waiting on an approval or an answer.
    Run(RunId),
    /// A plan waiting on its card.
    Plan(PlanId),
    /// One workflow step waiting on the person.
    Step(WorkflowStepKey),
}

impl AttentionWait {
    /// The moment an entry for this wait speaks for: a step's is its workflow run's.
    pub(crate) fn moment(&self) -> AttentionMoment {
        match self {
            Self::Run(run_id) => AttentionMoment::Run(*run_id),
            Self::Plan(plan_id) => AttentionMoment::Plan(*plan_id),
            Self::Step(step) => AttentionMoment::WorkflowRun(step.workflow_run_id),
        }
    }
}

/// The open entries an event resolves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AttentionOpenEntries {
    /// Every open entry of an agent run's moment: its wait, and the failed end a limit raised,
    /// since an interrupted run can run again.
    Run(RunId),
    /// A plan's wait on its card.
    Plan(PlanId),
    /// Every waiting step of a workflow run.
    WorkflowRun(WorkflowRunId),
    /// One workflow step's wait.
    Step(WorkflowStepKey),
}

/// A run's end that raises an entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AttentionEnd {
    /// An agent run's end, raised only for a lead run, which the statement writing it checks,
    /// since the event does not say whether the run has a parent.
    Run(RunId),
    /// A workflow run's end.
    WorkflowRun(WorkflowRunId),
}

impl AttentionEnd {
    /// The moment the end speaks for: its run's.
    pub(crate) fn moment(self) -> AttentionMoment {
        match self {
            Self::Run(run_id) => AttentionMoment::Run(run_id),
            Self::WorkflowRun(workflow_run_id) => AttentionMoment::WorkflowRun(workflow_run_id),
        }
    }
}

/// A new entry an event raises.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AttentionRaise {
    /// A wait on the person opens; a later event resolves it.
    Wait {
        /// What waits.
        wait: AttentionWait,
        /// `pendingApproval` or `pendingInput`.
        trigger: AttentionMomentTrigger,
    },
    /// A run or a workflow run ended.
    End {
        /// Which run ended.
        end: AttentionEnd,
        /// `runCompleted` or `runFailed`.
        trigger: AttentionMomentTrigger,
    },
}

impl AttentionRaise {
    /// The moment the entry speaks for.
    pub(crate) fn moment(&self) -> AttentionMoment {
        match self {
            Self::Wait { wait, .. } => wait.moment(),
            Self::End { end, .. } => end.moment(),
        }
    }

    /// What raised the entry.
    pub(crate) fn trigger(&self) -> AttentionMomentTrigger {
        match self {
            Self::Wait { trigger, .. } | Self::End { trigger, .. } => *trigger,
        }
    }

    /// Whether the entry blocks on the person: a wait does, an end does not, since its remedy is a
    /// new run.
    pub(crate) fn severity(&self) -> AttentionSeverity {
        match self {
            Self::Wait { .. } => AttentionSeverity::Actionable,
            Self::End { .. } => AttentionSeverity::Informational,
        }
    }
}

/// What one event does to the attention entries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AttentionChange {
    /// A new entry.
    Raise(AttentionRaise),
    /// Open entries resolve, then the same event may raise a new one: a run's next wait or its
    /// end. A run's resolve covers every open entry of its moment, a limit's failed end included.
    Resolve {
        /// The open entries that resolve.
        entries: AttentionOpenEntries,
        /// The entry the same event raises after them.
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

/// Every event type whose change is not [`AttentionChange::Nothing`]: the live statements read no
/// event of another type, and a rebuild folds only these.
pub(crate) const ATTENTION_EVENT_TYPES: [SessionEventType; 29] = [
    SessionEventType::AgentRunWaitingForApproval,
    SessionEventType::AgentRunWaitingForInput,
    SessionEventType::AgentRunQueued,
    SessionEventType::AgentRunStarting,
    SessionEventType::AgentRunRunning,
    SessionEventType::AgentRunPausing,
    SessionEventType::AgentRunPaused,
    SessionEventType::AgentRunCompleted,
    SessionEventType::AgentRunFailed,
    SessionEventType::AgentRunInterrupted,
    SessionEventType::AgentRunStopped,
    SessionEventType::PlanProposed,
    SessionEventType::PlanAccepted,
    SessionEventType::PlanKept,
    SessionEventType::PlanHandedOff,
    SessionEventType::WorkflowPhaseSuspended,
    SessionEventType::WorkflowPhaseResumed,
    SessionEventType::WorkflowStepCompleted,
    SessionEventType::WorkflowStepFailed,
    SessionEventType::WorkflowStepCanceled,
    SessionEventType::WorkflowRunResumed,
    SessionEventType::WorkflowRunCanceled,
    SessionEventType::WorkflowRunCompleted,
    SessionEventType::WorkflowRunFailed,
    SessionEventType::WorkflowRunDeleted,
    SessionEventType::SessionMuted,
    SessionEventType::SessionRenamed,
    SessionEventType::SessionConverted,
    SessionEventType::UserMessageSent,
];

/// What `event` does to the attention entries, read from the event alone.
pub(crate) fn entry_change_of(event: &SessionEvent) -> AttentionChange {
    // A run moving into a wait resolves whatever its moment still has open, the other wait
    // included, so one run holds one open wait.
    let wait_run = |run_id, trigger| AttentionChange::Resolve {
        entries: AttentionOpenEntries::Run(run_id),
        then: Some(AttentionRaise::Wait {
            wait: AttentionWait::Run(run_id),
            trigger,
        }),
    };
    let raise_wait = |wait, trigger| AttentionChange::Raise(AttentionRaise::Wait { wait, trigger });
    let resolve = |entries| AttentionChange::Resolve {
        entries,
        then: None,
    };
    let resolve_run = |run_id: RunId, then| AttentionChange::Resolve {
        entries: AttentionOpenEntries::Run(run_id),
        then,
    };
    let run_end = |is_raised: bool, run_id, trigger| {
        is_raised.then_some(AttentionRaise::End {
            end: AttentionEnd::Run(run_id),
            trigger,
        })
    };
    let resolve_step = |step| resolve(AttentionOpenEntries::Step(step));
    let workflow_run_end = |workflow_run_id, trigger| AttentionChange::Resolve {
        entries: AttentionOpenEntries::WorkflowRun(workflow_run_id),
        then: Some(AttentionRaise::End {
            end: AttentionEnd::WorkflowRun(workflow_run_id),
            trigger,
        }),
    };
    match event {
        SessionEvent::AgentRunWaitingForApproval(payload) => {
            wait_run(payload.run_id, AttentionMomentTrigger::PendingApproval)
        }
        SessionEvent::AgentRunWaitingForInput(payload) => {
            wait_run(payload.run_id, AttentionMomentTrigger::PendingInput)
        }
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
        SessionEvent::PlanAccepted(payload) => resolve(AttentionOpenEntries::Plan(payload.plan_id)),
        SessionEvent::PlanKept(payload) => resolve(AttentionOpenEntries::Plan(payload.plan_id)),
        SessionEvent::PlanHandedOff(payload) => {
            resolve(AttentionOpenEntries::Plan(payload.plan_id))
        }
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
        SessionEvent::WorkflowRunResumed(payload) => {
            resolve(AttentionOpenEntries::WorkflowRun(payload.workflow_run_id))
        }
        SessionEvent::WorkflowRunCanceled(payload) => {
            resolve(AttentionOpenEntries::WorkflowRun(payload.workflow_run_id))
        }
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
