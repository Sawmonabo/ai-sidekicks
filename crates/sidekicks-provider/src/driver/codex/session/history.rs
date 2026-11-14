//! A conversation's turns, and the turn one of the person's messages started, read back from
//! Codex page by page, since a resume asks only for the newest turn.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;

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

/// The words of Codex's failure to read a conversation whose first message it has taken and not
/// yet written, which holds no turn on record either; its message ends with the second.
const CODEX_UNWRITTEN_ROLLOUT_MESSAGES: [&str; 2] =
    ["failed to read session metadata", " is empty"];

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
    started_at: Option<i64>,
}

#[derive(Deserialize)]
struct ListedTurnSummary {
    id: Option<String>,
    #[serde(default)]
    items: Vec<Box<RawValue>>,
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
#[expect(
    clippy::struct_field_names,
    reason = "each field is the id of a different thing: a message, its turn's opener, a turn"
)]
pub(crate) struct CodexSoughtMessage<'a> {
    /// The message's id, which Codex keeps on its item as the `clientId` its `turn/start` or
    /// `turn/steer` was sent with; a `UUIDv7` dates its send.
    pub(crate) message_id: &'a str,
    /// The message that opened the turn this one rode in, where it is another: a turn start sends
    /// only its first message's id, so a turn holding the opener's `clientId` holds this one too.
    pub(crate) opener_id: Option<&'a str>,
    /// The turn the message opened or steered, where a record holds it.
    pub(crate) turn_id: Option<&'a str>,
}

impl CodexSoughtMessage<'_> {
    // Whether a listed item is the person's message sought, or the opener of the turn it rode in.
    fn is_held_by(&self, item: &RawValue) -> bool {
        read_codex_object::<ListedUserMessage>(item.get()).is_some_and(|message| {
            message.item_type.as_deref() == Some("userMessage")
                && message.client_id.as_deref().is_some_and(|client_id| {
                    client_id == self.message_id || self.opener_id == Some(client_id)
                })
        })
    }
}

/// What a search of a conversation's turns found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodexTurnListing {
    /// Codex lists the turn sought, by its id.
    Listed {
        /// The turn's id.
        turn_id: String,
    },
    /// Codex lists turns and none since the message's send, nor the one running at it, is the turn
    /// sought or holds the message's id.
    Unlisted,
    /// Codex holds the conversation and lists no turn of it: one whose history it has not
    /// projected, or one cut to before its first turn, which the listing cannot tell apart.
    Empty,
    /// What Codex lists shows neither the message nor that it is gone: it has no record of the
    /// conversation's turns yet, as for one no message has reached or whose first message it has
    /// not written, or it serves a legacy thread's items only as each turn's first message, which
    /// a steer is not.
    Indeterminate,
}

