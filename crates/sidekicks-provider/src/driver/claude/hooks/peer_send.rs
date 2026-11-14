//! The send hook: a `SendMessage` call aimed at another session is denied with the words that
//! point the model at `session_send`, so every message between sessions goes through the daemon
//! and is tracked, while a call aimed at one of the session's own helpers, or at `main`, passes.

use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use regex::Regex;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::error_description::describe_error;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::hooks::pause::ClaudeHookAnswer;
use crate::driver::claude::live_sessions::{
    ClaudeLiveSession, by_name, by_socket, names_socket, read_live_sessions,
};
use crate::driver::session_messages::{no_session_named, target_unread_reason};
use crate::port::agent_tree_lookup::AgentTreeLookup;
use crate::port::session_directory_lookup::{DirectoryMatch, SessionDirectoryLookup};
use crate::port::session_message_reading_publisher::SessionMessageArrival;

/// The recipient Claude Code reads as the session's lead.
const LEAD_RECIPIENT: &str = "main";

/// The schemes Claude Code's target resolver reads off a recipient as an address.
const ADDRESS_SCHEMES: [&str; 3] = ["uds:", "bridge:", "did:"];

/// A bare socket path, which Claude Code's resolver reads as a `uds:` address.
static SOCKET_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/\S*\.sock$").expect("the pattern is valid"));

/// A Windows named pipe, which Claude Code's resolver reads as a `uds:` address.
static PIPE_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[\\/]{2}[.?][\\/]pipe[\\/]").expect("the pattern is valid"));

/// A local session's id, which Claude Code reads as another session rather than a name.
static LOCAL_SESSION_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^local_[0-9a-f-]{8,72}$").expect("the pattern is valid"));

/// The words for a send to another session, naming it by `name` and telling the model to send to
/// `target`, the session's name or, where that name is shared, its id.
fn another_session(name: &str, target: &str) -> String {
    format!(
        "{name} is another session. Send with session_send {{\"to\": {}}}.",
        quoted(target)
    )
}

/// The words for a send to the address of the message that started the turn, from `name`, whose
/// session is `id`.
fn answer_goes_back(name: &str, id: &str) -> String {
    format!(
        "Your answer already reaches {name} when you finish this turn. To say more, use \
         session_send {{\"to\": {}}}.",
        quoted(id)
    )
}

// `text` as a JSON string, so a name holding a quote still reads as one value.
fn quoted(text: &str) -> String {
    serde_json::to_string(text).expect("a string serializes")
}

/// A session that sent the open turn a message, as its arrival names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudePeerSender {
    /// Its name, where the arrival gives one.
    name: Option<String>,
    /// Its id, which `session_send` takes.
    id: String,
}

impl ClaudePeerSender {
    // The name the words give it: its own, else its id.
    fn display_name(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.id)
    }
}

/// Who sent the open turn's messages from other sessions: the session whose message started the
/// turn, and the latest one whose message the running turn took in. A turn's end clears it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ClaudeTurnSenders {
    started_by: Option<ClaudePeerSender>,
    latest_absorbed: Option<ClaudePeerSender>,
}

impl ClaudeTurnSenders {
    /// Notes `arrival`'s sender, where the arrival names the sending session: as the turn's
    /// starter when its message starts the turn, else as the latest taken in.
    pub(crate) fn observe(&mut self, arrival: &SessionMessageArrival) {
        let Some(id) = arrival.from_session.clone().filter(|id| !id.is_empty()) else {
            return;
        };
        let sender = ClaudePeerSender {
            name: arrival.from_name.clone().filter(|name| !name.is_empty()),
            id,
        };
        if arrival.is_turn_start {
            self.started_by = Some(sender);
        } else {
            self.latest_absorbed = Some(sender);
        }
    }
}

/// One `SendMessage` call the send hook judges, with what it reads to judge it.
pub(crate) struct ClaudePeerSendCheck<'a> {
    /// The calling session.
    pub(crate) session_id: SessionId,
    /// The calling session's own process, whose registry file names it among the running ones.
    pub(crate) caller_process_id: u32,
    /// The call's recipient, never empty.
    pub(crate) to: &'a str,
    /// Who sent the open turn's messages.
    pub(crate) senders: ClaudeTurnSenders,
    /// The daemon's own inbox, the `from` of every message the daemon delivers.
    pub(crate) daemon_inbox: &'a str,
    /// The session's agent tree, once registered.
    pub(crate) agent_tree: Option<Arc<dyn AgentTreeLookup>>,
    /// The daemon's session directory, once registered.
    pub(crate) directory: Option<Arc<dyn SessionDirectoryLookup>>,
    /// The config folders whose live-session registries name the running Claude Code sessions,
    /// awaited only where the directory does not settle the call.
    pub(crate) registry_folders: BoxFuture<'a, Result<Vec<PathBuf>, Box<dyn Error + Send + Sync>>>,
}

