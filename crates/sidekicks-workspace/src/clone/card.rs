//! Each project's clone card while someone follows it or git runs for it: the status its readers
//! last heard, the gate that lets four updates through a second, and the git run it follows with
//! that run's progress and the questions git waits on. A card with no reader and nothing running
//! is dropped and read again from the project's record when next opened.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::clone::{
    AskpassAnswer, CloneLine, CloneQuestionId, PROJECT_CLONE_LINE_MAX_LEN, ProjectCloneFailedStep,
    ProjectCloneProgress, ProjectCloneQuestion, ProjectCloneStatus,
};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_ipc::stream::latest_value::{
    LatestValueOutlet, LatestValueOutletId, LatestValueOutlets,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::text_cut::cut_to_code_points;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::clone::askpass::broker::AskpassQuestion;
use crate::clone::progress::LatestUpdateGate;
use crate::schema::CloneOutcome;

/// The git run a card follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ActivityStep {
    /// The clone itself.
    Clone,
    /// A large-files pull after it.
    LargeFiles,
}

/// One git run a card follows: its stop, its latest progress, the questions git waits on, and the
/// token cancelled once the run has ended and its last status is set.
pub(crate) struct CloneActivity {
    step: ActivityStep,
    // Cancelled by the person's cancel alone; the service's stop has a token of its own.
    cancel: CancellationToken,
    progress: Option<ProjectCloneProgress>,
    questions: Vec<WaitingQuestion>,
    ended: CancellationToken,
}

impl CloneActivity {
    /// A run of `step` that has not begun, with its cancel and the token its end cancels.
    pub(crate) fn new(step: ActivityStep) -> Self {
        Self {
            step,
            cancel: CancellationToken::new(),
            progress: None,
            questions: Vec::new(),
            ended: CancellationToken::new(),
        }
    }

    /// The token the person's cancel cancels.
    pub(crate) fn cancel(&self) -> &CancellationToken {
        &self.cancel
    }

    /// The token cancelled once the run has ended and its card holds its last status.
    pub(crate) fn ended(&self) -> &CancellationToken {
        &self.ended
    }
}

// A question git waits on, and where its answer goes.
struct WaitingQuestion {
    question_id: CloneQuestionId,
    prompt: CloneLine,
    is_masked: bool,
    answer: oneshot::Sender<AskpassAnswer>,
}

// One project's card.
struct CloneCard {
    status: ProjectCloneStatus,
    // Shared with the gate's task, which sends each update it lets through to every reader.
    outlets: Arc<Mutex<LatestValueOutlets<ProjectCloneStatus>>>,
    gate: LatestUpdateGate<ProjectCloneStatus>,
    activity: Option<CloneActivity>,
    // The clone's destination as folders compare, while a clone runs.
    destination_key: Option<PathBuf>,
}

impl CloneCard {
    // A card standing at `status`, with no reader and nothing running.
    fn new(status: ProjectCloneStatus) -> Self {
        let outlets = Arc::new(Mutex::new(LatestValueOutlets::default()));
        let gate = {
            let outlets = Arc::clone(&outlets);
            LatestUpdateGate::new(move |update: ProjectCloneStatus| lock(&outlets).send(&update))
        };
        Self {
            status,
            outlets,
            gate,
            activity: None,
            destination_key: None,
        }
    }

    fn publish(&mut self, status: ProjectCloneStatus) {
        self.status = status.clone();
        self.gate.offer(status);
    }

    // The status of the run going on: its progress and the first question git waits on.
    fn publish_activity(&mut self, project_id: ProjectId) {
        let Some(activity) = &self.activity else {
            return;
        };
        let progress = activity.progress.clone();
        let question = activity
            .questions
            .first()
            .map(|waiting| ProjectCloneQuestion {
                question_id: waiting.question_id,
                prompt: waiting.prompt.clone(),
                masked: waiting.is_masked,
            });
        let status = match activity.step {
            ActivityStep::Clone => ProjectCloneStatus::Cloning {
                project_id,
                progress,
                question,
            },
            ActivityStep::LargeFiles => ProjectCloneStatus::PullingLargeFiles {
                project_id,
                progress,
                question,
            },
        };
        self.publish(status);
    }

    fn is_idle(&self) -> bool {
        self.activity.is_none() && lock(&self.outlets).is_empty()
    }
}

/// Every open clone card, by project. The lock is never held across an await.
#[derive(Default)]
pub(crate) struct CloneCards {
    cards: Mutex<HashMap<ProjectId, CloneCard>>,
}

