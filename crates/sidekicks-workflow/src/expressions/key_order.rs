//! Stored JSON turned into the evaluator's values with every object's keys in JavaScript's order,
//! so `$keys`, `$each` and a written object read the keys as a workflow's JavaScript readers do.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the evaluator thread, which builds each evaluation's input from stored JSON"
    )
)]

use jsonata_core::value::JValue;
use serde_json::Value;

/// `json` as an evaluator value, every object's keys in JavaScript's own-key order: the keys that
/// are array indexes first, ascending by number, then every other key in `json`'s order, through
/// every nested array and object.
pub(crate) fn to_jsonata_value(json: &Value) -> JValue {
    match json {
        Value::Null => JValue::Null,
        Value::Bool(flag) => JValue::Bool(*flag),
        Value::Number(number) => JValue::Number(
            number
                .as_f64()
                .expect("a JSON number reads as an f64, rounded or infinite when out of range"),
        ),
        Value::String(text) => JValue::string(text.as_str()),
        Value::Array(elements) => JValue::array(elements.iter().map(to_jsonata_value).collect()),
        Value::Object(members) => {
            let mut index_members = Vec::new();
            let mut other_members = Vec::new();
            for (key, value) in members {
                match array_index(key) {
                    Some(index) => index_members.push((index, key, value)),
                    None => other_members.push((key, value)),
                }
            }
            index_members.sort_unstable_by_key(|(index, _, _)| *index);
            JValue::object(
                index_members
                    .into_iter()
                    .map(|(_, key, value)| (key, value))
                    .chain(other_members)
                    .map(|(key, value)| (key.clone(), to_jsonata_value(value)))
                    .collect(),
            )
        }
    }
}

/// The array index `key` names: `0`, or digits with no leading zero up to `4294967294`, the
/// largest index a JavaScript array holds; `None` for any other key, `01`, `+1` and `4294967295`
/// among them.
fn array_index(key: &str) -> Option<u32> {
    let is_canonical = key == "0"
        || (!key.starts_with('0')
            && !key.is_empty()
            && key.bytes().all(|byte| byte.is_ascii_digit()));
    if !is_canonical {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

#[cfg(test)]
mod tests;
