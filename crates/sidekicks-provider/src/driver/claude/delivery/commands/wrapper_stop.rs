//! The wrapper that runs a session's command and the channel it reaches the daemon on, which a
//! stop of the command reaches it through.

use std::sync::{Arc, Weak};

use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;

use super::{ClaudeCommandChannel, ClaudeCommandChannels};
use crate::command::channel::{CommandChannel, PartyId};

impl ClaudeCommandChannels {
    /// The wrapper that runs `command_id` of `session_id` and its channel: the channel of the
    /// process apart from the session's own that runs the command, else the session's own;
    /// `None` before a wrapper pairs with the command's row and once it was let go.
    pub(crate) fn command_wrapper(
        &self,
        session_id: SessionId,
        command_id: &CommandId,
    ) -> Option<(Arc<CommandChannel>, PartyId)> {
        let party = self
            .command_output
            .port()?
            .paired_wrapper(session_id, command_id)?;
        let apart = lock(&self.apart)
            .get(&session_id)
            .into_iter()
            .flatten()
            .filter_map(Weak::upgrade)
            .find(|channel| {
                channel
                    .apart_run
                    .as_ref()
                    .is_some_and(|apart_run| apart_run.held_command(command_id.as_str()).is_some())
            });
        let channel = match apart {
            Some(channel) => channel,
            None => Arc::clone(lock(&self.sessions).get(&session_id)?),
        };
        Some((Arc::clone(&channel.channel), party))
    }
}

impl ClaudeCommandChannel {
    /// The channel the process's parties write to, which a test writes a party's records on.
    #[cfg(test)]
    pub(crate) fn command_channel(&self) -> &CommandChannel {
        &self.channel
    }
}
