//! The shared tool server's live entries, one per conversation spawn: the spawn's provider, the
//! secret of each tool server it opened, the dispatcher bound to that spawn, the tools its hook
//! rows call, and what each server's standing event streams wait on: its count of tool-list
//! changes, and for each client the closes it asked for. No client's listing is kept: a stream is
//! told at its open of every change since the listing mark its client sends back, or since the
//! entry was made where it sends none, so two clients the route cannot tell apart each hear every
//! change. A spawn holds its entry's guard, so the entry leaves the table when the spawn drops, and
//! every call and standing stream the spawn's process left open ends with it. A spawn that adopts
//! a conversation the provider kept from an earlier start of the daemon also answers, while it
//! holds its adoption, each other conversation of its session with no live entry whose request
//! presents the secret the daemon's key derives for that conversation's path; the adoption keeps
//! those conversations' closes, so each is a client of its own.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, Weak};

use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::bearer_token::BearerToken;
use sidekicks_provider::driver::callback_tool::CallbackToolDispatcher;
use sidekicks_provider::port::hook_tool_server::HookToolServer;
use sidekicks_provider::port::tool_server_route::{ToolServerConversation, ToolServerSpawn};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::Notify;

use crate::tools::secret_key::ToolServerSecretKey;
use crate::tools::server::ToolServerPath;

/// Where a spawn's entry sits: the session and the conversation of it the spawn runs.
type SpawnKey = (SessionId, ToolServerConversation);

/// The live entries by the conversation each spawn runs.
type EntryMap = Mutex<HashMap<SpawnKey, Arc<ToolServerEntry>>>;

/// The live adoptions by the session each answers for.
type AdoptionMap = Mutex<HashMap<SessionId, ToolServerAdoption>>;

/// The closes an adoption's earlier conversations asked for, one row a conversation and server,
/// made at its first standing stream or close.
type AdoptedStreamCloses = Mutex<Vec<AdoptedClientCloses>>;

/// Names what a listing mark's tag is drawn for, so it is never another hash of a server's secret.
const LISTING_MARK_CONTEXT: &str = "ai-sidekicks tool server listing mark";

/// A spawn that answers its session's earlier conversations on the servers it opened.
struct ToolServerAdoption {
    /// The adopting spawn's entry, which answers them.
    entry: Arc<ToolServerEntry>,
    /// The key their secrets are derived from.
    key: Arc<ToolServerSecretKey>,
    /// The closes they asked for.
    stream_closes: Arc<AdoptedStreamCloses>,
}

/// The closes one earlier conversation asked for on one server.
struct AdoptedClientCloses {
    /// The server's place among those the adopting spawn opened.
    server: usize,
    /// The earlier conversation.
    conversation: ToolServerConversation,
    /// The closes it asked for.
    closes: u32,
}

/// A tool server a spawn opened.
struct OpenedServer {
    /// The server's name on the spawn's route.
    name: &'static str,
    /// The secret the spawn's process presents there on every request.
    token: BearerToken,
    /// Counts the times the server's tool list changed since the entry was made, which its
    /// standing streams announce.
    tools_changes: AtomicU32,
    /// Counts the closes the spawn's own conversation asked for, each ending its standing streams
    /// open before it.
    stream_closes: AtomicU32,
}

/// One client of a spawn's tool server, as a request's path and secret tell it: the spawn's own
/// conversation, or an earlier conversation of its session the spawn's adoption answers.
pub(crate) struct ToolServerClient {
    /// The entry that answers the client.
    entry: Arc<ToolServerEntry>,
    /// The server's place among those the spawn opened.
    server: usize,
    /// Where the closes the client asked for are kept.
    closes: ClientClosesPlace,
}

/// Where the closes a client asked for are kept.
enum ClientClosesPlace {
    /// On the entry's server: the spawn's own conversation.
    OwnConversation,
    /// On the adoption, under the earlier conversation the request names.
    Adopted(AdoptedClient),
}

/// An earlier conversation an adoption answers, as a client of the adopting spawn's servers.
struct AdoptedClient {
    /// The earlier conversation.
    conversation: ToolServerConversation,
    /// The adoption's closes, which hold the conversation's rows.
    stream_closes: Arc<AdoptedStreamCloses>,
}

/// Where a standing event stream stands: what it announced and which of its client's closes ends
/// it.
pub(crate) struct StandingStreamMarks {
    /// The server's count of tool-list changes the stream announced; at its open the count its
    /// client listed at, and `None` where the client listed on another spawn's server, so a change
    /// is announced at once.
    tools_changes: Option<u32>,
    /// Its client's count of closes when the stream opened.
    stream_closes: u32,
}

/// What a standing event stream sends next.
pub(crate) enum StandingStreamEvent {
    /// The server's tool list changed since the stream's last announcement.
    ToolsChanged,
    /// The stream ends: its client closed it or the spawn dropped.
    Closed,
}

