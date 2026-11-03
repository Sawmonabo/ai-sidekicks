//! The answer's continue: what a resume carries to continue a lead the daemon's restart held on
//! the person, once every answer it waited on, its own or a helper's beneath it, was given, and
//! the one text each driver sends the lead for it.

use jiff::Timestamp;
use sidekicks_contracts::approval::{ApprovalDecision, ApprovalRequestId};
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;

use crate::driver::idle_sleep::KeptSchedule;

/// A held lead's continue: the lead, what was asked and answered while no process held the
/// session, and the timed fires that came due meanwhile and never ran.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldRunContinue {
    /// The lead run the continue goes to.
    pub lead_run_id: RunId,
    /// What the lead and the helpers beneath it were answered, oldest first; never empty.
    pub entries: Vec<ContinueEntry>,
    /// The session's timed fires whose time passed while the lead was held.
    pub missed_fires: Vec<KeptSchedule>,
}

impl HeldRunContinue {
    /// The continue of `lead_run_id` with `entries`, naming each of the session's
    /// `kept_schedules` whose fire is already past now: a single fire, or a recurring job's next
    /// run as the provider last said it.
    pub fn new(
        lead_run_id: RunId,
        entries: Vec<ContinueEntry>,
        kept_schedules: &[KeptSchedule],
    ) -> Self {
        let now = Timestamp::now();
        let missed_fires = kept_schedules
            .iter()
            .filter(|schedule| match schedule {
                KeptSchedule::Once { fires_at } => *fires_at <= now,
                KeptSchedule::Recurring { next_fire_at, .. } => {
                    next_fire_at.is_some_and(|fire_at| fire_at <= now)
                }
            })
            .cloned()
            .collect();
        Self {
            lead_run_id,
            entries,
            missed_fires,
        }
    }
}

/// One answer a held lead's continue carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContinueEntry {
    /// The run that asked: the lead, or a helper beneath it.
    pub run_id: RunId,
    /// The provider's own id of the helper that asked; `None` for the lead.
    pub subagent_id: Option<SubagentId>,
    /// What was asked and what the person answered.
    pub answer: ContinueAnswer,
}

/// What a held run was asked and answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContinueAnswer {
    /// A card the run raised and the person's answer to it.
    Approval {
        /// The card.
        approval_request_id: ApprovalRequestId,
        /// The words the card named, such as the command.
        subject: String,
        /// The tool the card held a call of, where it named one.
        tool_name: Option<String>,
        /// The person's answer.
        decision: ApprovalDecision,
        /// The `why not` words of a decline that carried any.
        decline_reason: Option<String>,
        /// The command or path as the person corrected it, on an approval that corrected one.
        edited_action: Option<String>,
    },
    /// A question the run asked and the person's answer, a secret read only as answered.
    Question {
        /// The question.
        question_id: QuestionId,
        /// The question's pages, one line each.
        question: String,
        /// The answers, one line each.
        answer: String,
    },
    /// A paused helper the person continued, with the words that waited for it.
    HelperContinued {
        /// The waiting messages' words, each file a line naming its path; `None` with none.
        words: Option<String>,
    },
}

/// The text a driver sends the held lead to continue it: one line naming what was asked and the
/// answer for each entry, a helper's entry closed by `ask_helper_again`, the driver's own sentence
/// asking the lead to continue that helper, and one line for each timed fire that never ran.
pub fn compose_continuation_text(
    held_run_continue: &HeldRunContinue,
    ask_helper_again: impl Fn(&SubagentId) -> String,
) -> String {
    let mut lines =
        vec!["While the app restarted, the person answered what you were waiting on:".to_owned()];
    for entry in &held_run_continue.entries {
        let asker = entry.subagent_id.as_ref().map_or_else(
            || "You".to_owned(),
            |subagent_id| format!("Your helper {}", subagent_id.as_str()),
        );
        let mut line = match &entry.answer {
            ContinueAnswer::Approval {
                subject,
                tool_name,
                decision,
                decline_reason,
                edited_action,
                ..
            } => {
                let asked = tool_name.as_ref().map_or_else(
                    || one_line(subject),
                    |tool_name| format!("{tool_name}: {}", one_line(subject)),
                );
                let answered = match decision {
                    ApprovalDecision::Approved => edited_action.as_ref().map_or_else(
                        || "approved it".to_owned(),
                        |edited| format!("approved it, changed to: {}", one_line(edited)),
                    ),
                    ApprovalDecision::Rejected => decline_reason.as_ref().map_or_else(
                        || "declined it".to_owned(),
                        |reason| format!("declined it: {}", one_line(reason)),
                    ),
                };
                format!("{asker} asked to approve {asked}. The person {answered}.")
            }
            ContinueAnswer::Question {
                question, answer, ..
            } => format!(
                "{asker} asked: {}. The person answered: {}.",
                one_line(question),
                one_line(answer)
            ),
            ContinueAnswer::HelperContinued { words } => words.as_ref().map_or_else(
                || format!("{asker} was paused, and the person continued it."),
                |words| {
                    format!(
                        "{asker} was paused, and the person continued it with: {}.",
                        one_line(words)
                    )
                },
            ),
        };
        if let Some(subagent_id) = &entry.subagent_id {
            line.push(' ');
            line.push_str(&ask_helper_again(subagent_id));
        }
        lines.push(line);
    }
    for fire in &held_run_continue.missed_fires {
        lines.push(match fire {
            KeptSchedule::Once { fires_at } => {
                format!("A scheduled run due at {fires_at} did not run while you waited.")
            }
            KeptSchedule::Recurring { cron, next_fire_at } => next_fire_at.map_or_else(
                || format!("A run of the schedule {cron} did not run while you waited."),
                |fire_at| {
                    format!(
                        "A run of the schedule {cron} due at {fire_at} did not run while you \
                         waited."
                    )
                },
            ),
        });
    }
    lines.join("\n")
}

// `text` on one line, its lines joined with "; ".
fn one_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("; ")
}
