//! The held lead's continue a relaunch carries: composed from the answers the person gave while
//! the daemon's restart held the session's lead, the lead's own and those of the helpers beneath
//! it, once no answer is still owed it, each answer's continue mark claimed before the driver is
//! called and given back when the driver fails or defers, or later tells the queue it did not
//! carry the continue, so the next relaunch carries it again.

use std::error::Error;
use std::sync::Weak;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use jiff::Timestamp;
use sidekicks_approval::kept_answers::KeptAnswers;
use sidekicks_contracts::approval::ApprovalRequestId;
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::idle_sleep::KeptSchedule;
use sidekicks_provider::driver::ports::ContinueGivenBackListener;
use sidekicks_provider::driver::session_control::LiveRunResume;
use sidekicks_provider::driver::session_control::held_run_continue::{
    ContinueAnswer, ContinueEntry, HeldRunContinue,
};
use sidekicks_session::questions::service::QuestionsService;
use sidekicks_std::mutex_lock::lock;
use tokio_util::task::TaskTracker;

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
}

impl KeptAnswerSource<ApprovalRequestId> for KeptAnswers {
    fn owed_continues(
        &self,
        session_id: SessionId,
    ) -> KeptAnswerFuture<'_, Vec<OwedAnswer<ApprovalRequestId>>> {
        async move {
            let owed = KeptAnswers::owed_continues(self, session_id).await?;
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
        async move { Ok(KeptAnswers::claim_continue(self, id).await?) }.boxed()
    }

    fn release_continue(&self, id: ApprovalRequestId) -> KeptAnswerFuture<'_, ()> {
        async move { Ok(KeptAnswers::release_continue(self, id).await?) }.boxed()
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
}

// One continue mark a relaunch claimed.
#[derive(Clone, Copy)]
pub(super) enum ClaimedMark {
    Approval(ApprovalRequestId),
    Question(QuestionId),
}

// The marks of the continue a relaunch handed its driver for the lead `lead_run_id`, kept until
// the driver's answer settles them or the driver gives the continue back.
pub(super) struct HandedContinue {
    lead_run_id: RunId,
    claims: Vec<ClaimedMark>,
}

/// The intake of a continue a driver gave back, as the drivers' port holds it: the provider
/// sessions weakly, since the port outlives no queue, each give-back settled on a task of the
/// queue's own.
pub(crate) struct ContinueGivenBack {
    /// The provider sessions, which hold each handed continue's marks.
    pub(crate) sessions: Weak<ProviderSessions>,
    /// The queue's tracked release tasks, which each give-back runs on.
    pub(crate) releases: TaskTracker,
}

impl ContinueGivenBackListener for ContinueGivenBack {
    fn continue_given_back(&self, session_id: SessionId, lead_run_id: RunId) {
        let Some(sessions) = self.sessions.upgrade() else {
            return;
        };
        self.releases.spawn(async move {
            if let Err(released) = sessions.give_back_continue(session_id, lead_run_id).await {
                tracing::error!(
                    session_id = %session_id,
                    run_id = %lead_run_id,
                    error = &*released as &(dyn Error + 'static),
                    "the person's answers a provider did not carry could not be given back"
                );
            }
        });
    }
}

impl ProviderSessions {
    // Keeps the marks `claims` of the continue this relaunch hands `session_id`'s lead
    // `lead_run_id` in place of any an earlier relaunch handed, so the driver's give-back finds
    // them; a relaunch handing none keeps none.
    pub(super) fn hand_continue(
        &self,
        session_id: SessionId,
        lead_run_id: Option<RunId>,
        claims: Vec<ClaimedMark>,
    ) {
        let mut handed = lock(&self.handed_continues);
        match lead_run_id {
            Some(lead_run_id) => {
                handed.insert(
                    session_id,
                    HandedContinue {
                        lead_run_id,
                        claims,
                    },
                );
            }
            None => {
                handed.remove(&session_id);
            }
        }
    }

