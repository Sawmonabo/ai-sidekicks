//! The shared tool server's live entries, one per conversation spawn and tool server: the spawn's
//! provider, its secret, the dispatcher bound to that spawn, the tools its hook rows call and the
//! MCP sessions admitted for it.
//! A spawn holds its entry's guard, so the entry leaves the table when the spawn drops, and every
//! call the spawn's process left open is canceled with it. A spawn that adopts a conversation the
//! provider kept from an earlier start of the daemon also answers, while it holds its adoption,
//! each other conversation of its session with no live entry whose request presents the secret
//! the daemon's key derives for that conversation's path.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};

use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::bearer_token::BearerToken;
use sidekicks_provider::driver::callback_tool::CallbackToolDispatcher;
use sidekicks_provider::port::hook_tool_server::HookToolServer;
use sidekicks_std::mutex_lock::lock;
use tokio_util::sync::CancellationToken;

use crate::tools::secret_key::ToolServerSecretKey;
use crate::tools::server::ToolServerPath;

/// The live entries by the route each sits at: the session, its conversation and the server.
type EntryMap = Mutex<HashMap<ToolServerPath, Arc<ToolServerEntry>>>;

/// The live adoptions by the session and the server each answers on.
type AdoptionMap = Mutex<HashMap<(SessionId, String), ToolServerAdoption>>;

/// A spawn that answers its session's earlier conversations on one server.
struct ToolServerAdoption {
    /// The adopting spawn's entry, which answers them.
    entry: Arc<ToolServerEntry>,
    /// The key their secrets are derived from.
    key: Arc<ToolServerSecretKey>,
}

/// One session spawn's entry on one tool server.
pub struct ToolServerEntry {
    /// The provider the spawn runs.
    provider: ProviderId,
    /// The secret the spawn's process presents on every request.
    token: BearerToken,
    /// Answers the spawn's tool calls, bound to the spawn's own installation.
    dispatcher: CallbackToolDispatcher,
    /// Lists and answers the tools the spawn's hook rows call; `None` for a spawn with no rows.
    hook_tools: Option<Arc<dyn HookToolServer>>,
    /// The `Mcp-Session-Id`s admitted for the spawn.
    mcp_sessions: Mutex<HashSet<String>>,
    /// Canceled when the spawn drops, since its process is gone and no open call is answered.
    spawn_ended: CancellationToken,
}

// The budget: an entry is at most 256 B beside what its dispatcher points at.
const _: () = assert!(size_of::<ToolServerEntry>() <= 256);

impl ToolServerEntry {
    /// The provider the spawn runs.
    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }

    /// The dispatcher that answers the spawn's tool calls.
    pub fn dispatcher(&self) -> &CallbackToolDispatcher {
        &self.dispatcher
    }

    /// The tools the spawn's hook rows call, where its driver gave it rows.
    pub fn hook_tools(&self) -> Option<&Arc<dyn HookToolServer>> {
        self.hook_tools.as_ref()
    }

    /// Settles once the spawn dropped, so a call its process left open is canceled.
    pub async fn ended(&self) {
        self.spawn_ended.cancelled().await;
    }

    /// Admits `mcp_session_id` for the spawn.
    pub fn admit_mcp_session(&self, mcp_session_id: String) {
        lock(&self.mcp_sessions).insert(mcp_session_id);
    }

    /// Whether `mcp_session_id` was admitted for the spawn and not forgotten since.
    pub fn admits_mcp_session(&self, mcp_session_id: &str) -> bool {
        lock(&self.mcp_sessions).contains(mcp_session_id)
    }

    /// Forgets `mcp_session_id`, once its client closed it.
    pub fn forget_mcp_session(&self, mcp_session_id: &str) {
        lock(&self.mcp_sessions).remove(mcp_session_id);
    }
}

/// Every live spawn's entry, by its route; adding an entry at a route replaces the one there, so a
/// conversation's earlier spawn is admitted no more.
#[derive(Default)]
pub struct ToolServerEntries {
    /// The live entries.
    entries: Arc<EntryMap>,
    /// The live adoptions.
    adoptions: Arc<AdoptionMap>,
}

