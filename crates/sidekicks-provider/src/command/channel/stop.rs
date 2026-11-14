//! A command's stop through its wrapper's channel. The processes of the wrapper and of every party
//! under it are pinned when the wrapper is read, before a stop lets any of them go, and the parties
//! under it are stopped innermost first, each level waited for before the level above is sent its
//! `Stop`, so no party's group is killed before the party under it ended a command of its own.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::time::Duration;

use futures::future::try_join_all;
use sidekicks_platforms::PinnedProcess;
use sidekicks_std::mutex_lock::lock;
use tokio::time::Instant;

use super::{CommandChannel, DaemonRequest, PartyId};

/// How long a command's stop waits for the parties under its wrapper to end before the wrapper is
/// sent its own `Stop`, and on Codex for the command's end after it.
pub(crate) const COMMAND_STOP_WAIT: Duration = Duration::from_secs(5);

/// The processes of the parties a command's stop reached, its wrapper and each party under it,
/// pinned at their admission, so a wait on their ends sees nothing of the command left running.
#[derive(Clone, Debug, Default)]
pub struct StoppedCommandParties {
    processes: Vec<PinnedProcess>,
}

impl StoppedCommandParties {
    /// The parties whose processes are `processes`, as a test's stop answers them.
    #[cfg(any(test, feature = "test-support"))]
    pub fn of_processes(processes: Vec<PinnedProcess>) -> Self {
        Self { processes }
    }

    /// The ids of the parties' processes, sorted, for a test to read which parties a stop reached.
    #[cfg(test)]
    pub(crate) fn process_ids(&self) -> Vec<u32> {
        let mut ids: Vec<_> = self.processes.iter().map(PinnedProcess::id).collect();
        ids.sort_unstable();
        ids
    }

    /// Waits for every party's process to end, together and with no bound of its own; an end
    /// before the wait counts. Fails with the system's error when an end cannot be watched.
    pub async fn wait_for_end(&self) -> io::Result<()> {
        try_join_all(self.processes.iter().map(PinnedProcess::wait_for_end)).await?;
        Ok(())
    }
}

/// A command's wrapper and the parties under it, read with their processes pinned, so a party let
/// go before its stop is still waited on.
pub(crate) struct CommandParties {
    wrapper: PartyId,
    wrapper_process: PinnedProcess,
    /// The parties under the wrapper by level, innermost first.
    levels: Vec<Vec<NestedParty>>,
}

// A party under a command's wrapper, as its stop reaches it.
struct NestedParty {
    party: PartyId,
    is_asking: bool,
    process: PinnedProcess,
}

impl CommandChannel {
    /// The wrapper `wrapper` and every party under it, their processes pinned; `None` for a
    /// wrapper not admitted.
    pub(crate) fn read_command_parties(&self, wrapper: PartyId) -> Option<CommandParties> {
        let parties = lock(&self.parties);
        let wrapper_process = parties.get(&wrapper)?.process.clone();
        let mut nested: HashMap<_, _> = parties
            .iter()
            .filter(|(_, party)| party.wrapper == Some(wrapper))
            .map(|(&id, party)| {
                let read = NestedParty {
                    party: id,
                    is_asking: party.is_asking,
                    process: party.process.clone(),
                };
                (id, (party.parent, read))
            })
            .collect();
        let parents: HashMap<_, _> = nested
            .iter()
            .map(|(&id, (parent, _))| (id, *parent))
            .collect();
        let levels = innermost_first(wrapper, &parents)
            .into_iter()
            .map(|level| {
                level
                    .into_iter()
                    .filter_map(|id| nested.remove(&id).map(|(_, read)| read))
                    .collect()
            })
            .collect();
        Some(CommandParties {
            wrapper,
            wrapper_process,
            levels,
        })
    }

    /// Stops the command `parties` names: each level under the wrapper, innermost first, is sent
    /// `Stop`, an askpass the empty answer that alone ends it, and waited on until its processes
    /// ended; then the wrapper is sent its `Stop`. The waits share `wait`, past which the levels
    /// left and the wrapper are sent theirs all the same, which is logged. A party let go meanwhile
    /// is skipped. Answers every pinned process. Fails with a write's or a watch's error.
    pub(crate) async fn stop_command_parties(
        &self,
        parties: CommandParties,
        wait: Duration,
    ) -> io::Result<StoppedCommandParties> {
        let deadline = Instant::now() + wait;
        let mut processes = Vec::new();
        for level in parties.levels {
            for nested in &level {
                let request = if nested.is_asking {
                    DaemonRequest::Answer {
                        text: String::new(),
                    }
                } else {
                    DaemonRequest::Stop {}
                };
                self.send_unless_let_go(nested.party, &request).await?;
            }
            let ends = try_join_all(level.iter().map(|nested| nested.process.wait_for_end()));
            match tokio::time::timeout_at(deadline, ends).await {
                Ok(ended) => {
                    ended?;
                }
                Err(_elapsed) => tracing::warn!(
                    wrapper = parties.wrapper,
                    "the parties under a command's wrapper did not end in time; the stop goes on"
                ),
            }
            processes.extend(level.into_iter().map(|nested| nested.process));
        }
        self.send_unless_let_go(parties.wrapper, &DaemonRequest::Stop {})
            .await?;
        processes.push(parties.wrapper_process);
        Ok(StoppedCommandParties { processes })
    }
}

// The parties under `wrapper` by level, innermost first, each level sorted: a party's level is the
// count of parties between it and the wrapper along `parents`, each party's nearest admitted party
// above it.
fn innermost_first(
    wrapper: PartyId,
    parents: &HashMap<PartyId, Option<PartyId>>,
) -> Vec<Vec<PartyId>> {
    let mut levels: BTreeMap<usize, Vec<PartyId>> = BTreeMap::new();
    for (&party, &parent) in parents {
        let mut level = 0;
        let mut above = parent;
        while let Some(next) = above.filter(|&next| next != wrapper) {
            level += 1;
            above = parents.get(&next).copied().flatten();
        }
        levels.entry(level).or_default().push(party);
    }
    levels
        .into_values()
        .rev()
        .map(|mut level| {
            level.sort_unstable();
            level
        })
        .collect()
}

#[cfg(test)]
mod tests;