/// Every turn of `thread_id`, oldest first, with its items not loaded, since each reader reads a
/// turn's own members only; a conversation no message has reached yet, or whose first message
/// Codex has not written, answers none. Fails as the connection's request does, and with
/// `CodexError::Transport` for a reply that is not a page or names the cursor it was sent as the
/// next.
pub(crate) async fn read_codex_turns(
    connection: &CodexAppServerConnection,
    thread_id: &str,
) -> Result<Vec<CodexListedTurn>, CodexError> {
    let mut newest_first = Vec::new();
    let mut cursor = None;
    loop {
        let Some(page) = read_turns_page(
            connection,
            thread_id,
            cursor.clone(),
            CODEX_TURNS_PAGE_LIMIT,
            TurnItemsView::NotLoaded,
        )
        .await?
        else {
            return Ok(Vec::new());
        };
        newest_first.extend(page.data.into_iter().filter_map(read_listed_turn));
        cursor = read_next_cursor(
            THREAD_TURNS_LIST_METHOD,
            cursor.as_deref(),
            page.next_cursor,
        )?;
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
/// the message was sent in, which no turn of the message can follow. A known turn id found among
/// them answers at once; otherwise the message's `clientId`, or that of the opener of the turn it
/// rode in, is looked for in the items of the turns that paging passed, one turn at a time through
/// `thread/items/list`, or, on a legacy thread that list does not serve, in each turn's first
/// message. Fails as [`read_codex_turns`] does, and with `CodexError::Transport` for a page that
/// names the cursor it was sent as the next.
pub(crate) async fn find_codex_turn(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    sought: CodexSoughtMessage<'_>,
) -> Result<CodexTurnListing, CodexError> {
    let sent_second = sent_second_of(sought.message_id);
    // The turns started since the send and those with no start time, each newest first, and the
    // one running when it was sent.
    let mut since_send = Vec::new();
    let mut undated = Vec::new();
    let mut before_send = None;
    let mut is_any_turn_listed = false;
    let mut cursor = None;
    'pages: loop {
        let Some(page) = read_turns_page(
            connection,
            thread_id,
            cursor.clone(),
            CODEX_TURNS_PAGE_LIMIT,
            TurnItemsView::NotLoaded,
        )
        .await?
        else {
            return Ok(CodexTurnListing::Indeterminate);
        };
        for turn in &page.data {
            let Some(listed) = read_codex_object::<ListedTurnStart>(turn.get()) else {
                continue;
            };
            let Some(turn_id) = listed.id.filter(|id| !id.is_empty()) else {
                continue;
            };
            is_any_turn_listed = true;
            if sought.turn_id == Some(turn_id.as_str()) {
                return Ok(CodexTurnListing::Listed { turn_id });
            }
            // A steered message joined the turn running when it was sent, so the first turn
            // started before the send is still searched. Codex dates every turn it opens; a turn
            // with no start time cannot be placed before the send, so the paging goes past it.
            match sent_second.zip(listed.started_at.filter(|started| *started > 0)) {
                Some((sent, started)) if started < sent => {
                    before_send = Some(turn_id);
                    break 'pages;
                }
                Some(_) => since_send.push(turn_id),
                None => undated.push(turn_id),
            }
        }
        cursor = read_next_cursor(
            THREAD_TURNS_LIST_METHOD,
            cursor.as_deref(),
            page.next_cursor,
        )?;
        if cursor.is_none() {
            break;
        }
    }
    if !is_any_turn_listed {
        return Ok(CodexTurnListing::Empty);
    }
    // The message most often opened the oldest turn started since its send, or steered the one
    // running then, so those two are read first, then any later turn oldest first; with no turn
    // dated before the send, the newest undated turn stands for the running one and the rest
    // follow newest first, nearest the send.
    since_send.reverse();
    let mut since_send = since_send.into_iter();
    let mut undated = undated.into_iter();
    let running_at_send = before_send.or_else(|| undated.next());
    let candidates: Vec<String> = since_send
        .next()
        .into_iter()
        .chain(running_at_send)
        .chain(since_send)
        .chain(undated)
        .collect();
    for (index, turn_id) in candidates.iter().enumerate() {
        match holds_message(connection, thread_id, turn_id, &sought).await {
            Ok(true) => {
                return Ok(CodexTurnListing::Listed {
                    turn_id: turn_id.clone(),
                });
            }
            Ok(false) => {}
            Err(error) if is_items_list_unserved(&error) => {
                let opened =
                    find_opening_turn(connection, thread_id, &candidates[index..], &sought).await?;
                return Ok(match opened {
                    Some(turn_id) => CodexTurnListing::Listed { turn_id },
                    None => CodexTurnListing::Indeterminate,
                });
            }
            Err(error) => return Err(error),
        }
    }
    Ok(CodexTurnListing::Unlisted)
}

// The second a message whose id is a UUIDv7 was sent in, from the id's time; `None` for an id of
// another form, whose search then reads every page.
fn sent_second_of(message_id: &str) -> Option<i64> {
    let (seconds, _) = uuid::Uuid::parse_str(message_id)
        .ok()?
        .get_timestamp()?
        .to_unix();
    i64::try_from(seconds).ok()
}

// Whether `error` is Codex's method-not-found answer to `thread/items/list`, which it gives for a
// thread with legacy history.
fn is_items_list_unserved(error: &CodexError) -> bool {
    matches!(
        error,
        CodexError::ProviderRequest { code, .. }
            if *code == i64::from(JsonRpcErrorCode::MethodNotFound.code())
    )
}

// The turn among `candidates` whose first user message, as Codex's summary of each turn shows it,
// is the message `sought` or the opener of the turn it rode in, the turns of `thread_id` paged
// newest first until every candidate was read; `None` where none opened with either.
async fn find_opening_turn(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    candidates: &[String],
    sought: &CodexSoughtMessage<'_>,
) -> Result<Option<String>, CodexError> {
    let mut unread: HashSet<&str> = candidates.iter().map(String::as_str).collect();
    let mut cursor = None;
    while !unread.is_empty() {
        let Some(page) = read_turns_page(
            connection,
            thread_id,
            cursor.clone(),
            CODEX_TURNS_PAGE_LIMIT,
            TurnItemsView::Summary,
        )
        .await?
        else {
            return Ok(None);
        };
        for turn in &page.data {
            let Some(ListedTurnSummary {
                id: Some(turn_id),
                items,
            }) = read_codex_object::<ListedTurnSummary>(turn.get())
            else {
                continue;
            };
            if !unread.remove(turn_id.as_str()) {
                continue;
            }
            if items.iter().any(|item| sought.is_held_by(item)) {
                return Ok(Some(turn_id));
            }
        }
        cursor = read_next_cursor(
            THREAD_TURNS_LIST_METHOD,
            cursor.as_deref(),
            page.next_cursor,
        )?;
        if cursor.is_none() {
            break;
        }
    }
    Ok(None)
}

// Whether turn `turn_id` of `thread_id` holds the message `sought` or the opener of the turn it
// rode in, its items read page by page.
async fn holds_message(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    turn_id: &str,
    sought: &CodexSoughtMessage<'_>,
) -> Result<bool, CodexError> {
    let mut cursor = None;
    loop {
        let params = ThreadItemsListParams {
            cursor: cursor.clone().map(CodexItemsCursor),
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
                .is_some_and(|item| sought.is_held_by(&item))
        });
        if is_held {
            return Ok(true);
        }
        cursor = read_next_cursor(
            THREAD_ITEMS_LIST_METHOD,
            cursor.as_deref(),
            page.next_cursor,
        )?;
        if cursor.is_none() {
            return Ok(false);
        }
    }
}

