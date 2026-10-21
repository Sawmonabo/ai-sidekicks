//! The user message a Claude Code process reads on its input in streaming-input mode: the words,
//! with any pictures as their own blocks, under the uuid a withdraw and a conversation cut address
//! it by; and how far a failed write of one got.

use std::io;

use serde::Serialize;

use crate::provider::outbound_text::{OutboundText, OutboundTextOrigin};

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
    #[expect(
        dead_code,
        reason = "the Claude driver's message writes send pictures with it"
    )]
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
    #[expect(
        dead_code,
        reason = "the Claude driver's message writes send pictures with it"
    )]
    Base64 {
        /// Its format.
        media_type: ClaudePictureMediaType,
        /// Its bytes in base64.
        data: String,
    },
}

/// The picture formats Claude Code's image block takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) enum ClaudePictureMediaType {
    /// JPEG.
    #[serde(rename = "image/jpeg")]
    #[expect(
        dead_code,
        reason = "the Claude driver's message writes send pictures with it"
    )]
    Jpeg,
    /// PNG.
    #[serde(rename = "image/png")]
    #[expect(
        dead_code,
        reason = "the Claude driver's message writes send pictures with it"
    )]
    Png,
    /// GIF.
    #[serde(rename = "image/gif")]
    #[expect(
        dead_code,
        reason = "the Claude driver's message writes send pictures with it"
    )]
    Gif,
    /// WebP.
    #[serde(rename = "image/webp")]
    #[expect(
        dead_code,
        reason = "the Claude driver's message writes send pictures with it"
    )]
    Webp,
}

/// When a running turn reads a message: at once, at its next step, or after it ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ClaudeMessagePriority {
    /// At once, stopping what the turn is doing.
    #[expect(
        dead_code,
        reason = "the Claude driver's message writes queue each message with it"
    )]
    Now,
    /// At the turn's next step.
    #[expect(
        dead_code,
        reason = "the Claude driver's message writes queue each message with it"
    )]
    Next,
    /// Once the turn ends.
    #[expect(
        dead_code,
        reason = "the Claude driver's message writes queue each message with it"
    )]
    Later,
}

/// The user message for one piece of provider-bound text, its words unchanged, followed by its
/// files' blocks in staging order. Only text the daemon composed to tell the agent what happened is
/// marked composed: the person's text and a command the daemon sends for Claude Code to run stay
/// unmarked, since the mark expands no `@path` and stops a command from running.
pub(crate) fn compose_claude_user_frame(
    outbound_text: &OutboundText,
    message_uuid: String,
    attachment_blocks: Vec<ClaudeUserContentBlock>,
) -> ClaudeUserFrame {
    let content = if attachment_blocks.is_empty() {
        ClaudeUserContent::Text(outbound_text.text.clone())
    } else {
        let mut blocks = Vec::with_capacity(attachment_blocks.len() + 1);
        blocks.push(ClaudeUserContentBlock::Text {
            text: outbound_text.text.clone(),
        });
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
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude Code process reports each write with it"
        )
    )]
    Written,
    /// The write failed.
    Failed {
        /// How far it got.
        delivery: ClaudeWriteDelivery,
        /// Why.
        cause: io::Error,
    },
}
