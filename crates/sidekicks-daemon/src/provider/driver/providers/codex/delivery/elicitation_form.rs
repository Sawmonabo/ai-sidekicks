//! A tool server's elicitation form as the questions card asks it: each field the form names is one
//! question, in the form's own order, carrying whether the form requires it, the answer it starts
//! from and a number field's bounds; the answers go back keyed by field, each as the type the field
//! declares.

use std::iter;
use std::slice;

use serde_json::{Map, Value};
use sidekicks_contracts::question::{
    QuestionAnswer, QuestionDefault, QuestionOption, QuestionPrompt,
};
use sidekicks_contracts::wire::number::Number;
use sidekicks_contracts::wire::text::{NonEmptyText, is_ecmascript_whitespace};

use crate::javascript_key_order::members_in_javascript_order;
use crate::provider::driver::providers::codex::ask_option_sets::{
    CodexAskOptionSetReading, ProviderAskOption, read_codex_elicitation_field_option_set,
};
use crate::provider::driver::question_answers::read_question_answer_texts;
use crate::provider::record_readers::read_non_empty_string;

// 2^63, the first whole number past `i64`; `i64::MAX as f64` rounds up to it.
const PAST_I64_MAX: f64 = 9_223_372_036_854_775_808.0;

// One field of a form, with the question text it is asked by.
struct CodexElicitationField<'params> {
    name: &'params str,
    property: &'params Value,
    members: &'params Map<String, Value>,
    text: NonEmptyText,
    takes_several_answers: bool,
    is_required: bool,
}

/// The questions one `mcpServer/elicitation/request` asks: one per field of a `form` with fields,
/// else its message alone. Every field carries the server's name and its message; `params` is
/// untrusted provider output.
pub(crate) fn read_codex_elicitation_questions(params: &Value) -> Vec<QuestionPrompt> {
    let no_members = Map::new();
    let payload = params.as_object().unwrap_or(&no_members);
    let message = read_non_empty_text(payload, "message");
    let header = read_non_empty_text(payload, "serverName");
    let fields = read_codex_elicitation_fields(payload);
    if fields.is_empty() {
        return message
            .map(|message| QuestionPrompt {
                header,
                text: message,
                heading: None,
                options: Vec::new(),
                several_answers: false,
                secret: false,
                required: None,
                default: None,
                minimum: None,
                maximum: None,
            })
            .into_iter()
            .collect();
    }
    fields
        .into_iter()
        .map(|field| {
            let option_set = read_codex_elicitation_field_option_set(
                field.property,
                field.takes_several_answers,
            );
            let default = read_starting_answer(&field, &option_set);
            let (minimum, maximum) = read_number_range(field.members);
            let options = match option_set {
                CodexAskOptionSetReading::Read { options } => options
                    .iter()
                    .map(|option| QuestionOption {
                        label: to_non_empty_text(option.label.as_str()),
                        description: None,
                        preview: None,
                    })
                    .collect(),
                CodexAskOptionSetReading::Absent | CodexAskOptionSetReading::Dropped { .. } => {
                    Vec::new()
                }
            };
            QuestionPrompt {
                header: header.clone(),
                text: field.text,
                heading: message.clone(),
                options,
                several_answers: field.takes_several_answers,
                secret: false,
                required: Some(field.is_required),
                default,
                minimum,
                maximum,
            }
        })
        .collect()
}

