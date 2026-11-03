//! The held lead's continue a relaunch carries: composed from the answers the person gave while
//! the daemon's restart held the session's lead, the lead's own and those of the helpers beneath
//! it, once no answer is still owed it, each answer's continue mark claimed before the driver is
//! called and given back when the driver fails or defers, so the next relaunch carries it again.

use std::collections::HashSet;
use std::error::Error;
use std::fmt;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use jiff::Timestamp;
use sidekicks_approval::service::ApprovalService;
use sidekicks_contracts::approval::ApprovalRequestId;
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::idle_sleep::KeptSchedule;
use sidekicks_provider::driver::session_control::LiveRunResume;
use sidekicks_provider::driver::session_control::held_run_continue::{
    ContinueAnswer, ContinueEntry, HeldRunContinue,
};
use sidekicks_session::questions::service::QuestionsService;

use crate::provider_session::ProviderSessions;
use crate::provider_session::errors::ProviderSessionError;

/// What a kept answers' read or write answers, or the error it failed with.
pub type KeptAnswerFuture<'a, T> = BoxFuture<'a, Result<T, Box<dyn Error + Send + Sync>>>;

/// An answer kept while no process held the session, which the held lead's continue owes the run
/// that asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwedAnswer<Id> {
    /// The card or question it answers, by which its continue mark is claimed.
    pub id: Id,
    /// The run that asked.
    pub run_id: RunId,
    /// What was asked and answered.
    pub answer: ContinueAnswer,
}

/// Where the answers of one kind kept for a session's continue are read and their continue marks
/// claimed: the approval cards' or the questions'.
pub trait KeptAnswerSource<Id>: Send + Sync {
    /// The session's answers no continue and no call made again took yet, oldest first. Fails as
    /// the read fails.
    fn owed_continues(&self, session_id: SessionId) -> KeptAnswerFuture<'_, Vec<OwedAnswer<Id>>>;

    /// Claims `id`'s continue mark: true for the one caller that takes it, false once another
    /// took it. Fails as the claim's write fails.
    fn claim_continue(&self, id: Id) -> KeptAnswerFuture<'_, bool>;

    /// Gives `id`'s continue mark back, so the next continue takes it. Fails as the write fails.
    fn release_continue(&self, id: Id) -> KeptAnswerFuture<'_, ()>;

    /// Whether `run_id` holds an ask of this kind the person has not answered yet. Fails as the
    /// read fails.
    fn has_open_ask(&self, run_id: RunId) -> KeptAnswerFuture<'_, bool>;
}

impl KeptAnswerSource<ApprovalRequestId> for ApprovalService {
    fn owed_continues(
        &self,
        session_id: SessionId,
    ) -> KeptAnswerFuture<'_, Vec<OwedAnswer<ApprovalRequestId>>> {
        async move {
            let owed = self.kept_answers().owed_continues(session_id).await?;
            Ok(owed
                .into_iter()
                .map(|card| OwedAnswer {
                    id: card.approval_request_id,
                    run_id: card.run_id,
                    answer: ContinueAnswer::Approval {
                        approval_request_id: card.approval_request_id,
                        subject: card.subject.as_str().to_owned(),
                        tool_name: card
                            .tool_name
                            .map(|tool_name| tool_name.as_str().to_owned()),
                        decision: card.decision,
                        decline_reason: card
                            .decline_reason
                            .map(|reason| reason.as_str().to_owned()),
                        edited_action: card.edited_action.map(|edited| edited.as_str().to_owned()),
                    },
                })
                .collect())
        }
        .boxed()
    }

    fn claim_continue(&self, id: ApprovalRequestId) -> KeptAnswerFuture<'_, bool> {
        async move { Ok(self.kept_answers().claim_continue(id).await?) }.boxed()
    }

    fn release_continue(&self, id: ApprovalRequestId) -> KeptAnswerFuture<'_, ()> {
        async move { Ok(self.kept_answers().release_continue(id).await?) }.boxed()
    }

    fn has_open_ask(&self, run_id: RunId) -> KeptAnswerFuture<'_, bool> {
        async move { Ok(self.has_pending_ask(run_id).await?) }.boxed()
    }
}

