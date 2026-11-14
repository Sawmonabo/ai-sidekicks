//! The person's acts on a Codex command, and an undo's stop of one. A stop of a command the wrapper
//! runs takes the wrapper's end ladder, then Codex's own terminate, so Codex records the terminal
//! stopped; any other is Codex's own background terminal, read from the relay's record or, for a
//! command the relay does not hold, from the session's open row, stopped through the service and
//! answered done only when Codex says it terminated. Typed input goes to the executor, sent again
//! under the same write id when its answer is late, which the executor takes once.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde_json::json;
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::mutex_lock::lock;

use crate::command::channel::stop::{COMMAND_STOP_WAIT, StoppedCommandParties};
use crate::command::running_set::takes_no_input;
use crate::driver::codex::exec_relay::executor::CodexExecutor;
use crate::driver::codex::exec_relay::methods::PROCESS_WRITE_METHOD;
use crate::driver::codex::exec_relay::terminate_hold::WrapperStop;
use crate::driver::codex::exec_relay::{CodexExecRelay, RelayedCommand};
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::background_terminals::terminate_codex_running_command;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::lifecycle_call::CodexLifecycleCall;
use crate::driver::codex::session::lifecycle_call::call_codex_lifecycle;
use crate::driver::contract::error::DriverError;
use crate::port::running_command_publisher::{
    RunningCommandParams, StopCommandParams, WriteCommandInputParams,
};

/// How long one write waits for the executor's answer before it is sent again.
const WRITE_WAIT: Duration = Duration::from_secs(5);

/// The byte a terminal reads as the end of input.
const END_OF_INPUT: &str = "\u{4}";

// The executor's answer to a write.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum WriteStatus {
    Accepted,
    UnknownProcess,
    StdinClosed,
    Starting,
}

#[derive(Deserialize)]
struct WriteAnswer {
    status: WriteStatus,
}

impl CodexDriver {
    /// Stops the command `params` names, whatever its cause, since Codex is told no words of it:
    /// through its wrapper where one runs it, then with Codex's terminate, answered done once it
    /// ended, a terminal Codex no longer holds included, with the parties the wrapper's stop
    /// reached; otherwise as Codex's background terminal, answered done only on Codex's
    /// `terminated: true`. A command whose item already ended, or whose process exited while its
    /// item is still open, is answered done. Refused `agent.command.notStopped` when it still runs
    /// or names no process to stop, as the session's live record is missing, and as the service's
    /// request fails.
    pub(crate) async fn stop_command(
        &self,
        params: StopCommandParams,
    ) -> Result<StoppedCommandParties, DriverError> {
        let params = params.command;
        let Some((service, relay, command)) =
            self.find_relayed(&params, CodexExecRelay::relayed_command)
        else {
            match self.find_relayed(&params, CodexExecRelay::exited_command) {
                // Its process ended on its own while its item is still open: the stop is done
                // whatever Codex's terminate answers for the terminal it let go.
                Some((service, _relay, command)) => {
                    let connection = service.connection()?;
                    terminate_codex_running_command(
                        &connection,
                        &command.thread_id,
                        &command.terminal_process_id,
                    )
                    .await?;
                }
                None => self.stop_background_terminal(&params).await?,
            }
            return Ok(StoppedCommandParties::default());
        };
        let (stop, parties) = match relay.executor() {
            Some(executor) => {
                relay
                    .stop_through_wrapper(
                        &executor,
                        params.command_id.as_str(),
                        &command,
                        COMMAND_STOP_WAIT,
                    )
                    .await
            }
            None => (WrapperStop::NoWrapper, StoppedCommandParties::default()),
        };
        // A command still running after its wrapper was asked is refused before Codex's terminate,
        // which would kill the wrapper while it ends its command's group.
        if matches!(stop, WrapperStop::StillRunning) {
            return Err(not_stopped(&params.command_id).into());
        }
        let connection = service.connection()?;
        let is_terminated = terminate_codex_running_command(
            &connection,
            &command.thread_id,
            &command.terminal_process_id,
        )
        .await?;
        // Codex answers `terminated: false` for a terminal it no longer holds, as one the wrapper
        // ended has been let go, so after the wrapper's end that answer is the stop done.
        if is_terminated || matches!(stop, WrapperStop::Ended) {
            Ok(parties)
        } else {
            Err(not_stopped(&params.command_id).into())
        }
    }

