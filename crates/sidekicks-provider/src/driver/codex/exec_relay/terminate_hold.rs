//! A relayed command's end. Codex's terminate kills the wrapper's process group alone, which
//! leaves the command's own group running, so the relay first has every party under the wrapper
//! end, then the wrapper end its command's whole session, and passes the terminate on once the
//! command ended or the hold ran out; a stop the person or an undo asks takes the same ladder and
//! waits longer for its end.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use sidekicks_contracts::command::CommandId;
use sidekicks_std::mutex_lock::lock;

use crate::command::channel::{PartyId, StoppedCommandParties};
use crate::driver::codex::exec_relay::executor::CodexExecutor;
use crate::driver::codex::exec_relay::{CodexExecRelay, RelayedCommand, SessionChannel, forward};

/// How long a terminate waits for the wrapper's end of its command before it passes on.
const TERMINATE_HOLD: Duration = Duration::from_millis(50);

// The member of a terminate the relay reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminateRead {
    process_id: String,
}

#[derive(Deserialize)]
struct TerminateMessage {
    params: TerminateRead,
}

/// How the wrapper's end of a command went.
pub(super) enum WrapperStop {
    /// The command ended within the wait.
    Ended,
    /// The wrapper was asked and the command had not ended when the wait ran out.
    StillRunning,
    /// No wrapper runs the command, or none could be asked.
    NoWrapper,
}

impl CodexExecRelay {
    /// Passes the terminate in `line` on to `executor`, first having the wrapper of a relayed
    /// command end it, within the hold.
    pub(super) async fn forward_terminate(
        self: Arc<Self>,
        executor: Arc<CodexExecutor>,
        line: String,
    ) {
        let relayed = serde_json::from_str::<TerminateMessage>(&line)
            .ok()
            .and_then(|message| self.command_on(&message.params.process_id));
        if let Some((call, command)) = relayed {
            // The terminate passes on whatever the wrapper's stop came to.
            self.stop_through_wrapper(&executor, &call, &command, TERMINATE_HOLD)
                .await;
        }
        drop(self);
        forward(&executor, line).await;
    }

    /// Has every party under the wrapper of `command`, the call `call`, end, then the wrapper end
    /// its command's whole session, and waits up to `wait`, the parties' ends included, for the
    /// executor to report the command ended; answers how it went, with the parties the stop
    /// reached once it reached them all within the wait. The stop runs on a task of its own, so
    /// the wait running out never leaves the wrapper unasked.
    pub(super) async fn stop_through_wrapper(
        &self,
        executor: &CodexExecutor,
        call: &str,
        command: &RelayedCommand,
        wait: Duration,
    ) -> (WrapperStop, StoppedCommandParties) {
        let Some((channel, party)) = self.wrapper_of(command, call) else {
            return (WrapperStop::NoWrapper, StoppedCommandParties::default());
        };
        let mut exited = executor.watch_exit(&command.executor_process_id);
        let stopping =
            tokio::spawn(async move { channel.channel.stop_command_parties(party).await });
        let stopped = tokio::time::timeout(wait, async {
            let parties = stopping.await.map_err(std::io::Error::other)??;
            let _ended = exited.wait_for(Option::is_some).await;
            Ok::<_, std::io::Error>(parties)
        })
        .await;
        match stopped {
            Ok(Ok(parties)) => (WrapperStop::Ended, parties),
            Ok(Err(error)) => {
                tracing::warn!(
                    party,
                    error = &error as &(dyn std::error::Error + 'static),
                    "a relayed command's wrapper could not be asked to stop it"
                );
                (WrapperStop::NoWrapper, StoppedCommandParties::default())
            }
            Err(_elapsed) => (WrapperStop::StillRunning, StoppedCommandParties::default()),
        }
    }

    // The call and running command the executor names `executor_process_id`.
    fn command_on(&self, executor_process_id: &str) -> Option<(String, RelayedCommand)> {
        lock(&self.commands)
            .iter()
            .find(|(_call, record)| {
                record.end.is_none() && record.command.executor_process_id == executor_process_id
            })
            .map(|(call, record)| (call.clone(), record.command.clone()))
    }

    // The channel and the wrapper party that run `command`, the call `call`, once it paired.
    fn wrapper_of(
        &self,
        command: &RelayedCommand,
        call: &str,
    ) -> Option<(Arc<SessionChannel>, PartyId)> {
        let sets = self.dependencies.command_output.port()?;
        let command_id = CommandId::new(call.to_owned())?;
        let party = sets.paired_wrapper(command.session_id, &command_id)?;
        let channel = Arc::clone(lock(&self.channels).get(&command.session_id)?.get()?);
        Some((channel, party))
    }
}