impl KeptAnswerSource<QuestionId> for QuestionsService {
    fn owed_continues(
        &self,
        session_id: SessionId,
    ) -> KeptAnswerFuture<'_, Vec<OwedAnswer<QuestionId>>> {
        async move {
            let owed = QuestionsService::owed_continues(self, session_id).await?;
            Ok(owed
                .into_iter()
                .map(|kept| OwedAnswer {
                    id: kept.question_id,
                    run_id: kept.run_id,
                    answer: ContinueAnswer::Question {
                        question_id: kept.question_id,
                        question: kept.question,
                        answer: kept.answer,
                    },
                })
                .collect())
        }
        .boxed()
    }

    fn claim_continue(&self, id: QuestionId) -> KeptAnswerFuture<'_, bool> {
        async move { Ok(QuestionsService::claim_continue(self, id).await?) }.boxed()
    }

    fn release_continue(&self, id: QuestionId) -> KeptAnswerFuture<'_, ()> {
        async move { Ok(QuestionsService::release_continue(self, id).await?) }.boxed()
    }

    fn has_open_ask(&self, run_id: RunId) -> KeptAnswerFuture<'_, bool> {
        async move { Ok(self.has_open_question(run_id).await?) }.boxed()
    }
}

// One continue mark a relaunch claimed.
#[derive(Clone, Copy, Debug)]
pub(super) enum ClaimedMark {
    Approval(ApprovalRequestId),
    Question(QuestionId),
}

/// The continue a relaunch claimed for the held lead, the marks it claimed, and the runs waiting on
/// the person, every ask of theirs answered, that it continues, each beside the wait it leaves.
#[derive(Default)]
pub(super) struct ClaimedContinue {
    pub(super) held_run_continue: Option<HeldRunContinue>,
    pub(super) claims: Vec<ClaimedMark>,
    pub(super) answered_runs: Vec<(RunId, RunState)>,
}

impl ProviderSessions {
    // The continue `live_runs`' lead is owed, every answer's mark claimed for this relaunch: none
    // where no lead starts, runs or waits, the lead is still held on the person, or nothing is owed
    // it. A run waiting on the person whose every ask is answered, an answer of its owed, counts as
    // running: the continue carries it on, and `live_runs` names it running where a continue was
    // claimed. An answer of a run outside the lead and its helpers is left out, as is one another
    // relaunch claimed first; a failed claim gives back the marks claimed before it.
    pub(super) async fn claim_held_run_continue(
        &self,
        session_id: SessionId,
        live_runs: &mut [LiveRunResume],
        kept_schedules: &[KeptSchedule],
    ) -> Result<ClaimedContinue, ProviderSessionError> {
        let may_continue = |run: &LiveRunResume| {
            run.is_lead()
                && !run.is_stopping
                && matches!(
                    run.run_state,
                    RunState::Starting
                        | RunState::Running
                        | RunState::WaitingForApproval
                        | RunState::WaitingForInput
                )
        };
        if !live_runs.iter().any(may_continue) {
            return Ok(ClaimedContinue::default());
        }
        let kept_answers = |cause| ProviderSessionError::KeptAnswers { session_id, cause };
        let approvals = self
            .deps
            .kept_approvals
            .owed_continues(session_id)
            .await
            .map_err(kept_answers)?;
        let questions = self
            .deps
            .kept_questions
            .owed_continues(session_id)
            .await
            .map_err(kept_answers)?;
        let owed_run_ids: HashSet<RunId> = approvals
            .iter()
            .map(|owed| owed.run_id)
            .chain(questions.iter().map(|owed| owed.run_id))
            .collect();
        let mut continued_runs = live_runs.to_vec();
        let mut answered_runs = Vec::new();
        for run in &mut continued_runs {
            if !run.is_stopping
                && matches!(
                    run.run_state,
                    RunState::WaitingForApproval | RunState::WaitingForInput
                )
                && owed_run_ids.contains(&run.run_id)
                && !self.has_open_ask(session_id, run.run_id).await?
            {
                answered_runs.push((run.run_id, run.run_state));
                run.run_state = RunState::Running;
            }
        }
        let Some(lead) = continued_runs.iter().find(|run| {
            run.is_lead()
                && !run.is_stopping
                && matches!(run.run_state, RunState::Starting | RunState::Running)
                && !run.is_held(&continued_runs)
        }) else {
            return Ok(ClaimedContinue::default());
        };
        let owed = approvals
            .into_iter()
            .map(|owed| (ClaimedMark::Approval(owed.id), owed.run_id, owed.answer))
            .chain(
                questions
                    .into_iter()
                    .map(|owed| (ClaimedMark::Question(owed.id), owed.run_id, owed.answer)),
            );
        let mut entries = Vec::new();
        let mut claims = Vec::new();
        for (mark, run_id, answer) in owed {
            // The lead's own answer, or a helper's beneath it; a workflow step's or another
            // agent's run beneath it is no helper the lead can continue.
            let subagent_id = if run_id == lead.run_id {
                None
            } else {
                let Some(helper) = continued_runs.iter().find(|run| {
                    run.run_id == run_id
                        && run.subagent_id.is_some()
                        && lead.is_above(run, &continued_runs)
                }) else {
                    continue;
                };
                helper.subagent_id.clone()
            };
            match self.claim_mark(mark).await {
                Ok(true) => {}
                Ok(false) => continue,
                Err(cause) => {
                    let failed = ProviderSessionError::KeptAnswers { session_id, cause };
                    return Err(self.release_marks_after(session_id, claims, failed).await);
                }
            }
            claims.push(mark);
            entries.push(ContinueEntry {
                run_id,
                subagent_id,
                answer,
            });
        }
        if entries.is_empty() {
            return Ok(ClaimedContinue {
                claims,
                ..ClaimedContinue::default()
            });
        }
        // Only the lead and the runs beneath it go on with the continue.
        answered_runs.retain(|(run_id, _)| {
            *run_id == lead.run_id
                || continued_runs
                    .iter()
                    .any(|run| run.run_id == *run_id && lead.is_above(run, &continued_runs))
        });
        for run in live_runs.iter_mut() {
            if answered_runs
                .iter()
                .any(|(run_id, _)| *run_id == run.run_id)
            {
                run.run_state = RunState::Running;
            }
        }
        Ok(ClaimedContinue {
            held_run_continue: Some(HeldRunContinue::new(
                lead.run_id,
                entries,
                kept_schedules,
                Timestamp::now(),
            )),
            claims,
            answered_runs,
        })
    }