impl ToolServerEntries {
    /// Adds the entry of a spawn at `path`, run by `provider`, presenting `token`, answered by
    /// `dispatcher` and, for the calls its hook rows make, by `hook_tools`, replacing the
    /// conversation's earlier entry there. The entry leaves the table when the returned guard
    /// drops.
    pub fn insert(
        &self,
        path: ToolServerPath,
        provider: ProviderId,
        token: BearerToken,
        dispatcher: CallbackToolDispatcher,
        hook_tools: Option<Arc<dyn HookToolServer>>,
    ) -> ToolServerEntryGuard {
        let entry = Arc::new(ToolServerEntry {
            provider,
            token,
            dispatcher,
            hook_tools,
            mcp_sessions: Mutex::new(HashSet::new()),
            spawn_ended: CancellationToken::new(),
        });
        let guard = ToolServerEntryGuard {
            entries: Arc::downgrade(&self.entries),
            path: path.clone(),
            entry: Arc::downgrade(&entry),
        };
        lock(&self.entries).insert(path, entry);
        guard
    }

    /// Makes the live entry at `path` answer each other conversation of its session on its server
    /// that has no live entry, for a request presenting the secret `key` derives for that
    /// conversation's path, replacing the session's earlier adoption there; `None` when no entry
    /// sits at `path`. The adoption leaves when the returned guard drops.
    pub fn adopt(
        &self,
        path: &ToolServerPath,
        key: Arc<ToolServerSecretKey>,
    ) -> Option<ToolServerAdoptionGuard> {
        let entry = Arc::clone(lock(&self.entries).get(path)?);
        let adopted = (path.session_id, path.server_name.clone());
        let guard = ToolServerAdoptionGuard {
            adoptions: Arc::downgrade(&self.adoptions),
            adopted: adopted.clone(),
            entry: Arc::downgrade(&entry),
        };
        lock(&self.adoptions).insert(adopted, ToolServerAdoption { entry, key });
        Some(guard)
    }

    /// The live entry `path` names when `authorization`, the request's `Authorization` header,
    /// presents its token. With no entry there, the session's adopting entry on the server when
    /// the header presents the secret its key derives for `path`. `None` otherwise.
    pub fn admitted(
        &self,
        path: &ToolServerPath,
        authorization: Option<&[u8]>,
    ) -> Option<Arc<ToolServerEntry>> {
        if let Some(entry) = lock(&self.entries).get(path) {
            return entry.token.admits(authorization).then(|| Arc::clone(entry));
        }
        let adoptions = lock(&self.adoptions);
        let adoption = adoptions.get(&(path.session_id, path.server_name.clone()))?;
        adoption
            .key
            .secret_of(path)
            .admits(authorization)
            .then(|| Arc::clone(&adoption.entry))
    }
}

/// A spawn's hold on its adoption: dropping it takes the adoption out of the table, unless a later
/// spawn of the session adopted there already.
#[must_use = "dropping the guard takes the spawn's adoption out of the table"]
pub struct ToolServerAdoptionGuard {
    /// The table the adoption sits in.
    adoptions: Weak<AdoptionMap>,
    /// The session and server it answers for.
    adopted: (SessionId, String),
    /// The adopting entry, to tell this adoption from a later one under the same key.
    entry: Weak<ToolServerEntry>,
}

impl Drop for ToolServerAdoptionGuard {
    fn drop(&mut self) {
        let Some(adoptions) = self.adoptions.upgrade() else {
            return;
        };
        let mut adoptions = lock(&adoptions);
        if adoptions
            .get(&self.adopted)
            .is_some_and(|live| Weak::ptr_eq(&Arc::downgrade(&live.entry), &self.entry))
        {
            adoptions.remove(&self.adopted);
        }
    }
}

/// A spawn's hold on its entry: dropping it cancels the calls the spawn left open and takes the
/// entry out of the table, with the MCP sessions admitted for it, unless a later spawn of the
/// conversation replaced it already.
#[must_use = "dropping the guard takes the spawn's entry out of the table"]
pub struct ToolServerEntryGuard {
    /// The table the entry sits in.
    entries: Weak<EntryMap>,
    /// Where it sits.
    path: ToolServerPath,
    /// The entry itself, to tell it from a later spawn's under the same key.
    entry: Weak<ToolServerEntry>,
}

