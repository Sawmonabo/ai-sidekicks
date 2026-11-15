//! The Codex sessions a person typed in a terminal inside the terminal service: what the daemon
//! remembers of them, the seat that keeps a command of one running, and, as an agent's message
//! reaches one, whether its terminal can still be reached and the exchange itself.

pub(crate) mod conversations;
pub(super) mod exchanges;
pub(super) mod seat;
#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::Duration;

use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::oneshot;
use tokio_util::task::TaskTracker;

use self::exchanges::{
    CodexTerminalDelivery, CodexTerminalMessage, CodexTerminalTurnEnd, deliver_to_terminal_session,
    reread_turn_end,
};
use crate::driver::codex::service::home::CodexServiceKind;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::registry::personal_folder::stored_turns::{
    StoredTurnCause, StoredTurnOutcome, StoredTurnWait,
};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::away::{CodexAvailabilityWatch, CodexServiceRest};
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

// How many times a wait reads a turn's end in a row, on a service that reads up, before it reads
// the stored turn on a service of the daemon's own and then waits for the service's next change
// or the conversation's next status change.
const TURN_END_READ_ATTEMPTS: usize = 3;

/// Why an agent's message did not reach a Codex session typed in a terminal.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CodexTerminalExchangeError {
    /// No terminal holds the conversation any more: its terminal closed, terminal reach is off,
    /// or the service has been away past the terminal's reconnect window, so the terminal gave up
    /// on it for good. Sending again cannot reach it; the words tell the person how to reopen it.
    #[error("Reopen it in a terminal: codex resume {thread_id}")]
    GivenUp {
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

/// Where the readings of one message to a terminal session go.
type TerminalReadings = Arc<PortRegistration<Arc<dyn SessionMessageReadingPublisher>>>;

impl CodexServiceRegistry {
    /// Delivers `delivery`, another session's message, into `thread_id`, a conversation a person
    /// typed in a terminal, publishing to `readings` what became of it: delivered and, for a turn
    /// it opened, that turn's answer or its failure once it ends, which `tasks` awaits. While the
    /// terminal service is away within the terminal's reconnect window the message reads held
    /// and goes in on `tasks` once the service is back. Answers `Refused` with the reopen line
    /// once the terminal gave the service up or where no terminal holds the conversation. Fails
    /// for a wake-up or a reminder and as the exchange's requests fail.
    pub(crate) async fn deliver_session_message_to_terminal(
        self: &Arc<Self>,
        thread_id: &str,
        delivery: SessionMessageDelivery,
        readings: &TerminalReadings,
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
        let Some(service) = self.terminal_home_service() else {
            return Ok(given_up(thread_id));
        };
        let Some(away) = service.away_for() else {
            return deliver_and_publish(self, &service, thread_id, &message, readings, tasks).await;
        };
        let window_left = TERMINAL_RECONNECT_WINDOW.saturating_sub(away);
        if window_left.is_zero() {
            return Ok(given_up(thread_id));
        }
        let message_id = message.message_id.to_string();
        publish_terminal_reading(
            readings,
            SessionMessageReading::Held {
                message_id: message_id.clone(),
            },
        );
        let readings = Arc::clone(readings);
        let thread_id = thread_id.to_owned();
        let later_tasks = tasks.clone();
        let registry = Arc::clone(self);
        tasks.spawn(async move {
            let is_back = tokio::time::timeout(window_left, service.when_up())
                .await
                .is_ok();
            let sent = if is_back {
                deliver_and_publish(
                    &registry,
                    &service,
                    &thread_id,
                    &message,
                    &readings,
                    &later_tasks,
                )
                .await
            } else {
                Ok(given_up(&thread_id))
            };
            let reading = match sent {
                Ok(SessionMessageSent::Sent) => return,
                Ok(SessionMessageSent::Refused { words }) => SessionMessageReading::Refused {
                    message_id,
                    reason: Some(words),
                    drop_reason: None,
                },
                Err(error) => {
                    tracing::warn!(
                        thread_id,
                        error = &error as &(dyn std::error::Error + 'static),
                        "a held message to a terminal session did not go in"
                    );
                    SessionMessageReading::NotDelivered { message_id }
                }
            };
            publish_terminal_reading(&readings, reading);
        });
        Ok(SessionMessageSent::Sent)
    }
}

// The refusal of a message to `thread_id`, whose terminal no longer holds it.
fn given_up(thread_id: &str) -> SessionMessageSent {
    SessionMessageSent::Refused {
        words: CodexTerminalExchangeError::GivenUp {
            thread_id: thread_id.to_owned(),
        }
        .to_string(),
    }
}

// Delivers `message` into `thread_id` on `service`, which is up and the terminal home's in
// `registry`, and publishes to `readings` that it was delivered and, for a turn it opened, that
// turn's answer or its failure once it ends, on `tasks`. Answers `Refused` with the reopen line
// where no terminal holds the conversation; fails as the exchange's requests fail.
async fn deliver_and_publish(
    registry: &Arc<CodexServiceRegistry>,
    service: &Arc<CodexService>,
    thread_id: &str,
    message: &CodexTerminalMessage,
    readings: &TerminalReadings,
    tasks: &TaskTracker,
) -> Result<SessionMessageSent, DriverError> {
    let delivered = match deliver_to_terminal_session(service, thread_id, message).await {
        Ok(delivered) => delivered,
        Err(refusal @ CodexTerminalExchangeError::GivenUp { .. }) => {
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
    if let CodexTerminalDelivery::Started { turn_id, ended } = delivered {
        tasks.spawn(publish_turn_end(
            Arc::clone(registry),
            Arc::clone(service),
            thread_id.to_owned(),
            turn_id,
            message_id,
            ended,
            Arc::clone(readings),
        ));
    }
    Ok(SessionMessageSent::Sent)
}

// Publishes to `readings` how the turn `turn_id` of `thread_id` on `service`, the terminal home's
// in `registry`, which the message `message_id` opened, ended: as `ended` hands it back, else,
// where the seat's connection ended first, as it is read again; not reachable once the home's
// service is down for good, and nothing once it is shut down with the daemon.
async fn publish_turn_end(
    registry: Arc<CodexServiceRegistry>,
    service: Arc<CodexService>,
    thread_id: String,
    turn_id: String,
    message_id: String,
    ended: oneshot::Receiver<CodexTerminalTurnEnd>,
    readings: TerminalReadings,
) {
    let end = match ended.await {
        Ok(end) => end,
        // A seat whose connection ended before the turn did leaves the turn's end unread.
        Err(_unread) => {
            match await_turn_end_again(&registry, service, &thread_id, &turn_id).await {
                TurnEndReread::Ended(end) => end,
                // The stored turn is read at the daemon's next start.
                TurnEndReread::ShutDown => return,
                TurnEndReread::DownForGood => {
                    let reopen = CodexTerminalExchangeError::GivenUp { thread_id }.to_string();
                    let reading = SessionMessageReading::NotReachable { message_id, reopen };
                    publish_terminal_reading(&readings, reading);
                    return;
                }
            }
        }
    };
    let reading = match end {
        CodexTerminalTurnEnd::Answered { reply } => SessionMessageReading::Answered {
            // The message opened the turn, so its id names the turn's record.
            turn_record: message_id.clone(),
            message_id,
            answer: reply,
        },
        CodexTerminalTurnEnd::Failed { notice } => {
            SessionMessageReading::Failed { message_id, notice }
        }
    };
    publish_terminal_reading(&readings, reading);
}

// What became of a turn whose end is read again.
enum TurnEndReread {
    // The turn ended, or Codex refused the read in its own words.
    Ended(CodexTerminalTurnEnd),
    // The home's service was shut down with the daemon, which may keep it running.
    ShutDown,
    // The home's service is down and nothing brings it back: its restarts are spent, it was
    // switched off, or its ordinary start failed.
    DownForGood,
}

// How a round of reads on the home's service ended without the turn's end.
#[derive(Clone, Copy)]
enum RoundEnd {
    // The service, one the daemon only joined, was reported answering nothing: the report count.
    Reported(u64),
    // A read's deadline passed on a service the daemon only joined.
    TimedOut,
    // Every read of the round failed.
    Failed,
    // The service's own connection is gone, which its next state follows.
    ConnectionGone,
}

// What a wait tries again on its folder's shared retry, where no event may follow a turn already
// stored.
#[derive(Clone, Copy)]
enum TurnEndRetry {
    // The daemon's own service could not read the stored turn: its read is tried again, after one
    // more read on the home's service where that service last answered overloaded.
    OwnRead { is_home_overloaded: bool },
    // A joined service that stays up reported answering nothing, and the stored turn still runs:
    // the report is made again, which every wait on the folder reads on one service.
    Report,
}

// The end of the turn `turn_id` of `thread_id`, read again after the seat's connection ended
// before it, following the terminal home's service in `registry` from `service` on: at once
// while the service is up, else once it is back however long it was away. A read that fails with
// the service still up, Codex's overloaded answer among them, or whose own seat's connection
// ends, is read again at once, up to `TURN_END_READ_ATTEMPTS` reads in all; one that fails as the
// service's own connection is gone waits for the service's next state. Past them, or at once
// where a service the daemon only joined lets a read's deadline pass or is reported answering
// nothing, the stored turn is read on a short-lived service of the daemon's own, one read for
// every wait on the folder; the wait then reads again at the service's next change or report or
// the conversation's next status change, whichever comes first. Where nothing may follow a turn
// already stored, the read is also tried again on the folder's one retry, which every wait there
// shares and the first to reach makes: where the daemon's own service could not read, that read,
// after the home's service again where it last answered overloaded; where a joined service that
// stays up answers nothing and the turn still ran, the report. A refusal of the stored read that
// asking again cannot change arms no retry, and a folder terminal reach no longer names leaves the
// turn not reachable. A service another took the home over from hands the wait to that one.
// Codex's own refusal of a read on the home's service ends the turn failed in its words.
async fn await_turn_end_again(
    registry: &Arc<CodexServiceRegistry>,
    mut service: Arc<CodexService>,
    thread_id: &str,
    turn_id: &str,
) -> TurnEndReread {
    let mut stored = registry.wait_on_stored_turn(thread_id, turn_id);
    'service: loop {
        let mut availability = service.watch_availability();
        loop {
            // Listening before the reads, so a status change that comes while they run wakes the
            // next round.
            let mut status_changes = service.terminal_conversations().listen_status_changes();
            let mut failed_reads = 0;
            let mut is_last_read_overloaded = false;
            let round_end = loop {
                if failed_reads == TURN_END_READ_ATTEMPTS {
                    break RoundEnd::Failed;
                }
                match availability.rest().await {
                    CodexServiceRest::Up => {}
                    CodexServiceRest::Unanswered(reports) => break RoundEnd::Reported(reports),
                    CodexServiceRest::ShutDown => return TurnEndReread::ShutDown,
                    CodexServiceRest::Down => match registry.terminal_home_service() {
                        Some(next) if !Arc::ptr_eq(&next, &service) => {
                            service = next;
                            continue 'service;
                        }
                        Some(_) | None => return TurnEndReread::DownForGood,
                    },
                }
                match read_on_home_service(&service, thread_id, turn_id).await {
                    Ok(Some(end)) => return TurnEndReread::Ended(end),
                    // The seat's own connection ended before the turn did.
                    Ok(None) => is_last_read_overloaded = false,
                    Err(error) => {
                        tracing::debug!(
                            thread_id,
                            error = &error as &(dyn std::error::Error + 'static),
                            "a terminal session's turn end is read again"
                        );
                        if !holds_open_connection(&service) {
                            break RoundEnd::ConnectionGone;
                        }
                        // The connection has already told the service's waits, this one among
                        // them, that it answers nothing.
                        if error.is_past_deadline() && service.kind() == CodexServiceKind::Joined {
                            break RoundEnd::TimedOut;
                        }
                        is_last_read_overloaded = error.is_service_overloaded();
                    }
                }
                failed_reads += 1;
            };
            let is_time_out_round = matches!(round_end, RoundEnd::Reported(_) | RoundEnd::TimedOut);
            let outcome = match round_end {
                RoundEnd::ConnectionGone => {
                    stored.end_retries();
                    None
                }
                RoundEnd::Reported(reports) => Some(
                    stored
                        .read(StoredTurnCause::Report {
                            service: &service,
                            reports,
                        })
                        .await,
                ),
                RoundEnd::TimedOut | RoundEnd::Failed => {
                    Some(stored.read(StoredTurnCause::Asked).await)
                }
            };
            let mut retry = match outcome {
                Some(outcome) => match follow_reading(
                    outcome,
                    is_last_read_overloaded,
                    is_time_out_round,
                    &service,
                    &availability,
                    &stored,
                ) {
                    Ok(retry) => retry,
                    Err(reread) => return reread,
                },
                None => None,
            };
            loop {
                let Some(current) = retry else {
                    tokio::select! {
                        () = availability.changed() => {}
                        () = status_changes.next_of(thread_id) => {}
                    }
                    break;
                };
                let armed = stored.arm_retry();
                tokio::select! {
                    () = availability.changed() => break,
                    () = status_changes.next_of(thread_id) => break,
                    // Another wait's try, or a read for a report, read this wait's turn too.
                    outcome = stored.next_reading() => {
                        retry = match follow_reading(
                            outcome,
                            current.is_home_overloaded(),
                            is_time_out_round,
                            &service,
                            &availability,
                            &stored,
                        ) {
                            Ok(retry) => retry,
                            Err(reread) => return reread,
                        };
                        continue;
                    }
                    () = tokio::time::sleep_until(armed.due) => {}
                }
                let current = match current {
                    TurnEndRetry::OwnRead {
                        is_home_overloaded: true,
                    } => match read_on_home_service(&service, thread_id, turn_id).await {
                        Ok(Some(end)) => return TurnEndReread::Ended(end),
                        Ok(None) => TurnEndRetry::OwnRead {
                            is_home_overloaded: false,
                        },
                        Err(error) => {
                            tracing::debug!(
                                thread_id,
                                error = &error as &(dyn std::error::Error + 'static),
                                "a terminal session's turn end is tried again"
                            );
                            TurnEndRetry::OwnRead {
                                is_home_overloaded: error.is_service_overloaded(),
                            }
                        }
                    },
                    other @ (TurnEndRetry::OwnRead { .. } | TurnEndRetry::Report) => other,
                };
                // Counted only once its wait ran to its end; another wait that made this try
                // wakes this one with its outcome.
                if !stored.take_retry(armed) {
                    retry = Some(current);
                    continue;
                }
                retry = match current {
                    // The report wakes every wait on the folder, this one's next round among them.
                    TurnEndRetry::Report => {
                        service.repeat_unanswered_report(availability.reports_read());
                        break;
                    }
                    TurnEndRetry::OwnRead { is_home_overloaded } => {
                        match follow_reading(
                            stored.read(StoredTurnCause::Asked).await,
                            is_home_overloaded,
                            is_time_out_round,
                            &service,
                            &availability,
                            &stored,
                        ) {
                            Ok(retry) => retry,
                            Err(reread) => return reread,
                        }
                    }
                };
            }
        }
    }
}

// What follows a reading of the stored turn: the wait's end where it settled or its folder can no
// longer be reached, else the retry it arms, if any. A read the daemon's own service could not
// make is tried again, after the home's service where `is_home_overloaded`; a refusal asking
// again cannot change arms none.
fn follow_reading(
    outcome: StoredTurnOutcome,
    is_home_overloaded: bool,
    is_time_out_round: bool,
    service: &CodexService,
    availability: &CodexAvailabilityWatch,
    stored: &StoredTurnWait,
) -> Result<Option<TurnEndRetry>, TurnEndReread> {
    match outcome {
        StoredTurnOutcome::Settled(end) => Err(TurnEndReread::Ended(end)),
        StoredTurnOutcome::Unreachable => Err(TurnEndReread::DownForGood),
        StoredTurnOutcome::Unread => Ok(Some(TurnEndRetry::OwnRead { is_home_overloaded })),
        StoredTurnOutcome::Unsettled => Ok(retry_unsettled(
            is_time_out_round,
            service,
            availability,
            stored,
        )),
        StoredTurnOutcome::Refused => Ok(None),
    }
}

// The retry after the stored turn read as not settled, in a round that ended on `service`
// answering nothing or a read's deadline passing: only where `service` is one the daemon only
// joined and still reads up, a state no event ends, since its time-out is reported once per
// silence and the turn's end reaches no connection of the daemon's. Where it arms none, that state
// is over, so the folder's retries start again from the first wait.
fn retry_unsettled(
    is_time_out_round: bool,
    service: &CodexService,
    availability: &CodexAvailabilityWatch,
    stored: &StoredTurnWait,
) -> Option<TurnEndRetry> {
    let is_silent_joined =
        is_time_out_round && service.kind() == CodexServiceKind::Joined && availability.reads_up();
    if !is_silent_joined {
        stored.end_retries();
    }
    is_silent_joined.then_some(TurnEndRetry::Report)
}

impl TurnEndRetry {
    // Whether the home's service last answered overloaded, so the retry reads it first.
    fn is_home_overloaded(self) -> bool {
        match self {
            Self::OwnRead { is_home_overloaded } => is_home_overloaded,
            Self::Report => false,
        }
    }
}

// Whether `service` holds a connection that is still open, so a read's failure is not its drop.
fn holds_open_connection(service: &CodexService) -> bool {
    service
        .connection()
        .is_ok_and(|connection| !connection.is_closed())
}

// The end of the turn `turn_id` of `thread_id` as one read on the home's `service` finds it:
// Codex's own refusal of the read ends it failed in Codex's words; `None` where the seat's own
// connection ended before the turn did. Fails as the read fails otherwise.
async fn read_on_home_service(
    service: &CodexService,
    thread_id: &str,
    turn_id: &str,
) -> Result<Option<CodexTerminalTurnEnd>, CodexError> {
    match reread_turn_end(service, thread_id, turn_id).await {
        Err(error) => match error.provider_refusal_words() {
            Some(words) => Ok(Some(CodexTerminalTurnEnd::Failed {
                notice: words.to_owned(),
            })),
            None => Err(error),
        },
        read => read,
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

/// Answers whether `service`, which is up, holds `thread_id` open in a terminal. Fails with
/// `GivenUp` where no terminal holds the conversation, and as the read of its loaded
/// conversations fails.
async fn require_terminal_session(
    service: &CodexService,
    thread_id: &str,
) -> Result<(), CodexTerminalExchangeError> {
    let loaded = service.terminal_sessions().await?;
    if !loaded.iter().any(|listed| listed == thread_id) {
        return Err(CodexTerminalExchangeError::GivenUp {
            thread_id: thread_id.to_owned(),
        });
    }
    Ok(())
}
