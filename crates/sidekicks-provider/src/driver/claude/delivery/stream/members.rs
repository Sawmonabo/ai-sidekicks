//! A routed frame's top-level members, each read on its own: the line is walked once without
//! building its values, then each member becomes a value, and a member nested deeper than a value
//! can be built is kept as its raw text, so no frame the reader passed is ever refused.

use std::collections::BTreeMap;

use serde_json::value::RawValue;
use serde_json::{Map, Value};

/// The members of the frame `text`; `None` when it is no JSON object.
pub(super) fn read_frame_members(text: &str) -> Option<Map<String, Value>> {
    let members: BTreeMap<String, Box<RawValue>> = serde_json::from_str(text).ok()?;
    Some(
        members
            .into_iter()
            .map(|(name, member)| {
                let value = serde_json::from_str(member.get())
                    .unwrap_or_else(|_| Value::String(member.get().to_owned()));
                (name, value)
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::read_frame_members;
    use crate::driver::claude::session::process::CLAUDE_OUTPUT_LINE_MAX_BYTES;

    // Fails when a frame whose member nests past serde's recursion limit is dropped rather than
    // read with that member kept as its text. Mutations: parsing the whole line into one `Value`;
    // dropping a member that does not become a value.
    #[test]
    fn a_frame_nested_to_the_line_cap_keeps_its_members() {
        let head = r#"{"type":"assistant","nested":"#;
        let depth = (CLAUDE_OUTPUT_LINE_MAX_BYTES - head.len() - 1) / 2;
        let mut text = String::with_capacity(CLAUDE_OUTPUT_LINE_MAX_BYTES);
        text.push_str(head);
        text.extend(std::iter::repeat_n('[', depth));
        text.extend(std::iter::repeat_n(']', depth));
        text.push('}');
        assert!(text.len() <= CLAUDE_OUTPUT_LINE_MAX_BYTES);

        let members = read_frame_members(&text).expect("an object's members");

        assert_eq!(members.get("type"), Some(&Value::from("assistant")));
        let Some(Value::String(nested)) = members.get("nested") else {
            panic!("the deep member is kept as its text");
        };
        assert_eq!(nested.len(), depth * 2);
    }
}
