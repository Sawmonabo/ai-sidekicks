//! `session.event.subscribe`: a session's events, caught up from after `afterCursor` (from the
//! start of its log when absent) and then followed, in batched frames, each change carrying its
//! cursor and, for an event of a run, the run stamp its transcript row carries. A tool call the
//! session's driver reads as a change to the agent's task list is left out, as the transcript
//! leaves it, and the stream reads on past it; the driver is the lead's provider's, resolved again
//! when the lead moves to another provider. The stream reads its first frame when the call is taken
//! and every later one from the log at its cursor only once the subscription's lane has credit and
//! the connection has room, so the catch-up goes at the connection's pace and nothing is dropped. A
//! session the daemon does not hold, a cursor it cannot read, or a first frame that cannot be read
//! is refused before anything opens, and a read that fails later ends the subscription with the
//! failure.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::{PAGE_MAX_BYTES, count_entries_fitting_one_frame};
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::provider::id::ProviderId;
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
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_ipc::stream::feed::{ChangeRecord, Feed, RecordPage};
use sidekicks_ipc::stream::frame_batcher::ChangeFeed;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_session::run::agent::read_session_lead;
use sidekicks_session::transcript::block_cut::{BlockParse, MARKDOWN_PARSE};
use sidekicks_session::transcript::stream_state::{
    StreamedPiece, TranscriptStreamState, load_piece_texts, read_streamed_pieces,
};
use sidekicks_session::transcript::task_list_call::is_task_list_call;
use sidekicks_session::transcript::turn_attribution::{
    RunTurnReads, SessionTurnAttribution, TurnAttributionError,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;
use sidekicks_store::events::log_service::{EventLogReadError, EventLogService, FollowStart};
use sidekicks_store::events::session::read::session_read_bound;
use tokio::sync::watch;

/// Registers `session.event.subscribe` over `log`. Refuses a session the daemon does not hold
/// `session.notFound` and a cursor it cannot read `session.event.cursorUnresolvable`, and fails the
/// call when its first page cannot be read, each opening nothing. Fails the start when the method
/// is already registered.
pub(crate) fn register_session_event_subscribe(
    registry: &mut MethodRegistryBuilder,
    log: Arc<EventLogService>,
    providers: Arc<ProviderRegistry>,
) -> Result<(), RegistrationError> {
    registry.register_subscription::<SessionEventSubscribe, _>(
        move |request: SessionEventSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let log = Arc::clone(&log);
            let providers = Arc::clone(&providers);
            async move {
                let start = request
                    .after_cursor
                    .map_or(FollowStart::StartOfLog, FollowStart::After);
                let cursor = log.read_follow_start(request.session_id, start).await?;
                let record = Arc::new(SessionEventRecord::new(
                    log,
                    providers,
                    request.session_id,
                    MARKDOWN_PARSE,
                ));
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
/// child run's events. A tool completion goes out once, whole: the parts its patched files are
/// stored in are no events, so the log's reads never hand them to the stream.
struct SessionEventRecord {
    log: Arc<EventLogService>,
    providers: Arc<ProviderRegistry>,
    session_id: SessionId,
    /// The driver that reads the session's task-list calls, kept with the lead's provider it was
    /// resolved for and resolved again when the lead's provider changes; `None` as the driver
    /// when no driver answers its provider, which keeps every call.
    task_list_driver: Arc<Mutex<Option<TaskListDriver>>>,
    /// The stream's attribution, fed every page in order; it holds one fold per run until the
    /// run's terminal event.
    attribution: Arc<Mutex<SessionTurnAttribution>>,
    /// The rows still taking pieces and the child runs the stream follows.
    rows: Arc<Mutex<TranscriptStreamState>>,
    /// The stored facts, texts included, of the events a size cut left for the next read, so a
    /// piece's text is loaded once however many frames its page takes.
    left_pieces: Arc<Mutex<HashMap<i64, StreamedPiece>>>,
}

/// One page of the stream's changes, read through its cursor.
type SessionStreamPage = RecordPage<EventCursor, SessionStreamChange>;

/// The driver a stream asks about task-list calls, with the lead's provider it answers for.
struct TaskListDriver {
    /// The lead's provider when the driver was resolved.
    provider: ProviderId,
    /// That provider's driver, `None` when the daemon has none.
    driver: Option<Arc<dyn ProviderDriver>>,
}

impl SessionEventRecord {
    fn new(
        log: Arc<EventLogService>,
        providers: Arc<ProviderRegistry>,
        session_id: SessionId,
        parse: BlockParse,
    ) -> Self {
        Self {
            log,
            providers,
            session_id,
            task_list_driver: Arc::new(Mutex::new(None)),
            attribution: Arc::new(Mutex::new(SessionTurnAttribution::new(session_id))),
            rows: Arc::new(Mutex::new(TranscriptStreamState::new(parse))),
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
    ) -> BoxFuture<'_, Result<SessionStreamPage, SessionEventStreamError>> {
        let cursor = cursor.clone();
        let providers = Arc::clone(&self.providers);
        let task_list_driver = Arc::clone(&self.task_list_driver);
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
                                    read_through: None,
                                    is_cut_short: false,
                                });
                            }
                        };
                        let read_bound =
                            session_read_bound(read_damaged_from_sequence, &session_id, None);
                        let task_list_driver =
                            match read_session_lead(connection, &session_id, read_bound)? {
                                Some(lead) => {
                                    let provider = lead.binding.provider_name;
                                    let mut kept = lock(&task_list_driver);
                                    match kept.as_ref() {
                                        Some(kept) if kept.provider == provider => {
                                            kept.driver.clone()
                                        }
                                        Some(_) | None => {
                                            let driver = providers.lookup(&provider).ok();
                                            *kept = Some(TaskListDriver {
                                                provider,
                                                driver: driver.clone(),
                                            });
                                            driver
                                        }
                                    }
                                }
                                None => None,
                            };
                        let sequences: Vec<i64> = page
                            .events
                            .iter()
                            .map(|event| i64::from(event.sequence))
                            .collect();
                        // Only this stream's reads take them, one at a time.
                        let mut left_pieces = lock(&left_pieces);
                        let mut stored = std::mem::take(&mut *left_pieces);
                        let unread: Vec<i64> = sequences
                            .iter()
                            .copied()
                            .filter(|sequence| !stored.contains_key(sequence))
                            .collect();
                        stored.extend(read_streamed_pieces(connection, &session_id, &unread)?);
                        let reads = RunTurnReads::new(connection, read_damaged_from_sequence);
                        let observed_at = WireInstant::now();
                        let mut attribution = lock(&attribution);
                        let mut rows = lock(&rows);
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
                        let is_cut_short = page.events.len() == max || kept < page.events.len();
                        let read_through =
                            encode_event_cursor(i64::from(page.events[kept - 1].sequence))
                                .map_err(EventLogReadError::from)?;
                        for event in &page.events[kept..] {
                            let sequence = i64::from(event.sequence);
                            if let Some(piece) = stored.remove(&sequence) {
                                left_pieces.insert(sequence, piece);
                            }
                        }
                        drop(left_pieces);
                        let mut changes = Vec::with_capacity(kept);
                        for (event, content) in page.events.into_iter().zip(contents).take(kept) {
                            // Every event read is folded once, a left-out one too, as the
                            // transcript's window folds the whole log.
                            let attributed = attribution.attribute(&reads, &event)?;
                            let is_left_out = task_list_driver.as_deref().is_some_and(|driver| {
                                let body = stored
                                    .get(&i64::from(event.sequence))
                                    .and_then(StreamedPiece::body_text);
                                is_task_list_call(driver, &event, body)
                            });
                            if is_left_out {
                                continue;
                            }
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
                            let ended_rows = rows.forget_ended(&event, run_id);
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
                            read_through: Some(read_through),
                            is_cut_short,
                        })
                    },
                )
                .await
        }
        .boxed()
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
mod tests;
