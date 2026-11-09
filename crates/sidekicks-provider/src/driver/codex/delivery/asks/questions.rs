//! The questions one Codex ask puts to the person, in its order, for the questions card: an agent's
//! `item/tool/requestUserInput` questions, or a tool server's elicitation form.

use serde_json::{Map, Value};
use sidekicks_contracts::question::{QuestionOption, QuestionPrompt};
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::driver::codex::server_requests::CodexRoutedMethod;
use crate::mcp::elicitation_form::read_elicitation_questions;
use crate::record_readers::read_non_empty_string;

/// One `item/tool/requestUserInput` question the card shows, with the id its answer goes under.
pub(crate) struct CodexUserInputQuestion<'params> {
    /// Codex's own id for the question.
    pub(crate) id: &'params str,
    /// The question as the card shows it.
    pub(crate) prompt: QuestionPrompt,
}

/// The questions the ask of `method` asks, from its untrusted `params`, in their order; a
/// user-input question with no id or no question text is skipped, and a secret question has no
/// option rows.
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
    read_codex_user_input_questions(params)
        .map(|question| question.prompt)
        .collect()
}

/// The questions of a user-input request's untrusted `params` the card shows, in their order:
/// each with an id and question text. The card's answers pair with these, never with the raw list,
/// so a question left out never moves a later answer onto another id.
pub(crate) fn read_codex_user_input_questions(
    params: &Value,
) -> impl Iterator<Item = CodexUserInputQuestion<'_>> {
    params
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|question| {
            Some(CodexUserInputQuestion {
                id: read_non_empty_string(question, "id")?,
                prompt: read_user_input_question(question)?,
            })
        })
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
        several_answers: true,
        secret,
        path: None,
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
