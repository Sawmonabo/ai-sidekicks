//! The text and thinking Claude Code streams while it writes a response, as `stream_event` frames
//! under `--include-partial-messages`: each block's pieces go out as stored pieces of its message,
//! and the block's assistant frame, before or after the block's stop, sends what the pieces have
//! not yet carried. A response Claude Code cut short drops what still waits of the blocks it will
//! never finish. Each piece names its block by its index and by the response under its message's
//! id it came in, since Claude Code can send a second response under an id it already sent. The
//! frames are untrusted, so each member is read leniently.

use std::collections::{BTreeSet, HashMap};

use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::event::declared_variants::{ProviderBlock, RunAgentOutputPayload};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::time::Instant;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::messages::{
    ClaudeMessageBody, ClaudeMessageFrame, ClaudeMessageRow, ClaudeMessageRowKind,
};
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::driver::reorder_buffer::ReorderPairingRole;
use crate::driver::streamed_text::{StreamedText, StreamedTextCompletion, StreamedTextPiece};
use crate::lenient_json::{lenient_object, read_lenient};
use crate::run::delivery::LateAppendableRow;

/// The run a streamed block's rows belong to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeStreamedRun {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: RunId,
}

/// A streamed block's key, which names the events its pieces are written as: its response's API
/// message id, which response under that id it is, and its index in that response.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ClaudeStreamedBlockKey {
    /// The response's API message id.
    pub(crate) message_id: String,
    /// Which response under the id it is, from 1.
    pub(crate) attempt: u64,
    /// The block's index in the response.
    pub(crate) block_index: u64,
}

impl ClaudeStreamedBlockKey {
    /// The block a piece of this block names.
    pub(crate) fn provider_block(&self) -> Option<ProviderBlock> {
        ProviderBlock::new(self.block_index, self.attempt)
    }
}

/// One stored piece of a streamed block, as the row it is written as, under the block's key.
pub(crate) struct ClaudeStreamedPiece {
    /// The block's key.
    pub(crate) block_key: ClaudeStreamedBlockKey,
    /// The row, its body the piece.
    pub(crate) row: ClaudeMessageRow,
}

/// Whether a streamed block is a reply's text or its thinking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProseKind {
    /// A reply's text.
    Text,
    /// Its thinking.
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

