//! A tool server's elicitation form as the questions card asks it: each field the form names is one
//! question, in the order the form's schema lists its fields, carrying whether the form requires
//! it, the answer it starts from and a number field's bounds; the answers go back keyed by field,
//! each as the type the field declares.

pub(crate) mod option_sets;

use std::iter;
use std::slice;
use std::str::FromStr;

use serde_json::{Map, Value};
use sidekicks_contracts::question::{
    QuestionAnswer, QuestionDefault, QuestionOption, QuestionPrompt,
};
use sidekicks_contracts::wire::number::Number;
use sidekicks_contracts::wire::text::{NonEmptyText, is_ecmascript_whitespace};

use crate::mcp::elicitation_form::option_sets::{
    ElicitationOption, ElicitationOptionSetReading, read_elicitation_field_option_set,
};
use crate::provider::driver::question_answers::read_question_answer_texts;
use crate::provider::record_readers::read_non_empty_string;

// 2^63, the first whole number past `i64`; `i64::MAX as f64` rounds up to it.
const PAST_I64_MAX: f64 = 9_223_372_036_854_775_808.0;

// One field of a form, with the question text it is asked by.
struct ElicitationField<'params> {
    name: &'params str,
    property: &'params Value,
    members: &'params Map<String, Value>,
    text: NonEmptyText,
    takes_several_answers: bool,
    is_required: bool,
}

/// The questions one `elicitation/create` asks: one per field of a `form` with fields, else its
/// message alone. Every field carries `header`, the asking server's name, and the message;
/// `params` is untrusted tool-server output.
pub(crate) fn read_elicitation_questions(
    params: &Value,
    header: Option<NonEmptyText>,
) -> Vec<QuestionPrompt> {
    let no_members = Map::new();
    let payload = params.as_object().unwrap_or(&no_members);
    let message = read_non_empty_text(payload, "message");
    let fields = read_elicitation_fields(payload);
    if fields.is_empty() {
        return message
            .map(|message| QuestionPrompt {
                header,
                text: message,
                heading: None,
                description: None,
                options: Vec::new(),
                several_answers: false,
                secret: false,
                required: None,
                default: None,
                minimum: None,
                maximum: None,
                step: None,
                unit: None,
                placeholder: None,
            })
            .into_iter()
            .collect();
    }
    fields
        .into_iter()
        .map(|field| {
            let option_set =
                read_elicitation_field_option_set(field.property, field.takes_several_answers);
            let default = read_starting_answer(&field, &option_set);
            let (minimum, maximum) = read_number_range(field.members);
            let options = match option_set {
                ElicitationOptionSetReading::Read { options } => options
                    .iter()
                    .map(|option| QuestionOption {
                        label: to_non_empty_text(option.label.as_str()),
                        description: None,
                        preview: None,
                    })
                    .collect(),
                ElicitationOptionSetReading::Absent => Vec::new(),
                ElicitationOptionSetReading::Dropped {
                    reason,
                    declared_count,
                } => {
                    tracing::warn!(
                        server = header.as_ref().map(NonEmptyText::as_str),
                        field = field.name,
                        reason,
                        declared_count,
                        "a tool server's choices could not be shown; the field is asked as text"
                    );
                    Vec::new()
                }
            };
            QuestionPrompt {
                header: header.clone(),
                text: field.text,
                heading: message.clone(),
                description: None,
                options,
                several_answers: field.takes_several_answers,
                secret: false,
                required: Some(field.is_required),
                default,
                minimum,
                maximum,
                step: None,
                unit: None,
                placeholder: None,
            }
        })
        .collect()
}

/// The form's `content`: each answered field under its own name, a picked label as the value it
/// stands for and typed text as the field's own type. `answers` holds one per question, in the
/// order [`read_elicitation_questions`] asked them; a skipped one leaves the field out.
pub(crate) fn compose_elicitation_content(
    params: &Value,
    answers: &[QuestionAnswer],
) -> Map<String, Value> {
    let no_members = Map::new();
    let payload = params.as_object().unwrap_or(&no_members);
    let mut content = Map::new();
    for (index, field) in read_elicitation_fields(payload).iter().enumerate() {
        let option_set =
            read_elicitation_field_option_set(field.property, field.takes_several_answers);
        let mut values = read_question_answer_texts(answers.get(index))
            .into_iter()
            .map(|pick| match &option_set {
                ElicitationOptionSetReading::Read { options } => {
                    let picked = options.iter().find(|option| option.label.as_str() == pick);
                    Value::from(picked.map_or(pick, |option| option.value.as_str()))
                }
                ElicitationOptionSetReading::Absent
                | ElicitationOptionSetReading::Dropped { .. } => {
                    read_typed_answer(field.members, pick)
                }
            });
        let Some(first) = values.next() else {
            continue;
        };
        let answer = if field.takes_several_answers {
            Value::Array(iter::once(first).chain(values).collect())
        } else {
            first
        };
        content.insert(field.name.to_owned(), answer);
    }
    content
}

