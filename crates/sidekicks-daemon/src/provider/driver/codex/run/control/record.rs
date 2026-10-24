//! The calls Codex run control makes on a session's record, each run on the session's task: an
//! interrupt marked before it goes and settled once Codex answered it, the steers its turn still
//! held unechoed, a pause marked for its turn's next step end and settled once its interrupt was
//! answered, and a continue placed by how its run's pause stands.

use std::sync::Arc;

use futures::future::{BoxFuture, Shared};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use tokio::sync::oneshot;

use crate::provider::driver::codex::run::start::record::CodexRunCallDependencies;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;
use crate::provider::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::provider::driver::run_control::ResumeRunParams;

/// One call of run control on a session's record.
pub(crate) enum CodexRunControlCall {
    /// Marks the run's newest live turn as being interrupted, so no steer goes into it, before the
    /// interrupt goes out.
    BeginInterrupt {
        /// The run.
        run_id: RunId,
        /// Where the interrupt to send goes, `None` when the run has no live turn, or why the
        /// service has no connection.
        reply: oneshot::Sender<Result<Option<CodexInterruptSend>, CodexError>>,
    },
    /// Settles an interrupt with Codex's answer: a stopped turn is taken from its run and kept for
    /// its coming end; one Codex refused runs on as the run's.
    SettleInterrupt {
        /// The run.
        run_id: RunId,
        /// The turn.
        turn_id: String,
        /// Whether Codex stopped the turn.
        is_stopped: bool,
    },
    /// Takes the steers an interrupted turn still holds unechoed, which Codex dropped.
    TakeDroppedSteers {
        /// The turn.
        turn_id: String,
        /// Where the steered messages' ids go, in send order.
        reply: oneshot::Sender<Vec<QueueItemId>>,
    },
    /// Marks the run's newest live turn to pause at its next step's end.
    MarkPause {
        /// The run.
        run_id: RunId,
        /// Where the refusal of a run with no live turn goes.
        reply: oneshot::Sender<Result<(), CodexError>>,
    },
    /// Places a continue by how its run's pause stands.
    PlaceContinue {
        /// The continue.
        params: ResumeRunParams,
        /// Where its place goes.
        reply: oneshot::Sender<CodexContinuePlace>,
    },
    /// Settles a pause's interrupt with Codex's answer.
    SettlePauseInterrupt {
        /// The paused run.
        run_id: RunId,
        /// Its turn.
        turn_id: String,
        /// Whether Codex stopped the turn.
        is_stopped: bool,
        /// Where a continue that waited on the pause goes, when the turn runs on.
        reply: oneshot::Sender<Option<ResumeRunParams>>,
    },
}

/// An interrupt the session's task marked, to send off it: the turn, where it goes, and the
/// conversation's steers already registered, which reach Codex first.
pub(crate) struct CodexInterruptSend {
    /// The connection the turn runs on.
    pub(crate) connection: Arc<CodexAppServerConnection>,
    /// The conversation.
    pub(crate) thread_id: String,
    /// The turn to stop.
    pub(crate) turn_id: String,
    /// Settled once every steer registered before the interrupt was answered.
    pub(crate) steers_sent: Option<Shared<BoxFuture<'static, ()>>>,
}

/// Where a continue goes, by how its run's pause stands.
pub(crate) enum CodexContinuePlace {
    /// The pause had not taken effect and is dropped: the messages are steered into the turn that
    /// still runs.
    SteerInto {
        /// The turn.
        turn_id: String,
        /// The continue.
        params: ResumeRunParams,
    },
    /// The pause's interrupt is on its way; the continue starts once its turn ends.
    AwaitsPause,
    /// The run is paused: its next turn starts with the messages.
    StartTurn(ResumeRunParams),
}

/// Runs one call of run control on the record, on the session's task.
pub(crate) fn run_codex_run_control_call(
    call: CodexRunControlCall,
    record: &mut CodexSessionRecord,
    dependencies: &CodexRunCallDependencies,
) {
    match call {
        CodexRunControlCall::BeginInterrupt { run_id, reply } => {
            let _unheard = reply.send(begin_interrupt(record, run_id));
        }
        CodexRunControlCall::SettleInterrupt {
            run_id,
            turn_id,
            is_stopped,
        } => settle_interrupt(record, dependencies, run_id, &turn_id, is_stopped),
        CodexRunControlCall::TakeDroppedSteers { turn_id, reply } => {
            let dropped = record
                .unechoed_steers_by_turn_id
                .remove(&turn_id)
                .map(|unechoed| unechoed.message_ids())
                .unwrap_or_default();
            let _unheard = reply.send(dropped);
        }
        CodexRunControlCall::MarkPause { run_id, reply } => {
            let _unheard = reply.send(mark_pause(record, dependencies, run_id));
        }
        CodexRunControlCall::PlaceContinue { params, reply } => {
            let _unheard = reply.send(place_continue(record, params));
        }
        CodexRunControlCall::SettlePauseInterrupt {
            run_id,
            turn_id,
            is_stopped,
            reply,
        } => {
            record.interrupting_turn_ids.remove(&turn_id);
            let waiting = if is_stopped {
                dependencies.run_routes.retire_turn_route(record, &turn_id);
                None
            } else {
                // The turn runs on, so a continue that waited for its end steers into it instead.
                record.paused_run_id_by_interrupted_turn_id.remove(&turn_id);
                record.continues_awaiting_pause.remove(&run_id)
            };
            let _unheard = reply.send(waiting);
        }
    }
}

