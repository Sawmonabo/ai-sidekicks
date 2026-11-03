//! The turns a restart kept running on a Codex service, in a session the start does not resume,
//! ended there: each interrupted by its recorded id on the service that runs it, with no resume of
//! its conversation, since a loaded conversation still answers once the client that started it is
//! gone. A stopping run's turn Codex continued under another id is followed once. A connection
//! that closes or a join cut while the service's process ends reads as the turns ended with it.

use std::error::Error;
use std::sync::Arc;

use futures::future::join_all;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::run::turn_interrupt::{
    CodexRunningTurnInterrupt, CodexTurnInterrupt, TURN_INTERRUPT_METHOD,
    interrupt_codex_running_turn, interrupt_codex_turn,
};
use crate::driver::codex::service::home::CodexConversationHome;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::socket_link::is_listening;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::start::kept_records::read_kept_service_socket;
use crate::driver::codex::session::detached_conversation::{
    CODEX_DETACHED_INTERRUPT_DEADLINE, CodexDetachedFrames,
};
use crate::driver::codex::session::errors::{
    CODEX_INVALID_REQUEST_CODE, CodexError, CodexUnansweredCause,
};
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::session_control::EndKeptTurnsParams;

/// The start of Codex's refusal of an interrupt of a turn that is not the one running, which goes
/// on with the turn named and the one running.
const EXPECTED_TURN_PREFIX: &str = "expected active turn id ";

/// The words between the two turns of Codex's refusal of an interrupt of a turn not running.
const FOUND_TURN_SEPARATOR: &str = " but found ";

/// How a kept turn's interrupt ended, read from Codex's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum KeptTurnInterrupt {
    /// Codex stopped the turn.
    Stopped,
    /// The turn had already ended.
    AlreadyEnded,
    /// The service holds the conversation no longer, so no turn of it runs.
    ThreadGone,
    /// The connection closed before Codex answered and the service's process has since ended, so
    /// the turn ended with it.
    EndedWithService,
    /// Codex refused the interrupt, in its own words.
    Refused {
        /// Codex's refusal.
        message: String,
    },
}

impl CodexDriver {
    /// Ends each turn `params` names on the service of the home that holds the session's
    /// conversation, on a task of the driver's that `params.stop` ends where it stands. Answers
    /// once that task holds the session's slot, so a resume of the session waits for the work, or
    /// at once where the stop came first; each turn's outcome is logged.
    pub(crate) async fn end_kept_turns(&self, params: EndKeptTurnsParams) {
        let (held, is_held) = oneshot::channel();
        let slots = Arc::clone(&self.slots);
        let registry = Arc::clone(&self.registry);
        self.tasks.spawn(async move {
            let stop = params.stop.clone();
            tokio::select! {
                () = stop.cancelled() => {}
                () = end_turns_holding_session(&slots, &registry, params, held) => {}
            }
        });
        // A stop before the claim drops the sender: the daemon is stopping, and the turns not yet
        // interrupted run on.
        is_held.await.unwrap_or_default();
    }
}

// Ends `params`' turns holding the session's slot, which tells `held` once taken, for at most
// [`CODEX_DETACHED_INTERRUPT_DEADLINE`] from the claim, the join included; the slot is let go with
// no close, so a resume that waited behind it goes on.
async fn end_turns_holding_session(
    slots: &CodexSessionSlots,
    registry: &CodexServiceRegistry,
    params: EndKeptTurnsParams,
    held: oneshot::Sender<()>,
) {
    let _claim = slots.claim_closing(params.session_id).await;
    // The entry no longer waits only once its caller left; the work goes on.
    let _unheard = held.send(());
    let deadline = Instant::now() + CODEX_DETACHED_INTERRUPT_DEADLINE;
    let Some((service, connection)) = connect_kept_service(registry, &params, deadline).await
    else {
        return;
    };
    let (service, connection) = (&service, &connection);
    let session_id = params.session_id;
    let conversation = params.conversation.as_str();
    join_all(params.runs.iter().flat_map(|run| {
        // A helper's id is its own conversation's.
        let thread_id = run
            .subagent_id
            .as_ref()
            .map_or(conversation, SubagentId::as_str);
        run.turn_ids.iter().map(move |turn_id| async move {
            let ended = end_kept_turn(
                connection,
                thread_id,
                turn_id.as_str(),
                run.is_for_stop,
                deadline,
            )
            .await;
            let ended = read_end_after_close(service, ended, deadline).await;
            log_kept_turn_end(session_id, thread_id, turn_id.as_str(), ended);
        })
    }))
    .await;
}