/// What one `stream_event` frame says, naming the response by its API message id, the
/// `message.id` its assistant frames carry.
pub(crate) enum ClaudeStreamEvent {
    /// A response under the id opened.
    MessageStarted {
        /// The response's API message id.
        message_id: String,
    },
    /// A block of the response opened.
    BlockStarted {
        /// The response's API message id.
        message_id: String,
        /// The block's index in the response.
        block_index: u64,
    },
    /// A piece of a text or thinking block.
    ProsePiece {
        /// The response's API message id.
        message_id: String,
        /// The block's index in the response.
        block_index: u64,
        /// Whether the block is text or thinking.
        kind: ProseKind,
        /// The piece's text.
        piece: String,
    },
    /// The response ended.
    MessageStopped {
        /// The response's API message id.
        message_id: String,
        /// The index from which the response's blocks will never get an assistant frame.
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

/// Which response under each API message id is streaming and the block it last started, as one
/// process's `stream_event` frames say.
#[derive(Debug, Default)]
pub(crate) struct ClaudeStreamedResponses {
    // Which response under each id is streaming, from 1: a `message_start` under an id already
    // seen opens the id's next response, as Claude Code may send two under one id.
    attempt_by_message: HashMap<String, u64>,
    // The key of the block each response last started, kept past the block's stop until an
    // assistant frame finishes it, whichever of the two comes first.
    started_block_by_message: HashMap<String, ClaudeStreamedBlockKey>,
}

impl ClaudeStreamedResponses {
    /// Takes a response's opening or a block's start; any other event changes nothing.
    pub(crate) fn observe(&mut self, event: &ClaudeStreamEvent) {
        match event {
            ClaudeStreamEvent::MessageStarted { message_id } => {
                *self
                    .attempt_by_message
                    .entry(message_id.clone())
                    .or_default() += 1;
                // A block the response before left unfinished gets no frame of this one.
                self.started_block_by_message.remove(message_id);
            }
            ClaudeStreamEvent::BlockStarted {
                message_id,
                block_index,
            } => {
                let key = ClaudeStreamedBlockKey {
                    message_id: message_id.clone(),
                    attempt: self.attempt_of(message_id),
                    block_index: *block_index,
                };
                self.started_block_by_message
                    .insert(message_id.clone(), key);
            }
            ClaudeStreamEvent::ProsePiece { .. } | ClaudeStreamEvent::MessageStopped { .. } => {}
        }
    }

    /// The response under `message_id` streaming now, from 1; one whose `message_start` was
    /// missed is the first.
    pub(crate) fn attempt_of(&self, message_id: &str) -> u64 {
        self.attempt_by_message
            .get(message_id)
            .copied()
            .unwrap_or(1)
    }

    /// The key of the block the response under `message_id` last started, which the assistant
    /// frame now arriving finishes; `None` where no block started since the last one finished.
    pub(crate) fn take_started_block(
        &mut self,
        message_id: &str,
    ) -> Option<ClaudeStreamedBlockKey> {
        self.started_block_by_message.remove(message_id)
    }

    /// Forgets every response.
    fn clear(&mut self) {
        self.attempt_by_message.clear();
        self.started_block_by_message.clear();
    }
}

/// The blocks one session's process is streaming, from their first piece to their turn's end.
pub(crate) struct ClaudeStreamedBlocks {
    text: StreamedText<ClaudeStreamedBlockKey>,
    responses: ClaudeStreamedResponses,
    // The row each streamed block's pieces are written as, by its key.
    prose_rows: HashMap<ClaudeStreamedBlockKey, ProseRow>,
    // The streamed blocks of each response no assistant frame has finished yet.
    unfinished_blocks_by_message: HashMap<String, BTreeSet<u64>>,
    // The key of the block each assistant frame of the open turn finished, by the frame's uuid.
    block_key_by_message_uuid: HashMap<String, ClaudeStreamedBlockKey>,
}

impl ClaudeStreamedBlocks {
    /// No block streamed yet.
    pub(crate) fn new() -> Self {
        Self {
            text: StreamedText::default(),
            responses: ClaudeStreamedResponses::default(),
            prose_rows: HashMap::new(),
            unfinished_blocks_by_message: HashMap::new(),
            block_key_by_message_uuid: HashMap::new(),
        }
    }

    /// Takes one `stream_event` frame's text of the run's turn at `now`, on the process running on
    /// `provider_account_id`'s account; answers the deadline a piece it began waiting goes out by,
    /// for the session's one timer.
    pub(crate) fn observe(
        &mut self,
        frame: &str,
        run: ClaudeStreamedRun,
        provider_account_id: &ProviderAccountId,
        now: Instant,
    ) -> Option<Instant> {
        let event = read_stream_event(frame)?;
        self.responses.observe(&event);
        match event {
            ClaudeStreamEvent::MessageStarted { .. } | ClaudeStreamEvent::BlockStarted { .. } => {
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
                    attempt: self.responses.attempt_of(&message_id),
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
                            provider_block: key.provider_block(),
                            origin: None,
                            source_epoch: None,
                            source_position: None,
                            content_length: None,
                            content_encoding: None,
                        },
                    });
                self.text.append(&key, &run.run_id.to_string(), &piece, now)
            }
            ClaudeStreamEvent::MessageStopped {
                message_id,
                abandoned_from_index,
            } => {
                self.drop_abandoned(
                    run.session_id,
                    provider_account_id,
                    &message_id,
                    abandoned_from_index,
                );
                None
            }
        }
    }

    /// The earliest deadline a waiting piece goes out by.
    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.text.next_deadline()
    }

    /// The pieces whose interval has passed by `now`.
    pub(crate) fn due(&mut self, now: Instant) -> Vec<ClaudeStreamedPiece> {
        let pieces = self.text.due(now);
        self.rows_of(pieces)
    }

    /// Finishes, with an assistant frame's text or thinking `rows`, the block it was streamed as:
    /// answers the pieces that carry what the streamed ones did not, and the frame's rows that
    /// streamed as no block. A final text that does not begin with what streamed is recorded, the
    /// streamed pieces standing, under `provider_account_id`'s account.
    pub(crate) fn finish(
        &mut self,
        frame: &ClaudeMessageFrame,
        rows: Vec<ClaudeMessageRow>,
        provider_account_id: &ProviderAccountId,
    ) -> (Vec<ClaudeStreamedPiece>, Vec<ClaudeMessageRow>) {
        let Some(message_id) = frame.provider_message_id() else {
            return (Vec::new(), rows);
        };
        let Some(key) = self.responses.take_started_block(message_id) else {
            // A frame that finishes no started block belongs to the response streaming now.
            let attempt = self.responses.attempt_of(message_id);
            let rows = rows
                .into_iter()
                .map(|row| stamp_attempt(row, attempt))
                .collect();
            return (Vec::new(), rows);
        };
        let (message_id, block_index) = (key.message_id.clone(), key.block_index);
        let mut pieces = Vec::new();
        let mut unstreamed = Vec::new();
        for row in rows {
            let Some((mut prose, final_text)) = ProseRow::of(&row) else {
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
            // The frame names its block by its index in the frame, so the last piece takes the
            // streamed block's, as the pieces before it did, and joins their row.
            prose.payload.provider_block = key.provider_block();
            let last_piece = match self.text.complete(&key, final_text) {
                StreamedTextCompletion::Completed { last_piece } => last_piece,
                StreamedTextCompletion::Diverged { last_piece } => {
                    report(
                        provider_account_id,
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
    pub(crate) fn block_key_for(&self, message_uuid: &str) -> Option<&ClaudeStreamedBlockKey> {
        self.block_key_by_message_uuid.get(message_uuid)
    }

    /// Forgets the open turn's assistant frames, as the next turn opens.
    pub(crate) fn open_turn(&mut self) {
        self.block_key_by_message_uuid.clear();
    }

    /// Answers what still waits of the blocks `run_id`'s turn left unfinished, as the turn ends.
    pub(crate) fn end_turn(&mut self, run_id: RunId) -> Vec<ClaudeStreamedPiece> {
        let pieces = self.text.end_turn(&run_id.to_string());
        self.responses.clear();
        self.unfinished_blocks_by_message.clear();
        let rows = self.rows_of(pieces);
        self.prose_rows
            .retain(|_, row| row.payload.run_id != run_id);
        rows
    }

    /// Answers what still waits of every block, as the session's process is gone.
    pub(crate) fn end_all(&mut self) -> Vec<ClaudeStreamedPiece> {
        let pieces = self.text.end_all();
        let rows = self.rows_of(pieces);
        self.responses.clear();
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

    fn drop_abandoned(
        &mut self,
        session_id: SessionId,
        provider_account_id: &ProviderAccountId,
        message_id: &str,
        from: Option<u64>,
    ) {
        let (Some(from), Some(unfinished)) =
            (from, self.unfinished_blocks_by_message.get_mut(message_id))
        else {
            return;
        };
        let abandoned = unfinished.split_off(&from);
        if abandoned.is_empty() {
            return;
        }
        // The cut-short response is the one under the id this `message_stop` closes.
        let attempt = self.responses.attempt_of(message_id);
        let stored_block_count = abandoned
            .into_iter()
            .filter(|block_index| {
                let key = ClaudeStreamedBlockKey {
                    message_id: message_id.to_owned(),
                    attempt,
                    block_index: *block_index,
                };
                self.prose_rows.remove(&key);
                self.text.discard(&key)
            })
            .count();
        report(
            provider_account_id,
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
}

fn report(
    provider_account_id: &ProviderAccountId,
    kind: DriverDiagnosticKind,
    raw_wire_type: &str,
    disposition_reason: &str,
    details: Map<String, Value>,
) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: Some(provider_account_id.clone()),
        kind,
        raw_wire_type: Some(raw_wire_type.to_owned()),
        disposition_reason: disposition_reason.to_owned(),
        details,
    });
}

/// What one `stream_event` frame says; `None` for an event no reader takes, or one naming no
/// response.
pub(crate) fn read_stream_event(frame: &str) -> Option<ClaudeStreamEvent> {
    let frame: StreamEventFrame = serde_json::from_str(frame).ok()?;
    let message_id = frame.api_message_id.filter(|id| !id.is_empty())?;
    let event = frame.event?;
    let block_index = event.index.as_ref().and_then(read_block_index);
    match event.event_type.as_deref()? {
        "message_start" => Some(ClaudeStreamEvent::MessageStarted { message_id }),
        "content_block_start" => Some(ClaudeStreamEvent::BlockStarted {
            message_id,
            block_index: block_index?,
        }),
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

// A prose row with its block named under response `attempt`; any other row as it is.
fn stamp_attempt(mut row: ClaudeMessageRow, attempt: u64) -> ClaudeMessageRow {
    if let ClaudeMessageRowKind::Thinking { payload, .. }
    | ClaudeMessageRowKind::Session {
        row: LateAppendableRow::AgentMessageSent(payload),
        ..
    } = &mut row.row
    {
        payload.provider_block = payload
            .provider_block
            .and_then(|block| ProviderBlock::new(block.index.get(), attempt));
    }
    row
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use jiff::Timestamp;
    use serde_json::{Value, json};
    use sidekicks_contracts::event::declared_variants::ProviderBlock;
    use sidekicks_contracts::provider::account::record::ProviderAccountId;
    use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use tokio::time::Instant;

    use super::{ClaudeStreamedBlocks, ClaudeStreamedPiece, ClaudeStreamedRun};
    use crate::driver::claude::delivery::messages::{
        ClaudeMessageBody, ClaudeMessageFrame, ClaudeMessageRow, ClaudeMessageRowKind,
        read_claude_assistant_rows,
    };
    use crate::driver::claude::run::routes::ClaudeBoundRun;
    use crate::driver::streamed_text::STREAMED_TEXT_PIECE_INTERVAL;
    use crate::run::delivery::LateAppendableRow;

    fn stream_event(event: &Value) -> String {
        json!({"type": "stream_event", "api_message_id": "m1", "event": event}).to_string()
    }

    fn text_delta(index: u64, text: &str) -> String {
        stream_event(&json!({
            "type": "content_block_delta",
            "index": index,
            "delta": {"type": "text_delta", "text": text},
        }))
    }

    // A reply row's block and text.
    fn stamp(row: &ClaudeMessageRow) -> (Option<ProviderBlock>, &str) {
        match &row.row {
            ClaudeMessageRowKind::Session {
                row: LateAppendableRow::AgentMessageSent(payload),
                body: ClaudeMessageBody::Text(text),
            } => (payload.provider_block, text.as_str()),
            ClaudeMessageRowKind::Session { .. } | ClaudeMessageRowKind::Thinking { .. } => {
                panic!("a text block's row is a reply")
            }
        }
    }

    // Each piece's block and text.
    fn stamps(pieces: &[ClaudeStreamedPiece]) -> Vec<(Option<ProviderBlock>, &str)> {
        pieces.iter().map(|piece| stamp(&piece.row)).collect()
    }

    fn block(index: u64, attempt: u64) -> Option<ProviderBlock> {
        ProviderBlock::new(index, attempt)
    }

    // A frame after its block's stop finishes that block, a second response under one id is a
    // new attempt, and a frame of no streamed block names the response streaming now.
    #[test]
    fn each_piece_names_its_own_block_and_response() {
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let run = ClaudeBoundRun {
            run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
            binding_id: RuntimeBindingId::new("binding".to_owned()).expect("a valid binding id"),
        };
        let streamed_run = ClaudeStreamedRun {
            session_id,
            run_id: run.run_id,
        };
        let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
        let mut blocks = ClaudeStreamedBlocks::new();
        let started = Instant::now();
        let observe = |blocks: &mut ClaudeStreamedBlocks, frame: String| {
            blocks.observe(&frame, streamed_run, &account, started);
        };

        observe(&mut blocks, stream_event(&json!({"type": "message_start"})));
        observe(
            &mut blocks,
            stream_event(&json!({"type": "content_block_start", "index": 0})),
        );
        observe(&mut blocks, text_delta(0, "Hello"));
        observe(
            &mut blocks,
            stream_event(&json!({"type": "content_block_start", "index": 2})),
        );
        observe(&mut blocks, text_delta(2, "World"));
        let first_pieces = blocks.due(started + STREAMED_TEXT_PIECE_INTERVAL);
        observe(
            &mut blocks,
            stream_event(&json!({"type": "content_block_stop", "index": 2})),
        );
        let finish = |blocks: &mut ClaudeStreamedBlocks, uuid: &str, text: &str| {
            let frame = json!({
                "type": "assistant",
                "uuid": uuid,
                "message": {"id": "m1", "content": [{"type": "text", "text": text}]},
            });
            let frame: ClaudeMessageFrame =
                serde_json::from_str(&frame.to_string()).expect("the assistant frame reads");
            let rows = read_claude_assistant_rows(
                &frame,
                session_id,
                &run,
                &mut HashMap::new(),
                Timestamp::now(),
            );
            blocks.finish(&frame, rows, &account)
        };
        let (last_pieces, unstreamed) = finish(&mut blocks, "frame-2", "World!");
        observe(&mut blocks, stream_event(&json!({"type": "message_start"})));
        observe(
            &mut blocks,
            stream_event(&json!({"type": "content_block_start", "index": 0})),
        );
        observe(&mut blocks, text_delta(0, "Again"));
        let retried_pieces = blocks.due(started + STREAMED_TEXT_PIECE_INTERVAL * 2);
        observe(&mut blocks, stream_event(&json!({"type": "message_start"})));
        let (whole_pieces, whole_rows) = finish(&mut blocks, "frame-3", "Whole.");

        assert_eq!(
            stamps(&first_pieces),
            [(block(0, 1), "Hello"), (block(2, 1), "World")]
        );
        assert_eq!(stamps(&last_pieces), [(block(2, 1), "!")]);
        assert!(unstreamed.is_empty());
        assert_eq!(stamps(&retried_pieces), [(block(0, 2), "Again")]);
        assert!(whole_pieces.is_empty());
        assert_eq!(
            whole_rows.iter().map(stamp).collect::<Vec<_>>(),
            [(block(0, 3), "Whole.")]
        );
    }
}
