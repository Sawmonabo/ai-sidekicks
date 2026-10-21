//! The calls the Codex driver makes on a session's record, each run on the session's task in its
//! place among the session's frames, so no frame and no call ever sees the record half changed.
//! A call that waits on Codex waits only for a reply, which the service's reader answers, never
//! for a frame of its own session, which sits behind it in the same queue.

use std::sync::Arc;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::run::id::RunId;
use tokio::sync::oneshot;

use crate::provider::driver::codex::notification_routing::{
    CodexRoutedFrames, CodexSessionRouting,
};
use crate::provider::driver::codex::run::faster_model_retry::{
    fork_codex_session_for_retry, restore_codex_retried_turn, stop_codex_turn_for_retry,
};
use crate::provider::driver::codex::run::start::record::{
    CodexRunCallDependencies, begin_codex_turn_start, settle_codex_turn_start,
};
use crate::provider::driver::codex::run::steer::{register_codex_steer, withdraw_codex_steer};
use crate::provider::driver::codex::run::turn_end_waiters::{
    CodexTurnEndDeadline, CodexTurnEndWaiters, CodexTurnWait,
};
use crate::provider::driver::codex::run::turn_interrupt::interrupt_codex_turn;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::fork::config_change::run_codex_config_fork;
use crate::provider::driver::codex::session::fork::{
    CodexForkDependencies, move_codex_session_to_fork,
};
use crate::provider::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInbound, CodexSessionInboundSender,
};
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;

/// What a session's task holds beside its queue: the record, its routing band and the waits on
/// its turns.
pub(crate) struct CodexSessionTask<'task> {
    /// The session's record.
    pub(crate) record: &'task mut CodexSessionRecord,
    /// The session's routing band.
    pub(crate) routing: &'task mut CodexSessionRouting,
    /// The waits on the session's turns, settled after each frame and call.
    pub(crate) waiters: &'task mut CodexTurnEndWaiters,
}

/// What the calls act through beside the session's task, shared by every session of the driver.
pub(crate) struct CodexSessionCallDependencies {
    /// What a fork reads and acts through.
    pub(crate) forks: CodexForkDependencies,
    /// What a turn's start acts through on the record.
    pub(crate) runs: CodexRunCallDependencies,
}

/// What a turn the daemon starts and `Allow once` read of a session: the connection its
/// conversation is on, the conversation, the account and posture a turn runs at, and the state of
/// its turns.
pub(crate) struct CodexSessionReading {
    /// The connection, or why the service has none.
    pub(crate) connection: Result<Arc<CodexAppServerConnection>, CodexError>,
    /// The session's conversation.
    pub(crate) thread_id: String,
    /// The account the conversation runs on.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The session's level and roots as they stand now.
    pub(crate) execution_posture: ExecutionPosture,
    /// Whether a turn runs, starts or still ends, so a turn the daemon starts would fold into it.
    pub(crate) is_turn_in_flight: bool,
    /// The runs whose turns are live, one entry per live turn.
    pub(crate) live_turn_runs: Vec<RunId>,
    /// Whether the service holds the conversation the reading was asked about loaded: the
    /// session's own or one of its helpers'.
    pub(crate) is_thread_loaded: bool,
}

