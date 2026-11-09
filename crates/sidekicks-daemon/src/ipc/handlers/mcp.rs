//! The `mcp.*` methods: the server inventory's reads, the public MCP Registry's search, the
//! binding edits the mutation service answers, `mcp.server.signIn` and `mcp.server.signOut`, which
//! the sign-in commands answer, and `mcp.subscribe`, the MCP governance stream: the stored
//! governance events of the daemon-scope sentinel session's log, followed from its head when the
//! call is taken, and the newest notice per key from the status tracker's notice board, the
//! stream's place in the board taken before the acknowledgment goes out, so a notice sent after it
//! is read and none falls between the call and a first `mcp.server.list`.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::{Arc, LazyLock};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::event::registry::MCP_GOVERNANCE_EVENT_TYPES;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::mcp::event::{McpGovernanceEvent, McpSubscribe, McpSubscribeEmission};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::session::event_cursor::{
    EventCursor, START_OF_LOG_POSITION, decode_event_cursor, encode_event_cursor,
};
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::{
    ChangeRecord, DistanceRead, Feed, RecordPage, RecordPageRead, SendGate,
};
use sidekicks_ipc::stream::frame_batcher::{ChangeFeed, FrameChanges, FrameRead};
use sidekicks_mcp::inventory_service::McpInventoryService;
use sidekicks_mcp::mutation::service::McpMutationService;
use sidekicks_mcp::registry_search::{MCP_REGISTRY_ADDRESS, McpRegistryClient};
use sidekicks_mcp::sign_in::commands::McpSignInCommands;
use sidekicks_mcp::status::notices::{McpNoticeBoard, McpNoticeFeed};
use sidekicks_store::database::connection::read_pool::DatabaseReadError;
use sidekicks_store::events::log_service::{
    EventLogFollowError, EventLogReadError, EventLogService, FollowStart,
};
use tokio::sync::watch;

use self::inventory::register_inventory_methods;
use self::requests::register_request_methods;

mod inventory;
mod requests;
#[cfg(test)]
mod tests;

/// The governance event types, as the log's typed read filters by them.
static MCP_GOVERNANCE_EVENT_TYPE_NAMES: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    MCP_GOVERNANCE_EVENT_TYPES
        .iter()
        .map(|event_type| event_type.as_str())
        .collect()
});

/// What the `mcp.*` methods read: the event log and the status tracker's notice board the
/// subscription follows, the server inventory, the mutation service the binding edits go through
/// and the sign-in commands; the registry search keeps its own client.
pub(crate) struct McpMethodSources {
    /// The event log, whose sentinel session holds the governance events.
    pub(crate) log: Arc<EventLogService>,
    /// The status tracker's notice board.
    pub(crate) board: Arc<McpNoticeBoard>,
    /// The server inventory `mcp.server.list` and `mcp.server.read` answer from.
    pub(crate) inventory: Arc<McpInventoryService>,
    /// The mutation service `mcp.server.upsert` and `mcp.server.enabled.update` answer from.
    pub(crate) mutations: Arc<McpMutationService>,
    /// The sign-in commands `mcp.server.signIn` and `mcp.server.signOut` answer from.
    pub(crate) sign_ins: Arc<McpSignInCommands>,
}

