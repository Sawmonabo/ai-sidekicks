//! What every system shares about a pinned process: the record a later process re-pins it from,
//! and the bound on a stop's wait once the process is killed.

use std::io;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::PinnedProcess;
#[cfg(target_os = "linux")]
use crate::linux::pinned_process::pin_recorded;
#[cfg(target_os = "macos")]
use crate::macos::pinned_process::pin_recorded;
#[cfg(target_os = "windows")]
use crate::windows::pinned_process::pin_recorded;

/// How long a pinned process's stop waits for it to end once it is killed, before the stop fails.
pub(crate) const KILL_WAIT_BOUND: Duration = Duration::from_secs(10);

/// What a later process re-pins a process from, kept as JSON: its id and the system's marks of
/// that process's start, which no later process given the same id carries. On macOS its unique id
/// and start time and the boot's UUID; on Linux its start in clock ticks since boot and the boot's
/// id; on Windows its creation time and the name of the job it runs in, a creation time naming one
/// instant across boots.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessRecord {
    pub(crate) id: u32,
    pub(crate) start: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) boot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) job: Option<String>,
}

impl ProcessRecord {
    /// The process's id.
    pub fn id(&self) -> u32 {
        self.id
    }

    /// The process this record names, pinned; `None` when the machine has started again since,
    /// the process has ended, or its id now names another process. Fails with the system's error,
    /// and on macOS with `Unsupported` where the system has no id-checked process read.
    pub fn pin(&self) -> io::Result<Option<PinnedProcess>> {
        pin_recorded(self)
    }
}

#[cfg(test)]
mod tests {
    use crate::{ProcessRecord, pin_child_process};

    // Mutation killed: a re-pin that compares the id alone takes the record with another start.
    #[test]
    fn pinned_process_record_re_pins_the_same_process_and_nothing_else() {
        let mut command = std::process::Command::new(sleeper_program());
        command.args(sleeper_arguments());
        let mut child = command.spawn().expect("the child starts");

        let record = pin_child_process(child.id())
            .expect("the child pins")
            .record()
            .expect("the record reads")
            .expect("the child runs");
        let stored = serde_json::to_string(&record).expect("the record writes as JSON");
        let read: ProcessRecord = serde_json::from_str(&stored).expect("the record reads back");
        let re_pinned = read.pin().expect("the re-pin reads");
        let another_start = ProcessRecord {
            start: record.start + 1,
            ..record.clone()
        };
        let re_pinned_with_another_start = another_start.pin().expect("the re-pin reads");

        child.kill().expect("the test ends its own child");
        child.wait().expect("the child is reaped");
        assert_eq!(re_pinned.map(|process| process.id()), Some(child.id()));
        assert!(re_pinned_with_another_start.is_none());
    }

    #[cfg(unix)]
    fn sleeper_program() -> &'static str {
        "/bin/sleep"
    }

    #[cfg(unix)]
    fn sleeper_arguments() -> &'static [&'static str] {
        &["30"]
    }

    #[cfg(windows)]
    fn sleeper_program() -> &'static str {
        "cmd.exe"
    }

    #[cfg(windows)]
    fn sleeper_arguments() -> &'static [&'static str] {
        &["/d", "/c", "ping -n 30 127.0.0.1 > NUL"]
    }
}
