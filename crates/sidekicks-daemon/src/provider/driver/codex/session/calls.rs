//! The calls the Codex driver makes on a session's record, each run on the session's task in its
//! place among the session's frames, so no frame and no call ever sees the record half changed.
//! A call that waits on Codex waits only for a reply, which the service's reader answers, never
//! for a frame of its own session, which sits behind it in the same queue.

use crate::provider::driver::codex::notification_routing::{
    CodexRoutedFrames, CodexSessionRouting,
};
use crate::provider::driver::codex::run::steer::{register_codex_steer, withdraw_codex_steer};
use crate::provider::driver::codex::run::turn_end_waiters::CodexTurnEndWaiters;
use crate::provider::driver::codex::session::fork::config_change::run_codex_config_fork;
use crate::provider::driver::codex::session::fork::{
    CodexForkDependencies, move_codex_session_to_fork,
};
use crate::provider::driver::codex::session::inbound::CodexSessionCall;
use crate::provider::driver::codex::session::state::CodexSessionRecord;

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
}

/// Runs `call` on the session's task, answering on the call's own reply, and settles the waits
/// the call may have answered. Answers the frames a fork released, which the task applies as it
/// applies a routed frame's.
#[expect(
    dead_code,
    reason = "the Codex session's task runs each call of its queue through it"
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
    }
    task.waiters.settle(task.record);
    routed
}
