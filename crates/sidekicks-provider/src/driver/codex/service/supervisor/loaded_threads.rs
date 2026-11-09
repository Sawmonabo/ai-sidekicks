//! What a Codex service holds loaded, read from Codex: the wait for one conversation's unload,
//! the conversations started in a terminal, and the wait until the service is free to stop.

use std::collections::HashMap;

use futures::future::join_all;
use tokio::sync::oneshot;

use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::start::read_codex_loaded_threads;
use crate::driver::codex::service::supervisor::transition::CodexServiceAvailability;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;

impl CodexService {
    /// Waits until the service no longer holds `thread_id` loaded: each `thread/closed` is
    /// confirmed by reading the loaded conversations, since a close can be stale. `false` once
    /// `deadline` passed.
    pub(crate) async fn await_unloaded(
        &self,
        thread_id: &str,
        deadline: tokio::time::Instant,
    ) -> bool {
        loop {
            // Armed before the read, so a close between the two is not missed.
            let closed = self.wait_for_thread_closed(thread_id.to_owned());
            if self.is_unloaded(thread_id).await {
                return true;
            }
            if tokio::time::timeout_at(deadline, closed).await.is_err() {
                return false;
            }
        }
    }

    // Whether the service no longer holds `thread_id` loaded; a read that fails leaves it to the
    // resume, which Codex refuses while the conversation is still written elsewhere.
    async fn is_unloaded(&self, thread_id: &str) -> bool {
        let Ok(connection) = self.connection() else {
            // A service that stopped holds nothing loaded.
            return true;
        };
        match read_codex_loaded_threads(&connection).await {
            Ok(loaded) => !loaded.iter().any(|loaded| loaded == thread_id),
            Err(error) => {
                CodexTransportDiagnostic::ConversationUnloadUnconfirmed {
                    thread_id: thread_id.to_owned(),
                    error: Box::new(error),
                }
                .report();
                true
            }
        }
    }

    /// The conversations started in a terminal that the service has loaded: every loaded one less
    /// those the daemon's sessions hold. Fails as the read's request does.
    pub(crate) async fn terminal_sessions(&self) -> Result<Vec<String>, CodexError> {
        let loaded = read_codex_loaded_threads(&*self.connection()?).await?;
        let threads = self.lock_threads();
        Ok(loaded
            .into_iter()
            .filter(|thread_id| threads.session_for(thread_id).is_none())
            .collect())
    }

    /// Answers once the service is free to stop: no conversation a session moved off it is held
    /// for a command it still runs, and no terminal session is inside it, each unload awaited as
    /// Codex reports it rather than polled. One starting or reconnecting is waited for first; one
    /// that ended or is stopping holds none. Fails as a read of the loaded conversations fails.
    pub(crate) async fn when_free_to_stop(&self) -> Result<(), CodexError> {
        self.dependencies.release.when_none_held_on(self.id).await;
        loop {
            let mut availability = self.availability.subscribe();
            // The sender lives in the service, which outlives this wait.
            let is_up = availability
                .wait_for(|availability| {
                    !matches!(
                        availability,
                        CodexServiceAvailability::Starting
                            | CodexServiceAvailability::Reconnecting
                            | CodexServiceAvailability::Restarting
                    )
                })
                .await
                .is_ok_and(|settled| matches!(*settled, CodexServiceAvailability::Up));
            if !is_up {
                return Ok(());
            }
            let inside = self.terminal_sessions().await?;
            if inside.is_empty() {
                return Ok(());
            }
            // Armed before the second read, so an unload between the two reads is never missed.
            let mut unloads: HashMap<String, oneshot::Receiver<()>> = inside
                .into_iter()
                .map(|thread_id| {
                    let unloaded = self.wait_for_thread_closed(thread_id.clone());
                    (thread_id, unloaded)
                })
                .collect();
            let still_inside = self.terminal_sessions().await?;
            // A wait whose sender went answers as the connection's end does.
            let _unloaded = join_all(
                still_inside
                    .iter()
                    .filter_map(|thread_id| unloads.remove(thread_id)),
            )
            .await;
        }
    }
}
