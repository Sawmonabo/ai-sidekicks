//! The start's sweep over what a previous run of the daemon left in the orphan registry: every
//! child still running from that run is killed with its group and everything under it, and every
//! other entry is discarded. A kill needs proof the process is the child or its own: the recorded
//! process, pinned by its boot, id and start, or the child's nonce in its environment, which a
//! descendant that left the child's tree still carries, read again once the process is pinned. A
//! pinned process is signaled through its pin, so the sweep never kills a stranger.

use std::collections::{HashMap, HashSet};
use std::io;
use std::time::Duration;

use sidekicks_platforms::{PinnedProcess, pin_running_process};
use tokio::task::JoinError;

use crate::pty::orphan::nonce_search::{find_processes_carrying_nonces, read_carried_nonce};
use crate::pty::orphan::registry::OrphanRegistryLeftover;

/// What the sweep did, counted in registry entries.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct OrphanSweepResult {
    /// Entries whose child or a carrier of its nonce was still running and was killed.
    pub(crate) killed: usize,
    /// Entries discarded with nothing signaled.
    pub(crate) discarded: usize,
    /// Why the registry file could not be trusted, when it could not; then nothing was signaled.
    pub(crate) unreadable_cause: Option<String>,
}

impl OrphanSweepResult {
    /// Writes what the sweep did to the service log.
    pub(crate) fn log(&self) {
        match &self.unreadable_cause {
            None => tracing::info!(
                killed = self.killed,
                discarded = self.discarded,
                "The terminal children a previous run left were swept."
            ),
            Some(cause) => tracing::warn!(
                killed = self.killed,
                discarded = self.discarded,
                "The orphan registry was discarded unread because {cause}."
            ),
        }
    }
}

/// Why the sweep could not finish.
#[derive(Debug, thiserror::Error)]
pub(crate) enum OrphanSweepError {
    /// A process could not be read, pinned or killed.
    #[error("a terminal child a previous run left could not be read or killed")]
    Process(#[source] io::Error),
    /// The sweep's blocking task ended before it finished.
    #[error("the orphan sweep ended before it finished")]
    Interrupted(#[source] JoinError),
}

/// Kills each child a previous run left running in the boot `boot_id` and discards every other
/// entry. Fails when a process could not be read or killed, so the start fails rather than skip a
/// child.
pub(crate) async fn sweep_orphans(
    leftover: OrphanRegistryLeftover,
    boot_id: String,
) -> Result<OrphanSweepResult, OrphanSweepError> {
    tokio::task::spawn_blocking(move || sweep(leftover, &boot_id))
        .await
        .map_err(OrphanSweepError::Interrupted)?
        .map_err(OrphanSweepError::Process)
}

fn sweep(leftover: OrphanRegistryLeftover, boot_id: &str) -> io::Result<OrphanSweepResult> {
    let total = leftover.entries.len();
    // A reboot ended every process of the earlier boot, and a process now holding a recorded id is
    // a stranger, so only this boot's entries are looked at.
    let entries: Vec<_> = leftover
        .entries
        .into_iter()
        .filter(|entry| entry.boot_id == boot_id)
        .collect();
    let nonces: HashSet<&str> = entries.iter().map(|entry| entry.nonce.as_str()).collect();
    let carriers: HashMap<u32, String> = find_processes_carrying_nonces(&nonces)?;
    let mut killed = 0;
    for entry in &entries {
        let mut is_killed = false;
        if let Some(record) = &entry.child {
            is_killed = match record.pin()? {
                Some(child) => kill(&child)?,
                // What the child started may still run in the group it led.
                None => record.end_survivors()?,
            };
        }
        for (process_id, nonce) in &carriers {
            if *nonce != entry.nonce {
                continue;
            }
            // Pinned first, so the nonce read next is the pinned process's own.
            let Some(carrier) = pin_running_process(*process_id)? else {
                continue;
            };
            if read_carried_nonce(*process_id)?.as_deref() == Some(entry.nonce.as_str()) {
                is_killed |= kill(&carrier)?;
            }
        }
        killed += usize::from(is_killed);
    }
    Ok(OrphanSweepResult {
        killed,
        discarded: total - killed,
        unreadable_cause: leftover.unreadable_cause,
    })
}

// Kills the process with its group and what it started at once; `true` once it is killed.
fn kill(process: &PinnedProcess) -> io::Result<bool> {
    process.stop(Duration::ZERO)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::process::Stdio;

    use sidekicks_platforms::{
        ProcessRecord, pin_child_process, process_identity, wrap_session_child_command,
    };
    use tokio::process::Command;

    use super::{OrphanSweepResult, sweep_orphans};
    use crate::pty::orphan::registry::{OrphanRegistryEntry, OrphanRegistryLeftover};

    /// A child that waits, leading a session of its own so its kill reaches nothing else.
    const WAITING_CHILD_STAND_IN: &str = "pty::orphan::sweep::tests::a_child_that_waits";

    #[test]
    #[ignore = "run only as the sweep test's child"]
    fn a_child_that_waits() {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }

    fn entry(boot_id: &str, child: ProcessRecord) -> OrphanRegistryLeftover {
        OrphanRegistryLeftover {
            entries: vec![OrphanRegistryEntry {
                nonce: "0123".to_owned(),
                boot_id: boot_id.to_owned(),
                child: Some(child),
            }],
            unreadable_cause: None,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn only_this_boot_s_child_with_its_own_start_is_killed() {
        let mut command = Command::new(std::env::current_exe().expect("the test program is known"));
        command
            .args(["--exact", WAITING_CHILD_STAND_IN, "--include-ignored"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = wrap_session_child_command(command, std::process::id())
            .spawn()
            .expect("the child starts");
        let child_id = child.id().expect("the child has an id");
        let record = pin_child_process(child_id)
            .and_then(|pinned| pinned.record())
            .expect("the child's record is read")
            .expect("the child runs");
        let boot_id = process_identity(std::process::id())
            .expect("this process's identity is read")
            .expect("this process runs")
            .boot_id
            .as_str()
            .to_owned();

        let other_boot = sweep_orphans(entry("another boot", record.clone()), boot_id.clone())
            .await
            .expect("the sweep runs");
        let mut other_start = serde_json::to_value(&record).expect("the record serializes");
        other_start["start"] = serde_json::json!(record_start(&other_start) + 1);
        let other_start: ProcessRecord =
            serde_json::from_value(other_start).expect("the changed record reads");
        let stranger = sweep_orphans(entry(&boot_id, other_start), boot_id.clone())
            .await
            .expect("the sweep runs");
        let is_running_after_both = child.try_wait().expect("the child is read").is_none();
        let own = sweep_orphans(entry(&boot_id, record), boot_id)
            .await
            .expect("the sweep runs");
        let ended = child.wait().await.expect("the child is reaped");

        let discarded = OrphanSweepResult {
            killed: 0,
            discarded: 1,
            unreadable_cause: None,
        };
        assert_eq!(other_boot, discarded);
        assert_eq!(stranger, discarded);
        assert!(
            is_running_after_both,
            "a discarded entry signaled its process"
        );
        assert_eq!(own.killed, 1);
        assert!(!ended.success());
    }

    fn record_start(record: &serde_json::Value) -> u64 {
        record["start"]
            .as_u64()
            .expect("the record names its start")
    }
}
