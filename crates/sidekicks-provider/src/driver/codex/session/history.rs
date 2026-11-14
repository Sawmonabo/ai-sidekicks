//! A conversation's turns, and the turn one of the person's messages started, read back from
//! Codex page by page, since a resume asks only for the newest turn.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::driver::codex::app_server_protocol::{
    SortDirection, ThreadItemsListParams, ThreadResumeInitialTurnsPageParams,
    ThreadTurnsListParams, TurnItemsView,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};

/// The largest page `thread/turns/list` returns.
const CODEX_TURNS_PAGE_LIMIT: u32 = 100;

/// Codex's refusal for a conversation no message has reached yet, which holds no turn.
const CODEX_NOT_MATERIALIZED_MESSAGE: &str = "is not materialized yet";

const THREAD_TURNS_LIST_METHOD: &str = "thread/turns/list";

const THREAD_ITEMS_LIST_METHOD: &str = "thread/items/list";

/// The continuation a `thread/items/list` page names, sent back as it came: the daemon pages
/// forward only, so it never sends Codex's item anchor.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub(crate) struct CodexItemsCursor(pub(crate) String);

/// One turn of a conversation as `thread/turns/list` lists it.
#[derive(Debug)]
pub(crate) struct CodexListedTurn {
    /// The turn's id.
    pub(crate) id: String,
    /// The turn as Codex listed it, its `status` and `error` among its members.
    pub(crate) turn: Box<RawValue>,
}

// The members of a page the readers read; an absent or empty `nextCursor` ends the paging.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexPage {
    data: Vec<Box<RawValue>>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct ListedTurnId {
    id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedTurnStart {
    id: Option<String>,
    started_at: Option<u64>,
}

#[derive(Deserialize)]
struct ListedItemEntry {
    item: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedUserMessage {
    #[serde(rename = "type")]
    item_type: Option<String>,
    client_id: Option<String>,
}

/// One of the person's messages a search of a conversation's turns looks for the turn of.
#[derive(Clone, Copy, Debug)]
pub(crate) struct CodexSoughtMessage<'a> {
    /// The message's id, which Codex keeps on its item as the `clientId` its `turn/start` or
    /// `turn/steer` was sent with; a `UUIDv7` dates its send.
    pub(crate) message_id: &'a str,
    /// The turn the message opened or steered, where a record holds it.
    pub(crate) turn_id: Option<&'a str>,
}

/// What a search of a conversation's turns found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodexTurnListing {
    /// Codex lists the turn sought, by its id.
    Listed {
        /// The turn's id.
        turn_id: String,
    },
    /// No turn Codex lists is the one sought.
    Unlisted,
    /// The conversation no message has reached yet, which holds no turn.
    Unmaterialized,
}

/// Every turn of `thread_id`, oldest first, each turn's items as `items_view` asks, Codex's
/// summary where it is `None`; a conversation no message has reached yet answers none. Fails as
/// the connection's request does, and with `CodexError::Transport` for a reply that is not a page.
pub(crate) async fn read_codex_turns(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    items_view: Option<TurnItemsView>,
) -> Result<Vec<CodexListedTurn>, CodexError> {
    let mut newest_first = Vec::new();
    let mut cursor = None;
    loop {
        let Some(page) = read_turns_page(
            connection,
            thread_id,
            cursor,
            CODEX_TURNS_PAGE_LIMIT,
            items_view,
        )
        .await?
        else {
            return Ok(Vec::new());
        };
        newest_first.extend(page.data.into_iter().filter_map(read_listed_turn));
        cursor = page.next_cursor.filter(|next| !next.is_empty());
        if cursor.is_none() {
            break;
        }
    }
    // Pages come newest first, the default order.
    newest_first.reverse();
    Ok(newest_first)
}

/// Where `thread_id` lists the turn of the message `sought` names. Its turns are read newest
/// first with no items, and the paging stops at the first turn that started before the second
/// the message was sent in, which no turn of the message can follow. A turn id is found among
/// them; with none, the message's `clientId` is looked for in the items of the turns that paging
/// passed, one turn at a time through `thread/items/list`, which Codex serves only for a
/// paginated thread. Fails as [`read_codex_turns`] does.
pub(crate) async fn find_codex_turn(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    sought: CodexSoughtMessage<'_>,
) -> Result<CodexTurnListing, CodexError> {
    let sent_second = sent_second_of(sought.message_id);
    // The turns started since the send, newest first, and the one running when it was sent.
    let mut since_send = Vec::new();
    let mut before_send = None;
    let mut cursor = None;
    'pages: loop {
        let Some(page) = read_turns_page(
            connection,
            thread_id,
            cursor,
            CODEX_TURNS_PAGE_LIMIT,
            Some(TurnItemsView::NotLoaded),
        )
        .await?
        else {
            return Ok(CodexTurnListing::Unmaterialized);
        };
        for turn in &page.data {
            let Some(listed) = read_codex_object::<ListedTurnStart>(turn.get()) else {
                continue;
            };
            let Some(turn_id) = listed.id.filter(|id| !id.is_empty()) else {
                continue;
            };
            if sought.turn_id == Some(turn_id.as_str()) {
                return Ok(CodexTurnListing::Listed { turn_id });
            }
            // A steered message joined the turn running when it was sent, so the first turn
            // started before the send is still searched.
            let is_before_send = sent_second
                .zip(listed.started_at)
                .is_some_and(|(sent, started)| started < sent);
            if is_before_send {
                before_send = Some(turn_id);
                break 'pages;
            }
            since_send.push(turn_id);
        }
        cursor = page.next_cursor.filter(|next| !next.is_empty());
        if cursor.is_none() {
            break;
        }
    }
    if sought.turn_id.is_some() {
        return Ok(CodexTurnListing::Unlisted);
    }
    // The message most often opened the oldest turn started since its send, or steered the one
    // running then, so those two are read first and any later turn after them, oldest first.
    since_send.reverse();
    let mut since_send = since_send.into_iter();
    let candidates = since_send
        .next()
        .into_iter()
        .chain(before_send)
        .chain(since_send);
    for turn_id in candidates {
        if holds_message(connection, thread_id, &turn_id, sought.message_id).await? {
            return Ok(CodexTurnListing::Listed { turn_id });
        }
    }
    Ok(CodexTurnListing::Unlisted)
}