    /// Whether `run_id` waits on an ask of its own the person has not answered, a card or a
    /// question; a helper's ask beneath it is the helper's. Fails as either read fails.
    pub(crate) async fn has_open_ask(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<bool, ProviderSessionError> {
        let kept_answers = |cause| ProviderSessionError::KeptAnswers { session_id, cause };
        Ok(self
            .deps
            .kept_approvals
            .has_open_ask(run_id)
            .await
            .map_err(kept_answers)?
            || self
                .deps
                .kept_questions
                .has_open_ask(run_id)
                .await
                .map_err(kept_answers)?)
    }

    // Gives back every mark of `claims` after `failed` ended its relaunch, answering `failed`, or
    // both where a mark could not be given back.
    pub(super) async fn release_marks_after(
        &self,
        session_id: SessionId,
        claims: Vec<ClaimedMark>,
        failed: ProviderSessionError,
    ) -> ProviderSessionError {
        match self.release_marks(claims).await {
            Ok(()) => failed,
            Err(released) => ProviderSessionError::ContinueNotReleased {
                session_id,
                failed: Box::new(failed),
                released,
            },
        }
    }

    // Gives back every mark of `claims`, each tried; fails naming every mark not given back.
    pub(super) async fn release_marks(
        &self,
        claims: Vec<ClaimedMark>,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let mut unreleased = Vec::new();
        for mark in claims {
            let released = match mark {
                ClaimedMark::Approval(id) => self.deps.kept_approvals.release_continue(id).await,
                ClaimedMark::Question(id) => self.deps.kept_questions.release_continue(id).await,
            };
            if let Err(error) = released {
                unreleased.push((mark, error));
            }
        }
        if unreleased.is_empty() {
            Ok(())
        } else {
            Err(Box::new(UnreleasedMarks(unreleased)))
        }
    }

    async fn claim_mark(&self, mark: ClaimedMark) -> Result<bool, Box<dyn Error + Send + Sync>> {
        match mark {
            ClaimedMark::Approval(id) => self.deps.kept_approvals.claim_continue(id).await,
            ClaimedMark::Question(id) => self.deps.kept_questions.claim_continue(id).await,
        }
    }
}

// The continue marks a give-back left claimed, each with why, so the next relaunch does not carry
// their answers until they are given back.
#[derive(Debug)]
struct UnreleasedMarks(Vec<(ClaimedMark, Box<dyn Error + Send + Sync>)>);

impl fmt::Display for UnreleasedMarks {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("continue marks could not be given back:")?;
        for (mark, error) in &self.0 {
            match mark {
                ClaimedMark::Approval(id) => write!(formatter, " approval {id} ({error});")?,
                ClaimedMark::Question(id) => write!(formatter, " question {id} ({error});")?,
            }
        }
        Ok(())
    }
}

impl Error for UnreleasedMarks {}
