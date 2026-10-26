//! Finds terminal children by the nonce in their environment, for children whose process the
//! daemon never recorded and for descendants that left their parent's tree. A system that shows no
//! other process's environment leaves the search empty, and the registry alone defends there.
//! macOS hides the start environment of its own restricted programs, such as `/bin/zsh`, from the
//! search, so a shell that took its terminal as the daemon died, never recorded, is invisible to
//! it; the `shell` mode's check of the daemon that started it keeps such a shell from starting.

use std::collections::{HashMap, HashSet};
use std::io;

use sidekicks_platforms::{list_user_process_ids, read_process_start};

use crate::pty::orphan::registry::SPAWN_NONCE_ENVIRONMENT_NAME;

/// Reads the environment of each process this user runs, once, and answers which of `nonces`
/// each carries, by process id; empty where the system shows no other process's environment.
/// Blocks on the reads; a process or a listing that cannot be read is logged and skipped.
pub(crate) fn find_processes_carrying_nonces(nonces: &HashSet<&str>) -> HashMap<u32, String> {
    if nonces.is_empty() {
        return HashMap::new();
    }
    match list_user_process_ids() {
        Ok(process_ids) => find_carriers_among(process_ids, nonces, read_carried_nonce),
        Err(error) if error.kind() == io::ErrorKind::Unsupported => HashMap::new(),
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "This user's processes could not be listed, so no terminal child was found by \
                 its nonce."
            );
            HashMap::new()
        }
    }
}

// Which of `nonces` each of `process_ids` carries, as `read` reads it, skipping a process whose
// read fails, as one that exits mid-read does.
fn find_carriers_among(
    process_ids: impl IntoIterator<Item = u32>,
    nonces: &HashSet<&str>,
    read: impl Fn(u32) -> io::Result<Option<String>>,
) -> HashMap<u32, String> {
    let mut carriers = HashMap::new();
    for process_id in process_ids {
        match read(process_id) {
            Ok(Some(nonce)) if nonces.contains(nonce.as_str()) => {
                carriers.insert(process_id, nonce);
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(
                process_id,
                error = &error as &(dyn std::error::Error + 'static),
                "A process's environment could not be read, so it was skipped in the nonce \
                 search."
            ),
        }
    }
    carriers
}

/// The environment entry that carries `nonce`, `NAME=nonce`.
pub(crate) fn carried_nonce_entry(nonce: &str) -> String {
    format!("{SPAWN_NONCE_ENVIRONMENT_NAME}={nonce}")
}

/// The nonce process `process_id`'s environment carries, `None` when it carries none or the
/// system shows none. Blocks on the read; fails with the system's error.
pub(crate) fn read_carried_nonce(process_id: u32) -> io::Result<Option<String>> {
    let prefix = carried_nonce_entry("");
    Ok(read_process_start(process_id)?.and_then(|start| {
        start
            .environment
            .into_iter()
            .find_map(|entry| entry.strip_prefix(&prefix).map(str::to_owned))
    }))
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::io;

    use super::find_carriers_among;

    // Fails when one process's failed read ends the search, as a process exiting between the
    // listing and its read would, so the carriers after it go unfound.
    #[test]
    fn a_process_whose_read_fails_is_skipped_and_the_search_goes_on() {
        let nonces = HashSet::from(["own"]);
        let read = |process_id: u32| match process_id {
            1 => Err(io::Error::other("the process exited mid-read")),
            2 => Ok(Some("another".to_owned())),
            3 => Ok(Some("own".to_owned())),
            _ => Ok(None),
        };

        let carriers = find_carriers_among([1, 2, 3, 4], &nonces, read);

        assert_eq!(carriers, HashMap::from([(3, "own".to_owned())]));
    }
}