// The second a message whose id is a UUIDv7 was sent in, from the id's time; `None` for an id of
// another form, whose search then reads every page.
fn sent_second_of(message_id: &str) -> Option<u64> {
    let (seconds, _) = uuid::Uuid::parse_str(message_id)
        .ok()?
        .get_timestamp()?
        .to_unix();
    Some(seconds)
}

// Whether turn `turn_id` of `thread_id` holds the person's message `message_id`, its items read
// page by page.
async fn holds_message(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    turn_id: &str,
    message_id: &str,
) -> Result<bool, CodexError> {
    let mut cursor = None;
    loop {
        let params = ThreadItemsListParams {
            cursor,
            limit: Some(CODEX_TURNS_PAGE_LIMIT),
            sort_direction: None,
            thread_id: thread_id.to_owned(),
            turn_id: Some(turn_id.to_owned()),
        };
        let reply = connection
            .request(THREAD_ITEMS_LIST_METHOD, &params)
            .await?;
        let page = read_page(THREAD_ITEMS_LIST_METHOD, &reply, "items")?;
        let is_held = page.data.iter().any(|entry| {
            read_codex_object::<ListedItemEntry>(entry.get())
                .and_then(|entry| entry.item)
                .and_then(|item| read_codex_object::<ListedUserMessage>(item.get()))
                .is_some_and(|message| {
                    message.item_type.as_deref() == Some("userMessage")
                        && message.client_id.as_deref() == Some(message_id)
                })
        });
        if is_held {
            return Ok(true);
        }
        cursor = page
            .next_cursor
            .filter(|next| !next.is_empty())
            .map(CodexItemsCursor);
        if cursor.is_none() {
            return Ok(false);
        }
    }
}

/// The newest turn of `thread_id`, `None` for a conversation no message has reached yet. Fails
/// as [`read_codex_turns`] does.
pub(crate) async fn read_codex_newest_turn(
    connection: &CodexAppServerConnection,
    thread_id: &str,
) -> Result<Option<CodexListedTurn>, CodexError> {
    let Some(page) = read_turns_page(connection, thread_id, None, 1, None).await? else {
        return Ok(None);
    };
    Ok(page.data.into_iter().find_map(read_listed_turn))
}

// One page of `thread_id`'s turns, newest first, from `cursor`, each turn's items as `items_view`
// asks, Codex's summary where it is `None`; `None` for a conversation no message has reached yet.
async fn read_turns_page(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    cursor: Option<String>,
    limit: u32,
    items_view: Option<TurnItemsView>,
) -> Result<Option<CodexPage>, CodexError> {
    let params = ThreadTurnsListParams {
        cursor,
        items_view,
        limit: Some(limit),
        sort_direction: None,
        thread_id: thread_id.to_owned(),
    };
    let reply = match connection.request(THREAD_TURNS_LIST_METHOD, &params).await {
        Ok(reply) => reply,
        Err(CodexError::ProviderRequest { message, .. })
            if message.contains(CODEX_NOT_MATERIALIZED_MESSAGE) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    read_page(THREAD_TURNS_LIST_METHOD, &reply, "turns").map(Some)
}

// A listed turn with its id; an entry with no id is skipped, since a placeholder would shift every
// later position.
fn read_listed_turn(turn: Box<RawValue>) -> Option<CodexListedTurn> {
    let id = read_codex_object::<ListedTurnId>(turn.get())
        .and_then(|listed| listed.id)
        .filter(|id| !id.is_empty())?;
    Some(CodexListedTurn { id, turn })
}

/// The page a `thread/resume` asks for: the conversation's newest turn, the live one where a turn
/// runs, its items not loaded.
pub(crate) fn compose_codex_newest_turn_page() -> ThreadResumeInitialTurnsPageParams {
    ThreadResumeInitialTurnsPageParams {
        items_view: Some(TurnItemsView::NotLoaded),
        limit: Some(1),
        sort_direction: Some(SortDirection::Desc),
    }
}

/// The newest turn a `thread/resume` reply's page holds; `None` where the reply carries no page,
/// as an older Codex answers, or the page holds no turn with an id.
pub(crate) fn read_codex_resumed_newest_turn(reply: &RawValue) -> Option<CodexListedTurn> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ResumeReply {
        initial_turns_page: Option<CodexPage>,
    }
    read_codex_object::<ResumeReply>(reply.get())?
        .initial_turns_page?
        .data
        .into_iter()
        .find_map(read_listed_turn)
}

// A reply read as a page, or the transport failure that names what it lacked.
fn read_page(method: &str, reply: &RawValue, entries: &str) -> Result<CodexPage, CodexError> {
    read_codex_object::<CodexPage>(reply.get()).ok_or_else(|| CodexError::Transport {
        detail: format!("The Codex app-server \"{method}\" reply carried no page of {entries}."),
        cause: None,
    })
}
