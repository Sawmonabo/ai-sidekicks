//! The turns a restart kept running on a Codex service, in a session the start does not resume,
//! ended there: each interrupted by its recorded id on the service that runs it, with no resume of
//! its conversation, since a loaded conversation still answers once the client that started it is
//! gone. Every running service the home's records keep is tried, the daemon's own first, since a
//! build move may have left the conversation on the service it replaced. A stopping run's turn
//! Codex continued under another id is followed once. A connection that closes or a join cut
//! while the service's process ends reads as the turns ended with it.

use std::error::Error;
use std::sync::Arc;

use futures::future::join_all;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::{mpsc, oneshot};
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
use crate::driver::codex::service::supervisor::start::kept_records::{
    RunningKeptService, read_running_kept_services,
};
use crate::driver::codex::session::detached_conversation::{
    CODEX_DETACHED_INTERRUPT_DEADLINE, CodexDetachedFrame, CodexDetachedFrames,
};
use crate::driver::codex::session::errors::{
    CODEX_INVALID_REQUEST_CODE, CodexError, CodexUnansweredCause,
};
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::session_control::{EndKeptTurnsParams, KeptTurnsEnding};

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
    /// at once where the stop came first; each turn's outcome is logged. The ending answered reads
    /// ended once every turn's interrupt has answered, failed or passed its deadline, and cut where
    /// the stop came first.
    pub(crate) async fn end_kept_turns(&self, params: EndKeptTurnsParams) -> KeptTurnsEnding {
        let (held, is_held) = oneshot::channel();
        let (ending, ended) = KeptTurnsEnding::waiting();
        let slots = Arc::clone(&self.slots);
        let registry = Arc::clone(&self.registry);
        self.tasks.spawn(async move {
            let stop = params.stop.clone();
            tokio::select! {
                // Drops the ending's sender, so the ending reads cut.
                () = stop.cancelled() => {}
                () = end_turns_holding_session(&slots, &registry, params, held) => {
                    // The send fails only once the pass has stopped waiting, at its stop.
                    let _unheard = ended.send(());
                }
            }
        });
        // A stop before the claim drops the sender: the daemon is stopping, and the turns not yet
        // interrupted run on.
        is_held.await.unwrap_or_default();
        ending
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
    let Some((service, connections)) = connect_kept_service(registry, &params, deadline).await
    else {
        return;
    };
    let (service, connections) = (&service, &connections);
    let session_id = params.session_id;
    let conversation = params.conversation.as_str();
    join_all(params.runs.iter().flat_map(|run| {
        // A helper's id is its own conversation's.
        let thread_id = run
            .subagent_id
            .as_ref()
            .map_or(conversation, SubagentId::as_str);
        run.turn_ids.iter().map(move |turn_id| async move {
            let mut ended = Ok(KeptTurnInterrupt::ThreadGone);
            // A service that holds the conversation no longer leaves it to the next one.
            for kept in connections {
                ended = end_kept_turn(
                    &kept.connection,
                    thread_id,
                    turn_id.as_str(),
                    run.is_for_stop,
                    deadline,
                )
                .await;
                ended = read_end_after_close(service, kept.process_id, ended, deadline).await;
                if !matches!(ended, Ok(KeptTurnInterrupt::ThreadGone)) {
                    break;
                }
            }
            log_kept_turn_end(session_id, thread_id, turn_id.as_str(), ended);
        })
    }))
    .await;
}

/// A connection on one running service the home's records keep.
pub(crate) struct KeptConnection {
    /// The service's process's id.
    pub(crate) process_id: u32,
    /// The connection: the daemon's own, or one of its own on a service it only joins.
    pub(crate) connection: Arc<CodexAppServerConnection>,
    /// The notifications of a connection of its own, in arrival order; `None` on the daemon's own.
    pub(crate) frames: Option<mpsc::UnboundedReceiver<CodexDetachedFrame>>,
}