/// One session spawn's entry, across every tool server it opened.
pub struct ToolServerEntry {
    /// The provider the spawn runs.
    provider: ProviderId,
    /// Each server the spawn opened.
    servers: Box<[OpenedServer]>,
    /// Answers the spawn's tool calls, bound to the spawn's own installation.
    dispatcher: CallbackToolDispatcher,
    /// Lists and answers the tools the spawn's hook rows call; `None` for a spawn with no rows.
    hook_tools: Option<Arc<dyn HookToolServer>>,
    /// Set when the spawn drops, since its process is gone and no open call is answered.
    has_ended: AtomicBool,
    /// Wakes every wait on the spawn's end and every standing stream, at the end, a changed tool
    /// list or a close.
    waiters: Notify,
}

// Counts the inline struct only: not its `Arc`'s counts, the heap its servers' slice and provider
// id hold, the table's slot, or its guard.
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
        loop {
            // Made before the flag is read, so a drop between the two still wakes it.
            let woken = self.waiters.notified();
            if self.has_ended.load(Ordering::Acquire) {
                return;
            }
            woken.await;
        }
    }

    // Marks the spawn ended and wakes every wait on it.
    fn end(&self) {
        self.has_ended.store(true, Ordering::Release);
        self.waiters.notify_waiters();
    }

    // The place of the server named `server_name` among those the spawn opened.
    fn server_index(&self, server_name: &str) -> Option<usize> {
        self.servers
            .iter()
            .position(|server| server.name == server_name)
    }
}

impl ToolServerClient {
    /// The listing mark a handshake's answer hands the client, as `<tag>.<count>`: this server's
    /// count of tool-list changes now, and a tag drawn from the server's secret that names this
    /// spawn's server alone and gives nothing of the secret away. Taken before the client lists,
    /// it names no change the listing missed.
    pub(crate) fn listing_mark(&self) -> String {
        let server = &self.entry.servers[self.server];
        format!(
            "{:016x}.{}",
            listing_tag(server),
            server.tools_changes.load(Ordering::Acquire)
        )
    }

    /// The marks of a standing stream the client opens now, sending back `listing_mark`, the mark
    /// its handshake was handed, where it has one. The stream announces at once every change since
    /// that mark; with no mark, every change since the entry was made; and with a mark of another
    /// spawn's server or one that does not read, a change at once, since its client listed
    /// elsewhere.
    pub(crate) fn open_standing_stream(&self, listing_mark: Option<&[u8]>) -> StandingStreamMarks {
        let server = &self.entry.servers[self.server];
        let tools_changes = match listing_mark {
            None => Some(0),
            Some(mark) => std::str::from_utf8(mark)
                .ok()
                .and_then(|mark| mark.split_once('.'))
                .filter(|(tag, _)| u64::from_str_radix(tag, 16) == Ok(listing_tag(server)))
                .and_then(|(_, count)| count.parse().ok()),
        };
        StandingStreamMarks {
            tools_changes,
            stream_closes: self.stream_closes(),
        }
    }

    /// Waits for what the client's standing stream at `marks` sends next: one announcement for
    /// every change since its last, however many arrived, or its end.
    pub(crate) async fn next_standing_event(
        &self,
        marks: &mut StandingStreamMarks,
    ) -> StandingStreamEvent {
        let server = &self.entry.servers[self.server];
        loop {
            // Made before the marks are read, so a change between the two still wakes it.
            let woken = self.entry.waiters.notified();
            if self.entry.has_ended.load(Ordering::Acquire)
                || self.stream_closes() != marks.stream_closes
            {
                return StandingStreamEvent::Closed;
            }
            let tools_changes = server.tools_changes.load(Ordering::Acquire);
            if marks.tools_changes != Some(tools_changes) {
                marks.tools_changes = Some(tools_changes);
                return StandingStreamEvent::ToolsChanged;
            }
            woken.await;
        }
    }

    /// Ends the client's standing streams open on the server, as it asks when it closes its
    /// connection; another client's stay open.
    pub(crate) fn close_standing_streams(&self) {
        match &self.closes {
            ClientClosesPlace::OwnConversation => {
                self.entry.servers[self.server]
                    .stream_closes
                    .fetch_add(1, Ordering::AcqRel);
            }
            ClientClosesPlace::Adopted(adopted) => adopted.with_row(self.server, |row| {
                row.closes = row.closes.wrapping_add(1);
            }),
        }
        self.entry.waiters.notify_waiters();
    }

    // The closes the client asked for.
    fn stream_closes(&self) -> u32 {
        match &self.closes {
            ClientClosesPlace::OwnConversation => self.entry.servers[self.server]
                .stream_closes
                .load(Ordering::Acquire),
            ClientClosesPlace::Adopted(adopted) => adopted.with_row(self.server, |row| row.closes),
        }
    }
}

// The tag a listing mark names `server` by: drawn from its secret, which only this spawn's server
// holds, as a one-way hash under its own context.
fn listing_tag(server: &OpenedServer) -> u64 {
    let derived = blake3::derive_key(LISTING_MARK_CONTEXT, server.token.text().as_bytes());
    u64::from_be_bytes(
        derived[..8]
            .try_into()
            .expect("a derived key is longer than eight bytes"),
    )
}

