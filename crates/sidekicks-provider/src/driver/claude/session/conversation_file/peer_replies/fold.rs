//! A terminal session's transcript read for the messages awaited in it: each line the appended
//! bytes complete read for the members a reply wait uses, and folded into what became of each
//! message, which started a turn, joined one under way, or has no record yet.

use std::cell::OnceCell;
use std::collections::HashSet;
use std::ops::ControlFlow;

use serde::Deserialize;
use uuid::Uuid;

use crate::driver::claude::session::conversation_file::lines::{
    ConversationLine, ConversationLines,
};
use crate::driver::claude::session::conversation_file::{ContentBlock, ConversationEntry};
use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};
use crate::port::session_message_reading_publisher::SessionMessageReading;

/// The transcript lines `chunk`, the transcript's next bytes handed to `lines`, completes; the
/// bytes before `lowest_start` are skipped unread.
pub(super) fn take_transcript_lines(
    lines: &mut ConversationLines,
    chunk: &[u8],
    lowest_start: u64,
) -> Vec<TranscriptLine> {
    let mut read = Vec::new();
    let _whole = lines.take::<PeerEntry>(chunk, lowest_start, |line| {
        read.push(transcript_line(line));
        ControlFlow::Continue(())
    });
    read
}

/// One transcript line as a reply wait reads it.
pub(super) struct TranscriptLine {
    entry: PeerEntry,
    // The line's text, kept for a `user` record no peer started, to ask whether a person wrote it.
    prompt_text: Option<String>,
    starts_turn: OnceCell<bool>,
}

impl TranscriptLine {
    // Whether the line starts a turn of its own: a `user` record a peer started, or a person's
    // prompt.
    fn starts_turn(&self) -> bool {
        *self.starts_turn.get_or_init(|| {
            self.entry.entry_type.as_deref() == Some("user")
                && (self.entry.turn_origin.is_some()
                    || self.prompt_text.as_deref().is_some_and(is_person_prompt))
        })
    }
}

// Whether `text` is a person's prompt, as the conversation's outline reads one.
fn is_person_prompt(text: &str) -> bool {
    let mut deserializer = serde_json::Deserializer::from_str(text);
    ConversationEntry::read(&mut deserializer)
        .ok()
        .flatten()
        .is_some_and(|entry| entry.is_person_prompt())
}

// The line as a reply wait reads it, its text kept for a `user` record no peer started.
fn transcript_line(line: ConversationLine<'_, PeerEntry>) -> TranscriptLine {
    let entry = line.entry;
    let prompt_text = (entry.entry_type.as_deref() == Some("user") && entry.turn_origin.is_none())
        .then(|| line.text.to_owned());
    TranscriptLine {
        entry,
        prompt_text,
        starts_turn: OnceCell::new(),
    }
}

// The members of a transcript entry a reply wait reads, each read leniently.
#[derive(Deserialize)]
struct PeerEntry {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    entry_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    uuid: Option<String>,
    #[serde(rename = "parentUuid", default, deserialize_with = "read_lenient")]
    parent_uuid: Option<String>,
    #[serde(rename = "isSidechain", default, deserialize_with = "read_lenient")]
    is_sidechain: Option<bool>,
    #[serde(rename = "turnOrigin", default, deserialize_with = "read_lenient")]
    turn_origin: Option<String>,
    #[serde(rename = "mergedSendUuids", default, deserialize_with = "read_lenient")]
    merged_send_uuids: Option<LenientList<String>>,
    #[serde(default, deserialize_with = "read_lenient")]
    attachment: Option<PeerAttachment>,
    #[serde(default, deserialize_with = "read_lenient")]
    message: Option<PeerMessage>,
}

#[derive(Deserialize)]
struct PeerAttachment {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    attachment_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    source_uuid: Option<String>,
}

#[derive(Deserialize)]
struct PeerMessage {
    #[serde(default, deserialize_with = "read_lenient")]
    id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    content: Option<LenientList<ContentBlock>>,
}

lenient_object!(PeerEntry, PeerAttachment, PeerMessage);

