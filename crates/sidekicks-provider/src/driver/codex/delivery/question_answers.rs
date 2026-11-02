//! The questions card's answers as Codex's `item/tool/requestUserInput` reads them: each shown
//! question's picked or typed texts under its own id.

use serde_json::{Map, Value, json};
use sidekicks_contracts::question::QuestionAnswer;

use crate::driver::codex::delivery::asks::questions::read_codex_user_input_questions;
use crate::driver::question_answers::read_question_answer_texts;

/// A user-input request's `answers`, keyed by the id of each question the card showed and paired
/// with `answers` in the card's order; a skipped question is an empty list under its id, as Codex's
/// own terminal sends one.
pub(crate) fn compose_codex_user_input_answers(
    params: &Value,
    answers: &[QuestionAnswer],
) -> Map<String, Value> {
    read_codex_user_input_questions(params)
        .enumerate()
        .map(|(index, question)| {
            let texts = read_question_answer_texts(answers.get(index));
            (question.id.to_owned(), json!({ "answers": texts }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sidekicks_contracts::question::QuestionAnswer;
    use sidekicks_contracts::wire::list::BoundedVec;
    use sidekicks_contracts::wire::text::NonEmptyText;

    use super::compose_codex_user_input_answers;

    fn text(words: &str) -> NonEmptyText {
        NonEmptyText::new(words.to_owned()).unwrap()
    }

    // Kills: a skipped question's key left out.
    #[test]
    fn a_skipped_question_is_answered_with_an_empty_list_under_its_id() {
        let params = json!({"questions": [
            {"id": "name", "question": "Which name?"},
            {"id": "color", "question": "Which color?"},
            {"id": "sizes", "question": "Which sizes?"},
        ]});
        let answers = [
            QuestionAnswer::Typed { text: text("Ada") },
            QuestionAnswer::Skipped {},
            QuestionAnswer::Picked {
                labels: BoundedVec::new(vec![text("small"), text("large")]).unwrap(),
            },
        ];

        assert_eq!(
            serde_json::Value::Object(compose_codex_user_input_answers(&params, &answers)),
            json!({
                "name": {"answers": ["Ada"]},
                "color": {"answers": []},
                "sizes": {"answers": ["small", "large"]}
            })
        );
    }

    // The card never shows a question with no text, so its first answer is the second question's.
    // Kills: the answers paired with the raw list's index.
    #[test]
    fn a_question_left_off_the_card_moves_no_answer_onto_another_id() {
        let params = json!({"questions": [
            {"id": "untitled", "question": ""},
            {"id": "color", "question": "Which color?"},
        ]});
        let answers = [QuestionAnswer::Typed { text: text("blue") }];

        assert_eq!(
            serde_json::Value::Object(compose_codex_user_input_answers(&params, &answers)),
            json!({"color": {"answers": ["blue"]}})
        );
    }
}