// The run's newest live turn, marked as being interrupted, with what the interrupt goes on.
fn begin_interrupt(
    record: &mut CodexSessionRecord,
    run_id: RunId,
) -> Result<Option<CodexInterruptSend>, CodexError> {
    let Some(turn_id) = record.newest_active_turn_for_run(run_id).map(str::to_owned) else {
        return Ok(None);
    };
    let connection = record.service.connection()?;
    record.interrupting_turn_ids.insert(turn_id.clone());
    Ok(Some(CodexInterruptSend {
        connection,
        thread_id: record.thread_id.clone(),
        turn_id,
        steers_sent: record.last_steer_send.clone(),
    }))
}

// A stopped turn leaves its run's routes and is kept for its coming end, a pause waiting on it
// dropped; one whose end already arrived is owed nothing. A turn Codex did not stop whose end
// already arrived lets go of its unechoed steers, which no take follows. Past the memory's bound
// the session is let go rather than lose an end silently.
fn settle_interrupt(
    record: &mut CodexSessionRecord,
    dependencies: &CodexRunCallDependencies,
    run_id: RunId,
    turn_id: &str,
    is_stopped: bool,
) {
    record.interrupting_turn_ids.remove(turn_id);
    if !is_stopped {
        forget_ended_turn_steers(record, turn_id);
        return;
    }
    record.pause_run_id_by_turn_id.remove(turn_id);
    if record.is_turn_settled(turn_id) {
        return;
    }
    if record
        .remember_interrupted_run(turn_id.to_owned(), run_id)
        .is_err()
    {
        CodexTransportDiagnostic::InterruptedRouteMemoryOverflowed {
            retained_turn_count: record.interrupted_run_by_turn_id.len(),
        }
        .report();
        dependencies.disposal.dispose(record.session_id);
        return;
    }
    dependencies.run_routes.retire_turn_route(record, turn_id);
}

// The steers a turn whose end arrived while its interrupt was on the wire still holds unechoed,
// kept at that end for the interrupt, let go once no take of them follows.
fn forget_ended_turn_steers(record: &mut CodexSessionRecord, turn_id: &str) {
    if record.is_turn_settled(turn_id) {
        record.unechoed_steers_by_turn_id.remove(turn_id);
    }
}

// A pause of the lead's live turn, taken at its next step's end. A helper's run, which holds no
// turn of the session's own conversation, pauses only through the daemon's pre-tool hook.
fn mark_pause(
    record: &mut CodexSessionRecord,
    dependencies: &CodexRunCallDependencies,
    run_id: RunId,
) -> Result<(), CodexError> {
    let turn_id = record
        .newest_active_turn_for_run(run_id)
        .filter(|_| dependencies.run_routes.binding_for(run_id).is_some())
        .map(str::to_owned);
    let Some(turn_id) = turn_id else {
        return Err(CodexError::Transport {
            detail: format!(
                "Run \"{run_id}\" has no live Codex turn on session \"{}\" that a pause can stop; \
                 a helper's run pauses only through the daemon's pre-tool hook.",
                record.session_id
            ),
            cause: None,
        });
    };
    record.pause_run_id_by_turn_id.insert(turn_id, run_id);
    Ok(())
}

// A pause not yet taken effect is dropped, its messages steered into the turn still running; one
// whose interrupt is on its way keeps the continue for its turn's end; a paused run starts again.
fn place_continue(record: &mut CodexSessionRecord, params: ResumeRunParams) -> CodexContinuePlace {
    let pausing_turn_id = record
        .pause_run_id_by_turn_id
        .iter()
        .find(|(_, run_id)| **run_id == params.run_id)
        .map(|(turn_id, _)| turn_id.clone());
    if let Some(turn_id) = pausing_turn_id {
        record.pause_run_id_by_turn_id.remove(&turn_id);
        return CodexContinuePlace::SteerInto { turn_id, params };
    }
    let is_pause_on_its_way = record
        .paused_run_id_by_interrupted_turn_id
        .values()
        .any(|run_id| *run_id == params.run_id);
    if is_pause_on_its_way {
        record
            .continues_awaiting_pause
            .insert(params.run_id, params);
        return CodexContinuePlace::AwaitsPause;
    }
    CodexContinuePlace::StartTurn(params)
}