// The service of the home that holds the session's conversation and a connection on each running
// service its records keep, by `deadline`, as [`join_kept_service`] joins them; `None` where none
// is joined, and where a service could not be found or reached in time while it still runs, which
// is logged.
async fn connect_kept_service(
    registry: &CodexServiceRegistry,
    params: &EndKeptTurnsParams,
    deadline: Instant,
) -> Option<(Arc<CodexService>, Vec<KeptConnection>)> {
    let joined = async {
        let service = registry
            .service_for_conversation(
                &params.provider_account_id,
                CodexConversationHome::read(&params.runtime_metadata),
            )
            .await
            .map_err(CodexError::Driver)?;
        let mut connections = join_kept_service(&service, deadline).await?;
        // Their notifications have no reader: the work only interrupts.
        for kept in &mut connections {
            kept.frames = None;
        }
        Ok((!connections.is_empty()).then_some((service, connections)))
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

/// A connection on each running service the records of `service`'s home keep, by `deadline`, the
/// records read first: the daemon's own connection first where a record names the daemon's own
/// process, else one of its own on each, draining, replaced or not, which is joined and never
/// started. Empty where no running service is kept; one that never answered on a socket, none
/// listens where its record says, or whose join was cut while its process ended is passed over,
/// since its work ended with it. A service whose probe or join failed while it still runs is
/// logged and passed over, the others kept. Fails as the records' read does, and as the last such
/// failure where no service was joined.
pub(crate) async fn join_kept_service(
    service: &CodexService,
    deadline: Instant,
) -> Result<Vec<KeptConnection>, CodexError> {
    let mut running = read_running_kept_services(
        &service.dependencies().data_folder,
        &service.home().codex_home,
    )
    .await?;
    let own_process = service.process_identity().map(|own| own.process_id);
    // The daemon's own first, where the moved conversations run.
    running.sort_by_key(|kept| Some(kept.process_id) != own_process);
    let mut connections = Vec::new();
    let mut unjoined = None;
    for kept in running {
        if Some(kept.process_id) == own_process
            && let Ok(connection) = service.connection()
        {
            connections.push(KeptConnection {
                process_id: kept.process_id,
                connection,
                frames: None,
            });
            continue;
        }
        match join_one_kept_service(service, &kept, deadline).await {
            Ok(Some((connection, frames))) => connections.push(KeptConnection {
                process_id: kept.process_id,
                connection: Arc::new(connection),
                frames: Some(frames),
            }),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    process_id = kept.process_id,
                    "a running codex service the home's records keep could not be joined; the \
                     others are"
                );
                unjoined = Some(error);
            }
        }
    }
    match unjoined {
        Some(error) if connections.is_empty() => Err(error),
        _ => Ok(connections),
    }
}

// A connection of its own on the running service `kept`, by `deadline`, with where its
// notifications arrive; `None` where it never answered on a socket, none listens where its record
// says, or the join was cut while its process ended. Fails as the probe or a join cut while the
// service still runs does.
async fn join_one_kept_service(
    service: &CodexService,
    kept: &RunningKeptService,
    deadline: Instant,
) -> Result<
    Option<(
        CodexAppServerConnection,
        mpsc::UnboundedReceiver<CodexDetachedFrame>,
    )>,
    CodexError,
> {
    let Some(kept_socket) = &kept.physical_socket else {
        return Ok(None);
    };
    let is_kept_listening =
        is_listening(kept_socket)
            .await
            .map_err(|error| CodexError::Transport {
                detail: "The Codex service's socket could not be probed.".to_owned(),
                cause: Some(Box::new(error)),
            })?;
    if !is_kept_listening {
        return Ok(None);
    }
    let (events, frames) = CodexDetachedFrames::new();
    let bound = deadline.saturating_duration_since(Instant::now());
    match service
        .dial_detached_connection(kept_socket, events, bound)
        .await
    {
        Ok(connection) => Ok(Some((connection, frames))),
        Err(error) => {
            if has_kept_service_ended(service, kept.process_id, deadline).await {
                return Ok(None);
            }
            Err(error)
        }
    }
}

/// A kept turn's end `ended` on the service whose process is `process_id`, read again where its
/// connection closed before Codex answered: the turn ended with its service once that process has
/// ended, read from the home's records by `deadline`; any other end, and a close while the service
/// still runs, stands as it was.
pub(super) async fn read_end_after_close(
    service: &CodexService,
    process_id: u32,
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
            if has_kept_service_ended(service, process_id, deadline).await {
                return Ok(KeptTurnInterrupt::EndedWithService);
            }
            Err(error)
        }
        ended => ended,
    }
}

// Whether the service whose process is `process_id` on `service`'s home has ended, read again
// from the home's records by `deadline`; `false` where it still runs, and where the read failed,
// which is logged, or ran past `deadline`.
async fn has_kept_service_ended(
    service: &CodexService,
    process_id: u32,
    deadline: Instant,
) -> bool {
    let read = read_running_kept_services(
        &service.dependencies().data_folder,
        &service.home().codex_home,
    );
    match tokio::time::timeout_at(deadline, read).await {
        Ok(Ok(running)) => !running.iter().any(|kept| kept.process_id == process_id),
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