impl CloneCards {
    fn cards(&self) -> MutexGuard<'_, HashMap<ProjectId, CloneCard>> {
        lock(&self.cards)
    }

    /// Whether a clone or a pull runs for the project.
    pub(crate) fn is_running(&self, project_id: ProjectId) -> bool {
        self.cards()
            .get(&project_id)
            .is_some_and(|card| card.activity.is_some())
    }

    /// Whether a running clone fills the destination whose comparison key is `destination_key`.
    pub(crate) fn is_filled_by_running_clone(&self, destination_key: &Path) -> bool {
        self.cards()
            .values()
            .any(|card| card.destination_key.as_deref() == Some(destination_key))
    }

    /// Opens a card for `outlet`'s reader, made at `status` read from the record when none is
    /// open, sends the card's status to the reader now and keeps the reader for every update after;
    /// answers the id its detach takes. Hands `outlet` back, opening nothing, when no card is open
    /// and `status` reads cloning: the run it was read from has ended since, its card dropped, so
    /// the record is to be read again.
    pub(crate) fn attach(
        &self,
        project_id: ProjectId,
        status: ProjectCloneStatus,
        outlet: LatestValueOutlet<ProjectCloneStatus>,
    ) -> Result<LatestValueOutletId, LatestValueOutlet<ProjectCloneStatus>> {
        let mut cards = self.cards();
        if !cards.contains_key(&project_id) && matches!(status, ProjectCloneStatus::Cloning { .. })
        {
            return Err(outlet);
        }
        Ok(attach_to_card(&mut cards, project_id, status, outlet))
    }

    /// Opens a card for `outlet`'s reader as [`attach`](Self::attach) does, made at `status`
    /// whatever it reads when none is open.
    pub(crate) fn attach_at(
        &self,
        project_id: ProjectId,
        status: ProjectCloneStatus,
        outlet: LatestValueOutlet<ProjectCloneStatus>,
    ) -> LatestValueOutletId {
        attach_to_card(&mut self.cards(), project_id, status, outlet)
    }

    /// Lets one reader go, dropping the card once it has no reader and nothing running.
    pub(crate) fn detach(&self, project_id: ProjectId, outlet_id: LatestValueOutletId) {
        let mut cards = self.cards();
        if let Some(card) = cards.get(&project_id) {
            lock(&card.outlets).detach(outlet_id);
        }
        drop_if_idle(&mut cards, project_id);
    }

    /// Begins `activity` on the project's card, opening one when none is, with the clone's
    /// destination key while a clone runs; answers false, beginning nothing, when a run is going
    /// on already.
    pub(crate) fn begin(
        &self,
        project_id: ProjectId,
        activity: CloneActivity,
        destination_key: Option<PathBuf>,
    ) -> bool {
        let mut cards = self.cards();
        let card = cards
            .entry(project_id)
            .or_insert_with(|| CloneCard::new(ProjectCloneStatus::Done { project_id }));
        if card.activity.is_some() {
            return false;
        }
        card.activity = Some(activity);
        card.destination_key = destination_key;
        card.publish_activity(project_id);
        true
    }

    /// Ends the run on the project's card at `status`, dropping the card when no one reads it.
    pub(crate) fn end(&self, project_id: ProjectId, status: ProjectCloneStatus) {
        let mut cards = self.cards();
        if let Some(card) = cards.get_mut(&project_id) {
            card.activity = None;
            card.destination_key = None;
            card.publish(status);
        }
        drop_if_idle(&mut cards, project_id);
    }

    /// Sets `status` on the project's card while nothing runs on it, dropping the card when no one
    /// reads it.
    pub(crate) fn publish_idle(&self, project_id: ProjectId, status: ProjectCloneStatus) {
        let mut cards = self.cards();
        if let Some(card) = cards.get_mut(&project_id)
            && card.activity.is_none()
        {
            card.publish(status);
        }
        drop_if_idle(&mut cards, project_id);
    }

    /// Cancels the run on the project's card and answers its end token; `None` when nothing runs.
    pub(crate) fn cancel(&self, project_id: ProjectId) -> Option<CancellationToken> {
        let cards = self.cards();
        let activity = cards.get(&project_id)?.activity.as_ref()?;
        activity.cancel.cancel();
        Some(activity.ended.clone())
    }

    /// Puts git's newest progress on the project's card.
    pub(crate) fn set_progress(&self, project_id: ProjectId, progress: ProjectCloneProgress) {
        let mut cards = self.cards();
        if let Some(card) = cards.get_mut(&project_id)
            && let Some(activity) = &mut card.activity
        {
            activity.progress = Some(progress);
            card.publish_activity(project_id);
        }
    }

    /// Puts git's `question` on the project's card until it is answered or git stops waiting, and
    /// answers the person's answer; `None`, so git gives up on it, for a question with no words,
    /// one asked with nothing running, and one git stopped waiting on.
    pub(crate) async fn ask(
        &self,
        project_id: ProjectId,
        question: AskpassQuestion,
    ) -> Option<AskpassAnswer> {
        let prompt = clone_line(&question.prompt)?;
        let question_id =
            CloneQuestionId::try_from(mint_uuid_v7()).expect("a minted UUID is a question id");
        let (answer, answered) = oneshot::channel();
        {
            let mut cards = self.cards();
            let card = cards.get_mut(&project_id)?;
            card.activity.as_mut()?.questions.push(WaitingQuestion {
                question_id,
                prompt,
                is_masked: question.is_masked,
                answer,
            });
            card.publish_activity(project_id);
        }
        let answer = tokio::select! {
            answer = answered => answer.ok(),
            () = question.cancel.cancelled() => None,
        };
        // A question answered is taken off the card by the answer; one git gave up on is taken
        // off here.
        self.take_question(project_id, question_id);
        answer
    }

    /// Hands `answer` to the question `question_id` the project's card waits on; answers false,
    /// taking nothing, when no such question waits.
    pub(crate) fn answer(
        &self,
        project_id: ProjectId,
        question_id: CloneQuestionId,
        answer: AskpassAnswer,
    ) -> bool {
        let Some(waiting) = self.take_question(project_id, question_id) else {
            return false;
        };
        // git may stop waiting as the answer arrives, which takes nothing.
        drop(waiting.answer.send(answer));
        true
    }

    /// Ends every card for the service's stop: no gate sends again and every reader's stream ends.
    pub(crate) fn close(&self) {
        let cards = std::mem::take(&mut *self.cards());
        for card in cards.into_values() {
            card.gate.close();
        }
    }

    // Takes the question off the project's card and tells its readers.
    fn take_question(
        &self,
        project_id: ProjectId,
        question_id: CloneQuestionId,
    ) -> Option<WaitingQuestion> {
        let mut cards = self.cards();
        let card = cards.get_mut(&project_id)?;
        let questions = &mut card.activity.as_mut()?.questions;
        let index = questions
            .iter()
            .position(|waiting| waiting.question_id == question_id)?;
        let waiting = questions.remove(index);
        card.publish_activity(project_id);
        Some(waiting)
    }
}

