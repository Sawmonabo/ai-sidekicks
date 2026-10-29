//! A routed frame as the stream reads it, parsed once: a message into the members its rows read, a
//! streamed piece left to its own reader, and any other frame, each small, into its top-level
//! members. Those are walked once without building their values, then each becomes a value; one
//! nested deeper than a value can be built is left out, so no frame the reader passed is refused
//! and no reader takes its raw text for a value.

use std::collections::BTreeMap;

use serde_json::value::RawValue;
use serde_json::{Map, Value};

use crate::driver::claude::delivery::messages::ClaudeMessageFrame;

/// One frame's body, as its kind is read.
pub(super) enum ClaudeFrameBody {
    /// An `assistant` or `user` frame.
    Message(ClaudeMessageFrame),
    /// A `stream_event` frame, which its reader parses itself.
    StreamEvent,
    /// Any other frame's top-level members.
    Members(Map<String, Value>),
}

/// The members of the frame `text`; `None` when it is no JSON object.
pub(super) fn read_frame_members(text: &str) -> Option<Map<String, Value>> {
    let members: BTreeMap<String, Box<RawValue>> = serde_json::from_str(text).ok()?;
    Some(
        members
            .into_iter()
            .filter_map(|(name, member)| Some((name, serde_json::from_str(member.get()).ok()?)))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::read_frame_members;
    use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
    use crate::driver::claude::session::process::CLAUDE_OUTPUT_LINE_MAX_BYTES;

    // Fails when a frame whose member nests past serde's recursion limit is dropped rather than
    // read without that member, or when the member is kept as its text, and when a message frame
    // carrying such a member no longer reads. Mutations: parsing the whole line into one `Value`;
    // keeping a member that does not become a value as a string.
    #[test]
    fn a_frame_nested_to_the_line_cap_keeps_its_other_members() {
        let head = r#"{"type":"assistant","uuid":"u1","nested":"#;
        let depth = (CLAUDE_OUTPUT_LINE_MAX_BYTES - head.len() - 1) / 2;
        let mut text = String::with_capacity(CLAUDE_OUTPUT_LINE_MAX_BYTES);
        text.push_str(head);
        text.extend(std::iter::repeat_n('[', depth));
        text.extend(std::iter::repeat_n(']', depth));
        text.push('}');
        assert!(text.len() <= CLAUDE_OUTPUT_LINE_MAX_BYTES);

        let members = read_frame_members(&text).expect("an object's members");

        assert_eq!(members.get("type"), Some(&Value::from("assistant")));
        assert_eq!(members.get("nested"), None);
        let message =
            serde_json::from_str::<ClaudeMessageFrame>(&text).expect("the message frame reads");
        assert_eq!(message.uuid(), Some("u1"));
    }
}
