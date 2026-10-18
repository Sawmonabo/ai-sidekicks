//! Reads the options a Codex ask offers (a request for user input or an elicitation) into one set
//! for the input-ask card. The reading is derived, since `params` still travels verbatim, and an
//! unreadable set is dropped whole because the free-text answer still reaches the provider.

use serde_json::Value;
use sidekicks_contracts::provider::driver::length_limits::{
    PROVIDER_COMMAND_DESCRIPTION_MAX_LEN, PROVIDER_DECLARED_TOKEN_MAX_LEN,
};
use sidekicks_contracts::wire::text::FreeFormText;

use crate::provider::record_readers::read_present_member;

/// One selectable answer of a provider ask: `value` is what a chooser sends back, `label` what a
/// person reads. The label takes the wider bound because a titled MCP option's `title` is prose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderAskOption {
    /// What a chooser sends back.
    pub(crate) value: FreeFormText<PROVIDER_DECLARED_TOKEN_MAX_LEN>,
    /// What a person reads.
    pub(crate) label: FreeFormText<PROVIDER_COMMAND_DESCRIPTION_MAX_LEN>,
}

/// What one ask's payload yielded when read for a choice set. `Absent` (no choices) differs from
/// `Dropped` (choices this driver refused to carry), so only the latter earns a diagnostic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodexAskOptionSetReading {
    /// The ask offers no choices.
    Absent,
    /// The choices, in the provider's order.
    Read {
        /// The options.
        options: Vec<ProviderAskOption>,
    },
    /// Choices the driver refused to carry.
    Dropped {
        /// Why the set was refused.
        reason: &'static str,
        /// How many questions, properties or options the provider declared.
        declared_count: usize,
    },
}

/// One declared option before its bounds are checked: the members that become its value and label.
struct AskOptionCandidate<'params> {
    value: Option<&'params Value>,
    label: Option<&'params Value>,
}

/// Reads the choice set an inbound ask publishes, if any. Pure: it emits no diagnostic, so the
/// caller decides what a `Dropped` reading is worth.
pub(crate) fn read_codex_ask_option_set(method: &str, params: &Value) -> CodexAskOptionSetReading {
    match method {
        "item/tool/requestUserInput" => read_codex_request_user_input_option_set(params),
        "mcpServer/elicitation/request" => read_codex_elicitation_option_set(params),
        // An approval publishes a decision vocabulary the daemon composes; it never reaches the
        // person's card.
        _ => CodexAskOptionSetReading::Absent,
    }
}

/// Reads `ToolRequestUserInputParams.questions[].options`. An option has no value member, so its
/// value is its label; `description` is not carried, to keep prose out of the answer. Only a
/// single-question ask is eligible, since a flat set has no question identity.
fn read_codex_request_user_input_option_set(params: &Value) -> CodexAskOptionSetReading {
    let Some(questions) = params.get("questions").and_then(Value::as_array) else {
        return CodexAskOptionSetReading::Absent;
    };
    let declared = questions.iter().find_map(|question| {
        question
            .get("options")
            .and_then(Value::as_array)
            .filter(|options| !options.is_empty())
    });
    let Some(declared) = declared else {
        return CodexAskOptionSetReading::Absent;
    };
    // The ask's own question count decides, not the option-bearing subset.
    if questions.len() > 1 {
        return CodexAskOptionSetReading::Dropped {
            reason: "the ask declares more than one question and a single flat choice set \
                     carries no question identity, so no answer built from it could satisfy the \
                     ask",
            declared_count: questions.len(),
        };
    }
    let candidates = declared
        .iter()
        .map(|option| {
            let label = option.as_object().and_then(|option| option.get("label"));
            AskOptionCandidate {
                value: label,
                label,
            }
        })
        .collect();
    read_codex_ask_option_candidates(candidates)
}

/// Reads the `McpServerElicitationRequestParams` single-select enum set. Only `form` mode has a
/// typed schema, so other modes read absent; only a one-property form is eligible, since the
/// answer is keyed by property.
fn read_codex_elicitation_option_set(params: &Value) -> CodexAskOptionSetReading {
    let Some(params) = params.as_object() else {
        return CodexAskOptionSetReading::Absent;
    };
    if params.get("mode").and_then(Value::as_str) != Some("form") {
        return CodexAskOptionSetReading::Absent;
    }
    let Some(properties) = params
        .get("requestedSchema")
        .and_then(Value::as_object)
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object)
    else {
        return CodexAskOptionSetReading::Absent;
    };
    let Some(candidates) = properties
        .values()
        .find_map(read_codex_elicitation_enum_arm)
    else {
        return CodexAskOptionSetReading::Absent;
    };
    // The form's own property count decides, not the enum-bearing subset; a sibling's `required`
    // is not consulted, since an optional text sibling is just as unanswerable by a bare value.
    if properties.len() > 1 {
        return CodexAskOptionSetReading::Dropped {
            reason: "the elicitation form declares more than one property and a flat choice set \
                     carries no property identity, so no answer built from it could satisfy the \
                     form",
            declared_count: properties.len(),
        };
    }
    read_codex_ask_option_candidates(candidates)
}

