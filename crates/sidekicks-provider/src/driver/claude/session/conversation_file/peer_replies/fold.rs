//! A terminal session's transcript read for the messages awaited in it: the appended bytes split
//! into lines, each line read for the members a reply wait uses, and each line folded into what
//! became of each message, which started a turn, joined one under way, or has no record yet.

use std::cell::OnceCell;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use bytes::BytesMut;
use serde::Deserialize;
use tokio_util::codec::{AnyDelimiterCodec, Decoder as _};
use uuid::Uuid;

use crate::driver::claude::session::conversation_file::ConversationEntry;
use crate::driver::claude::session::process::CLAUDE_OUTPUT_LINE_MAX_BYTES;
use crate::inbound_json::decode_inbound_json;
use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};
use crate::port::session_message_reading_publisher::SessionMessageReading;

/// A transcript's bytes, handed in as they come, split into lines read as entries.
pub(super) struct TranscriptLines {
    file: PathBuf,
    codec: AnyDelimiterCodec,
    buffer: BytesMut,
    // Where in the file the next bytes handed in start.
    offset: u64,
    is_skip_logged: bool,
}

impl TranscriptLines {
    /// The lines of `file` from `offset`, where the first bytes handed in start.
    pub(super) fn new(file: &Path, offset: u64) -> Self {
        Self {
            file: file.to_path_buf(),
            codec: AnyDelimiterCodec::new_with_max_length(
                b"\n".to_vec(),
                Vec::new(),
                CLAUDE_OUTPUT_LINE_MAX_BYTES,
            ),
            buffer: BytesMut::new(),
            offset,
            is_skip_logged: false,
        }
    }

    /// The entries of the lines `chunk` completes, the file's next bytes; the bytes before
    /// `lowest_start` are skipped unread, and a line past the ceiling is skipped, logged once.
    pub(super) fn take(&mut self, chunk: &[u8], lowest_start: u64) -> Vec<TranscriptLine> {
        let skipped = usize::try_from(lowest_start.saturating_sub(self.offset))
            .unwrap_or(usize::MAX)
            .min(chunk.len());
        self.offset += chunk.len() as u64;
        if skipped > 0 {
            // A line begun before the skip cannot be read whole.
            self.buffer.clear();
        }
        self.buffer.extend_from_slice(&chunk[skipped..]);
        let mut lines = Vec::new();
        loop {
            match self.codec.decode(&mut self.buffer) {
                Ok(Some(line)) => lines.extend(read_line(&line)),
                Ok(None) => return lines,
                // The codec only fails at the ceiling, and drops that line's rest itself.
                Err(_) => {
                    if !self.is_skip_logged {
                        self.is_skip_logged = true;
                        tracing::warn!(
                            file = %self.file.display(),
                            "a line of a Claude Code transcript passed the line ceiling, so it \
                             was skipped"
                        );
                    }
                }
            }
        }
    }
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

// The line's entry, or `None` for a line that is not one JSON object.
fn read_line(line: &[u8]) -> Option<TranscriptLine> {
    let text = decode_inbound_json(line);
    let mut deserializer = serde_json::Deserializer::from_str(&text);
    let entry = PeerEntry::read(&mut deserializer).ok().flatten()?;
    deserializer.end().ok()?;
    let prompt_text = (entry.entry_type.as_deref() == Some("user") && entry.turn_origin.is_none())
        .then(|| text.into_owned());
    Some(TranscriptLine {
        entry,
        prompt_text,
        starts_turn: OnceCell::new(),
    })
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

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    block_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    text: Option<String>,
}

lenient_object!(PeerEntry, PeerAttachment, PeerMessage, ContentBlock);

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
    use serde_json::{Value, json};

    use super::{AwaitedMessage, TranscriptLine, read_line};
    use crate::port::session_message_reading_publisher::SessionMessageReading;

    const MESSAGE: &str = "6f1c1e0a-0000-4000-8000-0000000000a1";
    const FIRST_REPLY: &str = "6f1c1e0a-0000-4000-8000-000000000001";
    const TOOL_RESULT: &str = "6f1c1e0a-0000-4000-8000-000000000002";
    const LAST_REPLY: &str = "6f1c1e0a-0000-4000-8000-000000000003";

    fn line(record: &Value) -> TranscriptLine {
        read_line(record.to_string().as_bytes()).expect("the record is one JSON object")
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
