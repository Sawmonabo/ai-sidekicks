//! The Codex sessions a person typed in a terminal inside the terminal service: what the daemon
//! remembers of them, the seat that keeps a command of one running, and, as an agent's message
//! reaches one, whether its terminal can still be reached and the exchange itself.

pub(crate) mod conversations;
pub(super) mod exchanges;
pub(super) mod seat;

use std::sync::Arc;
use std::time::Duration;

use sidekicks_std::port_registration::PortRegistration;
use tokio_util::task::TaskTracker;

use self::exchanges::{CodexTerminalDelivery, CodexTerminalMessage};
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::error::DriverError;
use crate::driver::session_messages::{
    SessionMessageDelivery, SessionMessageKind, SessionMessageSent,
};
use crate::port::session_message_reading_publisher::{
    SessionMessageReading, SessionMessageReadingPublisher,
};

/// How long a terminal joined to the service tries to reconnect once the service is away, Codex's
/// own window; past it the terminal never rejoins, even when the service comes back.
pub(crate) const TERMINAL_RECONNECT_WINDOW: Duration = Duration::from_secs(120);

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
    /// The delivery is a wake-up or a reminder, which a session typed in a terminal never sets
    /// off: it calls none of the daemon's tools.
    #[error("a Codex session typed in a terminal is sent no wake-up or reminder")]
    NotAMessage,
}

impl CodexServiceRegistry {
    /// Delivers `delivery`, another session's message, into `thread_id`, a conversation a person
    /// typed in a terminal, publishing to `readings` that it was delivered and, for a turn it
    /// opened, that turn's answer once it ends, which `tasks` awaits. Answers `Refused` with the
    /// exchange's words once the terminal gave the service up or where no terminal holds the
    /// conversation. Fails for a wake-up or a reminder and as the exchange's requests fail.
    pub(crate) async fn deliver_session_message_to_terminal(
        &self,
        thread_id: &str,
        delivery: SessionMessageDelivery,
        readings: &Arc<PortRegistration<Arc<dyn SessionMessageReadingPublisher>>>,
        tasks: &TaskTracker,
    ) -> Result<SessionMessageSent, DriverError> {
        let SessionMessageKind::Message { body, .. } = delivery.kind else {
            return Err(DriverError::Internal(Box::new(
                CodexTerminalExchangeError::NotAMessage,
            )));
        };
        let message = CodexTerminalMessage {
            message_id: delivery.message_id,
            sender_name: delivery.sender_name,
            sender_session_id: delivery.sender_session_id,
            body,
        };
        let delivered = match self.deliver_to_terminal_session(thread_id, &message).await {
            Ok(delivered) => delivered,
            Err(
                refusal @ (CodexTerminalExchangeError::GivenUp { .. }
                | CodexTerminalExchangeError::NotOpen { .. }),
            ) => {
                return Ok(SessionMessageSent::Refused {
                    words: refusal.to_string(),
                });
            }
            Err(CodexTerminalExchangeError::Codex(error)) => return Err(error.into()),
            Err(error @ CodexTerminalExchangeError::NotAMessage) => {
                return Err(DriverError::Internal(Box::new(error)));
            }
        };
        let message_id = message.message_id.to_string();
        publish_terminal_reading(
            readings,
            SessionMessageReading::Delivered {
                message_id: message_id.clone(),
            },
        );
        if let CodexTerminalDelivery::Started(ended) = delivered {
            let readings = Arc::clone(readings);
            let thread_id = thread_id.to_owned();
            tasks.spawn(async move {
                // A seat whose connection ended before the turn did leaves its answer unread.
                let Ok(end) = ended.await else {
                    tracing::warn!(thread_id, "a terminal session's turn ended unread");
                    return;
                };
                if !end.is_completed {
                    tracing::warn!(
                        thread_id,
                        error = ?end.error,
                        "a terminal session's turn a message opened did not complete"
                    );
                }
                // The message opened the turn, so its id names the turn's record.
                publish_terminal_reading(
                    &readings,
                    SessionMessageReading::Answered {
                        turn_record: message_id.clone(),
                        message_id,
                        answer: end.reply,
                    },
                );
            });
        }
        Ok(SessionMessageSent::Sent)
    }
}

// Publishes one reading of a message to a terminal session; one made before the readings are
// registered is dropped.
fn publish_terminal_reading(
    readings: &PortRegistration<Arc<dyn SessionMessageReadingPublisher>>,
    reading: SessionMessageReading,
) {
    if let Some(publisher) = readings.port() {
        publisher.publish(reading);
    }
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