/// Registers `mcp.server.list`, `mcp.server.read`, `mcp.server.upsert`,
/// `mcp.server.enabled.update`, `mcp.server.signIn`, `mcp.server.signOut` and `mcp.subscribe`
/// over `sources`, and `mcp.registry.search` over a registry client built here. A first read of
/// the log that fails refuses the subscription with nothing open. Fails the start when a method is
/// already registered.
pub(crate) fn register_mcp_methods(
    registry: &mut MethodRegistryBuilder,
    sources: McpMethodSources,
) -> Result<(), RegistrationError> {
    let McpMethodSources {
        log,
        board,
        inventory,
        mutations,
        sign_ins,
    } = sources;
    register_inventory_methods(registry, &inventory)?;
    register_request_methods(
        registry,
        Arc::new(McpRegistryClient::new(MCP_REGISTRY_ADDRESS)),
        &mutations,
        &sign_ins,
    )?;
    registry.register_subscription::<McpSubscribe, _>(
        move |_request: EmptyPayload, _context: HandlerContext, subscription_id: SubscriptionId| {
            let log = Arc::clone(&log);
            let board = Arc::clone(&board);
            async move {
                let feed: Box<dyn Feed<Emission = McpSubscribeEmission>> =
                    Box::new(open_mcp_subscribe_feed(log, board).await?);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}

/// Opens one subscriber's stream: its place in `board` first, then the log followed from its
/// head (the start of the log while the sentinel session holds no event). Fails as the log's
/// first read fails, leaving nothing attached.
async fn open_mcp_subscribe_feed(
    log: Arc<EventLogService>,
    board: Arc<McpNoticeBoard>,
) -> Result<McpSubscribeFeed, HandlerError> {
    let notices = board.follow().await?;
    let cursor = match log
        .read_follow_start(*DAEMON_SCOPE_SENTINEL_SESSION_ID, FollowStart::Newest)
        .await
    {
        Ok(cursor) => cursor,
        Err(EventLogFollowError::SessionNotFound(_)) => {
            encode_event_cursor(START_OF_LOG_POSITION).expect("the start of the log has a cursor")
        }
        Err(error) => return Err(error.into()),
    };
    let events = ChangeFeed::open(
        Arc::new(McpGovernanceRecord { log }),
        cursor,
        |read| match read {
            FrameRead::Changes(changes) => changes,
            FrameRead::Behind(head) => match head {},
        },
    )
    .await?;
    Ok(McpSubscribeFeed {
        events,
        unsent_events: VecDeque::new(),
        notices,
    })
}

/// One stored governance event and the cursor that resumes after it.
struct McpGovernanceChange {
    cursor: EventCursor,
    event: McpGovernanceEvent,
}

/// Why a page of the governance events could not be read.
#[derive(Debug, thiserror::Error)]
enum McpGovernanceStreamError {
    /// The log could not be read.
    #[error(transparent)]
    Log(#[from] EventLogReadError),
    /// A stored event of a governance type was not of the governance category.
    #[error("a stored event of an MCP governance type is not of the mcpGovernance category")]
    Category,
}

impl From<DatabaseReadError> for McpGovernanceStreamError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Log(error.into())
    }
}

/// The sentinel session's log as the governance stream reads it: only its governance events.
struct McpGovernanceRecord {
    log: Arc<EventLogService>,
}

impl ChangeRecord for McpGovernanceRecord {
    type Cursor = EventCursor;
    type Change = McpGovernanceChange;
    type Error = McpGovernanceStreamError;
    // Each governance event goes out as an emission of its own, which no behind mark replaces, so
    // the stream sends every event and is never moved.
    type Head = Infallible;

    fn read_after(
        &self,
        cursor: &EventCursor,
        max: usize,
    ) -> RecordPageRead<'_, EventCursor, McpGovernanceChange, McpGovernanceStreamError> {
        let cursor = cursor.clone();
        async move {
            let after_position = decode_event_cursor(&cursor).map_err(EventLogReadError::from)?;
            let changes = self
                .log
                .read_stream_page(
                    *DAEMON_SCOPE_SENTINEL_SESSION_ID,
                    after_position,
                    max,
                    Some(MCP_GOVERNANCE_EVENT_TYPE_NAMES.as_slice()),
                    |_connection, _read_damaged_from_sequence, page| {
                        page.events
                            .into_iter()
                            .map(|envelope| {
                                let cursor = encode_event_cursor(i64::from(envelope.sequence))
                                    .map_err(EventLogReadError::from)?;
                                let event = McpGovernanceEvent::new(envelope)
                                    .ok_or(McpGovernanceStreamError::Category)?;
                                Ok(McpGovernanceChange { cursor, event })
                            })
                            .collect::<Result<Vec<_>, McpGovernanceStreamError>>()
                    },
                )
                .await?;
            // The read holds governance events alone, so it reads through its last change; a
            // governance event is small, so a read is cut by its count alone.
            Ok(RecordPage {
                read_through: changes
                    .last()
                    .map(|change: &McpGovernanceChange| change.cursor.clone()),
                is_cut_short: changes.len() >= max,
                changes,
            })
        }
        .boxed()
    }

    fn read_distance(
        &self,
        _cursor: &EventCursor,
        _max_events: usize,
    ) -> DistanceRead<'_, Infallible, McpGovernanceStreamError> {
        Box::pin(std::future::ready(Ok(None)))
    }

    fn cursor_at(head: &Infallible) -> EventCursor {
        match *head {}
    }

    fn change_count(&self) -> watch::Receiver<u64> {
        self.log.change_count(&DAEMON_SCOPE_SENTINEL_SESSION_ID)
    }

    fn is_store_closed(error: &McpGovernanceStreamError) -> bool {
        match error {
            McpGovernanceStreamError::Log(error) => error.is_pool_closed(),
            McpGovernanceStreamError::Category => false,
        }
    }
}

/// One subscriber's `mcp.subscribe` stream: the governance events, one per emission, and the
/// board's notices, each read only when the subscription's lane has credit. A frame of events the
/// log read at once waits here until each is sent, so what waits is at most one frame.
struct McpSubscribeFeed {
    events: ChangeFeed<McpGovernanceRecord, FrameChanges<McpGovernanceChange>>,
    unsent_events: VecDeque<McpGovernanceEvent>,
    notices: McpNoticeFeed,
}

impl Feed for McpSubscribeFeed {
    type Emission = McpSubscribeEmission;

    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<McpSubscribeEmission>, HandlerError>> {
        async move {
            if !self.unsent_events.is_empty() {
                // The gate first, so a read dropped while it waits keeps the event.
                if gate.ready().await.is_err() {
                    return Ok(None);
                }
                return Ok(self
                    .unsent_events
                    .pop_front()
                    .map(McpSubscribeEmission::GovernanceEvent));
            }
            let Self {
                events,
                unsent_events,
                notices,
            } = self;
            // Each read, dropped unfinished, keeps what it has taken and where its frame's window
            // stands, so the one not chosen loses nothing.
            tokio::select! {
                frame = events.next(gate) => {
                    let Some(frame) = frame? else {
                        return Ok(None);
                    };
                    unsent_events.extend(frame.into_vec().into_iter().map(|change| change.event));
                    Ok(unsent_events.pop_front().map(McpSubscribeEmission::GovernanceEvent))
                }
                notice = notices.next(gate) => notice,
            }
        }
        .boxed()
    }
}
