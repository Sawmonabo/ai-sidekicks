//! The text and thinking Claude Code streams while it writes a response, as `stream_event` frames
//! under `--include-partial-messages`: each block's pieces go out as stored pieces of its message,
//! and the block's assistant frame, which arrives before the block's stop, sends what the pieces
//! have not yet carried. A response Claude Code cut short drops what still waits of the blocks it
//! will never finish. The frames are untrusted, so each member is read leniently.

use std::collections::{BTreeSet, HashMap};

use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::event::declared_variants::RunAgentOutputPayload;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::time::Instant;

use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::delivery::messages::{
    ClaudeMessageBody, ClaudeMessageFrame, ClaudeMessageRow, ClaudeMessageRowKind,
};
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::driver::reorder_buffer::ReorderPairingRole;
use crate::provider::driver::streamed_text::{
    StreamedText, StreamedTextCompletion, StreamedTextPiece,
};
use crate::provider::lenient_json::{lenient_object, read_lenient};
use crate::session::run::inbound::rows::LateAppendableRow;

/// The run a streamed block's rows belong to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[expect(
    dead_code,
    reason = "the Claude driver's stream reader names each streamed block's run with it"
)]
pub(crate) struct ClaudeStreamedRun {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: RunId,
}

/// A streamed block's key, which names the events its pieces are written as: its response's API
/// message id and its index in that response.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ClaudeStreamedBlockKey {
    /// The response's API message id.
    pub(crate) message_id: String,
    /// The block's index in the response.
    pub(crate) block_index: u64,
}

/// One stored piece of a streamed block, as the row it is written as, under the block's key.
pub(crate) struct ClaudeStreamedPiece {
    /// The block's key.
    #[expect(
        dead_code,
        reason = "the Claude driver's stream reader writes each piece under it"
    )]
    pub(crate) block_key: ClaudeStreamedBlockKey,
    /// The row, its body the piece.
    #[expect(
        dead_code,
        reason = "the Claude driver's stream reader writes each piece as it"
    )]
    pub(crate) row: ClaudeMessageRow,
}

/// Whether a streamed block is a reply's text or its thinking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProseKind {
    Text,
    Thinking,
}

/// The row a streamed block's pieces are written as, without its body.
#[derive(Clone)]
struct ProseRow {
    kind: ProseKind,
    payload: RunAgentOutputPayload,
}

impl ProseRow {
    fn with_body(&self, body: String) -> ClaudeMessageRow {
        ClaudeMessageRow {
            tool_call_id: None,
            pairing_role: ReorderPairingRole::Unpaired,
            row: match self.kind {
                ProseKind::Thinking => ClaudeMessageRowKind::Thinking {
                    payload: self.payload.clone(),
                    content: body,
                },
                ProseKind::Text => ClaudeMessageRowKind::Session {
                    row: LateAppendableRow::AgentMessageSent(self.payload.clone()),
                    body: ClaudeMessageBody::Text(body),
                },
            },
        }
    }

    // The prose row an assistant frame's row is, or `None` for a tool call or a result.
    fn of(row: &ClaudeMessageRow) -> Option<(Self, &str)> {
        match &row.row {
            ClaudeMessageRowKind::Thinking { payload, content } => Some((
                Self {
                    kind: ProseKind::Thinking,
                    payload: payload.clone(),
                },
                content.as_str(),
            )),
            ClaudeMessageRowKind::Session {
                row: LateAppendableRow::AgentMessageSent(payload),
                body: ClaudeMessageBody::Text(text),
            } => Some((
                Self {
                    kind: ProseKind::Text,
                    payload: payload.clone(),
                },
                text.as_str(),
            )),
            ClaudeMessageRowKind::Session { .. } => None,
        }
    }
}

// What one `stream_event` frame says, naming the response by its API message id, the
// `message.id` its assistant frames carry.
enum ClaudeStreamEvent {
    BlockStarted {
        message_id: String,
        block_index: u64,
    },
    BlockStopped {
        message_id: String,
    },
    ProsePiece {
        message_id: String,
        block_index: u64,
        kind: ProseKind,
        piece: String,
    },
    MessageStopped {
        message_id: String,
        // The index from which the response's blocks will never get an assistant frame.
        abandoned_from_index: Option<u64>,
    },
}

