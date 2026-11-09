//! The sessions a person typed in a terminal inside the terminal service, each named, placed and
//! given its folder by a `thread/read` of its own, which a stop's confirmation and an update's wait
//! count, and answered from what the last listing saw while the service is away.

use std::time::Duration;

use futures::future::join_all;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::controls::methods::{
    TerminalProviderSession, TerminalProviderSessionState,
};
use sidekicks_contracts::wire::text::ComposedText;

use super::CodexServiceRegistry;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::terminal_session::conversations::read_terminal_session_state;
use crate::driver::codex::thread::view::{CodexThreadReading, request_thread_reading};

// How long a confirmation waits on one session's read before it shows the session as unreachable.
const TERMINAL_SESSION_READ_TIMEOUT: Duration = Duration::from_secs(2);

impl CodexServiceRegistry {
    /// The sessions a person typed in a terminal that the terminal service holds and no session of
    /// the app does, in the service's own order; empty while terminal reach is off. A session
    /// whose read fails or names no thread is listed as unreachable, named by its thread id and
    /// with no folder or model; an unnamed one carries the start of its first message as its name,
    /// marked as no name of its own; and one a seat keeps for a running command as working. While
    /// the service is away the sessions its last listing named are answered as last seen, each
    /// unreachable once the service has been away past the terminal's reconnect window, and none
    /// before any listing. Fails as the read of the service's loaded conversations fails.
    pub(crate) async fn list_terminal_sessions(
        &self,
    ) -> Result<Vec<TerminalProviderSession>, CodexError> {
        let Some(service) = self.terminal_home_service() else {
            return Ok(Vec::new());
        };
        let conversations = service.terminal_conversations();
        if let Some(away) = service.away_for() {
            // A service coming back with nothing remembered names no terminal yet.
            return Ok(conversations.recall(away).unwrap_or_default());
        }
        if !service.is_serving() {
            return Ok(Vec::new());
        }
        let thread_ids = service.terminal_sessions().await?;
        let connection = service.connection()?;
        let readings = join_all(thread_ids.into_iter().map(|thread_id| {
            let connection = &connection;
            async move {
                let reading =
                    request_thread_reading(connection, &thread_id, TERMINAL_SESSION_READ_TIMEOUT)
                        .await;
                (thread_id, reading)
            }
        }))
        .await;
        let listed: Vec<TerminalProviderSession> = readings
            .into_iter()
            .filter_map(|(thread_id, reading)| compose_terminal_session(thread_id, reading))
            .collect();
        // A listing the service went away during reads every conversation as unreachable, which
        // says nothing of where they stand.
        if service.away_for().is_some() {
            return Ok(listed);
        }
        Ok(conversations.remember(listed))
    }
}

// The listed session `thread_id`'s read `reading` names: `None` for a thread no person typed in a
// terminal, one no longer loaded, or an empty id.
fn compose_terminal_session(
    thread_id: String,
    reading: Result<Option<CodexThreadReading>, CodexError>,
) -> Option<TerminalProviderSession> {
    let thread_id = ComposedText::new(thread_id)?;
    let unreachable = TerminalProviderSession {
        provider: DESCRIPTOR.provider_id(),
        name: thread_id.clone(),
        is_named: false,
        thread_id: thread_id.clone(),
        state: TerminalProviderSessionState::Unreachable,
        folder: None,
        model: None,
    };
    let Ok(Some(reading)) = reading else {
        return Some(unreachable);
    };
    if !reading.is_typed_in_terminal {
        return None;
    }
    let state = match reading.status {
        Some(status) => read_terminal_session_state(status)?,
        None => TerminalProviderSessionState::Idle,
    };
    let own_name = reading.name.and_then(ComposedText::new);
    let is_named = own_name.is_some();
    let name = own_name
        .or_else(|| reading.preview.and_then(ComposedText::new))
        .unwrap_or_else(|| thread_id.clone());
    Some(TerminalProviderSession {
        name,
        is_named,
        state,
        folder: reading
            .folder
            .and_then(|folder| FilesystemPath::new(folder).ok()),
        model: reading.model.and_then(ComposedText::new),
        ..unreachable
    })
}