// The service that runs the session's conversation and a connection on it, by `deadline`, as
// [`join_kept_service`] joins it; `None` where none is joined, and where the service could not be
// found or reached in time while it still runs, which is logged.
async fn connect_kept_service(
    registry: &CodexServiceRegistry,
    params: &EndKeptTurnsParams,
    deadline: Instant,
) -> Option<(Arc<CodexService>, Arc<CodexAppServerConnection>)> {
    let joined = async {
        let service = registry
            .service_for_conversation(
                &params.provider_account_id,
                CodexConversationHome::read(&params.runtime_metadata),
            )
            .await
            .map_err(CodexError::Driver)?;
        let connection = join_kept_service(&service, deadline).await?;
        Ok(connection.map(|connection| (service, connection)))
    };
    let joined = tokio::time::timeout_at(deadline, joined)
        .await
        .unwrap_or_else(|_elapsed| {
            Err(CodexError::Transport {
                detail: format!(
                    "The Codex service was not reached within {} seconds.",
                    CODEX_DETACHED_INTERRUPT_DEADLINE.as_secs()
                ),
                cause: None,
            })
        });
    match joined {
        Ok(joined) => joined,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                session_id = %params.session_id,
                conversation = params.conversation,
                "the codex service running the turns a restart kept could not be joined; they run \
                 on"
            );
            None
        }
    }
}

/// A connection on `service` for the turns a restart kept, by `deadline`: the daemon's own while
/// it is up, else one of its own on the service a former daemon kept running, draining or not,
/// which is joined and never started. `None` where no running service is kept, none listens where
/// its record says, or the join was cut while the service's process ended, since the turns ended
/// with it. Fails as the record's read, the probe or a join cut while the service still runs does.
pub(super) async fn join_kept_service(
    service: &CodexService,
    deadline: Instant,
) -> Result<Option<Arc<CodexAppServerConnection>>, CodexError> {
    if let Ok(connection) = service.connection() {
        return Ok(Some(connection));
    }
    let Some(kept_socket) = read_kept_service_socket(service).await? else {
        return Ok(None);
    };
    let is_kept_listening =
        is_listening(&kept_socket)
            .await
            .map_err(|error| CodexError::Transport {
                detail: "The Codex service's socket could not be probed.".to_owned(),
                cause: Some(Box::new(error)),
            })?;
    if !is_kept_listening {
        return Ok(None);
    }
    // Its notifications have no reader: the work only interrupts.
    let (events, _unread) = CodexDetachedFrames::new();
    let bound = deadline.saturating_duration_since(Instant::now());
    match service
        .dial_detached_connection(&kept_socket, events, bound)
        .await
    {
        Ok(connection) => Ok(Some(Arc::new(connection))),
        Err(error) => {
            if has_kept_service_ended(service, deadline).await {
                return Ok(None);
            }
            Err(error)
        }
    }
}

/// A kept turn's end `ended`, read again where its connection closed before Codex answered: the
/// turn ended with its service once the service's process has ended, read from its record by
/// `deadline`; any other end, and a close while the service still runs, stands as it was.
pub(super) async fn read_end_after_close(
    service: &CodexService,
    ended: Result<KeptTurnInterrupt, CodexError>,
    deadline: Instant,
) -> Result<KeptTurnInterrupt, CodexError> {
    match ended {
        Err(
            error @ (CodexError::Transport { .. }
            | CodexError::Unanswered {
                cause: CodexUnansweredCause::ConnectionClosed { .. },
                ..
            }),
        ) => {
            if has_kept_service_ended(service, deadline).await {
                return Ok(KeptTurnInterrupt::EndedWithService);
            }
            Err(error)
        }
        ended => ended,
    }
}

// Whether the service a former daemon kept on `service`'s home has ended, read again from its
// record by `deadline`; `false` where it still runs, and where the read failed, which is logged,
// or ran past `deadline`.
async fn has_kept_service_ended(service: &CodexService, deadline: Instant) -> bool {
    match tokio::time::timeout_at(deadline, read_kept_service_socket(service)).await {
        Ok(Ok(kept_socket)) => kept_socket.is_none(),
        Ok(Err(error)) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the record of the codex service a restart kept could not be read again"
            );
            false
        }
        Err(_elapsed) => false,
    }
}

