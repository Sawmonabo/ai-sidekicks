//! The sessions a person typed in a terminal inside the terminal service, each named, placed and
//! given its folder by a `thread/read` of its own, which a stop's confirmation and an update's wait
//! count.

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
use crate::driver::codex::thread::view::{
    CodexThreadReading, CodexThreadStatus, request_thread_reading,
};

// How long a confirmation waits on one session's read before it shows the session as unreachable.
const TERMINAL_SESSION_READ_TIMEOUT: Duration = Duration::from_secs(2);

impl CodexServiceRegistry {
    /// The sessions a person typed in a terminal that the terminal service holds and no session of
    /// the app does, in the service's own order; empty while terminal reach is off. A session
    /// whose read fails or names no thread is listed as unreachable, named by its thread id and
    /// with no folder.
    /// Fails when the service is on but its loaded conversations cannot be read, its connection
    /// down while it comes back among them, so a service that is on never reads as holding none.
    pub(crate) async fn list_terminal_sessions(
        &self,
    ) -> Result<Vec<TerminalProviderSession>, CodexError> {
        let Some(service) = self.terminal_reach_service() else {
            return Ok(Vec::new());
        };
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
        Ok(readings
            .into_iter()
            .filter_map(|(thread_id, reading)| compose_terminal_session(thread_id, reading))
            .collect())
    }
}

// The listed session `thread_id`'s read `reading` names: `None` for a thread no person typed in a
// terminal, one no longer loaded, or an empty id.
fn compose_terminal_session(
    thread_id: String,
    reading: Result<Option<CodexThreadReading>, CodexError>,
) -> Option<TerminalProviderSession> {
    let thread_id = ComposedText::new(thread_id)?;
    let (name, state, folder) = match reading {
        Ok(Some(reading)) => {
            if !reading.is_typed_in_terminal {
                return None;
            }
            let state = match reading.status {
                Some(CodexThreadStatus::NotLoaded) => return None,
                Some(CodexThreadStatus::Active) => TerminalProviderSessionState::Working,
                Some(CodexThreadStatus::Idle | CodexThreadStatus::SystemError) | None => {
                    TerminalProviderSessionState::Idle
                }
            };
            let name = reading
                .name
                .or(reading.preview)
                .and_then(ComposedText::new)
                .unwrap_or_else(|| thread_id.clone());
            let folder = reading
                .folder
                .and_then(|folder| FilesystemPath::new(folder).ok());
            (name, state, folder)
        }
        Ok(None) | Err(_) => (
            thread_id.clone(),
            TerminalProviderSessionState::Unreachable,
            None,
        ),
    };
    Some(TerminalProviderSession {
        provider: DESCRIPTOR.provider_id(),
        name,
        thread_id,
        state,
        folder,
    })
}
