//! A form wait's answer checked against its fields: the JSON Schema the form declared, so a value
//! of the wrong type or out of its bounds never reaches the step, whichever door it came through.

use std::error::Error;

use jsonschema::ValidationError;
use jsonschema::error::ValidationErrorKind;
use serde_json::{Map, Value};
use sidekicks_contracts::jsonrpc::issue::{IssuePathSegment, shape_faults};

/// Why a form's answer was not taken.
#[derive(Debug, thiserror::Error)]
pub enum FormAnswerCheckError {
    /// A field holds a value its schema does not take, or a required field is left out: the
    /// field's id, `None` for a rule over the whole form.
    #[error("a form field does not take the value given")]
    FieldValueInvalid {
        /// The id of the first field the schema refuses.
        field: Option<String>,
    },
    /// The form's schema does not compile: a fault of the form's kind, never of the answer.
    #[error("the form's schema does not compile")]
    SchemaInvalid(#[source] Box<dyn Error + Send + Sync>),
}

/// Checks `fields`, a form's answer keyed by each field's id, against `schema`, the form's fields'
/// JSON Schema, compiled for this one answer. Refused
/// [`FormAnswerCheckError::FieldValueInvalid`] naming the first field the schema refuses, and
/// failed [`FormAnswerCheckError::SchemaInvalid`] when the schema does not compile.
pub fn check_form_answer(
    schema: &Map<String, Value>,
    fields: &Map<String, Value>,
) -> Result<(), FormAnswerCheckError> {
    let validator = jsonschema::validator_for(&Value::Object(schema.clone()))
        .map_err(|error| FormAnswerCheckError::SchemaInvalid(Box::new(error)))?;
    let answer = Value::Object(fields.clone());
    let Err(refusal) = validator.validate(&answer) else {
        return Ok(());
    };
    Err(FormAnswerCheckError::FieldValueInvalid {
        field: refused_field(&refusal, &answer),
    })
}

// The field `refusal` names in `answer`: the missing one a `required` rule names, whose fault sits
// at the form's root, else the first member of the fault's path.
fn refused_field(refusal: &ValidationError<'_>, answer: &Value) -> Option<String> {
    if let ValidationErrorKind::Required { property } = refusal.kind() {
        return property.as_str().map(str::to_owned);
    }
    shape_faults(refusal, answer)
        .into_iter()
        .next()
        .and_then(|fault| fault.path.into_iter().next())
        .and_then(|segment| match segment {
            IssuePathSegment::Member(name) => Some(name),
            IssuePathSegment::Index(_) => None,
        })
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Map, Value, json};

    use super::{FormAnswerCheckError, check_form_answer};

    /// A form of an integer field of at most 10, a text field and a required yes-or-no field.
    fn schema() -> Map<String, Value> {
        let Value::Object(schema) = json!({
            "type": "object",
            "properties": {
                "count": { "type": "integer", "maximum": 10 },
                "note": { "type": "string" },
                "confirmed": { "type": "boolean" },
            },
            "required": ["confirmed"],
        }) else {
            unreachable!("the test's schema is an object");
        };
        schema
    }

    /// Each value its field does not take is refused naming that field, and a fitting answer is
    /// taken. Kills: the check skipped; the field's id dropped or taken from the wrong place, a
    /// left-out required field's included.
    #[rstest]
    #[case::text_in_a_number_field(json!({ "count": "abc", "confirmed": true }), Some("count"))]
    #[case::a_fraction_as_an_integer(json!({ "count": 1.5, "confirmed": true }), Some("count"))]
    #[case::past_the_fields_maximum(json!({ "count": 11, "confirmed": true }), Some("count"))]
    #[case::a_required_field_left_out(json!({ "count": 3, "note": "Hi" }), Some("confirmed"))]
    #[case::a_fitting_answer(json!({ "count": 10, "note": "Hi", "confirmed": false }), None)]
    fn a_form_answer_is_held_to_its_fields(#[case] fields: Value, #[case] refused: Option<&str>) {
        let Value::Object(fields) = fields else {
            unreachable!("the test's answer is an object");
        };

        let checked = check_form_answer(&schema(), &fields);

        match (checked, refused) {
            (Ok(()), None) => {}
            (Err(FormAnswerCheckError::FieldValueInvalid { field }), Some(refused)) => {
                assert_eq!(field.as_deref(), Some(refused));
            }
            (checked, refused) => panic!("{refused:?} expected, got {checked:?}"),
        }
    }
}
