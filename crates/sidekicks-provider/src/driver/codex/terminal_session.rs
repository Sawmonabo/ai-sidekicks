//! The Codex sessions a person typed in a terminal inside the terminal service, as an agent's
//! message reaches one: whether its terminal can still be reached, and the exchange itself.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver method that delivers a message into a Codex session typed in a \
                  terminal calls this"
    )
)]

pub(super) mod exchanges;

use std::sync::Arc;
use std::time::Duration;

use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;

/// How long a terminal joined to the service tries to reconnect once the service is away, Codex's
/// own window; past it the terminal never rejoins, even when the service comes back.
const TERMINAL_RECONNECT_WINDOW: Duration = Duration::from_secs(120);

/// Why an agent's message did not reach a Codex session typed in a terminal.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CodexTerminalExchangeError {
    /// The service has been away past the terminal's reconnect window, so the terminal gave up on
    /// it for good and sending again cannot reach it; the words tell the person how to reopen it.
    #[error("Reopen it in a terminal: codex resume {thread_id}")]
    GivenUp {
        /// The conversation's thread id.
        thread_id: String,
    },
    /// No terminal holds the conversation on the service any more, or terminal reach is off.
    #[error("no terminal holds the Codex conversation {thread_id}")]
    NotOpen {
        /// The conversation's thread id.
        thread_id: String,
    },
    /// A request of the exchange failed.
    #[error(transparent)]
    Codex(#[from] CodexError),
}

/// The terminal service holding `thread_id` open in a terminal, waited for within what is left of
/// the terminal's reconnect window while it is away. Fails with `GivenUp` once it has been away past
/// that window, with `NotOpen` while terminal reach is off or no terminal holds the conversation,
/// and as the read of its loaded conversations fails.
async fn require_terminal_session(
    registry: &CodexServiceRegistry,
    thread_id: &str,
) -> Result<Arc<CodexService>, CodexTerminalExchangeError> {
    let not_open = || CodexTerminalExchangeError::NotOpen {
        thread_id: thread_id.to_owned(),
    };
    let service = registry.terminal_home_service().ok_or_else(not_open)?;
    if let Some(away) = service.away_for() {
        let window_left = TERMINAL_RECONNECT_WINDOW.saturating_sub(away);
        let is_back = !window_left.is_zero()
            && tokio::time::timeout(window_left, service.when_up())
                .await
                .is_ok();
        if !is_back {
            return Err(CodexTerminalExchangeError::GivenUp {
                thread_id: thread_id.to_owned(),
            });
        }
    }
    let loaded = service.terminal_sessions().await?;
    if !loaded.iter().any(|listed| listed == thread_id) {
        return Err(not_open());
    }
    Ok(service)
}