/// The form's `content`: each answered field under its own name, a picked label as the value it
/// stands for and typed text as the field's own type. `answers` holds one per question, in the
/// order [`read_codex_elicitation_questions`] asked them; a skipped one leaves the field out.
pub(crate) fn compose_codex_elicitation_content(
    params: &Value,
    answers: &[QuestionAnswer],
) -> Map<String, Value> {
    let no_members = Map::new();
    let payload = params.as_object().unwrap_or(&no_members);
    let mut content = Map::new();
    for (index, field) in read_codex_elicitation_fields(payload).iter().enumerate() {
        let option_set =
            read_codex_elicitation_field_option_set(field.property, field.takes_several_answers);
        let mut values = read_question_answer_texts(answers.get(index))
            .into_iter()
            .map(|pick| match &option_set {
                CodexAskOptionSetReading::Read { options } => {
                    let picked = options.iter().find(|option| option.label.as_str() == pick);
                    Value::from(picked.map_or(pick, |option| option.value.as_str()))
                }
                CodexAskOptionSetReading::Absent | CodexAskOptionSetReading::Dropped { .. } => {
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

// The fields of a `form` elicitation, in the order JavaScript lists its schema's properties; none
// for any other mode. A field asked by nothing (no title, description, name or form message) is
// left out here, so the questions and the content pair every answer with the same field.
fn read_codex_elicitation_fields(payload: &Map<String, Value>) -> Vec<CodexElicitationField<'_>> {
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
    members_in_javascript_order(properties)
        .into_iter()
        .filter_map(|(name, property)| {
            let members = property.as_object()?;
            let text = read_non_empty_string(members, "title")
                .or_else(|| read_non_empty_string(members, "description"))
                .or_else(|| Some(name.as_str()).filter(|field_name| !field_name.is_empty()))
                .or(message)?;
            Some(CodexElicitationField {
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
    field: &CodexElicitationField<'_>,
    option_set: &CodexAskOptionSetReading,
) -> Option<QuestionDefault> {
    let declared = field.members.get("default")?;
    match option_set {
        CodexAskOptionSetReading::Read { options } => {
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
        CodexAskOptionSetReading::Absent | CodexAskOptionSetReading::Dropped { .. } => {
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
fn read_option_label(options: &[ProviderAskOption], value: &Value) -> Option<NonEmptyText> {
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
            read_javascript_number(text).map_or_else(|| Value::from(text), write_number)
        }
        Some("boolean") => match text {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            _ => Value::from(text),
        },
        Some(_) | None => Value::from(text),
    }
}

// The finite number JavaScript's `Number(text)` reads, or `None` where it reads `NaN`, an
// infinity, or zero from blank text. Rust's decimal grammar is JavaScript's but for `inf`,
// `infinity` and `nan`, which read only as numbers that are not finite.
fn read_javascript_number(text: &str) -> Option<f64> {
    let trimmed = text.trim_matches(is_ecmascript_whitespace);
    let number = read_prefixed_integer(trimmed).or_else(|| trimmed.parse::<f64>().ok())?;
    number.is_finite().then_some(number)
}

// The number a `0x`, `0o` or `0b` literal (either case, no sign) spells, rounded to the nearest
// `f64` as JavaScript rounds it; `None` for text that is no such literal.
fn read_prefixed_integer(text: &str) -> Option<f64> {
    let (radix, bits_per_digit) = match text.get(..2)? {
        "0x" | "0X" => (16, 4),
        "0o" | "0O" => (8, 3),
        "0b" | "0B" => (2, 1),
        _ => return None,
    };
    let digits = &text[2..];
    if digits.is_empty() {
        return None;
    }
    // Every digit is kept while it fits; past that, a digit only scales the value, and a nonzero one
    // sets the lowest bit, which lies far below the rounding point and so rounds as the exact
    // value does.
    let mut value: u128 = 0;
    let mut dropped_bits: u32 = 0;
    for character in digits.chars() {
        let digit = character.to_digit(radix)?;
        if value >> (u128::BITS - bits_per_digit) == 0 {
            value = (value << bits_per_digit) | u128::from(digit);
        } else {
            dropped_bits = dropped_bits.saturating_add(bits_per_digit);
            value |= u128::from(digit != 0);
        }
    }
    Some(scale_by_power_of_two(value, dropped_bits))
}

#[expect(
    clippy::cast_precision_loss,
    reason = "the integer rounds to the nearest f64, as JavaScript rounds the literal"
)]
fn scale_by_power_of_two(value: u128, exponent: u32) -> f64 {
    // An exponent past `i32` overflows to an infinity, as the exact value would.
    let exponent = i32::try_from(exponent).unwrap_or(i32::MAX);
    value as f64 * 2_f64.powi(exponent)
}

// A finite number as JavaScript writes it: a whole one within `i64` as an integer, since
// `serde_json` writes `5.0` where JavaScript writes `5`.
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

    use super::{compose_codex_elicitation_content, read_codex_elicitation_questions};

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
            "serverName": "tracker",
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
    #[case::array_index_keys_first(
        form(
            &json!({"b": {"type": "string"}, "2": {"type": "string"}, "1": {"type": "string"}}),
            None,
        ),
        vec![typed("one"), typed("two"), typed("bee")],
        &["1", "2", "b"],
        r#"{"1":"one","2":"two","b":"bee"}"#
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
        let questions = read_codex_elicitation_questions(&params);
        let texts: Vec<&str> = questions
            .iter()
            .map(|question| question.text.as_str())
            .collect();
        assert_eq!(texts, expected_texts);

        let content = compose_codex_elicitation_content(&params, &answers);
        assert_eq!(Value::Object(content).to_string(), expected_content);
    }
}
