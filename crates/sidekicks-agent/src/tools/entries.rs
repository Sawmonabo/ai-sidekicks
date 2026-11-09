//! The shared tool server's live entries, one per session spawn and tool server: the spawn's
//! provider, its secret, the dispatcher bound to that spawn and the MCP sessions admitted for it.
//! A spawn holds its entry's guard, so the entry leaves the table when the spawn drops.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};

use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::bearer_token::BearerToken;
use sidekicks_provider::driver::callback_tool::CallbackToolDispatcher;
use sidekicks_std::mutex_lock::lock;

/// The table's key: the session and the tool server's name on its route.
type EntryKey = (SessionId, String);

/// The live entries by their key.
type EntryMap = Mutex<HashMap<EntryKey, Arc<ToolServerEntry>>>;

/// One session spawn's entry on one tool server.
pub struct ToolServerEntry {
    /// The provider the spawn runs.
    provider: ProviderId,
    /// The secret the spawn's process presents on every request.
    token: BearerToken,
    /// Answers the spawn's tool calls, bound to the spawn's own installation.
    dispatcher: CallbackToolDispatcher,
    /// The `Mcp-Session-Id`s admitted for the spawn.
    mcp_sessions: Mutex<HashSet<String>>,
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

/// Every live spawn's entry, by session and tool server name; adding an entry for a key replaces
/// the one there, so a session's earlier spawn is admitted no more.
#[derive(Default)]
pub struct ToolServerEntries {
    /// The live entries.
    entries: Arc<EntryMap>,
}

impl ToolServerEntries {
    /// Adds the entry of a spawn of `session_id` on `server_name`, run by `provider`, presenting
    /// `token` and answered by `dispatcher`, replacing the session's earlier entry there. The entry
    /// leaves the table when the returned guard drops.
    pub fn insert(
        &self,
        session_id: SessionId,
        server_name: &str,
        provider: ProviderId,
        token: BearerToken,
        dispatcher: CallbackToolDispatcher,
    ) -> ToolServerEntryGuard {
        let entry = Arc::new(ToolServerEntry {
            provider,
            token,
            dispatcher,
            mcp_sessions: Mutex::new(HashSet::new()),
        });
        let key = (session_id, server_name.to_owned());
        let guard = ToolServerEntryGuard {
            entries: Arc::downgrade(&self.entries),
            key: key.clone(),
            entry: Arc::downgrade(&entry),
        };
        lock(&self.entries).insert(key, entry);
        guard
    }

    /// The live entry of `session_id` on `server_name` when `authorization`, the request's
    /// `Authorization` header, presents its token; `None` for any other header or no entry.
    pub fn admitted(
        &self,
        session_id: SessionId,
        server_name: &str,
        authorization: Option<&[u8]>,
    ) -> Option<Arc<ToolServerEntry>> {
        let entries = lock(&self.entries);
        let entry = entries.get(&(session_id, server_name.to_owned()))?;
        entry.token.admits(authorization).then(|| Arc::clone(entry))
    }
}

/// A spawn's hold on its entry: dropping it takes the entry out of the table, with the MCP
/// sessions admitted for it, unless a later spawn of the session replaced it already.
#[must_use = "dropping the guard takes the spawn's entry out of the table"]
pub struct ToolServerEntryGuard {
    /// The table the entry sits in.
    entries: Weak<EntryMap>,
    /// Where it sits.
    key: EntryKey,
    /// The entry itself, to tell it from a later spawn's under the same key.
    entry: Weak<ToolServerEntry>,
}

impl Drop for ToolServerEntryGuard {
    fn drop(&mut self) {
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
mod tests {
    use std::pin::Pin;
    use std::sync::Arc;

    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_provider::bearer_token::BearerToken;
    use sidekicks_provider::driver::callback_tool::{
        CallbackToolDispatcher, CallbackToolInvocation, CallbackToolResult,
    };

    use super::ToolServerEntries;

    const SESSION: &str = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
    const SERVER: &str = "sidekicks";

    /// What the test's dispatcher answers a call with.
    type DispatchedCall = Pin<Box<dyn Future<Output = CallbackToolResult> + Send>>;

    /// A dispatcher the test never calls.
    fn dispatcher() -> CallbackToolDispatcher {
        Arc::new(|_invocation: CallbackToolInvocation| -> DispatchedCall {
            Box::pin(async { CallbackToolResult::Failed { error: None } })
        })
    }

    /// The `Authorization` header that presents `token`.
    fn header(token: &str) -> Vec<u8> {
        format!("Bearer {token}").into_bytes()
    }

    // A later spawn's entry replaces the earlier one: the replaced token is admitted no more, the
    // new one answers the new entry, and the replaced spawn's drop leaves the new entry in place.
    // Killed by a replace that keeps the old token admitted, or a drop that removes by key alone.
    #[test]
    fn a_replaced_spawns_token_answers_nothing_and_the_new_token_answers_the_new_entry() {
        let session_id = SessionId::new(SESSION).expect("the text is a UUID");
        let entries = ToolServerEntries::default();
        let first_token = BearerToken::mint().expect("the system's random source reads");
        let first_header = header(first_token.text());
        let first = entries.insert(
            session_id,
            SERVER,
            ProviderId::new("codex".to_owned()).expect("the id is well formed"),
            first_token,
            dispatcher(),
        );
        assert!(
            entries
                .admitted(session_id, SERVER, Some(&first_header))
                .is_some()
        );

        let second_token = BearerToken::mint().expect("the system's random source reads");
        let second_header = header(second_token.text());
        let second = entries.insert(
            session_id,
            SERVER,
            ProviderId::new("claude-code".to_owned()).expect("the id is well formed"),
            second_token,
            dispatcher(),
        );
        assert!(
            entries
                .admitted(session_id, SERVER, Some(&first_header))
                .is_none()
        );
        drop(first);
        let live = entries
            .admitted(session_id, SERVER, Some(&second_header))
            .expect("the new spawn's token answers its entry");
        assert_eq!(live.provider().as_str(), "claude-code");

        drop(live);
        drop(second);
        assert!(
            entries
                .admitted(session_id, SERVER, Some(&second_header))
                .is_none(),
            "the entry leaves the table when its spawn drops"
        );
    }
}
