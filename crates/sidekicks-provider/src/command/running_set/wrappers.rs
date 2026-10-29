//! What a command channel's wrappers and askpasses report to their session's set: a wrapper's
//! start pairs it with its command's row, and its output, exit, input waits and prompts then reach
//! that row until the wrapper is let go.

use sidekicks_contracts::command::{CommandId, ExitCode};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::NonEmptyText;
use tokio::sync::watch;

use super::{
    OpenPrompt, PromptAnswer, RowWrapper, RunningCommandSets, UnpairedWrapper, WrapperCommand,
    WrapperExit, WrapperFacts, is_channel_row, row_runs,
};
use crate::command::channel::PartyId;
use crate::command::waiting_checks::WaitingState;

impl RunningCommandSets {
    /// Pairs the wrapper `party`, which came through the channel of the process that runs
    /// `apart_run` alone or, for `None`, of the session's own process, with its command's row among
    /// that process's rows: a line with the oldest unpaired row whose line runs the same text, a
    /// process with the row the provider names by it; a wrapper whose row is not known yet waits
    /// for it. Answers the signal raised once it pairs, which its output waits on.
    pub(crate) fn wrapper_started(
        &self,
        session_id: SessionId,
        party: PartyId,
        apart_run: Option<RunId>,
        command: WrapperCommand,
    ) -> watch::Receiver<bool> {
        let mut sessions = self.lock();
        let commands = sessions.entry(session_id).or_default();
        let found = commands.rows.iter_mut().find(|row| {
            row.wrapper == RowWrapper::Waiting
                && is_channel_row(row, apart_run, &commands.apart_runs)
                && row_runs(row, &command)
        });
        let (paired, is_paired) = watch::channel(found.is_some());
        match found {
            Some(row) => row.wrapper = RowWrapper::Paired(party),
            None => commands.unpaired.push(UnpairedWrapper {
                party,
                apart_run,
                command,
                facts: WrapperFacts::default(),
                paired,
            }),
        }
        is_paired
    }

    /// Output the wrapper `party` read from its command, kept in its row's live tail; dropped for a
    /// wrapper not paired.
    pub(crate) fn wrapper_output(&self, session_id: SessionId, party: PartyId, data: &str) {
        let mut sessions = self.lock();
        let Some(commands) = sessions.get_mut(&session_id) else {
            return;
        };
        if let Some(index) = commands
            .rows
            .iter()
            .position(|row| row.wrapper == RowWrapper::Paired(party))
        {
            commands.publish_output(index, data);
        }
    }

    /// The wrapper `party`'s command exited with `exit_code`, which its row's ending takes when
    /// the provider gives none.
    pub(crate) fn wrapper_exited(
        &self,
        session_id: SessionId,
        party: PartyId,
        exit_code: Option<ExitCode>,
    ) {
        self.update_wrapper(session_id, party, |facts| {
            facts.exit = Some(WrapperExit { code: exit_code });
            facts.prompt.take().is_some()
        });
    }

    /// What the wrapper `party`'s command's input wait now reads.
    pub(crate) fn waiting_read(&self, session_id: SessionId, party: PartyId, state: WaitingState) {
        self.update_wrapper(session_id, party, |facts| {
            let changed = facts.waiting != Some(state);
            facts.waiting = Some(state);
            changed
        });
    }

    /// Opens the askpass `askpass`'s prompt on the wrapper `party`'s command, in its own words,
    /// masked when its kind is; `answer` takes the person's answer, and answers empty at once for a
    /// wrapper the set holds nothing of or whose input the person ended.
    pub(crate) fn prompt_opened(
        &self,
        session_id: SessionId,
        party: PartyId,
        askpass: PartyId,
        text: NonEmptyText,
        is_masked: bool,
        answer: PromptAnswer,
    ) {
        self.update_wrapper(session_id, party, |facts| {
            // `answer` drops unused here, answering empty, so a retry after the end raises nothing.
            if facts.is_input_ended {
                return false;
            }
            facts.prompt = Some(OpenPrompt {
                askpass,
                text,
                is_masked,
                answer,
            });
            true
        });
    }

    /// Closes the prompt the askpass `askpass` opened on the wrapper `party`'s command, unanswered,
    /// once that askpass ended.
    pub(crate) fn prompt_ended(&self, session_id: SessionId, party: PartyId, askpass: PartyId) {
        self.update_wrapper(session_id, party, |facts| {
            let is_its_prompt = facts
                .prompt
                .as_ref()
                .is_some_and(|prompt| prompt.askpass == askpass);
            if is_its_prompt && let Some(prompt) = facts.prompt.take() {
                prompt.answer.dismiss();
            }
            is_its_prompt
        });
    }

    /// How many wrappers in `session_id` wait for their row.
    #[cfg(test)]
    pub(crate) fn unpaired_count(&self, session_id: SessionId) -> usize {
        self.lock()
            .get(&session_id)
            .map_or(0, |commands| commands.unpaired.len())
    }

    /// The wrapper that runs `command_id` in `session_id`; `None` before one pairs with its row
    /// and once it ended.
    pub(crate) fn paired_wrapper(
        &self,
        session_id: SessionId,
        command_id: &CommandId,
    ) -> Option<PartyId> {
        match self.lock().get(&session_id)?.row(command_id)?.wrapper {
            RowWrapper::Paired(party) => Some(party),
            RowWrapper::Waiting | RowWrapper::Ended => None,
        }
    }

    /// Forgets the wrapper `party`, whose command ended or whose process did, so a later process
    /// that reuses its id reaches no row of its.
    pub(crate) fn wrapper_ended(&self, session_id: SessionId, party: PartyId) {
        let mut sessions = self.lock();
        if let Some(commands) = sessions.get_mut(&session_id) {
            commands.unpaired.retain(|unpaired| unpaired.party != party);
            for row in &mut commands.rows {
                if row.wrapper == RowWrapper::Paired(party) {
                    row.wrapper = RowWrapper::Ended;
                }
            }
        }
    }

    // Applies `change` to a wrapper's facts, on its row or while it waits for one; a change that
    // answers true sends the set.
    fn update_wrapper(
        &self,
        session_id: SessionId,
        party: PartyId,
        change: impl FnOnce(&mut WrapperFacts) -> bool,
    ) {
        let mut sessions = self.lock();
        let Some(commands) = sessions.get_mut(&session_id) else {
            return;
        };
        if let Some(row) = commands
            .rows
            .iter_mut()
            .find(|row| row.wrapper == RowWrapper::Paired(party))
        {
            if change(&mut row.facts) {
                commands.publish_commands();
            }
        } else if let Some(unpaired) = commands.unpaired_mut(party) {
            change(&mut unpaired.facts);
        }
    }
}
