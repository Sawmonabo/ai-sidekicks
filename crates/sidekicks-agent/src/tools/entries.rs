//! The shared tool server's live entries, one per conversation spawn: the spawn's provider, the
//! secret of each tool server it opened, the dispatcher bound to that spawn, the tools its hook
//! rows call and the MCP sessions admitted for it.
//! A spawn holds its entry's guard, so the entry leaves the table when the spawn drops, and every
//! call the spawn's process left open is canceled with it. A spawn that adopts a conversation the
//! provider kept from an earlier start of the daemon also answers, while it holds its adoption,
//! each other conversation of its session with no live entry whose request presents the secret
//! the daemon's key derives for that conversation's path.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::bearer_token::BearerToken;
use sidekicks_provider::driver::callback_tool::CallbackToolDispatcher;
use sidekicks_provider::port::hook_tool_server::HookToolServer;
use sidekicks_provider::port::tool_server_route::{ToolServerConversation, ToolServerSpawn};
use sidekicks_std::mutex_lock::lock;
use tokio_util::sync::CancellationToken;

use crate::tools::secret_key::ToolServerSecretKey;
use crate::tools::server::ToolServerPath;

/// Where a spawn's entry sits: the session and the conversation of it the spawn runs.
type SpawnKey = (SessionId, ToolServerConversation);

/// The live entries by the conversation each spawn runs.
type EntryMap = Mutex<HashMap<SpawnKey, Arc<ToolServerEntry>>>;

/// The live adoptions by the session each answers for.
type AdoptionMap = Mutex<HashMap<SessionId, ToolServerAdoption>>;

/// A spawn that answers its session's earlier conversations on the servers it opened.
struct ToolServerAdoption {
    /// The adopting spawn's entry, which answers them.
    entry: Arc<ToolServerEntry>,
    /// The key their secrets are derived from.
    key: Arc<ToolServerSecretKey>,
}

