//! The service's login agent on macOS: a property list in `~/Library/LaunchAgents` named for the
//! service's launchd label, loaded into the person's login session through `/bin/launchctl`, and
//! whether the person turned it off in the login items. Only `launchctl`'s exit status is read,
//! never its printed text, which Apple says is no interface. Under `sudo` every step acts for the
//! account that ran `sudo`: its user id from `SUDO_UID` and its home from the user database, since
//! `sudo` may keep or replace `HOME`.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::Duration;

use nix::unistd::{Uid, User, chown, geteuid};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::app_identity::DAEMON_LAUNCHD_LABEL;
use sidekicks_contracts::daemon::lifecycle::{DAEMON_KILL_GRACE_MS, DAEMON_STOP_DRAIN_BOUND_MS};

use crate::macos::login_items::{LoginItemStatus, LoginItemStatusError, read_login_item_status};
use crate::service_registration::{ServiceInstall, ServiceOwner, ServiceRegistrationError};
use crate::{LeftoverSweep, current_user_id, replace_file_atomically};

// The service manager, by its full path so no `PATH` entry stands in for it.
const LAUNCHCTL_PROGRAM: &str = "/bin/launchctl";

// The program a run with root's rights starts a program as the account through, by its full path.
const SUDO_PROGRAM: &str = "/usr/bin/sudo";

/// The folder launchd reads the system domain's property lists from.
pub(crate) const SYSTEM_LIST_FOLDER: &str = "/Library/LaunchDaemons";

// The agent's list is the person's, and launchd refuses one that others can write.
const AGENT_LIST_MODE: u32 = 0o644;

// How long an uninstall waits before its one retry of a removal launchd answers is still running.
const BUSY_RETRY_DELAY: Duration = Duration::from_secs(1);

/// How long launchd leaves the service to exit after asking it to stop before it kills it: the
/// stop's whole drain and the kill grace past it, in whole seconds.
pub(crate) const EXIT_TIME_OUT_SECONDS: u64 =
    (DAEMON_STOP_DRAIN_BOUND_MS + DAEMON_KILL_GRACE_MS).div_ceil(1_000);

/// The service's login agent on this Mac, for the account this run acts for.
#[derive(Clone, Copy, Debug)]
pub struct ServiceRegistration {
    // The account's user id, 0 when a run with root's rights names no other account.
    user_id: u32,
    runs_as_root: bool,
}

