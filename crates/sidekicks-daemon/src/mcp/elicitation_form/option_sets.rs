//! Reads the options an elicitation form field offers into one set for the questions card. The
//! reading is derived, since the form still travels verbatim, and an unreadable set is dropped
//! whole because the free-text answer still reaches the asking server.

use serde_json::Value;
use sidekicks_contracts::provider::driver::length_limits::{
    PROVIDER_COMMAND_DESCRIPTION_MAX_LEN, PROVIDER_DECLARED_TOKEN_MAX_LEN,
};
use sidekicks_contracts::wire::text::FreeFormText;

use crate::provider::record_readers::read_present_member;

/// One selectable answer of an elicitation form field: `value` is what a chooser sends back,
/// `label` what a person reads. The label takes the wider bound because a titled option's `title`
/// is prose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ElicitationOption {
    /// What a chooser sends back.
    pub(crate) value: FreeFormText<PROVIDER_DECLARED_TOKEN_MAX_LEN>,
    /// What a person reads.
    pub(crate) label: FreeFormText<PROVIDER_COMMAND_DESCRIPTION_MAX_LEN>,
}

/// What one field yielded when read for a choice set. `Absent` (no choices) differs from
/// `Dropped` (choices the card cannot carry), so only the latter earns a diagnostic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AskOptionSetReading {
    /// The ask offers no choices.
    Absent,
    /// The choices, in the server's order.
    Read {
        /// The options.
        options: Vec<ElicitationOption>,
    },
    /// Choices the card cannot carry.
    Dropped {
        /// Why the set was refused.
        reason: &'static str,
        /// How many options the server declared.
        declared_count: usize,
    },
}

/// One declared option before its bounds are checked: the members that become its value and label.
struct AskOptionCandidate<'params> {
    value: Option<&'params Value>,
    label: Option<&'params Value>,
}

/// The choices one elicitation form field offers, read and bounded as a set: its own titled or
/// plain enum, or, for a field that takes several answers, its `items`' one.
pub(crate) fn read_elicitation_field_option_set(
    property: &Value,
    takes_several_answers: bool,
) -> AskOptionSetReading {
    let source = match property.as_object() {
        Some(property) if takes_several_answers => property.get("items"),
        _ => Some(property),
    };
    match source.and_then(read_elicitation_enum_arm) {
        Some(candidates) => read_ask_option_candidates(candidates),
        None => AskOptionSetReading::Absent,
    }
}

/// The candidates one elicitation property declares, or `None` when it declares no choices.
fn read_elicitation_enum_arm(property: &Value) -> Option<Vec<AskOptionCandidate<'_>>> {
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
/// hide a choice the server offered, whereas the free-text answer can express any choice.
fn read_ask_option_candidates(candidates: Vec<AskOptionCandidate<'_>>) -> AskOptionSetReading {
    if candidates.is_empty() {
        return AskOptionSetReading::Absent;
    }
    let declared_count = candidates.len();
    let options: Option<Vec<ElicitationOption>> = candidates
        .into_iter()
        .map(|candidate| {
            Some(ElicitationOption {
                value: read_bounded_text(candidate.value)?,
                label: read_bounded_text(candidate.label)?,
            })
        })
        .collect();
    match options {
        Some(options) => AskOptionSetReading::Read { options },
        None => AskOptionSetReading::Dropped {
            reason: "at least one declared option carried an unreadable or out-of-bounds value \
                     or label, and a partial set would hide a choice the server is waiting for",
            declared_count,
        },
    }
}

/// The member as free-form text within `MAX`, or `None` when it is not text or breaks a bound.
fn read_bounded_text<const MAX: usize>(member: Option<&Value>) -> Option<FreeFormText<MAX>> {
    FreeFormText::new(member?.as_str()?.to_owned()).ok()
}
