//! A Codex command's row in the session's running commands: added at its item's start, fed its
//! output as it prints, and ended by its own item's end, so a command outlives its turn's end and
//! its service's exit until Codex reports it done; a relayed command whose service was restarted
//! is ended by the relay at its process's end instead. A relayed command's row is keyed by the
//! executor's own process id, which its wrapper pairs by, and takes input as its start says.

use jiff::Timestamp;
use serde_json::{Map, Value};
use sidekicks_contracts::command::{CommandId, ExitCode};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::driver::codex::delivery::frames::CodexFrameDelivery;
use crate::driver::codex::delivery::rows::CodexRowRun;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::port::running_command_publisher::{
    CommandStart, ProviderCommandEnd, RunningCommandPublisher,
};
use crate::record_readers::read_non_empty_string;

impl CodexFrameDelivery {
    /// Adds the command item `item_id` started on `run` at `started_at_ms`, in Unix milliseconds,
    /// to the session's running commands; an item with no command text or an id outside the
    /// command id's bounds draws no row.
    pub(super) fn publish_command_started(
        &self,
        record: &CodexSessionRecord,
        item: &Map<String, Value>,
        item_id: &str,
        run: &CodexRowRun,
        started_at_ms: u64,
    ) {
        let Some(publisher) = self.dependencies.command_output.port() else {
            return;
        };
        let command_id = CommandId::new(item_id.to_owned());
        let name = read_non_empty_string(item, "command")
            .and_then(|command| NonEmptyText::new(command.to_owned()));
        let Some((command_id, name)) = command_id.zip(name) else {
            return;
        };
        // The relay holds a command it started before Codex reports the command's item.
        let relayed = record
            .service
            .exec_relay()
            .and_then(|relay| relay.relayed_command(record.session_id, &command_id));
        publisher.command_started(CommandStart {
            session_id: record.session_id,
            command_id,
            run_id: run.run_id,
            name,
            started_at: instant_at(started_at_ms),
            line: None,
            process_id: relayed
                .as_ref()
                .map(|command| command.executor_process_id.clone()),
            // Codex runs every command in the foreground and moves none while it runs.
            is_backgrounded: false,
            can_move_to_background: false,
            // Only the relay writes to a command, one whose start keeps its input.
            accepts_input: relayed.is_some_and(|command| command.accepts_input),
        });
    }

    /// Ends the command item `item_id` finished, with the exit code its item reports.
    pub(super) fn publish_command_ended(
        &self,
        record: &CodexSessionRecord,
        item: &Map<String, Value>,
        item_id: &str,
    ) {
        let Some(command_id) = CommandId::new(item_id.to_owned()) else {
            return;
        };
        if let Some(relay) = record.service.exec_relay() {
            relay.command_completed(&command_id);
        }
        let Some(publisher) = self.dependencies.command_output.port() else {
            return;
        };
        let exit_code = item
            .get("exitCode")
            .and_then(Value::as_i64)
            .and_then(ExitCode::new);
        publisher.command_ended(
            record.session_id,
            command_id,
            ProviderCommandEnd {
                exit_code,
                is_stopped_by_provider: false,
                summary: None,
            },
        );
    }

    /// Publishes a command's output as it prints to the running-commands stream, never stored; the
    /// whole output lands on the command's own end.
    pub(super) fn deliver_command_output(
        &self,
        record: &CodexSessionRecord,
        members: &Map<String, Value>,
    ) {
        let Some(publisher) = self.dependencies.command_output.port() else {
            return;
        };
        // An item id outside the command id's bounds names no row the stream could show it in.
        let command_id = read_non_empty_string(members, "itemId")
            .and_then(|item_id| CommandId::new(item_id.to_owned()));
        let data = members.get("delta").and_then(Value::as_str);
        if let Some((command_id, data)) = command_id.zip(data) {
            publisher.publish_output(record.session_id, command_id, data.to_owned());
        }
    }
}

// The instant `milliseconds` after the Unix epoch names, the clock's own for one past jiff's range.
fn instant_at(milliseconds: u64) -> WireInstant {
    i64::try_from(milliseconds)
        .ok()
        .and_then(|milliseconds| Timestamp::from_millisecond(milliseconds).ok())
        .and_then(WireInstant::from_timestamp)
        .unwrap_or_else(WireInstant::now)
}
