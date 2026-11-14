//! What a Claude Code session's processes showed the inspector, kept from each spawn until the
//! session closes: the memory files its last context read named, the memory store folders its
//! last `system/init` named, the `Auto memory` value its last process ran with, and the hooks that
//! process listed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::inspector::SessionHookListResponse;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;

use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::establishment::spawn_sources::ClaudeSpawnSources;
use crate::driver::claude::session::hook_listing::read_claude_hook_listing;
use crate::driver::claude::session::memory::read_claude_process_auto_memory;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::process_identity::ProviderProcessIdentity;

/// The memory a session's last process and its last context read showed.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ClaudeKeptMemory {
    /// The memory files the last context read named.
    pub(crate) files: Vec<FilesystemPath>,
    /// The memory store folders the last `system/init` named.
    pub(crate) stores: Vec<FilesystemPath>,
    /// The last process's `Auto memory` value.
    pub(crate) auto_memory: Option<bool>,
}

/// The hooks a session's last process listed.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the driver interface's hooks read calls it")
)]
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ClaudeKeptHookListing {
    /// No process since the daemon started.
    NoProcess,
    /// The last process listed nothing the daemon could read.
    Unread,
    /// Its listing.
    Listed(SessionHookListResponse),
}

// What one session's last process showed.
struct ClaudeKeptInspection {
    process: ProviderProcessIdentity,
    memory: ClaudeKeptMemory,
    /// The last process's listing, `None` while it is under way; never `NoProcess`.
    hook_listing: watch::Sender<Option<ClaudeKeptHookListing>>,
}

/// What each Claude Code session's processes showed the inspector, in memory until the session
/// closes or is purged.
#[derive(Default)]
pub(crate) struct ClaudeInspectorReads {
    sessions: Mutex<HashMap<SessionId, ClaudeKeptInspection>>,
}

impl ClaudeInspectorReads {
    /// Keeps what `live`'s start showed in place of its predecessor's, the memory files kept until
    /// its first context read and the store folders until its first `system/init`, and lists its
    /// hooks; returns at once.
    pub(crate) fn keep_spawn(
        self: &Arc<Self>,
        live: &Arc<LiveClaudeSession>,
        effective_auto_memory: Option<bool>,
        sources: &Arc<ClaudeSpawnSources>,
    ) {
        {
            let mut sessions = lock(&self.sessions);
            let (files, stores) = sessions
                .get(&live.session_id)
                .map(|kept| (kept.memory.files.clone(), kept.memory.stores.clone()))
                .unwrap_or_default();
            // The replaced entry's sender drops here, which ends a read waiting on its listing.
            sessions.insert(
                live.session_id,
                ClaudeKeptInspection {
                    process: live.process_identity,
                    memory: ClaudeKeptMemory {
                        files,
                        stores,
                        auto_memory: read_claude_process_auto_memory(
                            &live.spawn_bound_legs.spawn_environment,
                            effective_auto_memory,
                        ),
                    },
                    hook_listing: watch::Sender::new(None),
                },
            );
        }
        let reads = Arc::clone(self);
        let live = Arc::clone(live);
        let sources = Arc::clone(sources);
        tokio::spawn(async move { reads.list_hooks(&live, &sources).await });
    }

    // The one listing of a process, sent after its start; it always settles the entry's listing.
    // Claude Code's hooks are read once after each process start and kept for the session, so no
    // opening sends one; the control request's own deadline bounds the send.
    async fn list_hooks(&self, live: &LiveClaudeSession, sources: &ClaudeSpawnSources) {
        let outcome = match live
            .channel
            .send_control_request(ClaudeControlRequest::GetHooksListing {})
            .await
        {
            Ok(answer) => {
                let legs = &live.spawn_bound_legs;
                let reading = sources
                    .read_settings_sources(&legs.spawn_environment, &legs.working_directory)
                    .await;
                // An unreadable reply is not recorded, as the context read leaves one.
                match read_claude_hook_listing(
                    live.session_id,
                    answer.response.as_deref(),
                    &reading.sources(),
                )
                .await
                {
                    Some(listing) => {
                        for unread in &listing.unread {
                            record_unheard_claude_failure(
                                DriverDiagnosticKind::ProcessReportFailed,
                                live.session_id,
                                "a hooks listing's settings read",
                                unread,
                            );
                        }
                        ClaudeKeptHookListing::Listed(listing.response)
                    }
                    None => ClaudeKeptHookListing::Unread,
                }
            }
            Err(error) => {
                record_unheard_claude_failure(
                    DriverDiagnosticKind::ProcessReportFailed,
                    live.session_id,
                    "the hooks listing",
                    &error,
                );
                ClaudeKeptHookListing::Unread
            }
        };
        // A later process's entry keeps its own listing.
        if let Some(kept) = lock(&self.sessions)
            .get(&live.session_id)
            .filter(|kept| kept.process == live.process_identity)
        {
            kept.hook_listing.send_replace(Some(outcome));
        }
    }

    /// Keeps the memory files a context read of `session_id` named; with no entry, the session
    /// closed or no process was adopted, it keeps nothing.
    pub(crate) fn keep_memory_files(&self, session_id: SessionId, files: Vec<FilesystemPath>) {
        if let Some(kept) = lock(&self.sessions).get_mut(&session_id) {
            kept.memory.files = files;
        }
    }

    /// Keeps the memory store folders a `system/init` of `session_id` named; with no entry, the
    /// session closed or no process was adopted, it keeps nothing.
    pub(crate) fn keep_memory_stores(&self, session_id: SessionId, stores: Vec<FilesystemPath>) {
        if let Some(kept) = lock(&self.sessions).get_mut(&session_id) {
            kept.memory.stores = stores;
        }
    }

    /// The memory `session_id`'s last process and context read showed; `None` with no process
    /// since the daemon started.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the driver interface's memory read calls it")
    )]
    pub(crate) fn kept_memory(&self, session_id: SessionId) -> Option<ClaudeKeptMemory> {
        lock(&self.sessions)
            .get(&session_id)
            .map(|kept| kept.memory.clone())
    }

    /// The hooks `session_id`'s last process listed. It waits only while that listing is under
    /// way, which the control request's deadline bounds; it never sends a listing.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the driver interface's hooks read calls it")
    )]
    pub(crate) async fn kept_hook_listing(&self, session_id: SessionId) -> ClaudeKeptHookListing {
        loop {
            let Some(mut listing) = lock(&self.sessions)
                .get(&session_id)
                .map(|kept| kept.hook_listing.subscribe())
            else {
                return ClaudeKeptHookListing::NoProcess;
            };
            // A closed sender means the session was forgotten or a later process took its place,
            // so the entry is looked up again.
            if let Ok(settled) = listing.wait_for(Option::is_some).await {
                return settled
                    .clone()
                    .expect("the wait answers only a settled listing");
            }
        }
    }

    /// Forgets `session_id`'s rows; called only when the session closes or is purged, never when
    /// a process ends.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        lock(&self.sessions).remove(&session_id);
    }
}
