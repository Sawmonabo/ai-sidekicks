//! This process's user's processes, as Linux shows them under `/proc`.

use std::fs;
use std::io;

use nix::unistd::getuid;

// The line of `/proc/<pid>/status` that opens with the process's real, effective, saved and
// file-system user ids.
const USER_IDS_LINE_START: &str = "Uid:";

/// The ids of the processes whose real user id is this process's, each numeric entry of `/proc`
/// whose `status` says so; a process that ends during the walk is left out. Blocks on the reads;
/// fails with the system's error when `/proc` cannot be listed.
pub fn list_user_process_ids() -> io::Result<Vec<u32>> {
    let user_id = getuid().as_raw();
    let mut process_ids = Vec::new();
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(process_id) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        // A process that ended since the listing has no status left to read.
        let Ok(status) = fs::read_to_string(entry.path().join("status")) else {
            continue;
        };
        if real_user_id(&status) == Some(user_id) {
            process_ids.push(process_id);
        }
    }
    Ok(process_ids)
}

// The real user id a process's `status` text names.
fn real_user_id(status: &str) -> Option<u32> {
    status
        .lines()
        .find_map(|line| line.strip_prefix(USER_IDS_LINE_START))?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}
