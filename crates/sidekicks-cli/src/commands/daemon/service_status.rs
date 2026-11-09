//! The service's status file as the `daemon` commands read it while the service is not answering:
//! why its last start failed, and a stop that did not happen, each in the lines a command prints.

use std::io::{self, Write};
use std::path::Path;

use anyhow::Context as _;
use jiff::{SignedDuration, Timestamp};
use sidekicks_client::service_status::{ServiceStatusReadError, read_service_status};
use sidekicks_contracts::daemon::lifecycle::DAEMON_STOP_DRAIN_BOUND_MS;
use sidekicks_contracts::daemon::service_status::{
    DaemonCannotStart, DaemonCannotStop, DaemonStopping, ServiceStatusFile,
};
use sidekicks_platforms::{daemon_run_folder, pin_identified_process};

use crate::commands::daemon::status::ended_lines;

/// The line over a failed stop's reason.
const COULD_NOT_STOP_LINE: &str = "Could not stop.";

/// The status file in this machine's run folder; `None` where there is none or its bytes do not
/// parse, which a power loss can leave and which writes a warning to `stderr`. Fails as the run
/// folder's lookup, the file's read other than a missing file, or that warning's write does.
pub(crate) fn read_status_file(
    stderr: &mut impl Write,
) -> anyhow::Result<Option<ServiceStatusFile>> {
    let run_folder = daemon_run_folder()
        .context("could not find where the background service records its status")?;
    read_status_file_at(&run_folder.status_path, stderr)
}

/// [`read_status_file`] over the status file at `path`.
pub(crate) fn read_status_file_at(
    path: &Path,
    stderr: &mut impl Write,
) -> anyhow::Result<Option<ServiceStatusFile>> {
    match read_service_status(path) {
        Ok(file) => Ok(file),
        Err(unparsed @ ServiceStatusReadError::Unparsed { .. }) => {
            writeln!(stderr, "warning: {:#}", anyhow::Error::new(unparsed))?;
            Ok(None)
        }
        Err(unread @ ServiceStatusReadError::Read { .. }) => Err(unread.into()),
    }
}

/// Why the service's last start failed, from its status file; `None` where it wrote none or the
/// file holds another fact. Fails as [`read_status_file`] does.
pub(crate) fn read_cannot_start(
    stderr: &mut impl Write,
) -> anyhow::Result<Option<DaemonCannotStart>> {
    Ok(match read_status_file(stderr)? {
        Some(ServiceStatusFile::CannotStart(cannot_start)) => Some(cannot_start),
        Some(ServiceStatusFile::Stopping(_) | ServiceStatusFile::CannotStop(_)) | None => None,
    })
}

/// The reason's lines, each ended by a newline: one sentence, or a title over one line.
pub(crate) fn describe_cannot_start(cannot_start: &DaemonCannotStart) -> String {
    let lines = match cannot_start {
        DaemonCannotStart::ConnectionNameTaken {} => vec![
            "The background service cannot start because another program on this computer is \
             using its connection. Restarting Windows usually clears it."
                .to_owned(),
        ],
        DaemonCannotStart::TurnedOffInLoginItems {} => vec![
            "The background service cannot start because it is turned off in Login Items. Turn \
             it on in System Settings, then it starts on its own."
                .to_owned(),
        ],
        DaemonCannotStart::SavedSessionsUnrepaired { aside_folder } => vec![
            "Saved sessions could not be repaired".to_owned(),
            "Nothing was changed; restore a backup to go on.".to_owned(),
            format!("Folder  {}", aside_folder.as_str()),
        ],
        DaemonCannotStart::SavedSessionsFromAnotherVersion {} => vec![
            "Saved sessions are from another version".to_owned(),
            "Open the app version that saved them, or restore a backup.".to_owned(),
        ],
    };
    ended_lines(&lines)
}

/// Who reads a stop's record: `status`, for which a step within the stop's drain bound is a stop
/// still under way, or `stop`, which waited for its stop to end, so any step still running failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StopRecordReader {
    /// `sidekicks daemon status`.
    Status,
    /// `sidekicks daemon stop`, once its stop ended.
    Stop,
}

