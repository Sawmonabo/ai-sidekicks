//! The person's turn a held question's answer writes: one line per question, in the record's order,
//! each the answer's own words. The question's text is not repeated, since the transcript draws it
//! from the turn's `answersQuestionId`, and a secret reads only as answered.

use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_contracts::wire::text::NonEmptyText;

/// The line a secret answer writes, its value never stored.
const SECRET_ANSWER_LINE: &str = "Answered (secret)";

/// The line a skipped question writes.
const SKIPPED_ANSWER_LINE: &str = "Skipped";

/// The person's turn for `answers`: the picked labels joined with `", "`, the typed text,
/// `Skipped` or `Answered (secret)`, one line each.
pub(crate) fn compose_answer_text(answers: &[QuestionAnswer]) -> String {
    answers
        .iter()
        .map(|answer| match answer {
            QuestionAnswer::Picked { labels } => labels
                .as_slice()
                .iter()
                .map(NonEmptyText::as_str)
                .collect::<Vec<_>>()
                .join(", "),
            QuestionAnswer::Typed { text } => text.as_str().to_owned(),
            QuestionAnswer::Secret { .. } => SECRET_ANSWER_LINE.to_owned(),
            QuestionAnswer::Skipped {} => SKIPPED_ANSWER_LINE.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}
