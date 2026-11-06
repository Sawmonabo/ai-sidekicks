//! The held lead's continue a relaunch carries: composed from the answers the person gave while
//! the daemon's restart held the session's lead, the lead's own and those of the helpers beneath
//! it, and from each paused run the person continued, each helper beneath it and the lead itself,
//! with the words its kept messages make, once no answer is still owed it, each answer's continue
//! mark claimed before the driver is called and given back when the driver fails or defers, or
//! later tells the queue it did not carry the continue, so the next relaunch carries it again.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt;
use std::sync::Weak;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use jiff::Timestamp;
use sidekicks_approval::service::ApprovalService;
use sidekicks_contracts::approval::ApprovalRequestId;
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::idle_sleep::KeptSchedule;
use sidekicks_provider::driver::ports::ContinueGivenBackListener;
use sidekicks_provider::driver::session_control::LiveRunResume;
use sidekicks_provider::driver::session_control::held_run_continue::{
    ContinueAnswer, ContinueEntry, HeldRunContinue,
};
use sidekicks_session::questions::service::QuestionsService;
use sidekicks_session::run::pause::owes_continuation;
use sidekicks_session::run::read::RunStateReader;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::ReadLength;
use tokio_util::task::TaskTracker;

use crate::provider_session::ProviderSessions;
use crate::provider_session::errors::ProviderSessionError;

/// What an orphaned answers' read or write answers, or the error it failed with.
pub type OrphanedAnswerFuture<'a, T> = BoxFuture<'a, Result<T, Box<dyn Error + Send + Sync>>>;

/// An orphaned answer, given while no process held the session, which the held lead's continue
/// owes the run that asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwedAnswer<Id> {
    /// The card or question it answers, by which its continue mark is claimed.
    pub id: Id,
    /// The run that asked.
    pub run_id: RunId,
    /// What was asked and answered.
    pub answer: ContinueAnswer,
}

/// Where a session's orphaned answers of one kind are read for its continue and their continue
/// marks claimed: the approval cards' or the questions'.
pub trait OrphanedAnswerSource<Id>: Send + Sync {
    /// The session's answers no continue and no call made again took yet, oldest first. Fails as
    /// the read fails.
    fn owed_continues(
        &self,
        session_id: SessionId,
    ) -> OrphanedAnswerFuture<'_, Vec<OwedAnswer<Id>>>;

    /// Claims `id`'s continue mark: true for the one caller that takes it, false once another
    /// took it. Fails as the claim's write fails.
    fn claim_continue(&self, id: Id) -> OrphanedAnswerFuture<'_, bool>;

    /// Gives `id`'s continue mark back, so the next continue takes it. Fails as the write fails.
    fn release_continue(&self, id: Id) -> OrphanedAnswerFuture<'_, ()>;

    /// Whether `run_id` holds an ask of this kind the person has not answered yet. Fails as the
    /// read fails.
    fn has_open_ask(&self, run_id: RunId) -> OrphanedAnswerFuture<'_, bool>;
}

impl OrphanedAnswerSource<ApprovalRequestId> for ApprovalService {
    fn owed_continues(
        &self,
        session_id: SessionId,
    ) -> OrphanedAnswerFuture<'_, Vec<OwedAnswer<ApprovalRequestId>>> {
        async move {
            let owed = self.orphaned_answers().owed_continues(session_id).await?;
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

    fn claim_continue(&self, id: ApprovalRequestId) -> OrphanedAnswerFuture<'_, bool> {
        async move { Ok(self.orphaned_answers().claim_continue(id).await?) }.boxed()
    }

    fn release_continue(&self, id: ApprovalRequestId) -> OrphanedAnswerFuture<'_, ()> {
        async move { Ok(self.orphaned_answers().release_continue(id).await?) }.boxed()
    }

    fn has_open_ask(&self, run_id: RunId) -> OrphanedAnswerFuture<'_, bool> {
        async move { Ok(self.has_pending_ask(run_id).await?) }.boxed()
    }
}