#[derive(Deserialize)]
struct StreamEventFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    api_message_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    event: Option<StreamEvent>,
    // Claude Code puts the cut-short blocks beside the event, on the frame itself.
    #[serde(default, deserialize_with = "read_lenient")]
    abandoned_blocks: Option<AbandonedBlocks>,
}

#[derive(Deserialize)]
struct StreamEvent {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    event_type: Option<String>,
    #[serde(default)]
    index: Option<Value>,
    #[serde(default, deserialize_with = "read_lenient")]
    delta: Option<StreamDelta>,
}

#[derive(Deserialize)]
struct StreamDelta {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    delta_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    text: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    thinking: Option<String>,
}

#[derive(Deserialize)]
struct AbandonedBlocks {
    #[serde(default)]
    from_block_index: Option<Value>,
}

lenient_object!(StreamEventFrame, StreamEvent, StreamDelta, AbandonedBlocks);

/// The blocks one session's process is streaming, from their first piece to their turn's end.
pub(crate) struct ClaudeStreamedBlocks {
    provider_account_id: Option<ProviderAccountId>,
    text: StreamedText<ClaudeStreamedBlockKey>,
    // The row each streamed block's pieces are written as, by its key.
    prose_rows: HashMap<ClaudeStreamedBlockKey, ProseRow>,
    // The block each response is streaming now, by its API message id.
    streaming_block_by_message: HashMap<String, u64>,
    // The streamed blocks of each response no assistant frame has finished yet.
    unfinished_blocks_by_message: HashMap<String, BTreeSet<u64>>,
    // The key of the block each assistant frame of the open turn finished, by the frame's uuid.
    block_key_by_message_uuid: HashMap<String, ClaudeStreamedBlockKey>,
}