// The cursor of the page after one `method` answered for the cursor `sent`: `None` where the page
// names none, which ends the paging. Fails with `CodexError::Transport` where the page names `sent`
// again, which would page forever.
fn read_next_cursor(
    method: &str,
    sent: Option<&str>,
    next: Option<String>,
) -> Result<Option<String>, CodexError> {
    let next = next.filter(|next| !next.is_empty());
    if next.is_some() && next.as_deref() == sent {
        return Err(CodexError::Transport {
            detail: format!(
                "The Codex app-server \"{method}\" reply named the cursor it was sent again."
            ),
            cause: None,
        });
    }
    Ok(next)
}

/// The newest turn of `thread_id`, its items not loaded, `None` for a conversation no message has
/// reached yet. Fails as [`read_codex_turns`] does.
pub(crate) async fn read_codex_newest_turn(
    connection: &CodexAppServerConnection,
    thread_id: &str,
) -> Result<Option<CodexListedTurn>, CodexError> {
    let Some(page) =
        read_turns_page(connection, thread_id, None, 1, TurnItemsView::NotLoaded).await?
    else {
        return Ok(None);
    };
    Ok(page.data.into_iter().find_map(read_listed_turn))
}

// One page of `thread_id`'s turns, newest first, from `cursor`, each turn's items as `items_view`
// asks; `None` for a conversation no message has reached yet, or whose first message Codex has not
// written yet.
async fn read_turns_page(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    cursor: Option<String>,
    limit: u32,
    items_view: TurnItemsView,
) -> Result<Option<CodexPage>, CodexError> {
    let params = ThreadTurnsListParams {
        cursor,
        items_view: Some(items_view),
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
        Err(error) if is_rollout_unwritten(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    read_page(THREAD_TURNS_LIST_METHOD, &reply, "turns").map(Some)
}

// Whether `error` is Codex's internal failure to read a conversation whose record file it has
// made and not yet written to, as right after the first message's `turn/start`.
fn is_rollout_unwritten(error: &CodexError) -> bool {
    let [read_failed, empty] = CODEX_UNWRITTEN_ROLLOUT_MESSAGES;
    matches!(
        error,
        CodexError::ProviderRequest { code, message, .. }
            if *code == i64::from(JsonRpcErrorCode::InternalError.code())
                && message.contains(read_failed)
                && message.ends_with(empty)
    )
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
