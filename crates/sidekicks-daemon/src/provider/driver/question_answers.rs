//! The texts a questions card's answer gives, which every driver composes into its provider's own
//! answer shape.

use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_contracts::wire::text::NonEmptyText;

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