/// Runs `call` on the session's task, answering on the call's own reply, and settles the waits
/// the call may have answered. Answers the frames a fork released, which the task applies as it
/// applies a routed frame's.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex session's task runs each call of its queue through it"
    )
)]
pub(crate) async fn run_codex_session_call(
    call: CodexSessionCall,
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexSessionCallDependencies,
) -> CodexRoutedFrames {
    let mut routed = CodexRoutedFrames::default();
    match call {
        CodexSessionCall::RegisterSteer {
            run_id,
            expected_turn_id,
            message_id,
            reply,
        } => {
            // A caller that stopped waiting needs no answer.
            let _unheard = reply.send(register_codex_steer(
                task.record,
                run_id,
                expected_turn_id,
                message_id,
            ));
        }
        CodexSessionCall::WithdrawSteer {
            turn_id,
            message_id,
        } => withdraw_codex_steer(task.record, &turn_id, message_id),
        CodexSessionCall::WaitForTurns { wait, reply } => {
            let _unheard = reply.send(task.waiters.wait(task.record, wait));
        }
        CodexSessionCall::ConfigFork { reply } => {
            let forked = match run_codex_config_fork(task, &dependencies.forks).await {
                Ok((has_forked, released)) => {
                    routed = released;
                    Ok(has_forked)
                }
                Err(error) => Err(error),
            };
            let _unheard = reply.send(forked);
        }
        CodexSessionCall::MoveToFork { params, reply } => {
            let moved = match move_codex_session_to_fork(task, &dependencies.forks, &params).await {
                Ok((moved, released)) => {
                    routed = released;
                    Ok(moved)
                }
                Err(error) => Err(error),
            };
            let _unheard = reply.send(moved);
        }
        CodexSessionCall::BeginTurnStart { begin, reply } => {
            let _unheard =
                reply.send(begin_codex_turn_start(task, &dependencies.runs, *begin).await);
        }
        CodexSessionCall::SettleTurnStart {
            run_id,
            accepted,
            outcome,
            reply,
        } => {
            let settled =
                settle_codex_turn_start(task, &dependencies.runs, run_id, *accepted, outcome).await;
            let _unheard = reply.send(settled);
        }
        CodexSessionCall::ReadSession { thread_id, reply } => {
            let _unheard = reply.send(read_codex_session(task, thread_id.as_deref()));
        }
        CodexSessionCall::InterruptRunTurn { run_id, reply } => {
            let record = &*task.record;
            let interrupted = match record.newest_active_turn_for_run(run_id) {
                Some(turn_id) => match record.service.connection() {
                    Ok(connection) => {
                        interrupt_codex_turn(&connection, &record.thread_id, turn_id).await
                    }
                    Err(error) => Err(error),
                },
                None => Ok(()),
            };
            let _unheard = reply.send(interrupted);
        }
        CodexSessionCall::StopTurnForRetry {
            run_id,
            turn_id,
            reply,
        } => {
            let stop = stop_codex_turn_for_retry(task.record, &dependencies.runs, run_id, &turn_id);
            let _unheard = reply.send(stop);
        }
        CodexSessionCall::RestoreRetriedTurn {
            run_id,
            turn_id,
            reply,
        } => {
            let restored =
                restore_codex_retried_turn(task.record, &dependencies.runs, run_id, &turn_id);
            let _unheard = reply.send(restored);
        }
        CodexSessionCall::ForkForRetry {
            turn_id,
            model,
            binding_id,
            reply,
        } => {
            let forked = match fork_codex_session_for_retry(
                task,
                &dependencies.forks,
                &turn_id,
                model,
                binding_id,
            )
            .await
            {
                Ok(released) => {
                    routed = released;
                    Ok(())
                }
                Err(error) => Err(error),
            };
            let _unheard = reply.send(forked);
        }
    }
    task.waiters.settle(task.record);
    routed
}

/// Runs the call `compose` builds on the session's task `inbound` reaches and answers its reply.
/// Fails with `CodexError::Transport` once the session's task let its record go.
pub(crate) async fn call_codex_session<Answer>(
    inbound: &CodexSessionInboundSender,
    compose: impl FnOnce(oneshot::Sender<Answer>) -> CodexSessionCall,
) -> Result<Answer, CodexError> {
    let (reply, replied) = oneshot::channel();
    let let_go = || CodexError::Transport {
        detail: format!(
            "Codex session \"{}\" let its record go before it answered.",
            inbound.session_id()
        ),
        cause: None,
    };
    if !inbound.push(CodexSessionInbound::Call(compose(reply))) {
        return Err(let_go());
    }
    replied.await.map_err(|_dropped| let_go())
}

/// Waits on the session's turns for `wait`, within `deadline` where one bounds it: `true` once it
/// happened, `false` past the deadline or when the session's task dropped the wait. Fails as
/// [`call_codex_session`] does, and with `CodexError::SessionClosed` when the session closed.
pub(crate) async fn wait_for_codex_turns(
    inbound: &CodexSessionInboundSender,
    wait: CodexTurnWait,
    deadline: Option<&CodexTurnEndDeadline>,
) -> Result<bool, CodexError> {
    let answered = call_codex_session(inbound, |reply| CodexSessionCall::WaitForTurns {
        wait,
        reply,
    })
    .await?;
    match deadline {
        Some(deadline) => deadline.bound(answered).await,
        None => answered.await.unwrap_or(Ok(false)),
    }
}

// What the session's task reads for a turn the daemon starts or an `Allow once`.
fn read_codex_session(task: &CodexSessionTask<'_>, thread_id: Option<&str>) -> CodexSessionReading {
    let record = &*task.record;
    CodexSessionReading {
        connection: record.service.connection(),
        thread_id: record.thread_id.clone(),
        provider_account_id: record.provider_account_id.clone(),
        execution_posture: record.execution_posture.clone(),
        is_turn_in_flight: record.is_turn_in_flight(None),
        live_turn_runs: record
            .active_turns
            .iter()
            .map(|(_, run_id)| *run_id)
            .collect(),
        is_thread_loaded: thread_id.is_none_or(|thread_id| {
            thread_id == record.thread_id || task.routing.is_helper_thread(thread_id)
        }),
    }
}