impl OrphanedAnswerSource<QuestionId> for QuestionsService {
    fn owed_continues(
        &self,
        session_id: SessionId,
    ) -> OrphanedAnswerFuture<'_, Vec<OwedAnswer<QuestionId>>> {
        async move {
            let owed = QuestionsService::owed_continues(self, session_id).await?;
            Ok(owed
                .into_iter()
                .map(|orphaned| OwedAnswer {
                    id: orphaned.question_id,
                    run_id: orphaned.run_id,
                    answer: ContinueAnswer::Question {
                        question_id: orphaned.question_id,
                        question: orphaned.question,
                        answer: orphaned.answer,
                    },
                })
                .collect())
        }
        .boxed()
    }

    fn claim_continue(&self, id: QuestionId) -> OrphanedAnswerFuture<'_, bool> {
        async move { Ok(QuestionsService::claim_continue(self, id).await?) }.boxed()
    }

    fn release_continue(&self, id: QuestionId) -> OrphanedAnswerFuture<'_, ()> {
        async move { Ok(QuestionsService::release_continue(self, id).await?) }.boxed()
    }

    fn has_open_ask(&self, run_id: RunId) -> OrphanedAnswerFuture<'_, bool> {
        async move { Ok(self.has_open_question(run_id).await?) }.boxed()
    }
}

/// The messages a paused run's continue kept for its held lead's continue, and the words they
/// make, each file a line naming its path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct KeptWords {
    /// The kept messages, delivered with their run once a continue carried their words.
    pub(crate) message_ids: Vec<QueueItemId>,
    /// The words they make.
    pub(crate) words: String,
}

/// Delivers a paused run's kept messages once its held lead's continue carried their words, under
/// the session's transition lock alone, before the runs the resume named are settled.
pub(crate) trait KeptMessages: Send + Sync {
    /// Delivers each of `message_ids` still waiting with `run_id`. Fails as a read or record
    /// fails.
    fn deliver_carried(
        &self,
        run_id: RunId,
        message_ids: Vec<QueueItemId>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}

/// What a continue of the person's carries for the paused runs they continued, the held lead or a
/// helper beneath it: each run's kept words, as the queue read them before the continue, and where
/// their messages are delivered once it carried them.
pub(crate) struct ContinuedWords<'a> {
    /// Each paused run's kept words, by its run; a run with none waiting has no entry.
    pub(crate) kept: HashMap<RunId, KeptWords>,
    /// Delivers the kept messages of the runs a continue carried.
    pub(crate) messages: &'a dyn KeptMessages,
}

// One continue mark a relaunch claimed.
#[derive(Clone, Copy, Debug)]
pub(super) enum ClaimedMark {
    Approval(ApprovalRequestId),
    Question(QuestionId),
}

/// The continue a relaunch claimed for the held lead, the marks it claimed, the runs waiting on
/// the person, every ask of theirs answered, that it continues, each beside the wait it leaves,
/// and the kept messages of each continued run whose words it carries.
#[derive(Default)]
pub(super) struct ClaimedContinue {
    pub(super) held_run_continue: Option<HeldRunContinue>,
    pub(super) claims: Vec<ClaimedMark>,
    pub(super) answered_runs: Vec<(RunId, RunState)>,
    pub(super) continued_messages: Vec<(RunId, Vec<QueueItemId>)>,
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
    /// settled or handed another lead is left. Fails naming every mark not given back.
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

