//! The row of the running-commands list every device draws for one command the set holds.

use sidekicks_contracts::command::{CommandPrompt, RunningCommand};

use super::{CommandRow, RowState};
use crate::command::waiting_checks::WaitingState;

/// The row every device draws for `row`.
pub(super) fn drawn_row(row: &CommandRow) -> RunningCommand {
    let is_foreground = match row.state {
        RowState::Foreground => true,
        RowState::Background => false,
        RowState::Stopping { was_foreground } => was_foreground,
    };
    let waiting = row.facts.waiting.unwrap_or(WaitingState {
        is_waiting: false,
        is_echo_off: false,
    });
    let prompt = row.facts.prompt.as_ref();
    RunningCommand {
        command_id: row.start.command_id.clone(),
        run_id: row.start.run_id,
        name: row.start.name.clone(),
        started_at: row.start.started_at.clone(),
        waiting_in_foreground: is_foreground,
        can_move_to_background: row.state == RowState::Foreground
            && row.start.can_move_to_background,
        accepts_input: row.start.accepts_input,
        waiting_for_input: waiting.is_waiting || prompt.is_some(),
        echo_off: waiting.is_echo_off || prompt.is_some_and(|prompt| prompt.is_masked),
        prompt: prompt.map(|prompt| CommandPrompt {
            text: prompt.text.clone(),
        }),
    }
}
