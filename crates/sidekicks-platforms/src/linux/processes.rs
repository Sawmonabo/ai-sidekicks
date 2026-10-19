//! This process's user's processes and a process's environment, as Linux shows them under
//! `/proc`.

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

/// The environment process `process_id` started with, one `NAME=value` entry each, bytes that are
/// not UTF-8 read lossily; `None` when the system refuses the read because the process ended or
/// another user runs it. Blocks on the read; fails with the system's error on any other refusal.
pub fn read_process_environment(process_id: u32) -> io::Result<Option<Vec<String>>> {
    match fs::read(format!("/proc/{process_id}/environ")) {
        Ok(bytes) => Ok(Some(
            bytes
                .split(|byte| *byte == 0)
                .filter(|entry| !entry.is_empty())
                .map(|entry| String::from_utf8_lossy(entry).into_owned())
                .collect(),
        )),
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::EACCES | libc::ENOENT | libc::ESRCH)
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
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

#[cfg(test)]
mod tests {
    use super::{list_user_process_ids, read_process_environment};

    #[test]
    fn this_process_is_listed_and_its_environment_read_back() {
        let own_id = std::process::id();

        let listed = list_user_process_ids().expect("the processes are listed");
        let environment = read_process_environment(own_id)
            .expect("the environment is read")
            .expect("this process's environment is shown");

        assert!(listed.contains(&own_id), "{listed:?}");
        let path = std::env::var("PATH").expect("the test runs with a PATH");
        assert!(
            environment.contains(&format!("PATH={path}")),
            "{environment:?}"
        );
    }
}