impl AdoptedClient {
    // Runs `read` on the client's row for the server at `server`, made at its first use.
    fn with_row<T>(&self, server: usize, read: impl FnOnce(&mut AdoptedClientCloses) -> T) -> T {
        let mut rows = lock(&self.stream_closes);
        let found = rows
            .iter()
            .position(|row| row.server == server && row.conversation == self.conversation);
        let row = if let Some(row) = found {
            row
        } else {
            rows.reserve_exact(1);
            rows.push(AdoptedClientCloses {
                server,
                conversation: self.conversation,
                closes: 0,
            });
            rows.len() - 1
        };
        read(&mut rows[row])
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
        let servers = servers
            .into_iter()
            .map(|(name, token)| OpenedServer {
                name,
                token,
                tools_changes: AtomicU32::new(0),
                stream_closes: AtomicU32::new(0),
            })
            .collect();
        let entry = Arc::new(ToolServerEntry {
            provider: spawn.provider,
            servers,
            dispatcher: spawn.dispatcher,
            hook_tools: spawn.hook_tools,
            has_ended: AtomicBool::new(false),
            waiters: Notify::new(),
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
        lock(&self.adoptions).insert(
            session_id,
            ToolServerAdoption {
                entry,
                key,
                stream_closes: Arc::default(),
            },
        );
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
        self.admitted_client(path, authorization)
            .map(|client| client.entry)
    }

    /// The client `path` and `authorization` present, admitted as [`Self::admitted`] admits: the
    /// spawn's own conversation on its live entry, or an earlier conversation on its session's
    /// adopting entry. `None` when neither admits it.
    pub(crate) fn admitted_client(
        &self,
        path: &ToolServerPath,
        authorization: Option<&[u8]>,
    ) -> Option<ToolServerClient> {
        if let Some(entry) = lock(&self.entries).get(&(path.session_id, path.conversation))
            && let Some(server) = entry.server_index(&path.server_name)
        {
            return entry.servers[server]
                .token
                .admits(authorization)
                .then(|| ToolServerClient {
                    entry: Arc::clone(entry),
                    server,
                    closes: ClientClosesPlace::OwnConversation,
                });
        }
        let adoptions = lock(&self.adoptions);
        let adoption = adoptions.get(&path.session_id)?;
        let server = adoption.entry.server_index(&path.server_name)?;
        adoption
            .key
            .secret_of(path)
            .admits(authorization)
            .then(|| ToolServerClient {
                entry: Arc::clone(&adoption.entry),
                server,
                closes: ClientClosesPlace::Adopted(AdoptedClient {
                    conversation: path.conversation,
                    stream_closes: Arc::clone(&adoption.stream_closes),
                }),
            })
    }

    /// Tells every live spawn of `session_id` that opened the tool server `server_name` that its
    /// tool list there changed, which each standing stream open on it announces once, and each
    /// stream opened later announces as it opens unless its client listed after the change.
    pub fn raise_tools_changed(&self, session_id: SessionId, server_name: &str) {
        for ((entry_session, _), entry) in &*lock(&self.entries) {
            if *entry_session != session_id {
                continue;
            }
            if let Some(server) = entry.server_index(server_name) {
                entry.servers[server]
                    .tools_changes
                    .fetch_add(1, Ordering::AcqRel);
                entry.waiters.notify_waiters();
            }
        }
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

/// A spawn's hold on its entry: dropping it cancels the calls and ends the standing streams the
/// spawn left open and takes the entry out of the table, unless a later spawn of the conversation
/// replaced it already.
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
            entry.end();
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

    // A spawn's drop ends a wait already parked on it and one that starts after, so no held call
    // outlives its spawn. Killed by a drop that wakes no waiter and by an end kept in no flag.
    #[tokio::test]
    async fn a_spawns_drop_ends_a_wait_before_it_and_one_after() {
        let session_id = SessionId::new(SESSION).expect("the text is a UUID");
        let path = ToolServerPath {
            session_id,
            conversation: ToolServerConversation::of_session(session_id),
            server_name: SERVER.to_owned(),
        };
        let entries = ToolServerEntries::default();
        let token = BearerToken::mint().expect("the system's random source reads");
        let header = token.header_value();
        let guard = entries.insert(spawn_at(&path, "codex"), vec![(SERVER, token)]);
        let entry = entries
            .admitted(&path, Some(header.as_bytes()))
            .expect("the live spawn admits its secret");

        let mut parked = std::pin::pin!(entry.ended());
        assert!(futures::poll!(&mut parked).is_pending());
        drop(guard);
        let bound = std::time::Duration::from_secs(5);
        tokio::time::timeout(bound, parked)
            .await
            .expect("the drop wakes a wait parked before it");
        tokio::time::timeout(bound, entry.ended())
            .await
            .expect("a wait that starts after the drop ends at once");
    }
}