impl Drop for ToolServerEntryGuard {
    fn drop(&mut self) {
        if let Some(entry) = self.entry.upgrade() {
            entry.spawn_ended.cancel();
        }
        let Some(entries) = self.entries.upgrade() else {
            return;
        };
        let mut entries = lock(&entries);
        if entries
            .get(&self.path)
            .is_some_and(|live| Weak::ptr_eq(&Arc::downgrade(live), &self.entry))
        {
            entries.remove(&self.path);
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use std::pin::Pin;
    use std::sync::Arc;

    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_provider::bearer_token::BearerToken;
    use sidekicks_provider::driver::callback_tool::{
        CallbackToolDispatcher, CallbackToolInvocation, CallbackToolResult,
    };
    use sidekicks_provider::port::tool_server_route::ToolServerConversation;

    use super::ToolServerEntries;
    use crate::tools::server::ToolServerPath;

    const SESSION: &str = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
    const SERVER: &str = "sidekicks";

    /// What the test's dispatcher answers a call with.
    type DispatchedCall = Pin<Box<dyn Future<Output = CallbackToolResult> + Send>>;

    /// A dispatcher no test calls.
    pub(in crate::tools) fn dispatcher() -> CallbackToolDispatcher {
        Arc::new(|_invocation: CallbackToolInvocation| -> DispatchedCall {
            Box::pin(async { CallbackToolResult::Failed { error: None } })
        })
    }

    /// A provider id for the tests' entries.
    fn provider(id: &str) -> ProviderId {
        ProviderId::new(id.to_owned()).expect("the id is well formed")
    }

    // A later spawn of a conversation replaces its entry: the replaced token is admitted no more,
    // the new one answers the new entry, and the replaced spawn's drop leaves the new entry in
    // place; a copy beside the conversation has an entry of its own, whose drop leaves the
    // conversation's. Killed by a replace that keeps the old token admitted, a drop that removes by
    // key alone, or a key that leaves the conversation out.
    #[test]
    fn a_replaced_spawns_token_answers_nothing_and_a_dropped_copy_leaves_the_conversation() {
        let session_id = SessionId::new(SESSION).expect("the text is a UUID");
        let path = ToolServerPath {
            session_id,
            conversation: ToolServerConversation::of_session(session_id),
            server_name: SERVER.to_owned(),
        };
        let entries = ToolServerEntries::default();
        let first_token = BearerToken::mint().expect("the system's random source reads");
        let first_header = first_token.header_value();
        let first = entries.insert(
            path.clone(),
            provider("codex"),
            first_token,
            dispatcher(),
            None,
        );
        assert!(
            entries
                .admitted(&path, Some(first_header.as_bytes()))
                .is_some()
        );

        let second_token = BearerToken::mint().expect("the system's random source reads");
        let second_header = second_token.header_value();
        let second = entries.insert(
            path.clone(),
            provider("claude-code"),
            second_token,
            dispatcher(),
            None,
        );
        assert!(
            entries
                .admitted(&path, Some(first_header.as_bytes()))
                .is_none()
        );
        drop(first);
        let live = entries
            .admitted(&path, Some(second_header.as_bytes()))
            .expect("the new spawn's token answers its entry");
        assert_eq!(live.provider().as_str(), "claude-code");
        drop(live);

        let copy_path = ToolServerPath {
            conversation: ToolServerConversation::mint(),
            ..path.clone()
        };
        let copy_token = BearerToken::mint().expect("the system's random source reads");
        let copy_header = copy_token.header_value();
        let copy = entries.insert(
            copy_path.clone(),
            provider("claude-code"),
            copy_token,
            dispatcher(),
            None,
        );
        assert!(
            entries
                .admitted(&copy_path, Some(copy_header.as_bytes()))
                .is_some()
        );
        assert!(
            entries
                .admitted(&path, Some(copy_header.as_bytes()))
                .is_none()
        );
        drop(copy);
        assert!(
            entries
                .admitted(&path, Some(second_header.as_bytes()))
                .is_some(),
            "a copy's drop leaves the conversation's entry"
        );

        drop(second);
        assert!(
            entries
                .admitted(&path, Some(second_header.as_bytes()))
                .is_none(),
            "the entry leaves the table when its spawn drops"
        );
    }
}
