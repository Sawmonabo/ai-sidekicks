//! The question tool's questions as the questions card asks them: each question with its header,
//! its options and their previews, the ask's title as every page's summary line, and the extended
//! form's members its kind takes: a text question's placeholder, a number question's range, step,
//! starting value and unit.

use serde_json::{Map, Value};
use sidekicks_contracts::question::{
    QuestionDefault, QuestionKind, QuestionOption, QuestionPrompt,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::number::Number;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::event_normalizer::CLAUDE_QUESTION_TOOL_NAME;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::record_readers::{read_non_empty_string, read_non_empty_text};

/// The question tool's questions in `session_id`'s ask as the questions card asks them; a
/// malformed one is left out, and one of a kind the driver does not read is asked as a choice
/// question with its extended members ignored, logged once.
pub(super) fn read_question_prompts(
    session_id: SessionId,
    input: &Map<String, Value>,
) -> Vec<QuestionPrompt> {
    let Some(questions) = input.get("questions").and_then(Value::as_array) else {
        return Vec::new();
    };
    let heading = read_non_empty_text(input, "title");
    questions
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|question| {
            let text = read_non_empty_text(question, "question")?;
            let read_kind = read_question_kind(session_id, question);
            let mut prompt = QuestionPrompt {
                header: read_non_empty_text(question, "header"),
                text,
                kind: read_kind.unwrap_or(QuestionKind::Choice),
                heading: heading.clone(),
                description: None,
                options: read_question_options(question),
                several_answers: question.get("multiSelect") == Some(&Value::Bool(true)),
                secret: false,
                required: None,
                default: None,
                minimum: None,
                maximum: None,
                step: None,
                unit: None,
                placeholder: None,
            };
            let Some(kind) = read_kind else {
                return Some(prompt);
            };
            prompt.description = read_non_empty_text(question, "description");
            match kind {
                QuestionKind::Choice | QuestionKind::Integer | QuestionKind::Flag => {}
                QuestionKind::Text => {
                    prompt.placeholder = read_non_empty_text(question, "placeholder");
                }
                QuestionKind::Number => {
                    prompt.minimum = read_number(question, "min");
                    prompt.maximum = read_number(question, "max");
                    prompt.step = read_number(question, "step");
                    prompt.default =
                        read_number(question, "defaultValue").map(QuestionDefault::Number);
                    prompt.unit = read_non_empty_text(question, "unit");
                }
            }
            Some(prompt)
        })
        .collect()
}

// A question's option rows, each with its description and preview; a malformed one is left out.
fn read_question_options(question: &Map<String, Value>) -> Vec<QuestionOption> {
    question
        .get("options")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|option| {
            Some(QuestionOption {
                label: read_non_empty_text(option, "label")?,
                description: read_non_empty_string(option, "description").map(str::to_owned),
                preview: read_non_empty_string(option, "preview").map(str::to_owned),
            })
        })
        .collect()
}

// A question's kind, absent a choice; `None` for one the driver does not read, which is logged.
fn read_question_kind(
    session_id: SessionId,
    question: &Map<String, Value>,
) -> Option<QuestionKind> {
    match question.get("kind") {
        None | Some(Value::Null) => Some(QuestionKind::Choice),
        Some(Value::String(kind)) if kind == "choice" => Some(QuestionKind::Choice),
        Some(Value::String(kind)) if kind == "text" => Some(QuestionKind::Text),
        Some(Value::String(kind)) if kind == "number" => Some(QuestionKind::Number),
        Some(kind) => {
            report_unread_kind(session_id, kind);
            None
        }
    }
}

// A question of a kind the driver does not read, which is asked as a choice question.
fn report_unread_kind(session_id: SessionId, kind: &Value) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: None,
        kind: DriverDiagnosticKind::UnmappedWireKind,
        raw_wire_type: Some(CLAUDE_QUESTION_TOOL_NAME.to_owned()),
        disposition_reason: "a question kind the driver does not read; asked as a choice \
                             question with its extended members ignored"
            .to_owned(),
        details: Map::from_iter([
            ("sessionId".to_owned(), Value::from(session_id.to_string())),
            (
                "questionKind".to_owned(),
                kind.as_str().map_or(Value::Null, Value::from),
            ),
        ]),
    });
}

fn read_number(source: &Map<String, Value>, key: &str) -> Option<Number> {
    source.get(key)?.as_f64().and_then(Number::new)
}