    // Stops the command `params` names, which the relay does not hold, as Codex's background
    // terminal, reading where it runs from the session's open row.
    async fn stop_background_terminal(
        &self,
        params: &RunningCommandParams,
    ) -> Result<(), DriverError> {
        let inbound = self.slots.require_live(params.session_id)?;
        let item_id = params.command_id.as_str().to_owned();
        let reading = call_codex_lifecycle(&inbound, |reply| {
            CodexLifecycleCall::ReadRunningCommand { item_id, reply }
        })
        .await?;
        let Some(reading) = reading else {
            return Ok(());
        };
        let Some(process_id) = reading.terminal_process_id else {
            return Err(not_stopped(&params.command_id).into());
        };
        let connection = reading.connection?;
        let is_terminated =
            terminate_codex_running_command(&connection, &reading.thread_id, &process_id).await?;
        if is_terminated {
            Ok(())
        } else {
            Err(not_stopped(&params.command_id).into())
        }
    }

    /// Writes the person's input to the command `params` names, its end of input as the byte a
    /// terminal reads as one. Refused `agent.command.takesNoInput` for a command the relay does not
    /// hold, whose input closed or that the executor no longer runs, and `provider.timeout` when
    /// neither the write nor its one resend was answered in time.
    pub(crate) async fn write_command_input(
        &self,
        params: WriteCommandInputParams,
    ) -> Result<(), DriverError> {
        let command_id = &params.command.command_id;
        let found = self
            .find_relayed(&params.command, CodexExecRelay::relayed_command)
            .and_then(|(_service, relay, command)| Some((relay.executor()?, command)));
        let Some((executor, command)) = found else {
            return Err(takes_no_input(command_id).into());
        };
        let mut text = params.text.unwrap_or_default();
        if params.is_end_of_input {
            text.push_str(END_OF_INPUT);
        }
        write_input(&executor, &command, &text, command_id).await
    }

    // The service, relay and record of the command `params` names that `read` answers from a
    // relay, among every service's relay.
    fn find_relayed(
        &self,
        params: &RunningCommandParams,
        read: impl Fn(&CodexExecRelay, SessionId, &CommandId) -> Option<RelayedCommand>,
    ) -> Option<(Arc<CodexService>, Arc<CodexExecRelay>, RelayedCommand)> {
        self.registry.services().into_iter().find_map(|service| {
            let relay = service.exec_relay()?;
            let command = read(&relay, params.session_id, &params.command_id)?;
            Some((service, relay, command))
        })
    }
}

impl CodexExecRelay {
    /// The executor the relay runs now.
    pub(super) fn executor(&self) -> Option<Arc<CodexExecutor>> {
        lock(&self.executor).clone()
    }
}

/// Sends `text` to `command`'s process, once more under the same write id when the first answer
/// is late or the process still starts. Refused as [`CodexDriver::write_command_input`] says.
pub(super) async fn write_input(
    executor: &CodexExecutor,
    command: &RelayedCommand,
    text: &str,
    command_id: &CommandId,
) -> Result<(), DriverError> {
    let params = json!({
        "processId": command.executor_process_id,
        "chunk": STANDARD.encode(text),
        "writeId": mint_uuid_v7().to_string(),
    });
    for _attempt in 0..2 {
        let Some(answer) = executor
            .request_within(PROCESS_WRITE_METHOD, &params, WRITE_WAIT)
            .await?
        else {
            continue;
        };
        let status = serde_json::from_str::<WriteAnswer>(answer.get())
            .map_err(|error| CodexError::Transport {
                detail: "The Codex executor's answer to a write is unreadable.".to_owned(),
                cause: Some(Box::new(error)),
            })?
            .status;
        match status {
            WriteStatus::Accepted => return Ok(()),
            WriteStatus::UnknownProcess | WriteStatus::StdinClosed => {
                return Err(takes_no_input(command_id).into());
            }
            WriteStatus::Starting => {}
        }
    }
    Err(DomainError::new(
        "The Codex executor did not take the input in time.",
        RefusalCode::ProviderTimeout,
    )
    .with_detail(json!({ "commandId": command_id }))
    .into())
}

// The refusal of a stop whose command still runs.
fn not_stopped(command_id: &CommandId) -> DomainError {
    DomainError::new(
        "The command is still running.",
        RefusalCode::AgentCommandNotStopped,
    )
    .with_detail(json!({ "commandId": command_id }))
}
