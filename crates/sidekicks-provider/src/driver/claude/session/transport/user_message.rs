//! The user message a Claude Code process reads on its input in streaming-input mode: the words,
//! with any pictures as their own blocks, under the uuid a withdraw and a conversation cut address
//! it by; the reset words refused before one is written; and how far a failed write of one got.

use std::io;

use serde::{Deserialize, Serialize};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::wire::text::is_blank;
use sidekicks_ipc::domain_error::DomainError;

use crate::outbound_text::{OutboundText, OutboundTextOrigin};

/// One user message line as Claude Code's stream-json input reads it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ClaudeUserFrame {
    /// Always `user`.
    #[serde(rename = "type")]
    frame_type: ClaudeUserFrameType,
    /// The message's id.
    pub(crate) uuid: String,
    /// The message.
    message: ClaudeUserMessage,
    /// Set only on text the daemon composed, so a leading `/` or an `@path` in it reaches the model
    /// as written.
    #[serde(skip_serializing_if = "Option::is_none")]
    client_composed: Option<bool>,
    /// When a running turn reads the message; absent, Claude Code's own order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) priority: Option<ClaudeMessagePriority>,
    /// Set only on text a person typed, so Claude Code counts it as the person's own message.
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<ClaudeMessageOrigin>,
}

/// Who wrote a user message, as Claude Code's input reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ClaudeMessageOrigin {
    /// A person.
    Human,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ClaudeUserFrameType {
    User,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct ClaudeUserMessage {
    role: ClaudeUserFrameType,
    content: ClaudeUserContent,
}

// The words alone, or blocks when the message carries files.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
enum ClaudeUserContent {
    Text(String),
    Blocks(Vec<ClaudeUserContentBlock>),
}

/// One block of a user message's content: words, or a picture as its own bytes in base64.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ClaudeUserContentBlock {
    /// Words.
    Text {
        /// The words.
        text: String,
    },
    /// A picture.
    Image {
        /// Its bytes.
        source: ClaudePictureSource,
    },
}

/// A picture's bytes, in base64.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ClaudePictureSource {
    /// Inline.
    Base64 {
        /// Its format.
        media_type: ClaudePictureMediaType,
        /// Its bytes in base64.
        data: String,
    },
}

/// The picture formats Claude Code's image block takes, read from and written as their media
/// types.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ClaudePictureMediaType {
    /// JPEG.
    #[serde(rename = "image/jpeg")]
    Jpeg,
    /// PNG.
    #[serde(rename = "image/png")]
    Png,
    /// GIF.
    #[serde(rename = "image/gif")]
    Gif,
    /// WebP.
    #[serde(rename = "image/webp")]
    Webp,
}

/// The priority a person's `Send now` is written with; every other message carries none, which
/// Claude Code reads at the running turn's next step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ClaudeMessagePriority {
    /// At once, stopping what the turn is doing.
    Now,
}

/// The user message for one piece of provider-bound text, its words unchanged, followed by its
/// files' blocks in staging order; a message of files alone carries no words block. Only text the
/// daemon composed to tell the agent what happened is marked composed: the person's text and a
/// command the daemon sends for Claude Code to run stay unmarked, since the mark expands no
/// `@path` and stops a command from running.
pub(crate) fn compose_claude_user_frame(
    outbound_text: &OutboundText,
    message_uuid: String,
    attachment_blocks: Vec<ClaudeUserContentBlock>,
) -> ClaudeUserFrame {
    let content = if attachment_blocks.is_empty() {
        ClaudeUserContent::Text(outbound_text.text.clone())
    } else {
        let mut blocks = Vec::with_capacity(attachment_blocks.len() + 1);
        if !is_blank(&outbound_text.text) {
            blocks.push(ClaudeUserContentBlock::Text {
                text: outbound_text.text.clone(),
            });
        }
        blocks.extend(attachment_blocks);
        ClaudeUserContent::Blocks(blocks)
    };
    ClaudeUserFrame {
        frame_type: ClaudeUserFrameType::User,
        uuid: message_uuid,
        message: ClaudeUserMessage {
            role: ClaudeUserFrameType::User,
            content,
        },
        client_composed: (outbound_text.origin == OutboundTextOrigin::SystemNarration)
            .then_some(true),
        priority: None,
        origin: (outbound_text.origin == OutboundTextOrigin::HumanText)
            .then_some(ClaudeMessageOrigin::Human),
    }
}

/// The first tokens Claude Code runs as its own command that clears the conversation, matched
/// whole and in this case.
const CLAUDE_RESET_WORDS: [&str; 3] = ["/clear", "/reset", "/new"];

/// The sentence a message refused as a reset carries.
pub(crate) const CLAUDE_RESET_REFUSAL_SENTENCE: &str =
    "A session is not reset in place. Start a new session instead.";

/// Whether unmarked text, a person's or a driver command's, would reset the session: its whole
/// first token, ending at the text's end or at whitespace, is a reset word. Leading whitespace,
/// another case or a longer word reaches the model as written, as does narration, whose composed
/// mark stops a command from running, so a caller skips the check for narration.
pub(crate) fn is_reset_request(text: &str) -> bool {
    text.split(char::is_whitespace)
        .next()
        .is_some_and(|first_token| CLAUDE_RESET_WORDS.contains(&first_token))
}

/// The `session.message.resetRefused` refusal of a message that would reset the session, which
/// is never reset in place.
pub(crate) fn reset_refusal() -> DomainError {
    DomainError::new(
        CLAUDE_RESET_REFUSAL_SENTENCE,
        RefusalCode::SessionMessageResetRefused,
    )
}

/// How far a failed write got: nothing written, or anything at or after the hand-off, since a
/// partial line can be read as a whole message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeWriteDelivery {
    /// No byte reached the process.
    Unsent,
    /// Some bytes may have reached it, so it may act on them.
    Indeterminate,
}

/// The settled outcome of one write to the process's input, reported rather than raised, since a
/// raised failure cannot tell "nothing left" from "the bytes are gone and a turn may be running".
#[derive(Debug)]
pub(crate) enum ClaudeWriteAttempt {
    /// The whole line was written.
    Written,
    /// The write failed.
    Failed {
        /// How far it got.
        delivery: ClaudeWriteDelivery,
        /// Why.
        cause: io::Error,
    },
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::is_reset_request;

    // Killed by dropping the check (every refused row passes), by a prefix match (`/clearance`
    // and `/news` are refused), by a case-insensitive match (`/CLEAR` is), by trimming leading
    // whitespace (` /clear` is) and by reading a later line (`/clear` on the second line is).
    #[rstest]
    #[case::clear("/clear", true)]
    #[case::reset("/reset", true)]
    #[case::new("/new", true)]
    #[case::before_a_space("/clear now", true)]
    #[case::before_a_tab("/new\tx", true)]
    #[case::before_a_line_break("/reset\nand go on", true)]
    #[case::another_case("/CLEAR", false)]
    #[case::longer_word("/clearance", false)]
    #[case::longer_new("/news", false)]
    #[case::leading_whitespace(" /clear", false)]
    #[case::no_slash("clear", false)]
    #[case::empty("", false)]
    #[case::second_line("go on\n/clear", false)]
    fn a_reset_request_is_a_whole_first_token_that_is_a_reset_word(
        #[case] text: &str,
        #[case] is_refused: bool,
    ) {
        assert_eq!(is_reset_request(text), is_refused, "{text:?}");
    }
}