// The fields of a `form` elicitation, in the order its schema lists its properties; none for
// any other mode. A field asked by nothing (no title, description, name or form message) is
// left out here, so the questions and the content pair every answer with the same field.
fn read_elicitation_fields(payload: &Map<String, Value>) -> Vec<ElicitationField<'_>> {
    if payload.get("mode").and_then(Value::as_str) != Some("form") {
        return Vec::new();
    }
    let Some(schema) = payload.get("requestedSchema").and_then(Value::as_object) else {
        return Vec::new();
    };
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    let required_names = schema.get("required").and_then(Value::as_array);
    let message = read_non_empty_string(payload, "message");
    properties
        .iter()
        .filter_map(|(name, property)| {
            let members = property.as_object()?;
            let text = read_non_empty_string(members, "title")
                .or_else(|| read_non_empty_string(members, "description"))
                .or_else(|| Some(name.as_str()).filter(|field_name| !field_name.is_empty()))
                .or(message)?;
            Some(ElicitationField {
                name: name.as_str(),
                property,
                members,
                text: to_non_empty_text(text),
                takes_several_answers: members.get("type").and_then(Value::as_str) == Some("array"),
                is_required: required_names.is_some_and(|required_names| {
                    required_names
                        .iter()
                        .any(|required| required.as_str() == Some(name.as_str()))
                }),
            })
        })
        .collect()
}

// The answer a field starts from: an option field's preselected value as its option's label, a
// typed field's value as declared. None where the form declares none, or one the card could not
// draw, such as a value that is no option of the field.
fn read_starting_answer(
    field: &ElicitationField<'_>,
    option_set: &ElicitationOptionSetReading,
) -> Option<QuestionDefault> {
    let declared = field.members.get("default")?;
    match option_set {
        ElicitationOptionSetReading::Read { options } => {
            let values = if let Value::Array(values) = declared {
                values.as_slice()
            } else {
                slice::from_ref(declared)
            };
            let labels = values
                .iter()
                .map(|value| read_option_label(options, value))
                .collect::<Option<Vec<NonEmptyText>>>()?;
            if field.takes_several_answers {
                Some(QuestionDefault::Labels(labels))
            } else {
                labels
                    .into_iter()
                    .next()
                    .map(|label| QuestionDefault::Text(label.into_string()))
            }
        }
        ElicitationOptionSetReading::Absent | ElicitationOptionSetReading::Dropped { .. } => {
            match declared {
                Value::Array(values) => values
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .and_then(|text| NonEmptyText::new(text.to_owned()))
                    })
                    .collect::<Option<Vec<NonEmptyText>>>()
                    .map(QuestionDefault::Labels),
                Value::String(text) => Some(QuestionDefault::Text(text.clone())),
                Value::Bool(flag) => Some(QuestionDefault::Flag(*flag)),
                Value::Number(number) => number
                    .as_f64()
                    .and_then(Number::new)
                    .map(QuestionDefault::Number),
                Value::Null | Value::Object(_) => None,
            }
        }
    }
}

// The label of the option whose value is `value`, or `None` when no option has it.
fn read_option_label(options: &[ElicitationOption], value: &Value) -> Option<NonEmptyText> {
    options
        .iter()
        .find(|option| value.as_str() == Some(option.value.as_str()))
        .map(|option| to_non_empty_text(option.label.as_str()))
}

// A number field's bounds, where the form sets them. Bounds that cross bound no number, so both
// are dropped and the field asks unbounded rather than the whole card failing.
fn read_number_range(members: &Map<String, Value>) -> (Option<Number>, Option<Number>) {
    let minimum = read_number_bound(members, "minimum");
    let maximum = read_number_bound(members, "maximum");
    match (minimum, maximum) {
        (Some(minimum), Some(maximum)) if minimum > maximum => (None, None),
        range => range,
    }
}

// A number field's bound, where the form sets one.
fn read_number_bound(members: &Map<String, Value>, bound: &str) -> Option<Number> {
    let field_type = members.get("type").and_then(Value::as_str);
    if !matches!(field_type, Some("number" | "integer")) {
        return None;
    }
    members.get(bound)?.as_f64().and_then(Number::new)
}

