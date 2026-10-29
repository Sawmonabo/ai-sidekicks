//! The service's login agent on macOS: a property list in `~/Library/LaunchAgents` named for the
//! service's launchd label, loaded into the person's login session through `/bin/launchctl`. Only
//! `launchctl`'s exit status is read, never its printed text, which Apple says is no interface.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::app_identity::DAEMON_LAUNCHD_LABEL;
use sidekicks_contracts::daemon::lifecycle::DAEMON_STOP_DRAIN_BOUND_MS;

use crate::service_registration::{ServiceInstall, ServiceOwner, ServiceRegistrationError};
use crate::{LeftoverSweep, current_user_id, replace_file_atomically};

// The service manager, by its full path so no `PATH` entry stands in for it.
const LAUNCHCTL_PROGRAM: &str = "/bin/launchctl";

// The agent's list is the person's, and launchd refuses one that others can write.
const AGENT_LIST_MODE: u32 = 0o644;

// How long an uninstall waits before its one retry of a removal launchd answers is still running.
const BUSY_RETRY_DELAY: Duration = Duration::from_secs(1);

// The time past the stop's drain that launchd leaves the service to close and exit before it
// kills it.
const EXIT_MARGIN_SECONDS: u64 = 2;

/// How long launchd leaves the service to exit after asking it to stop before it kills it: the
/// stop's whole drain, in whole seconds, and the margin past it.
pub(crate) const EXIT_TIME_OUT_SECONDS: u64 =
    DAEMON_STOP_DRAIN_BOUND_MS.div_ceil(1_000) + EXIT_MARGIN_SECONDS;

/// The service's login agent on this Mac, for the user running this process.
#[derive(Clone, Copy, Debug)]
pub struct ServiceRegistration {
    user_id: u32,
}

/// The service's login agent for the user running this process; `None` only where the system
/// gives the process no user id, which macOS always gives.
pub fn service_registration() -> Option<ServiceRegistration> {
    current_user_id().map(|user_id| ServiceRegistration { user_id })
}

// The agent's property list, as launchd reads it.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AgentList {
    label: String,
    program_arguments: Vec<PathBuf>,
    run_at_load: bool,
    exit_time_out: u64,
}

impl AgentList {
    // The list that starts `daemon_program` with no arguments at login, never restarted by launchd
    // after it exits, and given the stop's whole drain before launchd kills it.
    fn naming(daemon_program: &Path) -> Self {
        Self {
            label: DAEMON_LAUNCHD_LABEL.to_owned(),
            program_arguments: vec![daemon_program.to_owned()],
            run_at_load: true,
            exit_time_out: EXIT_TIME_OUT_SECONDS,
        }
    }
}

impl ServiceRegistration {
    /// Which registration starts the service at login: the command line's when its own list is
    /// in `~/Library/LaunchAgents`, else the app's when launchd has the label loaded in this
    /// user's login session, else none. Fails when the list's folder or `launchctl` cannot be
    /// read.
    pub fn owner(&self) -> Result<ServiceOwner, ServiceRegistrationError> {
        let path = agent_list_path()?;
        let has_own_list = path
            .try_exists()
            .map_err(|source| ServiceRegistrationError::Read { path, source })?;
        if has_own_list {
            return Ok(ServiceOwner::CommandLine);
        }
        Ok(if self.is_loaded()? {
            ServiceOwner::App
        } else {
            ServiceOwner::None
        })
    }

    /// Installs the command line's login agent starting `daemon_program`: the list written through
    /// a temporary file renamed into place, then `launchctl enable` and `bootstrap` into the
    /// login session, which starts the service. A list naming another program is booted out and
    /// rewritten first; with no one logged in at the screen only the list is written. The caller
    /// has read the owner first. Fails with the step that failed and its cause.
    pub fn install(
        &self,
        daemon_program: &Path,
    ) -> Result<ServiceInstall, ServiceRegistrationError> {
        let path = agent_list_path()?;
        let list = AgentList::naming(daemon_program);
        let written: Option<AgentList> = read_launchd_list(&path)?;
        let is_current = written.as_ref() == Some(&list);
        if is_current && self.is_loaded()? {
            return Ok(ServiceInstall::Unchanged);
        }
        if !is_current {
            if written.is_some() {
                self.boot_out()?;
            }
            write_agent_list(&path, &list)?;
        }
        if !self.has_screen_session()? {
            return Ok(ServiceInstall::AtNextLogin);
        }
        // A label the person once turned off stays refused by `bootstrap` until it is enabled.
        run_launchctl("enable", ["enable", &self.service_target()])?.succeeded("enable")?;
        let domain_target = self.domain_target();
        let arguments = [
            OsStr::new("bootstrap"),
            OsStr::new(&domain_target),
            path.as_os_str(),
        ];
        run_launchctl("bootstrap", arguments)?.succeeded("bootstrap")?;
        Ok(ServiceInstall::Loaded)
    }

    /// Starts the registered service in the login session; a running one is left running. Fails
    /// with `launchctl kickstart`'s exit status when it refuses, as it does for an agent that is
    /// not loaded or is turned off.
    pub fn kickstart(&self) -> Result<(), ServiceRegistrationError> {
        run_launchctl("kickstart", ["kickstart", &self.service_target()])?.succeeded("kickstart")
    }