impl ClaudeStreamedBlocks {
    /// The blocks of a process running on `provider_account_id`'s home.
    #[expect(
        dead_code,
        reason = "the Claude Code stream reader keeps one per session's process"
    )]
    pub(crate) fn new(provider_account_id: Option<ProviderAccountId>) -> Self {
        Self {
            provider_account_id,
            text: StreamedText::default(),
            prose_rows: HashMap::new(),
            streaming_block_by_message: HashMap::new(),
            unfinished_blocks_by_message: HashMap::new(),
            block_key_by_message_uuid: HashMap::new(),
        }
    }

    /// Takes one `stream_event` frame's text of the run's turn at `now`; answers the deadline a
    /// piece it began waiting goes out by, for the session's one timer.
    #[expect(
        dead_code,
        reason = "the Claude driver's stream reader takes each stream event through it"
    )]
    pub(crate) fn observe(
        &mut self,
        frame: &str,
        run: ClaudeStreamedRun,
        now: Instant,
    ) -> Option<Instant> {
        match read_stream_event(frame)? {
            ClaudeStreamEvent::BlockStarted {
                message_id,
                block_index,
            } => {
                self.streaming_block_by_message
                    .insert(message_id, block_index);
                None
            }
            ClaudeStreamEvent::BlockStopped { message_id } => {
                self.streaming_block_by_message.remove(&message_id);
                None
            }
            ClaudeStreamEvent::ProsePiece {
                message_id,
                block_index,
                kind,
                piece,
            } => {
                let provider_message_id =
                    FreeFormText::<EVENT_FIELD_MAX_LEN>::new(message_id.clone()).ok()?;
                let key = ClaudeStreamedBlockKey {
                    message_id: message_id.clone(),
                    block_index,
                };
                self.unfinished_blocks_by_message
                    .entry(message_id)
                    .or_default()
                    .insert(block_index);
                self.prose_rows
                    .entry(key.clone())
                    .or_insert_with(|| ProseRow {
                        kind,
                        payload: RunAgentOutputPayload {
                            session_id: run.session_id,
                            provider_message_id,
                            content_type: None,
                            run_id: run.run_id,
                            provider_block: None,
                            origin: None,
                            source_epoch: None,
                            source_position: None,
                            content_length: None,
                            content_truncated: None,
                        },
                    });
                self.text.append(&key, &run.run_id.to_string(), &piece, now)
            }
            ClaudeStreamEvent::MessageStopped {
                message_id,
                abandoned_from_index,
            } => {
                self.drop_abandoned(run.session_id, &message_id, abandoned_from_index);
                None
            }
        }
    }

    /// The earliest deadline a waiting piece goes out by.
    #[expect(
        dead_code,
        reason = "the Claude Code stream reader arms its timer on it"
    )]
    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.text.next_deadline()
    }

    /// The pieces whose interval has passed by `now`.
    #[expect(
        dead_code,
        reason = "the Claude Code stream reader writes them when its timer fires"
    )]
    pub(crate) fn due(&mut self, now: Instant) -> Vec<ClaudeStreamedPiece> {
        let pieces = self.text.due(now);
        self.rows_of(pieces)
    }

    /// Finishes, with an assistant frame's text or thinking `rows`, the block it was streamed as:
    /// answers the pieces that carry what the streamed ones did not, and the frame's rows that
    /// streamed as no block. A final text that does not begin with what streamed is recorded, the
    /// streamed pieces standing.
    #[expect(
        dead_code,
        reason = "the Claude driver's stream reader finishes each streamed block through it"
    )]
    pub(crate) fn finish(
        &mut self,
        frame: &ClaudeMessageFrame,
        rows: Vec<ClaudeMessageRow>,
    ) -> (Vec<ClaudeStreamedPiece>, Vec<ClaudeMessageRow>) {
        let streamed = frame.provider_message_id().and_then(|message_id| {
            self.streaming_block_by_message
                .get(message_id)
                .map(|block_index| (message_id.to_owned(), *block_index))
        });
        let Some((message_id, block_index)) = streamed else {
            return (Vec::new(), rows);
        };
        let key = ClaudeStreamedBlockKey {
            message_id: message_id.clone(),
            block_index,
        };
        let mut pieces = Vec::new();
        let mut unstreamed = Vec::new();
        for row in rows {
            let Some((prose, final_text)) = ProseRow::of(&row) else {
                unstreamed.push(row);
                continue;
            };
            if let Some(unfinished) = self.unfinished_blocks_by_message.get_mut(&message_id) {
                unfinished.remove(&block_index);
            }
            if let Some(uuid) = frame.uuid() {
                self.block_key_by_message_uuid
                    .insert(uuid.to_owned(), key.clone());
            }
            self.prose_rows.remove(&key);
            let last_piece = match self.text.complete(&key, final_text) {
                StreamedTextCompletion::Completed { last_piece } => last_piece,
                StreamedTextCompletion::Diverged { last_piece } => {
                    self.report(
                        DriverDiagnosticKind::StreamedTextDiverged,
                        "assistant",
                        "the assistant frame's text does not begin with what streamed of its \
                         block, so the streamed pieces stand and the frame's text is not written \
                         again",
                        Map::from_iter([
                            ("messageId".to_owned(), Value::from(message_id.clone())),
                            ("blockIndex".to_owned(), Value::from(block_index)),
                        ]),
                    );
                    last_piece
                }
            };
            pieces.extend(last_piece.map(|piece| ClaudeStreamedPiece {
                block_key: key.clone(),
                row: prose.with_body(piece),
            }));
        }
        (pieces, unstreamed)
    }

    /// The key of the block the open turn's assistant frame `message_uuid` finished, if it
    /// streamed.
    #[expect(
        dead_code,
        reason = "the Claude Code stream reader keys a finished block's rows by it"
    )]
    pub(crate) fn block_key_for(&self, message_uuid: &str) -> Option<&ClaudeStreamedBlockKey> {
        self.block_key_by_message_uuid.get(message_uuid)
    }

    /// Forgets the open turn's assistant frames, as the next turn opens.
    #[expect(
        dead_code,
        reason = "the Claude Code stream reader calls it as each turn opens"
    )]
    pub(crate) fn open_turn(&mut self) {
        self.block_key_by_message_uuid.clear();
    }

    /// Answers what still waits of the blocks `run_id`'s turn left unfinished, as the turn ends.
    #[expect(
        dead_code,
        reason = "the Claude Code stream reader calls it as each turn ends"
    )]
    pub(crate) fn end_turn(&mut self, run_id: RunId) -> Vec<ClaudeStreamedPiece> {
        let pieces = self.text.end_turn(&run_id.to_string());
        self.streaming_block_by_message.clear();
        self.unfinished_blocks_by_message.clear();
        let rows = self.rows_of(pieces);
        self.prose_rows
            .retain(|_, row| row.payload.run_id != run_id);
        rows
    }

    /// Answers what still waits of every block, as the session's process is gone.
    #[expect(
        dead_code,
        reason = "the Claude Code stream reader calls it as its process ends"
    )]
    pub(crate) fn end_all(&mut self) -> Vec<ClaudeStreamedPiece> {
        let pieces = self.text.end_all();
        let rows = self.rows_of(pieces);
        self.prose_rows.clear();
        rows
    }

    // The rows of streamed pieces.
    fn rows_of(
        &self,
        pieces: Vec<StreamedTextPiece<ClaudeStreamedBlockKey>>,
    ) -> Vec<ClaudeStreamedPiece> {
        pieces
            .into_iter()
            .filter_map(|piece| {
                let row = self.prose_rows.get(&piece.key)?.with_body(piece.text);
                Some(ClaudeStreamedPiece {
                    block_key: piece.key,
                    row,
                })
            })
            .collect()
    }

    fn drop_abandoned(&mut self, session_id: SessionId, message_id: &str, from: Option<u64>) {
        let (Some(from), Some(unfinished)) =
            (from, self.unfinished_blocks_by_message.get_mut(message_id))
        else {
            return;
        };
        let abandoned = unfinished.split_off(&from);
        if abandoned.is_empty() {
            return;
        }
        let stored_block_count = abandoned
            .into_iter()
            .filter(|block_index| {
                let key = ClaudeStreamedBlockKey {
                    message_id: message_id.to_owned(),
                    block_index: *block_index,
                };
                self.prose_rows.remove(&key);
                self.text.discard(&key)
            })
            .count();
        self.report(
            DriverDiagnosticKind::StreamedBlocksAbandoned,
            "stream_event",
            "Claude Code stopped reading a response and will never finish these blocks, so what \
             still waited of them is dropped; pieces already stored stay",
            Map::from_iter([
                ("sessionId".to_owned(), Value::from(session_id.to_string())),
                ("messageId".to_owned(), Value::from(message_id)),
                ("fromBlockIndex".to_owned(), Value::from(from)),
                (
                    "storedBlockCount".to_owned(),
                    Value::from(stored_block_count),
                ),
            ]),
        );
    }

    fn report(
        &self,
        kind: DriverDiagnosticKind,
        raw_wire_type: &str,
        disposition_reason: &str,
        details: Map<String, Value>,
    ) {
        emit_driver_diagnostic(&DriverDiagnosticRecord {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id: self.provider_account_id.clone(),
            kind,
            raw_wire_type: Some(raw_wire_type.to_owned()),
            disposition_reason: disposition_reason.to_owned(),
            details,
        });
    }
}

