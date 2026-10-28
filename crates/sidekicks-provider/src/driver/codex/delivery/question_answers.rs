//! The questions card's answers as Codex's `item/tool/requestUserInput` reads them: each
//! question's picked or typed texts under its own id.

use serde_json::{Map, Value, json};
use sidekicks_contracts::question::QuestionAnswer;

use crate::driver::question_answers::read_question_answer_texts;

/// A user-input request's `answers`, keyed by each question's own id and paired with `answers` in
/// the order the questions were asked; a skipped question has no key, which Codex reads as
/// unanswered.
pub(crate) fn compose_codex_user_input_answers(
    params: &Value,
    answers: &[QuestionAnswer],
) -> Map<String, Value> {
    let mut composed = Map::new();
    let Some(questions) = params.get("questions").and_then(Value::as_array) else {
        return composed;
    };
    for (index, question) in questions.iter().enumerate() {
        let Some(question_id) = question.get("id").and_then(Value::as_str) else {
            continue;
        };
        let texts = read_question_answer_texts(answers.get(index));
        if !texts.is_empty() {
            composed.insert(question_id.to_owned(), json!({ "answers": texts }));
        }
    }
    composed
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

    #[test]
    fn keys_each_answer_by_its_question_id_and_leaves_a_skipped_one_out() {
        let params = json!({"questions": [{"id": "name"}, {"id": "color"}, {"id": "sizes"}]});
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
                "sizes": {"answers": ["small", "large"]}
            })
        );
    }
}