    /// Removes the command line's login agent: `launchctl bootout --wait`, which waits for the
    /// service to exit, retried once a second later when launchd answers that a removal is still
    /// running, then the list deleted. Fails with the step that failed and its cause.
    pub fn uninstall(&self) -> Result<(), ServiceRegistrationError> {
        self.boot_out()?;
        let path = agent_list_path()?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            // Gone already, so the goal holds.
            Err(missing) if missing.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(ServiceRegistrationError::Remove { path, source }),
        }
    }

    /// Whether a person is logged in at this Mac's screen, read from whether this user's login
    /// session exists in launchd. Fails when `launchctl` cannot start.
    pub fn has_screen_session(&self) -> Result<bool, ServiceRegistrationError> {
        let domain_target = self.domain_target();
        Ok(run_launchctl("print", ["print", &domain_target])?
            .status
            .success())
    }

    // Whether launchd has the label loaded in this user's login session, whichever list it came
    // from.
    fn is_loaded(&self) -> Result<bool, ServiceRegistrationError> {
        let service_target = self.service_target();
        Ok(run_launchctl("print", ["print", &service_target])?
            .status
            .success())
    }

    // Unloads the agent and waits for the service to exit, so a `bootstrap` after it cannot race
    // the exit. An agent that is not loaded, such as one whose list was written while no one was
    // at the screen, is already out.
    fn boot_out(&self) -> Result<(), ServiceRegistrationError> {
        let service_target = self.service_target();
        let arguments = ["bootout", "--wait", service_target.as_str()];
        let mut answer = run_launchctl("bootout", arguments)?;
        if answer.status.code() == Some(libc::EINPROGRESS) {
            thread::sleep(BUSY_RETRY_DELAY);
            answer = run_launchctl("bootout", arguments)?;
        }
        if answer.status.code() == Some(libc::ESRCH) {
            return Ok(());
        }
        answer.succeeded("bootout")
    }

    // This user's login session in launchd.
    fn domain_target(&self) -> String {
        format!("gui/{}", self.user_id)
    }

    // The service's label in this user's login session.
    fn service_target(&self) -> String {
        format!("gui/{}/{DAEMON_LAUNCHD_LABEL}", self.user_id)
    }
}

// What one `launchctl` run answered.
struct LaunchctlAnswer {
    status: std::process::ExitStatus,
    stderr: Vec<u8>,
}

impl LaunchctlAnswer {
    // Ok when `launchctl` exited 0, else its refusal of `step` with its status and error text.
    fn succeeded(self, step: &'static str) -> Result<(), ServiceRegistrationError> {
        if self.status.success() {
            return Ok(());
        }
        Err(ServiceRegistrationError::Refused {
            step,
            status: self.status,
            message: String::from_utf8_lossy(&self.stderr).trim().to_owned(),
        })
    }
}

// Runs `launchctl` with `arguments` for `step` and waits for it, its output dropped and its error
// stream kept for a refusal.
fn run_launchctl(
    step: &'static str,
    arguments: impl IntoIterator<Item = impl AsRef<OsStr>>,
) -> Result<LaunchctlAnswer, ServiceRegistrationError> {
    let Output { status, stderr, .. } = Command::new(LAUNCHCTL_PROGRAM)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|source| ServiceRegistrationError::Start { step, source })?;
    Ok(LaunchctlAnswer { status, stderr })
}

// The command line's own list: `~/Library/LaunchAgents/<label>.plist`.
fn agent_list_path() -> Result<PathBuf, ServiceRegistrationError> {
    let home = std::env::home_dir().ok_or(ServiceRegistrationError::NoHomeFolder)?;
    Ok(home
        .join("Library/LaunchAgents")
        .join(format!("{DAEMON_LAUNCHD_LABEL}.plist")))
}

/// The launchd property list at `path`, or `None` when no file is there. Fails when the file
/// cannot be read or is not such a list.
pub(crate) fn read_launchd_list<T: DeserializeOwned>(
    path: &Path,
) -> Result<Option<T>, ServiceRegistrationError> {
    let read_failure = |source: io::Error| ServiceRegistrationError::Read {
        path: path.to_owned(),
        source,
    };
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(missing) if missing.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(read_failure(source)),
    };
    plist::from_bytes(&bytes)
        .map(Some)
        .map_err(|source| read_failure(io::Error::new(io::ErrorKind::InvalidData, source)))
}

// Writes `list` to `path` through a temporary file renamed over it, making the folder first, which
// a new account lacks.
fn write_agent_list(path: &Path, list: &AgentList) -> Result<(), ServiceRegistrationError> {
    let write_failure = |source: io::Error| ServiceRegistrationError::Write {
        path: path.to_owned(),
        source,
    };
    let contents = launchd_list_bytes(list).map_err(write_failure)?;
    let folder = path
        .parent()
        .expect("the agent's list path ends in a file name");
    fs::create_dir_all(folder).map_err(write_failure)?;
    replace_file_atomically(path, &contents, AGENT_LIST_MODE, LeftoverSweep::Unswept)
        .map_err(|source| write_failure(io::Error::other(source)))
}

/// `list` as the XML property list launchd reads. Fails when a value has no property-list form.
pub(crate) fn launchd_list_bytes(list: &impl Serialize) -> io::Result<Vec<u8>> {
    let mut contents = Vec::new();
    plist::to_writer_xml(&mut contents, list)
        .map_err(|source| io::Error::new(io::ErrorKind::InvalidInput, source))?;
    Ok(contents)
}