/// One message awaited in a transcript, and what its lines so far tell of it.
pub(super) struct AwaitedMessage {
    /// The transcript's length as the message was sent, where its records can first be.
    pub(super) start_offset: u64,
    // Whether its `Delivered` was published, so a read again publishes it once.
    is_delivered: bool,
    turn: TurnReading,
}

// What the lines so far tell of one message.
enum TurnReading {
    // No record of it yet.
    Unseen,
    // It joined a turn under way, which answers it nothing.
    Absorbed,
    // It started a turn: the uuid of the record that started it, the ids of the turn's records,
    // and its last reply so far.
    Started {
        root_record: String,
        turn_ids: HashSet<Uuid>,
        reply: Option<Reply>,
    },
}

// One assistant message's text blocks, joined in order.
struct Reply {
    message_id: Option<String>,
    text: String,
}

impl AwaitedMessage {
    /// A message sent when the transcript held `start_offset` bytes.
    pub(super) fn new(start_offset: u64) -> Self {
        Self {
            start_offset,
            is_delivered: false,
            turn: TurnReading::Unseen,
        }
    }

    /// Forgets what the lines told, for a read again from the start offset; a `Delivered` already
    /// published stays so.
    pub(super) fn reread(&mut self) {
        self.turn = TurnReading::Unseen;
    }

    /// Folds `line` into what became of the message `message_id`: its own record, or a merged
    /// start naming it, starts its turn; a queued command naming it joins a turn under way; a
    /// record whose parent is in its turn joins it, unless it starts a turn of its own; a side
    /// chain's record is passed over. The `Delivered` the line first shows, if any.
    pub(super) fn fold(
        &mut self,
        message_id: &str,
        line: &TranscriptLine,
    ) -> Option<SessionMessageReading> {
        let entry = &line.entry;
        if entry.is_sidechain == Some(true) {
            return None;
        }
        let is_user = entry.entry_type.as_deref() == Some("user");
        let is_own_start = is_user
            && (entry.uuid.as_deref() == Some(message_id)
                || entry.merged_send_uuids.as_ref().is_some_and(|merged| {
                    merged.0.iter().any(|merged_id| merged_id == message_id)
                }));
        let is_queued = entry.entry_type.as_deref() == Some("attachment")
            && entry.attachment.as_ref().is_some_and(|attachment| {
                attachment.attachment_type.as_deref() == Some("queued_command")
                    && attachment.source_uuid.as_deref() == Some(message_id)
            });
        if is_own_start || is_queued {
            if !matches!(self.turn, TurnReading::Unseen) {
                return None;
            }
            self.turn = if is_own_start {
                TurnReading::Started {
                    // A start record with no uuid, which Claude Code always writes, names the
                    // message's own turn.
                    root_record: entry.uuid.clone().unwrap_or_else(|| message_id.to_owned()),
                    turn_ids: entry
                        .uuid
                        .as_deref()
                        .and_then(read_uuid)
                        .into_iter()
                        .collect(),
                    reply: None,
                }
            } else {
                TurnReading::Absorbed
            };
            return (!std::mem::replace(&mut self.is_delivered, true)).then(|| {
                SessionMessageReading::Delivered {
                    message_id: message_id.to_owned(),
                }
            });
        }
        let TurnReading::Started {
            turn_ids, reply, ..
        } = &mut self.turn
        else {
            return None;
        };
        let is_in_turn = entry
            .parent_uuid
            .as_deref()
            .and_then(read_uuid)
            .is_some_and(|parent| turn_ids.contains(&parent));
        if !is_in_turn || line.starts_turn() {
            return None;
        }
        // A record already folded, as a read again over lines a watch folded meets it, adds
        // nothing more.
        if let Some(uuid) = entry.uuid.as_deref().and_then(read_uuid)
            && !turn_ids.insert(uuid)
        {
            return None;
        }
        if entry.entry_type.as_deref() == Some("assistant")
            && let Some(message) = &entry.message
        {
            let texts = message
                .content
                .iter()
                .flat_map(|blocks| &blocks.0)
                .filter(|block| block.block_type.as_deref() == Some("text"))
                .filter_map(|block| block.text.as_deref());
            match reply {
                Some(last) if last.message_id == message.id => last.text.extend(texts),
                Some(_) | None => {
                    *reply = Some(Reply {
                        message_id: message.id.clone(),
                        text: texts.collect(),
                    });
                }
            }
        }
        None
    }

