//! `session.event.subscribe`: a session's events, caught up from after `afterCursor` (from the
//! start of its log when absent) and then followed, in batched frames, each change carrying its
//! cursor and, for an event of a run, the run stamp its transcript row carries. The stream reads
//! its first frame when the call is taken and every later one from the log at its cursor only once
//! the subscription's lane has credit and the connection has room, so the catch-up goes at the
//! connection's pace and nothing is dropped. A session the daemon does not hold, a cursor it cannot
//! read, or a first frame that cannot be read is refused before anything opens, and a read that
//! fails later ends the subscription with the failure.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::{PAGE_MAX_BYTES, count_entries_fitting_one_frame};
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::session::directory::SessionEventSubscribe;
use sidekicks_contracts::session::event_cursor::{
    EventCursor, decode_event_cursor, encode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{
    SessionEventSubscribeRequest, SessionStreamChange, SessionStreamFrame,
};
use sidekicks_contracts::transcript::content::TranscriptRowContent;
use sidekicks_contracts::wire::instant::WireInstant;
use tokio::sync::watch;

use crate::database::connection::read_pool::DatabaseReadError;
use crate::events::log_service::{EventLogReadError, EventLogService, FollowStart};
use crate::events::session::read::session_read_bound;
use crate::ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use crate::ipc::stream::feed::{ChangeRecord, Feed, RecordPage};
use crate::ipc::stream::frame_batcher::ChangeFeed;
use crate::transcript::stream_state::{
    StreamedPiece, TranscriptStreamState, load_piece_texts, read_streamed_pieces,
};
use crate::transcript::turn_attribution::{
    RunTurnReads, SessionTurnAttribution, TurnAttributionError,
};

/// Registers `session.event.subscribe` over `log`. Refuses a session the daemon does not hold
/// `session.notFound` and a cursor it cannot read `session.event.cursorUnresolvable`, and fails the
/// call when its first page cannot be read, each opening nothing. Fails the start when the method
/// is already registered.
pub(crate) fn register_session_event_subscribe(
    registry: &mut MethodRegistryBuilder,
    log: Arc<EventLogService>,
) -> Result<(), RegistrationError> {
    registry.register_subscription::<SessionEventSubscribe, _>(
        move |request: SessionEventSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let log = Arc::clone(&log);
            async move {
                let start = request
                    .after_cursor
                    .map_or(FollowStart::StartOfLog, FollowStart::After);
                let cursor = log.read_follow_start(request.session_id, start).await?;
                let record = Arc::new(SessionEventRecord::new(log, request.session_id));
                let feed: Box<dyn Feed<Emission = SessionStreamFrame>> = Box::new(
                    ChangeFeed::open(record, cursor, |changes| SessionStreamFrame { changes })
                        .await?,
                );
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}

/// Why a page of a session's event stream could not be read.
#[derive(Debug, thiserror::Error)]
enum SessionEventStreamError {
    /// The log could not be read.
    #[error(transparent)]
    Log(#[from] EventLogReadError),
    /// An event of a run could not be attributed to its turn.
    #[error(transparent)]
    Attribution(#[from] TurnAttributionError),
    /// A read of the page's pieces, of a row met partway or of a child run's count failed.
    #[error("a read of a streamed page's pieces, a row or a child run's count failed")]
    Rows(#[from] rusqlite::Error),
}

impl From<DatabaseReadError> for SessionEventStreamError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Log(error.into())
    }
}

/// One session's log as its event stream reads it, stamping each event of a run as its transcript
/// row is stamped, placing each piece of a reply or of reasoning in its row, and summarizing each
/// child run's events.
struct SessionEventRecord {
    log: Arc<EventLogService>,
    session_id: SessionId,
    /// The stream's attribution, fed every page in order; it holds one fold per run until the
    /// run's terminal event.
    attribution: Arc<Mutex<SessionTurnAttribution>>,
    /// The rows still taking pieces and the child runs the stream follows.
    rows: Arc<Mutex<TranscriptStreamState>>,
    /// The stored facts, texts included, of the events a size cut left for the next read, so a
    /// piece's text is loaded once however many frames its page takes.
    left_pieces: Arc<Mutex<HashMap<i64, StreamedPiece>>>,
}

impl SessionEventRecord {
    fn new(log: Arc<EventLogService>, session_id: SessionId) -> Self {
        Self {
            log,
            session_id,
            attribution: Arc::new(Mutex::new(SessionTurnAttribution::new(session_id))),
            rows: Arc::new(Mutex::new(TranscriptStreamState::default())),
            left_pieces: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl ChangeRecord for SessionEventRecord {
    type Cursor = EventCursor;
    type Change = SessionStreamChange;
    type Error = SessionEventStreamError;

    fn read_after(
        &self,
        cursor: &EventCursor,
        max: usize,
    ) -> BoxFuture<'_, Result<RecordPage<SessionStreamChange>, SessionEventStreamError>> {
        let cursor = cursor.clone();
        let attribution = Arc::clone(&self.attribution);
        let rows = Arc::clone(&self.rows);
        let left_pieces = Arc::clone(&self.left_pieces);
        async move {
            let after_position = decode_event_cursor(&cursor).map_err(EventLogReadError::from)?;
            self.log
                .read_stream_page(
                    self.session_id,
                    after_position,
                    max,
                    None,
                    move |connection, read_damaged_from_sequence, page| {
                        let session_id = match page.events.first() {
                            Some(event) => event.session_id,
                            None => {
                                return Ok(RecordPage {
                                    changes: Vec::new(),
                                    is_cut_by_size: false,
                                });
                            }
                        };
                        let read_bound =
                            session_read_bound(read_damaged_from_sequence, &session_id, None);
                        let sequences: Vec<i64> = page
                            .events
                            .iter()
                            .map(|event| i64::from(event.sequence))
                            .collect();
                        // Only this stream's reads take them, one at a time.
                        let mut left_pieces =
                            left_pieces.lock().unwrap_or_else(PoisonError::into_inner);
                        let mut stored = std::mem::take(&mut *left_pieces);
                        let unread: Vec<i64> = sequences
                            .iter()
                            .copied()
                            .filter(|sequence| !stored.contains_key(sequence))
                            .collect();
                        stored.extend(read_streamed_pieces(connection, &session_id, &unread)?);
                        let reads = RunTurnReads::new(connection, read_damaged_from_sequence);
                        let observed_at = WireInstant::now();
                        let mut attribution =
                            attribution.lock().unwrap_or_else(PoisonError::into_inner);
                        let mut rows = rows.lock().unwrap_or_else(PoisonError::into_inner);
                        // A large piece's text is loaded only where its row's cut reads it.
                        let cut_texts: Vec<i64> = page
                            .events
                            .iter()
                            .filter(|event| {
                                stored.get(&i64::from(event.sequence)).is_some_and(|piece| {
                                    piece.lacks_text() && rows.reads_text_of(event, piece)
                                })
                            })
                            .map(|event| i64::from(event.sequence))
                            .collect();
                        load_piece_texts(connection, &session_id, &mut stored, &cut_texts)?;
                        let contents: Vec<Option<TranscriptRowContent>> = page
                            .events
                            .iter()
                            .map(|event| {
                                stored
                                    .get(&i64::from(event.sequence))
                                    .and_then(|piece| piece.content_of(&event.payload))
                            })
                            .collect();
                        // Cut before any fold moves, so an event left for the next read is
                        // folded once.
                        let kept =
                            count_changes_fitting_one_frame(&page.events, &contents, &stored);
                        let is_cut_by_size = kept < page.events.len();
                        for event in &page.events[kept..] {
                            let sequence = i64::from(event.sequence);
                            if let Some(piece) = stored.remove(&sequence) {
                                left_pieces.insert(sequence, piece);
                            }
                        }
                        drop(left_pieces);
                        let mut changes = Vec::with_capacity(kept);
                        for (event, content) in page.events.into_iter().zip(contents).take(kept) {
                            let attributed = attribution.attribute(&reads, &event)?;
                            let cursor = encode_event_cursor(i64::from(event.sequence))
                                .map_err(EventLogReadError::from)?;
                            let Some(attributed) = attributed else {
                                changes.push(SessionStreamChange {
                                    cursor,
                                    event,
                                    run_stamp: None,
                                    piece: None,
                                    child_run_summary: None,
                                    ended_rows: None,
                                });
                                continue;
                            };
                            let run_id = attributed.run_id;
                            let stored = stored.get(&i64::from(event.sequence));
                            let piece = match (content, stored) {
                                (Some(content), Some(stored)) => Some(rows.place_piece(
                                    connection, read_bound, &event, run_id, stored, content,
                                )?),
                                _ => None,
                            };
                            let child_run_summary = rows.child_run_summary(
                                connection,
                                read_bound,
                                &event,
                                run_id,
                                &observed_at,
                            )?;
                            let ended_rows = rows.forget_ended(
                                &event,
                                run_id,
                                stored.is_some_and(StreamedPiece::starts_row),
                            );
                            changes.push(SessionStreamChange {
                                cursor,
                                event,
                                run_stamp: Some(attributed.stamp),
                                piece,
                                child_run_summary,
                                ended_rows,
                            });
                        }
                        Ok(RecordPage {
                            changes,
                            is_cut_by_size,
                        })
                    },
                )
                .await
        }
        .boxed()
    }

    fn cursor_of(change: &SessionStreamChange) -> EventCursor {
        change.cursor.clone()
    }

    fn change_count(&self) -> watch::Receiver<u64> {
        self.log.change_count(&self.session_id)
    }

    fn is_store_closed(error: &SessionEventStreamError) -> bool {
        match error {
            SessionEventStreamError::Log(error) => error.is_pool_closed(),
            SessionEventStreamError::Attribution(_) | SessionEventStreamError::Rows(_) => false,
        }
    }
}

/// The most bytes a change takes beside its event, its piece's body and its starts: its cursor,
/// its run stamp, its piece's place, a child's summary and the rows it ends, each a few ids and
/// integers.
const CHANGE_BESIDE_BODIES_MAX_BYTES: usize = 1024;

// How many leading events go out in one frame: as many as fit the page budget with their pieces'
// bodies and the most bytes their block starts can take, never fewer than one.
fn count_changes_fitting_one_frame(
    events: &[EventEnvelope],
    contents: &[Option<TranscriptRowContent>],
    stored: &HashMap<i64, StreamedPiece>,
) -> usize {
    let changes: Vec<(&EventEnvelope, &Option<TranscriptRowContent>)> =
        events.iter().zip(contents).collect();
    count_entries_fitting_one_frame(
        &changes,
        changes.len(),
        PAGE_MAX_BYTES,
        |(event, content)| {
            let starts_bytes = stored
                .get(&i64::from(event.sequence))
                .map_or(0, StreamedPiece::block_starts_bytes_max);
            Ok(json_utf8_byte_length(event)?
                + json_utf8_byte_length(content)?
                + starts_bytes
                + CHANGE_BESIDE_BODIES_MAX_BYTES)
        },
    )
    .expect("an event and its body serialize")
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use sidekicks_contracts::method::Method as _;

    use super::*;
    use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
    use crate::events::log_service::EventLogAppendOptions;
    use crate::events::log_service::tests::open_log;
    use crate::ipc::call_fixtures::{context, request};
    use crate::ipc::registry::{Dispatch as _, EncodedFeed, Reply};
    use crate::ipc::stream::feed::CreditGate;
    use crate::transcript::block_cut::STALLING_TEXT;
    use crate::transcript::test_log::{wire_block_starts, wire_message};

    /// Long enough for a frame that is coming to come, many windows over.
    const QUIET: Duration = Duration::from_millis(250);

    async fn pin(log: &EventLogService, session_id: SessionId) {
        let pinned = serde_json::from_value(json!({
            "type": "session.pinned",
            "payload": { "sessionId": session_id, "at": "2026-10-14T09:00:00.000Z" },
        }))
        .expect("the test writes a session.pinned event");
        log.append(
            test_envelope(session_id, &pinned),
            EventLogAppendOptions::default(),
        )
        .await
        .expect("the append commits");
    }

    /// The sequences of the next frame's events.
    async fn next_sequences(feed: &mut Box<dyn EncodedFeed>, gate: &CreditGate) -> Vec<u64> {
        let value = feed
            .next(gate)
            .await
            .expect("the log reads")
            .expect("the stream goes on");
        let frame: SessionStreamFrame =
            serde_json::from_slice(&value.json).expect("the frame reads as its type");
        frame
            .changes
            .into_vec()
            .into_iter()
            .map(|change| change.event.sequence.get())
            .collect()
    }

    #[tokio::test]
    async fn the_catch_up_reads_past_its_first_page_only_once_the_lane_has_credit_then_follows() {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await.service;
        let session_id = test_session_id();
        for _ in 0..60 {
            pin(&log, session_id).await;
        }
        let mut builder = MethodRegistryBuilder::new();
        register_session_event_subscribe(&mut builder, Arc::clone(&log))
            .expect("the method registers");
        let reply = builder
            .freeze()
            .dispatch(
                request(
                    SessionEventSubscribe::DESCRIPTOR.method,
                    Some(&json!({ "sessionId": session_id })),
                ),
                context(1),
            )
            .await;
        let Ok(Reply::Subscription { mut feed, .. }) = reply else {
            panic!("a held session's subscribe answers a subscription");
        };

        let gate = CreditGate::spending(0);
        assert!(
            tokio::time::timeout(QUIET, feed.next(&gate)).await.is_err(),
            "nothing goes out while the lane has no credit"
        );
        gate.credit.add_permits(1);
        assert_eq!(
            next_sequences(&mut feed, &gate).await,
            (0..50).collect::<Vec<u64>>()
        );
        // An event stored while the lane has no credit is in the next page, read once credit comes.
        assert!(
            tokio::time::timeout(QUIET, feed.next(&gate)).await.is_err(),
            "nothing goes out while the lane has no credit"
        );
        pin(&log, session_id).await;
        gate.credit.add_permits(1);
        assert_eq!(
            next_sequences(&mut feed, &gate).await,
            (50..61).collect::<Vec<u64>>()
        );
        // Caught up: the stream is quiet until the log takes a new event, which it then follows.
        let gate = CreditGate::with_credit(1);
        assert!(
            tokio::time::timeout(QUIET, feed.next(&gate)).await.is_err(),
            "the caught-up stream waits for the log"
        );
        let (followed, ()) = tokio::join!(next_sequences(&mut feed, &gate), pin(&log, session_id));
        assert_eq!(followed, [61]);
    }

    /// Appends a piece of the first block of `run_id`'s reply `message_id` holding `body`;
    /// returns its id.
    async fn reply_piece(
        log: &EventLogService,
        session_id: SessionId,
        run_id: &str,
        message_id: &str,
        body: &str,
    ) -> String {
        let piece = serde_json::from_value(json!({
            "type": "agent.message.sent",
            "payload": {
                "sessionId": session_id,
                "runId": run_id,
                "providerMessageId": message_id,
                "providerBlock": { "index": 0, "attempt": 1 },
            },
        }))
        .expect("the test writes a reply piece");
        let receipt = log
            .append(
                test_envelope(session_id, &piece),
                EventLogAppendOptions {
                    content_body: Some(body.to_owned()),
                    ..EventLogAppendOptions::default()
                },
            )
            .await
            .expect("the append commits");
        receipt.id.as_str().to_owned()
    }

    /// Each change's piece, as its row's id, its offset and its inline text.
    fn pieces_of(page: &RecordPage<SessionStreamChange>) -> Vec<(String, u64, serde_json::Value)> {
        page.changes
            .iter()
            .map(|change| {
                let piece = change.piece.as_ref().expect("each change is a piece");
                (
                    piece.row_id.as_str().to_owned(),
                    piece.offset.get(),
                    serde_json::to_value(&piece.content).expect("a body serializes")["body"]
                        .clone(),
                )
            })
            .collect()
    }

    // Killed by a piece placed relative to itself rather than its row, by a frame over the page
    // budget or one cut without saying so, by a frame's fold advanced past a cut, and by a stream
    // opened inside a row placing its pieces from zero.
    #[tokio::test]
    async fn event_subscribe_places_pieces_in_their_row_across_cut_frames_and_from_inside() {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await.service;
        let session_id = test_session_id();
        let run_id = crate::uuid_v7::mint_uuid_v7().to_string();
        let body = "x".repeat(30_000);
        let piece_count = 40;
        let row_id = reply_piece(&log, session_id, &run_id, "m1", &body).await;
        for _ in 1..piece_count {
            reply_piece(&log, session_id, &run_id, "m1", &body).await;
        }
        let start = log
            .read_follow_start(session_id, FollowStart::StartOfLog)
            .await
            .expect("the session's start reads");
        let placed = |index: usize| {
            let offset = u64::try_from(index * body.len()).expect("a test offset fits");
            (row_id.clone(), offset, json!(body))
        };

        let record = SessionEventRecord::new(Arc::clone(&log), session_id);
        let first = record
            .read_after(&start, 64)
            .await
            .expect("the frame reads");
        let kept = first.changes.len();
        assert!(first.is_cut_by_size);
        assert!(kept > 0 && kept < piece_count);
        assert_eq!(pieces_of(&first), (0..kept).map(placed).collect::<Vec<_>>());
        let last_cursor = first.changes[kept - 1].cursor.clone();
        let next = record
            .read_after(&last_cursor, 64)
            .await
            .expect("the frame reads");
        assert_eq!(pieces_of(&next)[0], placed(kept));

        let opened_inside = SessionEventRecord::new(Arc::clone(&log), session_id);
        let inside = opened_inside
            .read_after(&first.changes[2].cursor, 1)
            .await
            .expect("the frame reads");
        assert_eq!(pieces_of(&inside), [placed(3)]);
    }

    // Killed by the stream's cut call removed, by an ended row's held-back starts never sent, by a
    // later row of the run not ending the open one, and by one row's failed cut failing the frame
    // or another row.
    #[tokio::test]
    async fn event_subscribe_sends_each_rows_block_starts_and_a_failed_cut_fails_its_row_alone() {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await.service;
        let session_id = test_session_id();
        let run_id = crate::uuid_v7::mint_uuid_v7().to_string();
        let text = "First.\n\nSecond.\n\nThird.\n\nFourth.\n";
        let row_id = reply_piece(&log, session_id, &run_id, "m1", text).await;
        let stalling = format!("Before.\n\n{STALLING_TEXT}\n");
        let stalled_row_id = reply_piece(&log, session_id, &run_id, "m2", &stalling).await;
        let start = log
            .read_follow_start(session_id, FollowStart::StartOfLog)
            .await
            .expect("the session's start reads");

        let record = SessionEventRecord::new(Arc::clone(&log), session_id);
        let page = record
            .read_after(&start, 64)
            .await
            .expect("the frame reads");
        let [open, stalled] = page.changes.as_slice() else {
            panic!("both pieces go out in one frame");
        };
        let (open, open_attachments) = wire_message(open);
        assert_eq!(open["piece"]["rowId"], row_id.as_str());
        let mut starts = wire_block_starts(&open["piece"]["blockStarts"], &open_attachments);
        assert!(!starts.is_empty() && starts.len() < 4);
        let (stalled, stalled_attachments) = wire_message(stalled);
        assert_eq!(stalled["piece"]["rowId"], stalled_row_id.as_str());
        assert_eq!(stalled["piece"]["blockCutFailure"], "stalled");
        assert!(stalled["piece"].get("blockStarts").is_none());
        let ended = &stalled["endedRows"][0];
        assert_eq!(ended["rowId"], row_id.as_str());
        starts.extend(wire_block_starts(
            &ended["blockStarts"],
            &stalled_attachments,
        ));
        assert_eq!(starts, [0, 8, 17, 25]);
    }
}
