//! A relayed command's end. Codex's terminate kills the wrapper's process group alone, which
//! leaves the command's own group running, so the relay first has the wrapper end its command's
//! whole session and passes the terminate on once the command ended or the hold ran out; a stop
//! the person asks takes the same ladder and waits longer for its end.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use sidekicks_contracts::command::CommandId;
use sidekicks_std::mutex_lock::lock;

use crate::command::channel::{DaemonRequest, PartyId};
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
            self.stop_through_wrapper(&executor, &call, &command, TERMINATE_HOLD)
                .await;
        }
        drop(self);
        forward(&executor, line).await;
    }

    /// Has the wrapper of `command`, the call `call`, end its command's whole session, then waits
    /// up to `wait` for the executor to report it ended.
    pub(super) async fn stop_through_wrapper(
        &self,
        executor: &CodexExecutor,
        call: &str,
        command: &RelayedCommand,
        wait: Duration,
    ) -> WrapperStop {
        let Some((channel, party)) = self.wrapper_of(command, call) else {
            return WrapperStop::NoWrapper;
        };
        let mut exited = executor.watch_exit(&command.executor_process_id);
        if let Err(error) = channel
            .channel
            .send_request(party, &DaemonRequest::Stop {})
            .await
        {
            tracing::warn!(
                party,
                %error,
                "a relayed command's wrapper could not be asked to stop it"
            );
            return WrapperStop::NoWrapper;
        }
        match tokio::time::timeout(wait, exited.wait_for(Option::is_some)).await {
            Ok(_ended) => WrapperStop::Ended,
            Err(_elapsed) => WrapperStop::StillRunning,
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
