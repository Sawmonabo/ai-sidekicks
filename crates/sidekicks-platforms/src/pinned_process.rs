//! What every system shares about a pinned process: the record a later process re-pins it from,
//! and the bound on a stop's wait once the process is killed.

use std::io;
use std::time::Duration;

use serde::{Deserialize, Deserializer, Serialize};

use crate::PinnedProcess;
#[cfg(target_os = "linux")]
use crate::linux::pinned_process::{end_recorded_survivors, pin_recorded};
#[cfg(target_os = "macos")]
use crate::macos::pinned_process::{end_recorded_survivors, pin_recorded};
#[cfg(target_os = "windows")]
use crate::windows::pinned_process::{end_recorded_survivors, pin_recorded};

/// How long a pinned process's stop waits for it to end once it is killed, before the stop fails.
pub(crate) const KILL_WAIT_BOUND: Duration = Duration::from_secs(10);

/// What a later process re-pins a process from, kept as JSON: its id and the system's marks of
/// that process's start, which no later process given the same id carries (on macOS its unique id,
/// start time and boot UUID; on Linux its start in clock ticks since boot and the boot's id; on
/// Windows its creation time, one instant across boots, the boot's instant and its job's name).
/// The process's exit never ends the group it leads or the job it runs in, so what it started is
/// ended by its stop, or through the record once it is gone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessRecord {
    /// The process's id, never 0.
    #[serde(deserialize_with = "deserialize_process_id")]
    pub(crate) id: u32,
    /// The system's fixed mark of the process: its unique id on macOS, its start in clock ticks
    /// since boot on Linux, its creation time on Windows.
    pub(crate) start: u64,
    /// Its start time in microseconds since the epoch, on macOS; `None` elsewhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) started_at: Option<u64>,
    /// The boot it started in: macOS's boot session UUID, Linux's boot id, Windows' boot instant.
    pub(crate) boot: String,
    /// The name of the job of its own a lasting child runs in, on Windows; `None` elsewhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) job: Option<String>,
}

impl ProcessRecord {
    /// The process's id.
    pub fn id(&self) -> u32 {
        self.id
    }

    /// The process this record names, pinned; `None` when the machine has started again since,
    /// the process has ended, or its id now names another process, and then what it started may
    /// still run, which [`Self::end_survivors`] ends. Fails with the system's error, on macOS with
    /// `Unsupported` where the system has no id-checked process read, and on Windows with
    /// `InvalidData` for a job name no lasting child is given or a job that does not hold its
    /// running process.
    pub fn pin(&self) -> io::Result<Option<PinnedProcess>> {
        pin_recorded(self)
    }

    /// Ends what the record's process started that outlived it, for a record [`Self::pin`]
    /// answered `None` for, before a fresh lasting child is started: on Windows what is left in the
    /// job the record names, on macOS and Linux the group the process led, on its boot, while no
    /// process holds its id and every member is in its session and started no earlier than it;
    /// `true` when something was ended.
    /// Fails with the system's error, on macOS with `Unsupported` where the system has no
    /// id-checked process read, and on Windows with `InvalidData` for a job name no lasting child
    /// is given.
    pub fn end_survivors(&self) -> io::Result<bool> {
        end_recorded_survivors(self)
    }
}