    // The continue `live_runs`' lead is owed, every answer's mark claimed for this relaunch: none
    // where no lead starts, runs or waits, the lead is still held on the person, or nothing is owed
    // it. A run waiting on the person whose every ask is answered, an answer of its owed, counts as
    // running: the continue carries it on, and `live_runs` names it running where a continue was
    // claimed. An answer of a run outside the lead and its helpers is left out, as is one another
    // relaunch claimed first; a failed claim gives back the marks claimed before it. Given
    // `continued_words`, each paused run the person continued while the lead was held, each helper
    // beneath it and then the lead itself (running, no turn open, its newest turn end the cut or
    // its messages kept), is owed too, with its kept words.
    pub(super) async fn claim_held_run_continue(
        &self,
        session_id: SessionId,
        live_runs: &mut [LiveRunResume],
        kept_schedules: &[KeptSchedule],
        continued_words: Option<&ContinuedWords<'_>>,
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
        let orphaned_answers = |cause| ProviderSessionError::OrphanedAnswers { session_id, cause };
        let approvals = self
            .deps
            .orphaned_approvals
            .owed_continues(session_id)
            .await
            .map_err(orphaned_answers)?;
        let questions = self
            .deps
            .orphaned_questions
            .owed_continues(session_id)
            .await
            .map_err(orphaned_answers)?;
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
                    let failed = ProviderSessionError::OrphanedAnswers { session_id, cause };
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
        let mut continued_messages = Vec::new();
        if let Some(continued_words) = continued_words {
            let continued = self
                .continued_paused_runs(lead, &continued_runs, &answered_runs, &continued_words.kept)
                .await?;
            for (run_id, subagent_id) in continued {
                let kept = continued_words.kept.get(&run_id);
                if let Some(kept) = kept {
                    continued_messages.push((run_id, kept.message_ids.clone()));
                }
                entries.push(ContinueEntry {
                    run_id,
                    subagent_id,
                    answer: ContinueAnswer::Continued {
                        words: kept.map(|kept| kept.words.clone()),
                    },
                });
            }
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
            continued_messages,
        })
    }

    // Each paused run the person continued while the restart held `lead`, the lead itself or a
    // helper beneath it, with its helper's id, `None` for the lead, which comes last: running with
    // no turn open and no answer of `answered_runs` carrying it on, and owed the continue, its
    // newest turn end the restart's cut or its waiting messages kept in `kept`. Fails as the read
    // fails.
    async fn continued_paused_runs(
        &self,
        lead: &LiveRunResume,
        live_runs: &[LiveRunResume],
        answered_runs: &[(RunId, RunState)],
        kept: &HashMap<RunId, KeptWords>,
    ) -> Result<Vec<(RunId, Option<SubagentId>)>, ProviderSessionError> {
        let mut candidates: Vec<(RunId, Option<SubagentId>, bool)> = live_runs
            .iter()
            .filter(|run| {
                !run.is_stopping
                    && run.run_state == RunState::Running
                    && run.open_turns.is_empty()
                    && !answered_runs
                        .iter()
                        .any(|(run_id, _)| *run_id == run.run_id)
            })
            .filter_map(|run| {
                let subagent_id = if run.run_id == lead.run_id {
                    None
                } else if lead.is_above(run, live_runs) {
                    Some(run.subagent_id.clone()?)
                } else {
                    return None;
                };
                Some((run.run_id, subagent_id, kept.contains_key(&run.run_id)))
            })
            .collect();
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        // The helpers' words first, then the lead's own.
        candidates.sort_by_key(|(_, subagent_id, _)| subagent_id.is_none());
        self.deps
            .pool
            .read(ReadLength::Short, move |reader| {
                let mut continued = Vec::new();
                for (run_id, subagent_id, is_kept) in candidates {
                    if is_kept || owes_continuation(reader, &run_id)? {
                        continued.push((run_id, subagent_id));
                    }
                }
                Ok::<_, ProviderSessionError>(continued)
            })
            .await
    }

    /// The lead of `session_id` a person's continue moved to `running` while the restart held it:
    /// a live lead read `running` with no turn open and no stop, or `None` with none. Read only
    /// while no process holds the session, where no other lead reads so. Fails as the read fails.
    pub(crate) async fn read_held_continued_lead(
        &self,
        session_id: SessionId,
    ) -> Result<Option<RunId>, ProviderSessionError> {
        self.deps
            .pool
            .read(ReadLength::Short, move |reader| {
                let live_runs = RunStateReader::new(reader).list_live_run_resumes(&session_id)?;
                Ok::<_, ProviderSessionError>(
                    live_runs
                        .iter()
                        .find(|run| {
                            run.is_lead()
                                && !run.is_stopping
                                && run.run_state == RunState::Running
                                && run.open_turns.is_empty()
                        })
                        .map(|run| run.run_id),
                )
            })
            .await
    }

    /// Whether `run_id` waits on an ask of its own the person has not answered, a card or a
    /// question; a helper's ask beneath it is the helper's. Fails as either read fails.
    pub(crate) async fn has_open_ask(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<bool, ProviderSessionError> {
        let orphaned_answers = |cause| ProviderSessionError::OrphanedAnswers { session_id, cause };
        Ok(self
            .deps
            .orphaned_approvals
            .has_open_ask(run_id)
            .await
            .map_err(orphaned_answers)?
            || self
                .deps
                .orphaned_questions
                .has_open_ask(run_id)
                .await
                .map_err(orphaned_answers)?)
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
                ClaimedMark::Approval(id) => {
                    self.deps.orphaned_approvals.release_continue(id).await
                }
                ClaimedMark::Question(id) => {
                    self.deps.orphaned_questions.release_continue(id).await
                }
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
            ClaimedMark::Approval(id) => self.deps.orphaned_approvals.claim_continue(id).await,
            ClaimedMark::Question(id) => self.deps.orphaned_questions.claim_continue(id).await,
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