/// Ends the kept turn `turn_id` of the conversation `thread_id` over `connection` by `deadline`,
/// the interrupt and its follow included; a refusal for a run stopping, `is_for_stop`, is followed
/// once. Fails as a request does, and with `CodexError::Unanswered` at the deadline, which names
/// [`CODEX_DETACHED_INTERRUPT_DEADLINE`] as its bound.
pub(super) async fn end_kept_turn(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    turn_id: &str,
    is_for_stop: bool,
    deadline: Instant,
) -> Result<KeptTurnInterrupt, CodexError> {
    tokio::time::timeout_at(deadline, async {
        let answer =
            read_kept_turn_interrupt(interrupt_codex_turn(connection, thread_id, turn_id).await)?;
        match answer {
            KeptTurnInterrupt::Refused { message } if is_for_stop => {
                follow_refused_interrupt(connection, thread_id, turn_id, message).await
            }
            KeptTurnInterrupt::Stopped
            | KeptTurnInterrupt::AlreadyEnded
            | KeptTurnInterrupt::ThreadGone
            | KeptTurnInterrupt::EndedWithService
            | KeptTurnInterrupt::Refused { .. } => Ok(answer),
        }
    })
    .await
    .unwrap_or_else(|_elapsed| {
        Err(CodexError::Unanswered {
            method: TURN_INTERRUPT_METHOD.to_owned(),
            cause: CodexUnansweredCause::Deadline {
                timeout: CODEX_DETACHED_INTERRUPT_DEADLINE,
            },
        })
    })
}

// Follows a refused interrupt of a stopping run's turn once: the conversation's running turn under
// another id, Codex's continuation of it, is interrupted; listed running under none, the turn the
// refusal names as running is. Answers the refusal where neither is found.
async fn follow_refused_interrupt(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    turn_id: &str,
    message: String,
) -> Result<KeptTurnInterrupt, CodexError> {
    match interrupt_codex_running_turn(connection, thread_id, Some(turn_id)).await {
        Ok(CodexRunningTurnInterrupt::Running(answer)) => read_kept_turn_interrupt(Ok(answer)),
        Err(error) => read_kept_turn_interrupt(Err(error)),
        Ok(CodexRunningTurnInterrupt::NoTurn | CodexRunningTurnInterrupt::Untouched(_)) => {
            if let Some(running) = read_running_turn_named(&message) {
                return read_kept_turn_interrupt(
                    interrupt_codex_turn(connection, thread_id, running).await,
                );
            }
            Ok(KeptTurnInterrupt::Refused { message })
        }
    }
}

// Reads an interrupt's answer for a kept turn: Codex's `-32600` refusals become outcomes, a
// conversation not loaded among them, and every other failure stays one.
fn read_kept_turn_interrupt(
    interrupted: Result<CodexTurnInterrupt, CodexError>,
) -> Result<KeptTurnInterrupt, CodexError> {
    match interrupted {
        Ok(CodexTurnInterrupt::Stopped) => Ok(KeptTurnInterrupt::Stopped),
        Ok(CodexTurnInterrupt::AlreadyEnded) => Ok(KeptTurnInterrupt::AlreadyEnded),
        Err(error) if error.is_thread_not_found() => Ok(KeptTurnInterrupt::ThreadGone),
        Err(CodexError::ProviderRequest {
            code: CODEX_INVALID_REQUEST_CODE,
            message,
            ..
        }) => Ok(KeptTurnInterrupt::Refused { message }),
        Err(error) => Err(error),
    }
}

// The turn a refusal names as running, from Codex's words `expected active turn id {X} but found
// {Y}`; `None` for any other refusal, and where it names none.
fn read_running_turn_named(message: &str) -> Option<&str> {
    let (_expected, running) = message
        .strip_prefix(EXPECTED_TURN_PREFIX)?
        .split_once(FOUND_TURN_SEPARATOR)?;
    let running = running.trim();
    (!running.is_empty()).then_some(running)
}

// Logs a kept turn's end where it was not ended: a refusal left, a failure or the deadline.
fn log_kept_turn_end(
    session_id: SessionId,
    thread_id: &str,
    turn_id: &str,
    ended: Result<KeptTurnInterrupt, CodexError>,
) {
    match ended {
        Ok(
            KeptTurnInterrupt::Stopped
            | KeptTurnInterrupt::AlreadyEnded
            | KeptTurnInterrupt::ThreadGone
            | KeptTurnInterrupt::EndedWithService,
        ) => {}
        Ok(KeptTurnInterrupt::Refused { message }) => tracing::warn!(
            %session_id,
            thread_id,
            turn_id,
            message,
            "codex refused to end a turn a restart kept; it runs on"
        ),
        Err(error) => tracing::warn!(
            error = &error as &(dyn Error + 'static),
            %session_id,
            thread_id,
            turn_id,
            "a turn a restart kept could not be ended on codex; it runs on"
        ),
    }
}