// A record's process id; refuses 0, which names no process.
fn deserialize_process_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let id = u32::deserialize(deserializer)?;
    if id == 0 {
        return Err(serde::de::Error::custom(
            "the record's id 0 names no process",
        ));
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use crate::{ProcessRecord, pin_child_process};

    // Fails when a record naming the id 0, which no process has, reads as a process to re-pin.
    #[test]
    fn pinned_process_record_refuses_the_id_0() {
        let zero = serde_json::from_str::<ProcessRecord>(r#"{"id":0,"start":1}"#);
        let one = serde_json::from_str::<ProcessRecord>(r#"{"id":1,"start":1}"#);

        assert!(
            zero.is_err_and(|error| error.to_string().contains("names no process")),
            "the id 0 reads"
        );
        assert_eq!(one.map(|record| record.id).ok(), Some(1));
    }

    // Fails when a re-pin compares the id alone, or leaves out the start time or the boot, which
    // takes a record of another process or another boot.
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
        let others = [
            ProcessRecord {
                start: record.start + 1,
                ..record.clone()
            },
            ProcessRecord {
                started_at: Some(record.started_at.map_or(1, |started_at| started_at + 1)),
                ..record.clone()
            },
            ProcessRecord {
                boot: format!("{}-another", record.boot),
                ..record
            },
        ];
        let re_pinned_others = others
            .iter()
            .map(|other| other.pin().expect("the re-pin reads").is_some())
            .collect::<Vec<_>>();

        child.kill().expect("the test ends its own child");
        child.wait().expect("the child is reaped");
        assert_eq!(re_pinned.map(|process| process.id()), Some(child.id()));
        assert_eq!(re_pinned_others, [false, false, false]);
    }

    // Fails when a record ends a group without checking each member's start, or while a process
    // holds its id, or on another boot, any of which kills a group the record does not name; or
    // leaves the group of its ended process running, whose output then stays open.
    #[cfg(unix)]
    #[test]
    fn pinned_process_record_ends_the_survivors_of_its_ended_process() {
        use std::time::Duration;

        use crate::posix::process::group::read_group_output_to_end;

        let (mut child, mut output, record) = start_group_leader(true);
        let is_held_group_ended = ProcessRecord {
            start: 0,
            ..record.clone()
        }
        .end_survivors()
        .expect("the held record's survivors read");
        let is_running = record.pin().expect("the re-pin reads").is_some();
        drop(child.stdin.take());
        child.wait().expect("the child is reaped");

        let refusals = [
            ProcessRecord {
                start: u64::MAX,
                ..record.clone()
            },
            ProcessRecord {
                boot: "another".to_owned(),
                ..record.clone()
            },
        ]
        .map(|other| {
            other
                .end_survivors()
                .expect("the other record's survivors read")
        });
        let is_re_pinned = record.pin().expect("the re-pin reads").is_some();
        let is_group_ended = record.end_survivors().expect("the survivors end");
        let rest = read_group_output_to_end(&mut output, record.id, Duration::from_secs(5));

        assert!(!is_held_group_ended);
        assert!(is_running);
        assert_eq!(refusals, [false, false]);
        assert!(!is_re_pinned);
        assert!(is_group_ended);
        assert_eq!(rest, Some(Vec::new()));
    }

    // Fails when a record ends a group without checking each member's session, which kills a
    // group in another session, here the test's own.
    #[cfg(unix)]
    #[test]
    fn pinned_process_record_leaves_a_group_of_another_session() {
        use std::time::Duration;

        use nix::sys::signal::Signal;

        use crate::posix::process::group::{read_group_output_to_end, signal_group};

        let (mut child, mut output, record) = start_group_leader(false);
        drop(child.stdin.take());
        child.wait().expect("the child is reaped");

        let is_group_ended = record.end_survivors().expect("the survivors read");
        signal_group(record.id, Signal::SIGKILL).expect("the test ends its own child's group");
        let rest = read_group_output_to_end(&mut output, record.id, Duration::from_secs(5));

        assert!(!is_group_ended);
        assert_eq!(rest, Some(Vec::new()));
    }

    // A shell that leads a group of its own, in a session of its own when `is_own_session`, and
    // leaves a child sleeping a minute; answered once it is ready, with its output and record.
    #[cfg(unix)]
    fn start_group_leader(
        is_own_session: bool,
    ) -> (
        std::process::Child,
        std::process::ChildStdout,
        ProcessRecord,
    ) {
        use std::io::Read as _;
        use std::os::unix::process::CommandExt as _;
        use std::process::Stdio;

        use crate::posix::child_command::prepare_lasting_child_command;

        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args([
                "-c",
                "(/bin/sleep 60; echo outlived) & echo ready; read never",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if is_own_session {
            prepare_lasting_child_command(&mut command);
        } else {
            command.as_std_mut().process_group(0);
        }
        let mut child = command.as_std_mut().spawn().expect("the child starts");
        let mut output = child.stdout.take().expect("the child's output is piped");
        let mut ready = [0; 6];
        output
            .read_exact(&mut ready)
            .expect("the child's line reads");
        assert_eq!(&ready, b"ready\n");
        let record = pin_child_process(child.id())
            .expect("the child pins")
            .record()
            .expect("the record reads")
            .expect("the child runs");
        (child, output, record)
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