// Keeps `outlet`'s reader on the project's card, made at `status` when none is open, and sends it
// the card's status now.
fn attach_to_card(
    cards: &mut HashMap<ProjectId, CloneCard>,
    project_id: ProjectId,
    status: ProjectCloneStatus,
    outlet: LatestValueOutlet<ProjectCloneStatus>,
) -> LatestValueOutletId {
    let card = cards
        .entry(project_id)
        .or_insert_with(|| CloneCard::new(status));
    outlet.send(card.status.clone());
    lock(&card.outlets).attach(outlet)
}

// Drops the project's card once it has no reader and nothing running, ending its gate.
fn drop_if_idle(cards: &mut HashMap<ProjectId, CloneCard>, project_id: ProjectId) {
    if cards.get(&project_id).is_some_and(CloneCard::is_idle)
        && let Some(card) = cards.remove(&project_id)
    {
        card.gate.close();
    }
}

/// `text` as a line of the card: NULs dropped and cut to [`PROJECT_CLONE_LINE_MAX_LEN`] code
/// points; `None` when nothing but space is left.
pub(crate) fn clone_line(text: &str) -> Option<CloneLine> {
    let text = text.replace('\0', "");
    CloneLine::new(cut_to_code_points(&text, PROJECT_CLONE_LINE_MAX_LEN).to_owned()).ok()
}

/// The card a clone's recorded outcome reads as: running is cloning, a restart's cut is a clone
/// failure with no line of git's.
pub(crate) fn status_of_outcome(
    project_id: ProjectId,
    outcome: CloneOutcome,
    failure: Option<&str>,
) -> ProjectCloneStatus {
    match outcome {
        CloneOutcome::Running => ProjectCloneStatus::Cloning {
            project_id,
            progress: None,
            question: None,
        },
        CloneOutcome::Canceled => ProjectCloneStatus::Canceled { project_id },
        CloneOutcome::Failed => ProjectCloneStatus::Failed {
            project_id,
            step: ProjectCloneFailedStep::Clone,
            failure_line: failure.and_then(clone_line),
        },
        CloneOutcome::Interrupted => ProjectCloneStatus::Failed {
            project_id,
            step: ProjectCloneFailedStep::Clone,
            failure_line: None,
        },
    }
}