    /// What the message's idle notice publishes: a started turn its root record and answer, no
    /// answer where its last reply held no text, a message absorbed into a turn nothing more, and
    /// one with no record `NotDelivered`.
    pub(super) fn settle(self, message_id: String) -> Option<SessionMessageReading> {
        match self.turn {
            TurnReading::Started {
                root_record, reply, ..
            } => Some(SessionMessageReading::Answered {
                message_id,
                turn_record: root_record,
                answer: reply
                    .map(|reply| reply.text)
                    .filter(|text| !text.is_empty()),
            }),
            TurnReading::Absorbed => None,
            TurnReading::Unseen => Some(SessionMessageReading::NotDelivered { message_id }),
        }
    }
}

fn read_uuid(text: &str) -> Option<Uuid> {
    Uuid::parse_str(text).ok()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::{Value, json};

    use super::{AwaitedMessage, TranscriptLine, take_transcript_lines};
    use crate::driver::claude::session::conversation_file::lines::ConversationLines;
    use crate::port::session_message_reading_publisher::SessionMessageReading;

    const MESSAGE: &str = "6f1c1e0a-0000-4000-8000-0000000000a1";
    const FIRST_REPLY: &str = "6f1c1e0a-0000-4000-8000-000000000001";
    const TOOL_RESULT: &str = "6f1c1e0a-0000-4000-8000-000000000002";
    const LAST_REPLY: &str = "6f1c1e0a-0000-4000-8000-000000000003";

    fn line(record: &Value) -> TranscriptLine {
        let mut lines = ConversationLines::new(Path::new("transcript.jsonl"), 0);
        take_transcript_lines(&mut lines, format!("{record}\n").as_bytes(), 0)
            .pop()
            .expect("the record is one JSON object")
    }

    fn peer_start() -> TranscriptLine {
        line(&json!({
            "type": "user", "uuid": MESSAGE, "parentUuid": null, "turnOrigin": "peer",
            "message": {"role": "user", "content": "a peer's message"},
        }))
    }

    // Killed by a record folded again appending its text again (the answer reads "oursours").
    #[test]
    fn a_record_folded_twice_answers_its_text_once() {
        let mut message = AwaitedMessage::new(0);
        let reply = line(&json!({
            "type": "assistant", "uuid": FIRST_REPLY, "parentUuid": MESSAGE,
            "message": {"id": "msg-ours", "content": [{"type": "text", "text": "ours"}]},
        }));
        for folded in [peer_start(), reply] {
            message.fold(MESSAGE, &folded);
            message.fold(MESSAGE, &folded);
        }

        assert_eq!(
            message.settle(MESSAGE.to_owned()),
            Some(SessionMessageReading::Answered {
                message_id: MESSAGE.to_owned(),
                turn_record: MESSAGE.to_owned(),
                answer: Some("ours".to_owned()),
            })
        );
    }

    // Killed by a turn whose last reply holds no text answering an empty text.
    #[test]
    fn a_turn_whose_last_reply_holds_no_text_answers_nothing() {
        let mut message = AwaitedMessage::new(0);
        for folded in [
            peer_start(),
            line(&json!({
                "type": "assistant", "uuid": FIRST_REPLY, "parentUuid": MESSAGE,
                "message": {"id": "msg-first", "content": [{"type": "text", "text": "looking"}]},
            })),
            line(&json!({
                "type": "user", "uuid": TOOL_RESULT, "parentUuid": FIRST_REPLY,
                "message": {"role": "user", "content": [{"type": "tool_result"}]},
            })),
            line(&json!({
                "type": "assistant", "uuid": LAST_REPLY, "parentUuid": TOOL_RESULT,
                "message": {"id": "msg-last", "content": [{"type": "tool_use", "name": "Read"}]},
            })),
        ] {
            message.fold(MESSAGE, &folded);
        }

        assert_eq!(
            message.settle(MESSAGE.to_owned()),
            Some(SessionMessageReading::Answered {
                message_id: MESSAGE.to_owned(),
                turn_record: MESSAGE.to_owned(),
                answer: None,
            })
        );
    }
}