/// `Could not stop.` over its reason, each line ended by a newline, where `file` holds a stop that
/// did not happen: a stop that could not keep the person's Stop, whatever its process, or a step
/// still running in the process the record names, for `status` only once past the stop's bound;
/// `None` for any other fact, and for a step whose process has ended. Fails as the process's pin
/// does.
pub(crate) fn describe_failed_stop(
    file: &ServiceStatusFile,
    reader: StopRecordReader,
) -> io::Result<Option<String>> {
    let reason = match file {
        ServiceStatusFile::CannotStart(_) => return Ok(None),
        ServiceStatusFile::CannotStop(DaemonCannotStop::StopIntent {}) => {
            "The background service could not save that you stopped it, so it may resume your \
             sessions when it starts."
                .to_owned()
        }
        ServiceStatusFile::Stopping(stopping) => {
            let is_under_way = reader == StopRecordReader::Status && !is_past_stop_bound(stopping);
            if is_under_way || pin_identified_process(&stopping.process)?.is_none() {
                return Ok(None);
            }
            format!(
                "The background service is still {}.",
                stopping.step.phrase()
            )
        }
    };
    Ok(Some(format!("{COULD_NOT_STOP_LINE}\n{reason}\n")))
}

/// Whether the stop `stopping` records began longer ago than the stop's drain bound; a start that
/// does not read counts as past it.
fn is_past_stop_bound(stopping: &DaemonStopping) -> bool {
    let bound = SignedDuration::from_millis(
        i64::try_from(DAEMON_STOP_DRAIN_BOUND_MS).expect("the drain bound fits 64 bits"),
    );
    stopping
        .stop_started
        .timestamp()
        .is_none_or(|started| Timestamp::now().duration_since(started) >= bound)
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::daemon::service_status::{DaemonCannotStart, ServiceStatusFile};

    use super::read_status_file_at;

    // A status file holding why the last start failed.
    const CANNOT_START: &str = r#"{"cannotStart":{"reason":"savedSessionsFromAnotherVersion"}}"#;

    // A status file holding why the last stop failed.
    const CANNOT_STOP: &str = r#"{"cannotStop":{"reason":"stopIntent"}}"#;

    /// Each fact the status file holds reads as itself, a missing file as none, and a torn or
    /// empty file as none after one warning naming the file. Killed by a torn file failing the
    /// read, and by the warning dropped.
    #[rstest]
    #[case::cannot_start(
        Some(CANNOT_START),
        Some(ServiceStatusFile::CannotStart(
            DaemonCannotStart::SavedSessionsFromAnotherVersion {}
        )),
        false
    )]
    #[case::cannot_stop(
        Some(CANNOT_STOP),
        Some(serde_json::from_str(CANNOT_STOP).expect("a status file")),
        false
    )]
    #[case::torn(CANNOT_START.get(..CANNOT_START.len() / 2), None, true)]
    #[case::empty(Some(""), None, true)]
    #[case::missing(None, None, false)]
    fn the_status_file_reads_its_fact(
        #[case] contents: Option<&str>,
        #[case] expected: Option<ServiceStatusFile>,
        #[case] is_warned: bool,
    ) {
        let folder = tempfile::tempdir().expect("a temporary folder");
        let path = folder.path().join("service-status.json");
        if let Some(contents) = contents {
            std::fs::write(&path, contents).expect("the status file is written");
        }
        let mut stderr = Vec::new();

        let file = read_status_file_at(&path, &mut stderr).expect("the status file's read answers");

        assert_eq!(file, expected);
        let stderr = String::from_utf8(stderr).expect("UTF-8");
        if is_warned {
            assert_eq!(stderr.lines().count(), 1, "{stderr}");
            assert!(
                stderr.starts_with("warning: ") && stderr.contains(&path.display().to_string()),
                "{stderr}"
            );
        } else {
            assert_eq!(stderr, "");
        }
    }
}
