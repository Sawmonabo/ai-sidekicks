//! The texts a questions card's answer gives, which every driver composes into its provider's own
//! answer shape, and the reason a driver refuses a question the card could not show.

use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_contracts::wire::text::NonEmptyText;

/// Why a question the questions card could not show is refused at its provider, which the agent
/// reads in place of an answer.
pub(crate) const QUESTION_UNSHOWN_REASON: &str =
    "The question could not be shown to the person, so it was not answered.";

/// The texts one answer gives: the labels picked, the text typed or the secret; none if skipped
/// or absent.
pub(crate) fn read_question_answer_texts(answer: Option<&QuestionAnswer>) -> Vec<&str> {
    match answer {
        Some(QuestionAnswer::Picked { labels }) => {
            labels.as_slice().iter().map(NonEmptyText::as_str).collect()
        }
        Some(QuestionAnswer::Typed { text }) => vec![text.as_str()],
        Some(QuestionAnswer::Secret { value }) => vec![value.as_str()],
        Some(QuestionAnswer::Skipped {}) | None => Vec::new(),
    }
}