fn read_stream_event(frame: &str) -> Option<ClaudeStreamEvent> {
    let frame: StreamEventFrame = serde_json::from_str(frame).ok()?;
    let message_id = frame.api_message_id.filter(|id| !id.is_empty())?;
    let event = frame.event?;
    let block_index = event.index.as_ref().and_then(read_block_index);
    match event.event_type.as_deref()? {
        "content_block_start" => Some(ClaudeStreamEvent::BlockStarted {
            message_id,
            block_index: block_index?,
        }),
        "content_block_stop" => Some(ClaudeStreamEvent::BlockStopped { message_id }),
        "content_block_delta" => {
            let delta = event.delta?;
            let (kind, piece) = match delta.delta_type.as_deref()? {
                "text_delta" => (ProseKind::Text, delta.text?),
                "thinking_delta" => (ProseKind::Thinking, delta.thinking?),
                _ => return None,
            };
            Some(ClaudeStreamEvent::ProsePiece {
                message_id,
                block_index: block_index?,
                kind,
                piece,
            })
        }
        "message_stop" => Some(ClaudeStreamEvent::MessageStopped {
            message_id,
            abandoned_from_index: frame
                .abandoned_blocks
                .and_then(|abandoned| abandoned.from_block_index)
                .as_ref()
                .and_then(read_block_index),
        }),
        _ => None,
    }
}

// A whole, non-negative block index; a fraction or a negative number is none.
fn read_block_index(value: &Value) -> Option<u64> {
    value.as_u64()
}