    // Takes the marks of the continue handed `session_id`'s driver, none once it gave them back.
    pub(super) fn take_handed_continue(&self, session_id: SessionId) -> Vec<ClaimedMark> {
        lock(&self.handed_continues)
            .remove(&session_id)
            .map(|handed| handed.claims)
            .unwrap_or_default()
    }

    /// Gives back each mark of the continue handed `session_id`'s lead `lead_run_id`, which its
    /// driver did not carry, so the next relaunch carries the answers again; a continue already
    /// settled or handed another lead is left. Fails with the first release that failed.
    pub(crate) async fn give_back_continue(
        &self,
        session_id: SessionId,
        lead_run_id: RunId,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let claims = {
            let mut handed = lock(&self.handed_continues);
            match handed.get(&session_id) {
                Some(continue_handed) if continue_handed.lead_run_id == lead_run_id => handed
                    .remove(&session_id)
                    .map(|handed| handed.claims)
                    .unwrap_or_default(),
                Some(_) | None => return Ok(()),
            }
        };
        self.release_marks(claims).await
    }

    // The continue `live_runs`' lead is owed, every answer's mark claimed for this relaunch, beside
    // the marks claimed: none where no lead starts or runs, the lead is still held on the person,
    // or nothing is owed it. An answer of a run outside the lead and its helpers is left out, as is
    // one another relaunch claimed first; a failed claim gives back the marks claimed before it.
    pub(super) async fn claim_held_run_continue(
        &self,
        session_id: SessionId,
        live_runs: &[LiveRunResume],
        kept_schedules: &[KeptSchedule],
    ) -> Result<(Option<HeldRunContinue>, Vec<ClaimedMark>), ProviderSessionError> {
        let Some(lead) = live_runs.iter().find(|run| {
            run.is_lead()
                && !run.is_stopping
                && matches!(run.run_state, RunState::Starting | RunState::Running)
                && !run.is_held(live_runs)
        }) else {
            return Ok((None, Vec::new()));
        };
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
                let Some(helper) = live_runs.iter().find(|run| {
                    run.run_id == run_id
                        && run.subagent_id.is_some()
                        && lead.is_above(run, live_runs)
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
            return Ok((None, claims));
        }
        Ok((
            Some(HeldRunContinue::new(
                lead.run_id,
                entries,
                kept_schedules,
                Timestamp::now(),
            )),
            claims,
        ))
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

    // Gives back every mark of `claims`, each tried; fails with the first release that failed, and
    // logs each later failure with its card or question, which that error does not name.
    pub(super) async fn release_marks(
        &self,
        claims: Vec<ClaimedMark>,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let mut unreleased = Ok(());
        for mark in claims {
            let released = match mark {
                ClaimedMark::Approval(id) => self.deps.kept_approvals.release_continue(id).await,
                ClaimedMark::Question(id) => self.deps.kept_questions.release_continue(id).await,
            };
            match released {
                Err(error) if unreleased.is_err() => log_unreleased_mark(mark, &*error),
                Err(error) => unreleased = Err(error),
                Ok(()) => {}
            }
        }
        unreleased
    }

    async fn claim_mark(&self, mark: ClaimedMark) -> Result<bool, Box<dyn Error + Send + Sync>> {
        match mark {
            ClaimedMark::Approval(id) => self.deps.kept_approvals.claim_continue(id).await,
            ClaimedMark::Question(id) => self.deps.kept_questions.claim_continue(id).await,
        }
    }
}

// Logs a continue mark that could not be given back after an earlier one already failed the
// give-back, so the next relaunch will not carry its answer.
fn log_unreleased_mark(mark: ClaimedMark, error: &(dyn Error + 'static)) {
    match mark {
        ClaimedMark::Approval(id) => tracing::error!(
            approval_request_id = %id,
            error,
            "a kept approval's continue mark could not be given back"
        ),
        ClaimedMark::Question(id) => tracing::error!(
            question_id = %id,
            error,
            "a kept question's continue mark could not be given back"
        ),
    }
}