/// The send hook's answer to `check`, the first matching rule deciding: one of the session's own
/// helpers by id or name, or `main`, passes; the daemon's inbox is denied with the words for the
/// turn's starting sender, else its latest absorbed one, else as no session; any other address is
/// denied as the session the directory or the registry finds there, else as no session; a name a
/// session has is denied as that session; any other name passes. A failed read is denied with its
/// cause.
pub(crate) async fn answer_peer_send(check: ClaudePeerSendCheck<'_>) -> ClaudeHookAnswer {
    match judge(check).await {
        Ok(Some(reason)) => ClaudeHookAnswer::Deny { reason },
        Ok(None) => ClaudeHookAnswer::Pass,
        Err(error) => ClaudeHookAnswer::Deny {
            reason: target_unread_reason(&describe_error(&*error)),
        },
    }
}

// The reason `check`'s call is denied with, `None` where it passes.
async fn judge(
    check: ClaudePeerSendCheck<'_>,
) -> Result<Option<String>, Box<dyn Error + Send + Sync>> {
    let to = check.to;
    if to == LEAD_RECIPIENT
        || is_own_helper(check.agent_tree.as_deref(), check.session_id, to).await?
    {
        return Ok(None);
    }
    if names_socket(to, check.daemon_inbox).await {
        let senders = &check.senders;
        let reason = match (&senders.started_by, &senders.latest_absorbed) {
            (Some(starter), _) => answer_goes_back(starter.display_name(), &starter.id),
            (None, Some(absorbed)) => another_session(absorbed.display_name(), &absorbed.id),
            (None, None) => no_session_named(to),
        };
        return Ok(Some(reason));
    }
    // The calling session is no other session, so a send to its own name is not refused as one.
    let caller_id = check.session_id.to_string();
    let listed: Vec<_> = match &check.directory {
        Some(directory) => directory
            .sessions_named(to.to_owned())
            .await?
            .into_iter()
            .filter(|session| session.id != caller_id)
            .collect(),
        None => Vec::new(),
    };
    if let Some(reason) = directory_refusal(&listed) {
        return Ok(Some(reason));
    }
    let mut running = read_live_sessions(&check.registry_folders.await?).await;
    running.retain(|session| session.process_id != check.caller_process_id);
    if !is_address(to) {
        return Ok(by_name(&running, to)
            .next()
            .map(|session| registry_refusal(&running, session, to)));
    }
    // An address whose folder cannot be resolved holds no session, and is denied either way.
    let at_socket = if is_socket_address(to) {
        by_socket(&running, to).await.ok().flatten()
    } else {
        None
    };
    Ok(Some(at_socket.map_or_else(
        || no_session_named(to),
        |session| registry_refusal(&running, session, to),
    )))
}

// Whether `to` is the id or the name of a helper of `session_id` the agent tree holds; a tree not
// yet registered holds none.
async fn is_own_helper(
    agent_tree: Option<&dyn AgentTreeLookup>,
    session_id: SessionId,
    to: &str,
) -> Result<bool, Box<dyn Error + Send + Sync>> {
    let Some(agent_tree) = agent_tree else {
        return Ok(false);
    };
    let by_id = agent_tree
        .helper_by_subagent_id(session_id, DESCRIPTOR.provider_id(), to.to_owned())
        .await?;
    if by_id.is_some() {
        return Ok(true);
    }
    Ok(agent_tree
        .helper_by_name(session_id, to.to_owned())
        .await?
        .is_some())
}

// Whether Claude Code reads `to` as another session's address rather than a name.
fn is_address(to: &str) -> bool {
    ADDRESS_SCHEMES.iter().any(|scheme| to.starts_with(scheme))
        || SOCKET_PATH.is_match(to)
        || PIPE_NAME.is_match(to)
        || LOCAL_SESSION_ID.is_match(to)
}

// Whether `to` is an address of a socket or a pipe, which a registry entry's inbox can be.
fn is_socket_address(to: &str) -> bool {
    to.starts_with("uds:") || SOCKET_PATH.is_match(to) || PIPE_NAME.is_match(to)
}

// The words for the session the directory lists for a call, by its id where several share its
// name; `None` where it lists none.
fn directory_refusal(listed: &[DirectoryMatch]) -> Option<String> {
    let first = listed.first()?;
    let target = if listed.len() > 1 {
        &first.id
    } else {
        &first.name
    };
    Some(another_session(&first.name, target))
}

// The words for `session`, a running session of `running`: by its name, else its id, else what
// the call named, and sent to by its id where another running session shares its name.
fn registry_refusal(
    running: &[ClaudeLiveSession],
    session: &ClaudeLiveSession,
    to: &str,
) -> String {
    let name = session
        .name
        .as_deref()
        .or(session.session_id.as_deref())
        .unwrap_or(to);
    let is_shared = session
        .name
        .as_deref()
        .is_some_and(|name| by_name(running, name).nth(1).is_some());
    let target = match (is_shared, session.session_id.as_deref()) {
        (true, Some(id)) => id,
        _ => name,
    };
    another_session(name, target)
}

#[cfg(test)]
mod tests;
