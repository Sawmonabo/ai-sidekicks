//! What a running-commands subscriber reads: the whole set once per change it saw, and each
//! command's output from its live tail, read through the subscriber's own cursor, so a slow reader
//! costs nothing past the tails the set already keeps.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::command::{AgentCommandSubscribeFrame, CommandId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::list::UniqueList;
use tokio::sync::watch;

use super::SessionCommands;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::stream::feed::{Feed, SendGate};
use sidekicks_std::mutex_lock::lock;

/// The most output bytes a command's live tail keeps: 64 KiB, a terminal's recent scrollback for a
/// reader that joins late; the whole output lands as the tool call's result.
const OUTPUT_TAIL_BYTES: usize = 64 * 1024;

/// A command's live tail: its newest output, cut only at a character boundary, with the offset
/// of its first byte in everything the command printed.
#[derive(Default)]
pub(super) struct OutputRing {
    tail: String,
    start: u64,
}

impl OutputRing {
    pub(super) fn push(&mut self, data: &str) {
        self.tail.push_str(data);
        if self.tail.len() > OUTPUT_TAIL_BYTES {
            let mut cut = self.tail.len() - OUTPUT_TAIL_BYTES;
            while !self.tail.is_char_boundary(cut) {
                cut += 1;
            }
            self.tail.drain(..cut);
            self.start += cut as u64;
        }
    }

    fn end(&self) -> u64 {
        self.start + self.tail.len() as u64
    }

    // The output from `cursor` on; a cursor that fell off the tail's start resumes there.
    fn read_from(&self, cursor: u64) -> &str {
        let from = cursor
            .saturating_sub(self.start)
            .min(self.tail.len() as u64);
        &self.tail[usize::try_from(from).expect("a tail's offset fits in memory")..]
    }
}

/// One subscriber's running-commands feed; dropping it ends the subscription.
pub struct RunningCommandFeed {
    sessions: Arc<Mutex<HashMap<SessionId, SessionCommands>>>,
    session_id: SessionId,
    changed: watch::Receiver<()>,
    sent_version: Option<u64>,
    // How far into each command's output this feed has read.
    cursors: HashMap<CommandId, u64>,
    // The command whose output went last, so the next output frame goes to the one after it.
    last_output: Option<CommandId>,
}

impl RunningCommandFeed {
    pub(super) fn new(
        sessions: Arc<Mutex<HashMap<SessionId, SessionCommands>>>,
        session_id: SessionId,
        changed: watch::Receiver<()>,
    ) -> Self {
        Self {
            sessions,
            session_id,
            changed,
            sent_version: None,
            cursors: HashMap::new(),
            last_output: None,
        }
    }

    // The next frame due: the set when it changed since this feed last sent it, else the output
    // of the next command, in row order after the last one served, that has output unread.
    fn next_frame(&mut self) -> Option<AgentCommandSubscribeFrame> {
        let sessions = lock(&self.sessions);
        let commands = sessions.get(&self.session_id)?;
        if self.sent_version != Some(commands.commands_version) {
            self.sent_version = Some(commands.commands_version);
            self.cursors
                .retain(|command_id, _| commands.index(command_id).is_some());
            return Some(AgentCommandSubscribeFrame::Commands {
                session_id: self.session_id,
                commands: UniqueList::new(commands.running_commands())
                    .expect("a session's rows name each command once"),
            });
        }
        let after = self
            .last_output
            .as_ref()
            .and_then(|command_id| commands.index(command_id))
            .map_or(0, |index| index + 1);
        let count = commands.rows.len();
        let row = (0..count)
            .map(|step| &commands.rows[(after + step) % count])
            .find(|row| {
                let cursor = self
                    .cursors
                    .get(&row.start.command_id)
                    .copied()
                    .unwrap_or(0);
                cursor < row.output.end()
            })?;
        let command_id = row.start.command_id.clone();
        let cursor = self.cursors.get(&command_id).copied().unwrap_or(0);
        let data = row.output.read_from(cursor).to_owned();
        self.cursors.insert(command_id.clone(), row.output.end());
        self.last_output = Some(command_id.clone());
        Some(AgentCommandSubscribeFrame::Output {
            session_id: self.session_id,
            command_id,
            data,
        })
    }
}

/// The next frame `feed` sends through a gate of one credit, failing the test after 5 s.
#[cfg(test)]
pub(crate) async fn next_sent_frame(feed: &mut RunningCommandFeed) -> AgentCommandSubscribeFrame {
    let gate = sidekicks_ipc::stream::feed::CreditGate::with_credit(1);
    tokio::time::timeout(std::time::Duration::from_secs(5), feed.next(&gate))
        .await
        .expect("a frame comes")
        .expect("the feed reads")
        .expect("the feed is open")
}

/// The next set `feed` sends in which `holds` holds, skipping output and every other set.
#[cfg(test)]
pub(crate) async fn next_sent_set_where(
    feed: &mut RunningCommandFeed,
    holds: impl Fn(&[sidekicks_contracts::command::RunningCommand]) -> bool,
) -> Vec<sidekicks_contracts::command::RunningCommand> {
    loop {
        if let AgentCommandSubscribeFrame::Commands { commands, .. } = next_sent_frame(feed).await
            && holds(commands.as_slice())
        {
            return commands.as_slice().to_vec();
        }
    }
}

impl Feed for RunningCommandFeed {
    type Emission = AgentCommandSubscribeFrame;

    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<AgentCommandSubscribeFrame>, HandlerError>> {
        async move {
            loop {
                if gate.ready().await.is_err() {
                    return Ok(None);
                }
                // Marked seen before the read, so a change after it wakes the wait below.
                self.changed.borrow_and_update();
                if let Some(frame) = self.next_frame() {
                    return Ok(Some(frame));
                }
                if self.changed.changed().await.is_err() {
                    return Ok(None);
                }
            }
        }
        .boxed()
    }
}
