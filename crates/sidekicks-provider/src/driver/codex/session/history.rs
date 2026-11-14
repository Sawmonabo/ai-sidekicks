//! A conversation's turns, and the turn one of the person's messages started, read back from
//! Codex page by page, since a resume asks only for the newest turn.

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::driver::codex::app_server_protocol::{
    SortDirection, ThreadResumeInitialTurnsPageParams, ThreadTurnsListParams, TurnItemsView,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};

/// The largest page `thread/turns/list` returns.
const CODEX_TURNS_PAGE_LIMIT: u32 = 100;

/// Codex's refusal for a conversation no message has reached yet, which holds no turn.
const CODEX_NOT_MATERIALIZED_MESSAGE: &str = "is not materialized yet";

const THREAD_TURNS_LIST_METHOD: &str = "thread/turns/list";

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
struct ListedTurnItems {
    id: Option<String>,
    #[serde(default)]
    items: Vec<Box<RawValue>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedUserMessage {
    #[serde(rename = "type")]
    item_type: Option<String>,
    client_id: Option<String>,
}

/// The turn a search of a conversation's turns looks for.
#[derive(Clone, Copy, Debug)]
pub(crate) enum CodexSoughtTurn<'a> {
    /// The turn with this id.
    Turn(&'a str),
    /// The turn holding the person's message with this id, which Codex keeps on the message's
    /// item as the `clientId` its `turn/start` or `turn/steer` was sent with.
    Message(&'a str),
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

/// Every turn of `thread_id`, oldest first; a conversation no message has reached yet answers
/// none. Fails as the connection's request does, and with `CodexError::Transport` for a reply
/// that is not a page.
pub(crate) async fn read_codex_turns(
    connection: &CodexAppServerConnection,
    thread_id: &str,
) -> Result<Vec<CodexListedTurn>, CodexError> {
    let mut newest_first = Vec::new();
    let mut cursor = None;
    loop {
        let Some(page) =
            read_turns_page(connection, thread_id, cursor, CODEX_TURNS_PAGE_LIMIT, None).await?
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

/// Where `thread_id` lists the turn `sought` names, its turns read newest first and the paging
/// stopped at the page that lists it; a message is found by its `clientId` among each turn's full
/// items, which a turn's summary leaves out for a steered message. Fails as [`read_codex_turns`]
/// does.
pub(crate) async fn find_codex_turn(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    sought: CodexSoughtTurn<'_>,
) -> Result<CodexTurnListing, CodexError> {
    let items_view = || match sought {
        CodexSoughtTurn::Turn(_) => TurnItemsView::NotLoaded,
        CodexSoughtTurn::Message(_) => TurnItemsView::Full,
    };
    let mut cursor = None;
    loop {
        let Some(page) = read_turns_page(
            connection,
            thread_id,
            cursor,
            CODEX_TURNS_PAGE_LIMIT,
            Some(items_view()),
        )
        .await?
        else {
            return Ok(CodexTurnListing::Unmaterialized);
        };
        if let Some(turn_id) = page.data.iter().find_map(|turn| find_sought(turn, sought)) {
            return Ok(CodexTurnListing::Listed { turn_id });
        }
        cursor = page.next_cursor.filter(|next| !next.is_empty());
        if cursor.is_none() {
            return Ok(CodexTurnListing::Unlisted);
        }
    }
}

// The id of listed `turn` where it is the one `sought` names.
fn find_sought(turn: &RawValue, sought: CodexSoughtTurn<'_>) -> Option<String> {
    let listed = read_codex_object::<ListedTurnItems>(turn.get())?;
    let turn_id = listed.id.filter(|id| !id.is_empty())?;
    let is_sought = match sought {
        CodexSoughtTurn::Turn(sought_id) => turn_id == sought_id,
        CodexSoughtTurn::Message(message_id) => listed.items.iter().any(|item| {
            read_codex_object::<ListedUserMessage>(item.get()).is_some_and(|message| {
                message.item_type.as_deref() == Some("userMessage")
                    && message.client_id.as_deref() == Some(message_id)
            })
        }),
    };
    is_sought.then_some(turn_id)
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