// Typed text as the type the field declares; text that is no such value goes as typed, for the
// server to refuse.
fn read_typed_answer(members: &Map<String, Value>, text: &str) -> Value {
    match members.get("type").and_then(Value::as_str) {
        Some("number" | "integer") => {
            read_finite_number(text).map_or_else(|| Value::from(text), write_number)
        }
        Some("boolean") => match text {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            _ => Value::from(text),
        },
        Some(_) | None => Value::from(text),
    }
}

// The finite decimal number `text` spells around its whitespace, or `None` for blank text, other
// text, and an infinity or `NaN`.
fn read_finite_number(text: &str) -> Option<f64> {
    f64::from_str(text.trim_matches(is_ecmascript_whitespace))
        .ok()
        .filter(|number| number.is_finite())
}

// A finite number as the answer's JSON: a whole one within `i64` is written as an integer literal,
// so an integer field gets an integer.
#[expect(
    clippy::cast_possible_truncation,
    reason = "the number is whole and within i64, so the cast is exact"
)]
fn write_number(number: f64) -> Value {
    if number.fract() == 0.0 && (-PAST_I64_MAX..PAST_I64_MAX).contains(&number) {
        Value::from(number as i64)
    } else {
        Value::from(number)
    }
}

// Text a reader already found non-empty, as the contract's non-empty text.
fn to_non_empty_text(text: &str) -> NonEmptyText {
    NonEmptyText::new(text.to_owned()).expect("the text holds at least one character")
}

fn read_non_empty_text(payload: &Map<String, Value>, key: &str) -> Option<NonEmptyText> {
    read_non_empty_string(payload, key).map(to_non_empty_text)
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::question::QuestionAnswer;
    use sidekicks_contracts::wire::list::BoundedVec;
    use sidekicks_contracts::wire::text::NonEmptyText;

    use super::{compose_elicitation_content, read_elicitation_questions};

    fn typed(text: &str) -> QuestionAnswer {
        QuestionAnswer::Typed {
            text: NonEmptyText::new(text.to_owned()).unwrap(),
        }
    }

    fn picked(label: &str) -> QuestionAnswer {
        QuestionAnswer::Picked {
            labels: BoundedVec::new(vec![NonEmptyText::new(label.to_owned()).unwrap()]).unwrap(),
        }
    }

    fn form(properties: &Value, message: Option<&str>) -> Value {
        let mut params = json!({
            "mode": "form",
            "requestedSchema": {"type": "object", "properties": properties},
        });
        if let Some(message) = message {
            params["message"] = json!(message);
        }
        params
    }

    #[rstest]
    #[case::typed_picked_and_skipped_fields_in_form_order(
        form(
            &json!({
                "count": {"type": "integer", "title": "How many"},
                "severity": {"oneOf": [
                    {"const": "p1", "title": "Urgent"},
                    {"const": "p2", "title": "Normal"},
                ]},
                "note": {"type": "string"},
            }),
            Some("File the bug"),
        ),
        vec![typed("5"), picked("Urgent"), QuestionAnswer::Skipped {}],
        &["How many", "severity", "note"],
        r#"{"count":5,"severity":"p1"}"#
    )]
    #[case::fields_in_the_order_the_schema_lists_them(
        form(
            &json!({"b": {"type": "string"}, "2": {"type": "string"}, "1": {"type": "string"}}),
            None,
        ),
        vec![typed("bee"), typed("two"), typed("one")],
        &["b", "2", "1"],
        r#"{"b":"bee","2":"two","1":"one"}"#
    )]
    #[case::a_number_only_in_decimal(
        form(
            &json!({
                "spaced": {"type": "number"},
                "hex": {"type": "number"},
                "inf": {"type": "number"},
            }),
            None,
        ),
        vec![typed("\u{a0}2.5\u{feff}"), typed("0x10"), typed("inf")],
        &["spaced", "hex", "inf"],
        r#"{"spaced":2.5,"hex":"0x10","inf":"inf"}"#
    )]
    #[case::a_field_asked_by_nothing_before_a_field(
        form(&json!({"": {}, "size": {"type": "string"}}), None),
        vec![typed("large")],
        &["size"],
        r#"{"size":"large"}"#
    )]
    fn asks_each_field_and_answers_it_under_its_own_name(
        #[case] params: Value,
        #[case] answers: Vec<QuestionAnswer>,
        #[case] expected_texts: &[&str],
        #[case] expected_content: &str,
    ) {
        let questions = read_elicitation_questions(&params, None);
        let texts: Vec<&str> = questions
            .iter()
            .map(|question| question.text.as_str())
            .collect();
        assert_eq!(texts, expected_texts);

        let content = compose_elicitation_content(&params, &answers);
        assert_eq!(Value::Object(content).to_string(), expected_content);
    }
}