/// The choices one elicitation form field offers, read and bounded as a set: its own titled or
/// plain enum, or, for a field that takes several answers, its `items`' one.
pub(crate) fn read_codex_elicitation_field_option_set(
    property: &Value,
    takes_several_answers: bool,
) -> CodexAskOptionSetReading {
    let source = match property.as_object() {
        Some(property) if takes_several_answers => property.get("items"),
        _ => Some(property),
    };
    match source.and_then(read_codex_elicitation_enum_arm) {
        Some(candidates) => read_codex_ask_option_candidates(candidates),
        None => CodexAskOptionSetReading::Absent,
    }
}

/// The candidates one elicitation property declares, or `None` when it declares no choices.
fn read_codex_elicitation_enum_arm(property: &Value) -> Option<Vec<AskOptionCandidate<'_>>> {
    let property = property.as_object()?;
    // A single pick titles its values in `oneOf`, a field of several picks in its items' `anyOf`.
    let titled =
        read_present_member(property, "oneOf").or_else(|| read_present_member(property, "anyOf"));
    if let Some(titled) = titled
        .and_then(Value::as_array)
        .filter(|titled| !titled.is_empty())
    {
        return Some(
            titled
                .iter()
                .map(|option| match option.as_object() {
                    Some(option) => AskOptionCandidate {
                        value: option.get("const"),
                        label: option.get("title"),
                    },
                    None => AskOptionCandidate {
                        value: None,
                        label: None,
                    },
                })
                .collect(),
        );
    }
    let values = property
        .get("enum")
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())?;
    let names = property.get("enumNames").and_then(Value::as_array);
    Some(
        values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                // The names pair by position and may run short; a missing caption falls back to
                // the value.
                let declared_name = names
                    .and_then(|names| names.get(index))
                    .filter(|name| name.is_string());
                AskOptionCandidate {
                    value: Some(value),
                    label: Some(declared_name.unwrap_or(value)),
                }
            })
            .collect(),
    )
}

/// Reads one candidate set whole, or says why it was refused. All or nothing: a partial set would
/// hide a choice the provider offered, whereas the free-text answer can express any choice.
fn read_codex_ask_option_candidates(
    candidates: Vec<AskOptionCandidate<'_>>,
) -> CodexAskOptionSetReading {
    if candidates.is_empty() {
        return CodexAskOptionSetReading::Absent;
    }
    let declared_count = candidates.len();
    let options: Option<Vec<ProviderAskOption>> = candidates
        .into_iter()
        .map(|candidate| {
            Some(ProviderAskOption {
                value: read_bounded_text(candidate.value)?,
                label: read_bounded_text(candidate.label)?,
            })
        })
        .collect();
    match options {
        Some(options) => CodexAskOptionSetReading::Read { options },
        None => CodexAskOptionSetReading::Dropped {
            reason: "at least one declared option carried an unreadable or out-of-bounds value \
                     or label, and a partial set would hide a choice the provider is waiting for",
            declared_count,
        },
    }
}

/// The member as free-form text within `MAX`, or `None` when it is not text or breaks a bound.
fn read_bounded_text<const MAX: usize>(member: Option<&Value>) -> Option<FreeFormText<MAX>> {
    FreeFormText::new(member?.as_str()?.to_owned()).ok()
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::{CodexAskOptionSetReading, read_codex_ask_option_set};

    // An option's value is its label, so a label past the value's 128 code points is out of bounds.
    #[rstest]
    #[case::one_out_of_bounds_option(
        json!({"questions": [
            {"id": "q", "options": [{"label": "yes"}, {"label": "x".repeat(129)}]}
        ]}),
        Some(2)
    )]
    #[case::two_questions(
        json!({"questions": [{"id": "a", "options": [{"label": "yes"}]}, {"id": "b"}]}),
        Some(2)
    )]
    #[case::one_question_in_bounds(
        json!({"questions": [{"id": "q", "options": [{"label": "yes"}, {"label": "no"}]}]}),
        None
    )]
    fn drops_a_set_it_cannot_carry_whole(
        #[case] params: Value,
        #[case] dropped_count: Option<usize>,
    ) {
        let reading = read_codex_ask_option_set("item/tool/requestUserInput", &params);
        match (reading, dropped_count) {
            (CodexAskOptionSetReading::Dropped { declared_count, .. }, Some(expected)) => {
                assert_eq!(declared_count, expected);
            }
            (CodexAskOptionSetReading::Read { options }, None) => {
                let labels: Vec<&str> =
                    options.iter().map(|option| option.label.as_str()).collect();
                assert_eq!(labels, ["yes", "no"]);
            }
            (reading, expected) => panic!("read {reading:?}, expected a drop of {expected:?}"),
        }
    }
}
