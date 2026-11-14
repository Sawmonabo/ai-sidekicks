//! The agent run and the workflow run an event belongs to, as each event type's payload names
//! them: the rules the session event table gives each type, and the reads of the payloads whose
//! arms name their run differently.

use crate::approval::events::{
    ApprovalCanceledPayload, ApprovalRequestedPayload, ApprovalResolvedPayload,
};
use crate::approval::holder::ApprovalHolder;
use crate::event::declared_variants::AgentOutputPayload;
use crate::git::local::GitSettledPayload;
use crate::question::QuestionAskedPayload;
use crate::run::id::RunId;
use crate::run::queued::AgentRunQueuedPayload;
use crate::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use crate::wire::integer::SafeInt;
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::step::events::suspended::WorkflowPhaseSuspendedPayload;

/// The run an event belongs to: its payload's `runId`, with its `runVersion` and `turnNumber`
/// where it carries them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EventRun {
    /// The run.
    pub run_id: RunId,
    /// The run's progression counter the event was written at.
    pub run_version: Option<SafeInt<0>>,
    /// The turn's number within its run, on a turn's start and its end.
    pub turn_number: Option<SafeInt<1>>,
}

/// One arm of [`SessionEvent::run`]: the pattern that binds the payload where its run is read,
/// then the run read from it, as the arm's rule in the registration table says: `versioned` for a
/// `runId` and a `runVersion`, `turn` for those and a `turnNumber`, `required` for a `runId`
/// alone, `optional` for an optional `runId`, `read(function)` for a payload union whose arms
/// differ, and no rule for no run.
macro_rules! event_run {
    (@binding $payload:ident) => {
        _
    };
    (@binding $payload:ident $rule:ident $(($read:ident))?) => {
        $payload
    };
    ($payload:ident) => {
        None
    };
    ($payload:ident versioned) => {
        Some(EventRun {
            run_id: $payload.run_id,
            run_version: Some($payload.run_version),
            turn_number: None,
        })
    };
    ($payload:ident turn) => {
        Some(EventRun {
            run_id: $payload.run_id,
            run_version: Some($payload.run_version),
            turn_number: Some($payload.turn_number),
        })
    };
    ($payload:ident required) => {
        Some(EventRun {
            run_id: $payload.run_id,
            run_version: None,
            turn_number: None,
        })
    };
    ($payload:ident optional) => {
        $payload.run_id.map(|run_id| EventRun {
            run_id,
            run_version: None,
            turn_number: None,
        })
    };
    ($payload:ident read($read:ident)) => {
        $read($payload)
    };
}

pub(super) use event_run;

/// One arm of [`SessionEvent::workflow_run_id`]: the pattern that binds the payload where its
/// workflow run is read, then the run read from it, as the arm's `in` rule in the registration
/// table says: `workflow_run` for a `workflowRunId`, `workflow_run(function)` for a payload union,
/// and no rule for an event no workflow run of its session owns.
macro_rules! event_workflow_run {
    (@binding $payload:ident) => {
        _
    };
    (@binding $payload:ident workflow_run $(($read:ident))?) => {
        $payload
    };
    ($payload:ident) => {
        None
    };
    ($payload:ident workflow_run) => {
        Some($payload.workflow_run_id)
    };
    ($payload:ident workflow_run($read:ident)) => {
        Some($read($payload))
    };
}

pub(super) use event_workflow_run;

/// The workflow run whose step waits.
pub(super) fn phase_suspended_run(payload: &WorkflowPhaseSuspendedPayload) -> WorkflowRunId {
    let (WorkflowPhaseSuspendedPayload::Account {
        workflow_run_id, ..
    }
    | WorkflowPhaseSuspendedPayload::Approval {
        workflow_run_id, ..
    }
    | WorkflowPhaseSuspendedPayload::Form {
        workflow_run_id, ..
    }
    | WorkflowPhaseSuspendedPayload::Reply {
        workflow_run_id, ..
    }
    | WorkflowPhaseSuspendedPayload::Chain {
        workflow_run_id, ..
    }) = payload;
    *workflow_run_id
}

/// The run of an agent row: a run's row names it, a voice call's answer names none.
pub(super) fn agent_output_run(payload: &AgentOutputPayload) -> Option<EventRun> {
    match payload {
        AgentOutputPayload::Run(output) => Some(EventRun {
            run_id: output.run_id,
            run_version: None,
            turn_number: None,
        }),
        AgentOutputPayload::Voice(_) => None,
    }
}

/// The run that holds an ask; a workflow wait's card names none.
fn approval_holder_run(holder: &ApprovalHolder) -> Option<EventRun> {
    holder.run_id().map(|run_id| EventRun {
        run_id,
        run_version: None,
        turn_number: None,
    })
}

/// The run that holds a raised ask.
pub(super) fn approval_requested_run(payload: &ApprovalRequestedPayload) -> Option<EventRun> {
    approval_holder_run(&payload.holder)
}

/// The run that held an answered ask.
pub(super) fn approval_resolved_run(payload: &ApprovalResolvedPayload) -> Option<EventRun> {
    approval_holder_run(&payload.holder)
}

/// The run that held a canceled ask.
pub(super) fn approval_canceled_run(payload: &ApprovalCanceledPayload) -> Option<EventRun> {
    approval_holder_run(&payload.holder)
}

/// The run that holds a question; a workflow wait's question names none.
pub(super) fn question_asked_run(payload: &QuestionAskedPayload) -> Option<EventRun> {
    match payload {
        QuestionAskedPayload::Run(question) => Some(EventRun {
            run_id: question.run_id,
            run_version: None,
            turn_number: None,
        }),
        QuestionAskedPayload::Wait(_) => None,
    }
}

/// The run behind a commit or an opened pull request, where it names one.
pub(super) fn git_settled_run(payload: &GitSettledPayload) -> Option<EventRun> {
    match payload {
        GitSettledPayload::Committed { run_id, .. }
        | GitSettledPayload::PullRequestOpened { run_id, .. } => run_id.map(|run_id| EventRun {
            run_id,
            run_version: None,
            turn_number: None,
        }),
        GitSettledPayload::Pushed { .. }
        | GitSettledPayload::Pulled { .. }
        | GitSettledPayload::ReviewPosted { .. } => None,
    }
}

/// The run queued, at the version it was queued at.
#[expect(
    clippy::unnecessary_wraps,
    reason = "every run rule that reads its payload answers an Option"
)]
pub(super) fn run_queued_run(payload: &AgentRunQueuedPayload) -> Option<EventRun> {
    Some(EventRun {
        run_id: payload.run_id(),
        run_version: Some(payload.run_version()),
        turn_number: None,
    })
}

/// The run a notice is about: only the run that asked for fast output it lacks.
pub(super) fn session_notice_run(payload: &SessionNoticePostedPayload) -> Option<EventRun> {
    let SessionNoticePostedPayload::Notice(SessionNotice::FastOutputUnavailable { run_id, .. }) =
        payload
    else {
        return None;
    };
    Some(EventRun {
        run_id: *run_id,
        run_version: None,
        turn_number: None,
    })
}