/// One session spawn's entry, across every tool server it opened.
pub struct ToolServerEntry {
    /// The provider the spawn runs.
    provider: ProviderId,
    /// Each server the spawn opened, with the secret its process presents there on every request.
    servers: Box<[(&'static str, BearerToken)]>,
    /// Answers the spawn's tool calls, bound to the spawn's own installation.
    dispatcher: CallbackToolDispatcher,
    /// Lists and answers the tools the spawn's hook rows call; `None` for a spawn with no rows.
    hook_tools: Option<Arc<dyn HookToolServer>>,
    /// The `Mcp-Session-Id`s admitted for the spawn, each with the server it was minted on.
    mcp_sessions: Mutex<HashMap<String, (&'static str, CancellationToken)>>,
    /// Canceled when the spawn drops, since its process is gone and no open call is answered.
    spawn_ended: CancellationToken,
}

// Counts the inline struct only: not its `Arc`'s counts, the heap its servers' slice, provider id
// and cancellation node hold, its admitted sessions, the table's slot, or its guard.
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

    // The server named `server_name` the spawn opened, with its secret.
    fn server(&self, server_name: &str) -> Option<&(&'static str, BearerToken)> {
        self.servers.iter().find(|(name, _)| *name == server_name)
    }

    /// Admits `mcp_session_id`, minted on the spawn's server `server_name`, for the spawn;
    /// `closed` is canceled once its client closes it.
    pub(crate) fn admit_mcp_session(
        &self,
        server_name: &str,
        mcp_session_id: String,
        closed: CancellationToken,
    ) {
        let (server, _) = self
            .server(server_name)
            .expect("a session is minted only on a server its entry admitted");
        lock(&self.mcp_sessions).insert(mcp_session_id, (server, closed));
    }

    /// Whether `mcp_session_id` was admitted for the spawn on `server_name` and not forgotten
    /// since.
    pub(crate) fn admits_mcp_session(&self, server_name: &str, mcp_session_id: &str) -> bool {
        lock(&self.mcp_sessions)
            .get(mcp_session_id)
            .is_some_and(|(server, _)| *server == server_name)
    }

    /// Forgets `mcp_session_id`, once its client closed it, and cancels its `closed` token.
    pub(crate) fn forget_mcp_session(&self, mcp_session_id: &str) {
        if let Some((_, closed)) = lock(&self.mcp_sessions).remove(mcp_session_id) {
            closed.cancel();
        }
    }
}

/// Every live spawn's entry, by the conversation it runs; adding an entry there replaces the one
/// there, so a conversation's earlier spawn is admitted no more.
#[derive(Default)]
pub struct ToolServerEntries {
    /// The live entries.
    entries: Arc<EntryMap>,
    /// The live adoptions.
    adoptions: Arc<AdoptionMap>,
}

impl ToolServerEntries {
    /// Adds `spawn`'s entry on each of `servers`, each presenting its own secret, replacing the
    /// conversation's earlier entry. The entry leaves the table when the returned guard drops.
    pub fn insert(
        &self,
        spawn: ToolServerSpawn,
        servers: Vec<(&'static str, BearerToken)>,
    ) -> ToolServerEntryGuard {
        let key = (spawn.session_id, spawn.conversation);
        let entry = Arc::new(ToolServerEntry {
            provider: spawn.provider,
            servers: servers.into_boxed_slice(),
            dispatcher: spawn.dispatcher,
            hook_tools: spawn.hook_tools,
            mcp_sessions: Mutex::new(HashMap::new()),
            spawn_ended: CancellationToken::new(),
        });
        let guard = ToolServerEntryGuard {
            entries: Arc::downgrade(&self.entries),
            key,
            entry: Arc::downgrade(&entry),
        };
        lock(&self.entries).insert(key, entry);
        guard
    }

    /// Makes the live entry of `session_id`'s `conversation` answer each other conversation of
    /// its session that has no live entry, on the servers it opened, for a request presenting
    /// the secret `key` derives for that conversation's path, replacing the session's earlier
    /// adoption; `None` when no entry runs that conversation. The adoption leaves when the
    /// returned guard drops.
    pub fn adopt(
        &self,
        session_id: SessionId,
        conversation: ToolServerConversation,
        key: Arc<ToolServerSecretKey>,
    ) -> Option<ToolServerAdoptionGuard> {
        let entry = Arc::clone(lock(&self.entries).get(&(session_id, conversation))?);
        let guard = ToolServerAdoptionGuard {
            adoptions: Arc::downgrade(&self.adoptions),
            session_id,
            entry: Arc::downgrade(&entry),
        };
        lock(&self.adoptions).insert(session_id, ToolServerAdoption { entry, key });
        Some(guard)
    }

    /// The live entry of the conversation `path` names when it opened `path`'s server and
    /// `authorization`, the request's `Authorization` header, presents that server's secret.
    /// With no such entry, the session's adopting entry when it opened the server and the header
    /// presents the secret its key derives for `path`. `None` otherwise.
    pub fn admitted(
        &self,
        path: &ToolServerPath,
        authorization: Option<&[u8]>,
    ) -> Option<Arc<ToolServerEntry>> {
        if let Some(entry) = lock(&self.entries).get(&(path.session_id, path.conversation))
            && let Some((_, token)) = entry.server(&path.server_name)
        {
            return token.admits(authorization).then(|| Arc::clone(entry));
        }
        let adoptions = lock(&self.adoptions);
        let adoption = adoptions.get(&path.session_id)?;
        (adoption.entry.server(&path.server_name).is_some()
            && adoption.key.secret_of(path).admits(authorization))
        .then(|| Arc::clone(&adoption.entry))
    }
}

/// A spawn's hold on its adoption: dropping it takes the adoption out of the table, unless a later
/// spawn of the session adopted there already.
#[must_use = "dropping the guard takes the spawn's adoption out of the table"]
pub struct ToolServerAdoptionGuard {
    /// The table the adoption sits in.
    adoptions: Weak<AdoptionMap>,
    /// The session it answers for.
    session_id: SessionId,
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
            .get(&self.session_id)
            .is_some_and(|live| Weak::ptr_eq(&Arc::downgrade(&live.entry), &self.entry))
        {
            adoptions.remove(&self.session_id);
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
    key: SpawnKey,
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
            .get(&self.key)
            .is_some_and(|live| Weak::ptr_eq(&Arc::downgrade(live), &self.entry))
        {
            entries.remove(&self.key);
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
    use sidekicks_provider::port::tool_server_route::{ToolServerConversation, ToolServerSpawn};

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

    /// A spawn of `path`'s conversation run by `provider`, with no hook rows.
    pub(in crate::tools) fn spawn_at(path: &ToolServerPath, provider: &str) -> ToolServerSpawn {
        ToolServerSpawn {
            session_id: path.session_id,
            conversation: path.conversation,
            provider: ProviderId::new(provider.to_owned()).expect("the id is well formed"),
            dispatcher: dispatcher(),
            hook_tools: None,
        }
    }

    // A later spawn of a conversation replaces its entry: the replaced token is admitted no more,
    // the new one answers the new entry, and the replaced spawn's drop leaves the new entry in
    // place; a copy beside the conversation has an entry of its own, whose drop leaves the
    // conversation's; a server the spawn did not open admits nothing. Killed by a replace that
    // keeps the old token admitted, a drop that removes by key alone, a key that leaves the
    // conversation out, or a lookup that ignores the server.
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
        let first = entries.insert(spawn_at(&path, "codex"), vec![(SERVER, first_token)]);
        assert!(
            entries
                .admitted(&path, Some(first_header.as_bytes()))
                .is_some()
        );
        let unopened = ToolServerPath {
            server_name: "sidekicks_hooks".to_owned(),
            ..path
        };
        assert!(
            entries
                .admitted(&unopened, Some(first_header.as_bytes()))
                .is_none()
        );

        let second_token = BearerToken::mint().expect("the system's random source reads");
        let second_header = second_token.header_value();
        let second = entries.insert(spawn_at(&path, "claude-code"), vec![(SERVER, second_token)]);
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
            spawn_at(&copy_path, "claude-code"),
            vec![(SERVER, copy_token)],
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