/// The service's login agent for the account this run acts for: the user running this process,
/// or with root's rights the account `SUDO_UID` names; `None` only where the system gives the
/// process no user id, which macOS always gives.
pub fn service_registration() -> Option<ServiceRegistration> {
    let runs_as_root = geteuid().is_root();
    let user_id = if runs_as_root {
        std::env::var_os("SUDO_UID")
            .and_then(|value| value.to_str()?.parse::<u32>().ok())
            .unwrap_or(0)
    } else {
        current_user_id()?
    };
    Some(ServiceRegistration {
        user_id,
        runs_as_root,
    })
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
    /// Which registration starts the service at login: none when `$HOME` is not the account's
    /// home in the user database, since the agent's service runs with that home and listens under
    /// it, a check skipped under root's rights; else the command line's when its own list is in
    /// the account's `Library/LaunchAgents`, else the app's when launchd has the label loaded in
    /// the account's login session, else none. Fails when the user database, the list's folder or
    /// `launchctl` cannot be read.
    pub fn owner(&self) -> Result<ServiceOwner, ServiceRegistrationError> {
        if !self.is_account_home()? {
            return Ok(ServiceOwner::None);
        }
        let path = self.agent_list_path()?;
        let has_own_list = path
            .try_exists()
            .map_err(|source| ServiceRegistrationError::Read { path, source })?;
        if has_own_list {
            return Ok(ServiceOwner::CommandLine);
        }
        Ok(if self.is_agent_loaded()? {
            ServiceOwner::App
        } else {
            ServiceOwner::None
        })
    }

    /// Installs the command line's login agent starting `daemon_program`: the list written through
    /// a temporary file renamed into place, then `launchctl enable` and `bootstrap` into the
    /// login session, which starts the service. A list naming another program is booted out and
    /// rewritten first; with no one logged in at the screen only the list is written. Under root's
    /// rights the list, and a folder it makes, are handed to the account. The caller has read the
    /// owner first. Fails with the step that failed and its cause.
    pub fn install(
        &self,
        daemon_program: &Path,
    ) -> Result<ServiceInstall, ServiceRegistrationError> {
        let path = self.agent_list_path()?;
        let list = AgentList::naming(daemon_program);
        let written: Option<AgentList> = read_launchd_list(&path)?;
        let is_current = written.as_ref() == Some(&list);
        if is_current && self.is_agent_loaded()? {
            return Ok(ServiceInstall::Unchanged);
        }
        if !is_current {
            if written.is_some() {
                self.boot_out_agent()?;
            }
            self.write_agent_list(&path, &list)?;
        }
        if !self.has_screen_session()? {
            return Ok(ServiceInstall::AtNextLogin);
        }
        // A label the person once turned off stays refused by `bootstrap` until it is enabled.
        run_launchctl("enable", ["enable", &self.service_target()?])?.succeeded("enable")?;
        let domain_target = self.domain_target()?;
        let arguments = [
            OsStr::new("bootstrap"),
            OsStr::new(&domain_target),
            path.as_os_str(),
        ];
        run_launchctl("bootstrap", arguments)?.succeeded("bootstrap")?;
        Ok(ServiceInstall::Loaded)
    }

    /// The program the command line's own login agent starts, read from its list; `None` with no
    /// list. Fails when the list cannot be read.
    pub fn agent_program(&self) -> Result<Option<PathBuf>, ServiceRegistrationError> {
        let written: Option<AgentList> = read_launchd_list(&self.agent_list_path()?)?;
        Ok(written.and_then(|list| list.program_arguments.into_iter().next()))
    }

    /// Whether the person turned the command line's own login agent off in Login Items, which
    /// launchd does not honor when asked to start it, so a start reads it first. Blocks on the
    /// system's answer. Fails when the list's folder cannot be read, and with
    /// [`ServiceRegistrationError::UnknownLoginItemStatus`] on a status this build does not know.
    pub fn is_turned_off(&self) -> Result<bool, ServiceRegistrationError> {
        let path = self.agent_list_path()?;
        match read_login_item_status(&path) {
            Ok(status) => Ok(status == LoginItemStatus::TurnedOff),
            Err(LoginItemStatusError::File(source)) => {
                Err(ServiceRegistrationError::Read { path, source })
            }
            Err(LoginItemStatusError::UnknownStatus { value }) => {
                Err(ServiceRegistrationError::UnknownLoginItemStatus { value })
            }
        }
    }

    /// Starts the registered service in the login session; a running one is left running. Fails
    /// with `launchctl kickstart`'s exit status when it refuses, as it does for an agent that is
    /// not loaded or is turned off.
    pub fn kickstart(&self) -> Result<(), ServiceRegistrationError> {
        run_launchctl("kickstart", ["kickstart", &self.service_target()?])?.succeeded("kickstart")
    }

    /// Removes the command line's login agent: `launchctl bootout --wait`, which waits for the
    /// service to exit, retried once a second later when launchd answers that a removal is still
    /// running, then the list deleted. Fails with the step that failed and its cause.
    pub fn uninstall(&self) -> Result<(), ServiceRegistrationError> {
        self.boot_out_agent()?;
        let path = self.agent_list_path()?;
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
        let domain_target = self.domain_target()?;
        Ok(run_launchctl("print", ["print", &domain_target])?
            .status
            .success())
    }

    /// Whether this run has root's rights, as under `sudo`, so the system service is installed and
    /// removed directly, with no administrator password prompt.
    pub fn runs_as_root(&self) -> bool {
        self.runs_as_root
    }

    /// The account's home folder, where its agent's list and the service's data folder live: from
    /// the user database under root's rights, since `sudo` may keep or replace `HOME`, else
    /// `$HOME`. Fails with [`ServiceRegistrationError::NoInvokingAccount`] under root's rights
    /// with no account named, and when the home cannot be read.
    pub fn account_home(&self) -> Result<PathBuf, ServiceRegistrationError> {
        if self.runs_as_root {
            return Ok(self.account()?.dir);
        }
        std::env::home_dir().ok_or(ServiceRegistrationError::NoHomeFolder)
    }

    /// Whether launchd has the label loaded in the account's login session, whichever list it
    /// came from. Fails when `launchctl` cannot start, and with
    /// [`ServiceRegistrationError::NoInvokingAccount`] under root's rights with no account named.
    pub fn is_agent_loaded(&self) -> Result<bool, ServiceRegistrationError> {
        let service_target = self.service_target()?;
        Ok(run_launchctl("print", ["print", &service_target])?
            .status
            .success())
    }

    /// Unloads the agent from the account's login session and waits for the service to exit, so a
    /// `bootstrap` after it cannot race the exit; an agent that is not loaded, such as one whose
    /// list was written while no one was at the screen, is already out. Fails with `launchctl`'s
    /// refusal, and as [`Self::is_agent_loaded`] fails.
    pub fn boot_out_agent(&self) -> Result<(), ServiceRegistrationError> {
        let service_target = self.service_target()?;
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

    /// The command that runs `program` as the account: under root's rights through
    /// `/usr/bin/sudo -H -u #<user id> --`, which sets the account's home, its groups and a clean
    /// environment, so what the program writes in the home is the account's; otherwise `program`
    /// itself. Fails with [`ServiceRegistrationError::NoInvokingAccount`] under root's rights with
    /// no account named.
    pub fn account_command(&self, program: &Path) -> Result<Command, ServiceRegistrationError> {
        if !self.runs_as_root {
            return Ok(Command::new(program));
        }
        let mut command = Command::new(SUDO_PROGRAM);
        command
            .args(["-H", "-u"])
            .arg(format!("#{}", self.account_user_id()?))
            .arg("--")
            .arg(program);
        Ok(command)
    }

    /// The account's entry in the user database. Fails with
    /// [`ServiceRegistrationError::NoInvokingAccount`] under root's rights with no account named
    /// or one with no entry, and with [`ServiceRegistrationError::Account`] when the database
    /// cannot be read or has no entry for this run's own account.
    pub(crate) fn account(self) -> Result<User, ServiceRegistrationError> {
        User::from_uid(Uid::from_raw(self.account_user_id()?))
            .map_err(|errno| ServiceRegistrationError::Account {
                source: io::Error::from(errno),
            })?
            .ok_or_else(|| {
                if self.runs_as_root {
                    return ServiceRegistrationError::NoInvokingAccount;
                }
                ServiceRegistrationError::Account {
                    source: io::Error::new(
                        io::ErrorKind::NotFound,
                        "the account has no entry in the user database",
                    ),
                }
            })
    }

    // The account's user id; root's own is never one, so a run with root's rights that names no
    // other account refuses every step that acts for the account.
    fn account_user_id(self) -> Result<u32, ServiceRegistrationError> {
        if self.user_id == 0 {
            return Err(ServiceRegistrationError::NoInvokingAccount);
        }
        Ok(self.user_id)
    }

    /// Whether `$HOME` is this account's home in the user database, so a run under a private home
    /// never reads, starts, writes or removes the account's own agent, whose service could never
    /// answer it there. Under root's rights the home is the account's own by construction. Fails
    /// when `$HOME` or the user database cannot be read.
    pub fn is_account_home(&self) -> Result<bool, ServiceRegistrationError> {
        if self.runs_as_root {
            return Ok(true);
        }
        let home = std::env::home_dir().ok_or(ServiceRegistrationError::NoHomeFolder)?;
        Ok(home == self.account()?.dir)
    }

    // The command line's own list: `<home>/Library/LaunchAgents/<label>.plist`.
    fn agent_list_path(self) -> Result<PathBuf, ServiceRegistrationError> {
        Ok(self
            .account_home()?
            .join("Library/LaunchAgents")
            .join(format!("{DAEMON_LAUNCHD_LABEL}.plist")))
    }

    // Writes `list` to `path` through a temporary file renamed over it, making the folder first,
    // which a new account lacks. Under root's rights the list and a folder made here are handed to
    // the account, so no file of root's is left in its home.
    fn write_agent_list(
        self,
        path: &Path,
        list: &AgentList,
    ) -> Result<(), ServiceRegistrationError> {
        let write_failure = |source: io::Error| ServiceRegistrationError::Write {
            path: path.to_owned(),
            source,
        };
        let contents = launchd_list_text(list).map_err(write_failure)?;
        let folder = path
            .parent()
            .expect("the agent's list path ends in a file name");
        let has_folder = folder.try_exists().map_err(write_failure)?;
        fs::create_dir_all(folder).map_err(write_failure)?;
        replace_file_atomically(
            path,
            contents.as_bytes(),
            AGENT_LIST_MODE,
            LeftoverSweep::Unswept,
        )
        .map_err(|source| write_failure(io::Error::other(source)))?;
        if !self.runs_as_root {
            return Ok(());
        }
        let account = self.account()?;
        let hand_over = |made: &Path| {
            chown(made, Some(account.uid), Some(account.gid)).map_err(|errno| {
                ServiceRegistrationError::Write {
                    path: made.to_owned(),
                    source: io::Error::from(errno),
                }
            })
        };
        if !has_folder {
            hand_over(folder)?;
        }
        hand_over(path)
    }

    // The account's login session in launchd.
    fn domain_target(self) -> Result<String, ServiceRegistrationError> {
        Ok(format!("gui/{}", self.account_user_id()?))
    }

    // The service's label in the account's login session.
    fn service_target(self) -> Result<String, ServiceRegistrationError> {
        Ok(format!(
            "gui/{}/{DAEMON_LAUNCHD_LABEL}",
            self.account_user_id()?
        ))
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

/// `list` as the text of the XML property list launchd reads, which a root step writes from its
/// arguments. Fails when a value has no property-list form.
pub(crate) fn launchd_list_text(list: &impl Serialize) -> io::Result<String> {
    let mut contents = Vec::new();
    plist::to_writer_xml(&mut contents, list)
        .map_err(|source| io::Error::new(io::ErrorKind::InvalidInput, source))?;
    Ok(String::from_utf8(contents).expect("the XML property list writer writes UTF-8"))
}

/// The exit status `launchctl bootout` answers for a service that is not loaded, as a root step
/// takes it.
pub(crate) fn not_loaded_status() -> OsString {
    OsString::from(libc::ESRCH.to_string())
}
