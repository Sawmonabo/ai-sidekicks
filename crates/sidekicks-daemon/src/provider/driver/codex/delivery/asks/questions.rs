//! The questions one Codex ask puts to the person, in its order, for the questions card: an agent's
//! `item/tool/requestUserInput` questions, or a tool server's elicitation form.

use serde_json::{Map, Value};
use sidekicks_contracts::question::{QuestionOption, QuestionPrompt};
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::mcp::elicitation_form::read_elicitation_questions;
use crate::provider::driver::codex::server_requests::CodexRoutedMethod;
use crate::provider::record_readers::read_non_empty_string;

/// The questions the ask of `method` asks, from its untrusted `params`, in their order; an entry
/// with no question text is skipped, and a secret question has no option rows.
pub(crate) fn read_codex_question_prompts(
    method: CodexRoutedMethod,
    params: &Value,
) -> Vec<QuestionPrompt> {
    if method == CodexRoutedMethod::ElicitationRequest {
        let server_name = params
            .as_object()
            .and_then(|payload| read_non_empty_string(payload, "serverName"))
            .and_then(|name| NonEmptyText::new(name.to_owned()));
        return read_elicitation_questions(params, server_name);
    }
    let Some(questions) = params.get("questions").and_then(Value::as_array) else {
        return Vec::new();
    };
    questions
        .iter()
        .filter_map(Value::as_object)
        .filter_map(read_user_input_question)
        .collect()
}

fn read_user_input_question(question: &Map<String, Value>) -> Option<QuestionPrompt> {
    let text = read_text(question, "question")?;
    let secret = question.get("isSecret").and_then(Value::as_bool) == Some(true);
    let options = if secret {
        Vec::new()
    } else {
        question
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .filter_map(|option| {
                Some(QuestionOption {
                    label: read_text(option, "label")?,
                    description: read_non_empty_string(option, "description").map(str::to_owned),
                    preview: None,
                })
            })
            .collect()
    };
    Some(QuestionPrompt {
        header: read_text(question, "header"),
        text,
        heading: None,
        description: None,
        options,
        several_answers: false,
        secret,
        required: None,
        default: None,
        minimum: None,
        maximum: None,
        step: None,
        unit: None,
        placeholder: None,
    })
}

fn read_text(members: &Map<String, Value>, key: &str) -> Option<NonEmptyText> {
    read_non_empty_string(members, key)
        .map(|text| NonEmptyText::new(text.to_owned()).expect("the text holds a character"))
}
