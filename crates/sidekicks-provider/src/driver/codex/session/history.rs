//! A conversation's turns, and the turn each of the person's messages started, read back from
//! Codex page by page, since a resume asks for no turns.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::driver::codex::app_server_protocol::{ThreadItemsListParams, ThreadTurnsListParams};
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
struct ListedItemEntry {
    turn_id: Option<String>,
    item: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedUserMessage {
    #[serde(rename = "type")]
    item_type: Option<String>,
    client_id: Option<String>,
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
        let params = ThreadTurnsListParams {
            cursor,
            items_view: None,
            limit: Some(CODEX_TURNS_PAGE_LIMIT),
            sort_direction: None,
            thread_id: thread_id.to_owned(),
        };
        let reply = match connection.request(THREAD_TURNS_LIST_METHOD, &params).await {
            Ok(reply) => reply,
            Err(CodexError::ProviderRequest { message, .. })
                if message.contains(CODEX_NOT_MATERIALIZED_MESSAGE) =>
            {
                return Ok(Vec::new());
            }
            Err(error) => return Err(error),
        };
        let page = read_page(THREAD_TURNS_LIST_METHOD, &reply, "turns")?;
        for turn in page.data {
            // An entry with no id is skipped: a placeholder would shift every later position.
            let id = read_codex_object::<ListedTurnId>(turn.get())
                .and_then(|listed| listed.id)
                .filter(|id| !id.is_empty());
            if let Some(id) = id {
                newest_first.push(CodexListedTurn { id, turn });
            }
        }
        cursor = page.next_cursor.filter(|next| !next.is_empty());
        if cursor.is_none() {
            break;
        }
    }
    // Pages come newest first, the default order.
    newest_first.reverse();
    Ok(newest_first)
}

/// The turn each of the person's messages started on `thread_id`, by the message's id, read from
/// the conversation's items page by page; a message sent with no id is left out. Fails as the
/// connection's request does, and with `CodexError::Transport` for a reply that is not a page.
pub(crate) async fn read_codex_turn_id_by_client_message_id(
    connection: &CodexAppServerConnection,
    thread_id: &str,
) -> Result<HashMap<String, String>, CodexError> {
    let mut turn_id_by_client_message_id = HashMap::new();
    let mut cursor = None;
    loop {
        let params = ThreadItemsListParams {
            cursor,
            limit: None,
            sort_direction: None,
            thread_id: thread_id.to_owned(),
            turn_id: None,
        };
        let reply = connection
            .request(THREAD_ITEMS_LIST_METHOD, &params)
            .await?;
        let page = read_page(THREAD_ITEMS_LIST_METHOD, &reply, "items")?;
        for entry in page.data {
            let Some(ListedItemEntry {
                turn_id: Some(turn_id),
                item: Some(item),
            }) = read_codex_object::<ListedItemEntry>(entry.get())
            else {
                continue;
            };
            // A user message carries the id its `turn/start` was sent with as `clientId`.
            let Some(ListedUserMessage {
                item_type: Some(item_type),
                client_id: Some(client_id),
            }) = read_codex_object::<ListedUserMessage>(item.get())
            else {
                continue;
            };
            if item_type == "userMessage" && !turn_id.is_empty() && !client_id.is_empty() {
                turn_id_by_client_message_id.insert(client_id, turn_id);
            }
        }
        cursor = page
            .next_cursor
            .filter(|next| !next.is_empty())
            .map(CodexItemsCursor);
        if cursor.is_none() {
            break;
        }
    }
    Ok(turn_id_by_client_message_id)
}

// A reply read as a page, or the transport failure that names what it lacked.
fn read_page(method: &str, reply: &RawValue, entries: &str) -> Result<CodexPage, CodexError> {
    read_codex_object::<CodexPage>(reply.get()).ok_or_else(|| CodexError::Transport {
        detail: format!("The Codex app-server \"{method}\" reply carried no page of {entries}."),
        cause: None,
    })
}
