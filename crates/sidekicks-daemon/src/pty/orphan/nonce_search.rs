//! Finds terminal children by the nonce in their environment, for children whose process the
//! daemon never recorded and for descendants that left their parent's tree. A system that shows no
//! other process's environment leaves the search empty, and the registry alone defends there.
//! macOS hides the start environment of its own restricted programs, such as `/bin/zsh`, from the
//! search, so a shell that took its terminal as the daemon died, never recorded, is invisible to
//! it; the `shell` mode's check of the daemon that started it keeps such a shell from starting.

use std::collections::{HashMap, HashSet};
use std::io;

use sidekicks_platforms::{list_user_process_ids, read_process_environment};

use crate::pty::orphan::registry::SPAWN_NONCE_ENVIRONMENT_NAME;

/// Reads the environment of each process this user runs, once, and answers which of `nonces`
/// each carries, by process id; empty where the system shows no other process's environment.
/// Blocks on the reads; fails with the system's error.
pub(crate) fn find_processes_carrying_nonces(
    nonces: &HashSet<&str>,
) -> io::Result<HashMap<u32, String>> {
    let mut carriers = HashMap::new();
    if nonces.is_empty() {
        return Ok(carriers);
    }
    let process_ids = match list_user_process_ids() {
        Ok(process_ids) => process_ids,
        Err(error) if error.kind() == io::ErrorKind::Unsupported => return Ok(carriers),
        Err(error) => return Err(error),
    };
    for process_id in process_ids {
        if let Some(nonce) = read_carried_nonce(process_id)?
            && nonces.contains(nonce.as_str())
        {
            carriers.insert(process_id, nonce);
        }
    }
    Ok(carriers)
}

/// The nonce process `process_id`'s environment carries, `None` when it carries none or the
/// system shows none. Blocks on the read; fails with the system's error.
pub(crate) fn read_carried_nonce(process_id: u32) -> io::Result<Option<String>> {
    let prefix = format!("{SPAWN_NONCE_ENVIRONMENT_NAME}=");
    Ok(
        read_process_environment(process_id)?.and_then(|environment| {
            environment
                .into_iter()
                .find_map(|entry| entry.strip_prefix(&prefix).map(str::to_owned))
        }),
    )
}
