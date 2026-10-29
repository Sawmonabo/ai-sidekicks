//! The service's system service on macOS, which runs the daemon as its account while that account
//! is logged out: a property list in `/Library/LaunchDaemons` naming the account in `UserName`,
//! loaded into launchd's system domain. Writing and loading it needs root, which a run without it
//! gets from the administrator password prompt `osascript` draws, and a run under `sudo` already
//! has. Every value reaches the shell as its own word, quoted by AppleScript, never as script text.

use std::ffi::{OsStr, OsString};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use nix::unistd::{Uid, User, geteuid};
use serde::{Deserialize, Serialize};
use sidekicks_contracts::app_identity::{APP_BUNDLE_IDENTIFIER, DAEMON_LAUNCHD_LABEL};

use super::service_registration::{
    EXIT_TIME_OUT_SECONDS, ServiceRegistration, launchd_list_bytes, read_launchd_list,
};
use crate::posix::login_shell::read_account;
use crate::service_registration::{
    SYSTEM_SERVICE_MODE, ServiceRegistrationError, SystemServiceOwner,
};

// The program that runs AppleScript, by its full path so no `PATH` entry stands in for it.
const OSASCRIPT_PROGRAM: &str = "/usr/bin/osascript";

// The shell each root step runs in, its values passed as the shell's own arguments.
const SHELL_PROGRAM: &str = "/bin/sh";

// The folder launchd reads the system domain's property lists from.
const SYSTEM_LIST_FOLDER: &str = "/Library/LaunchDaemons";

// The AppleScript that runs its arguments as one command line as root: each argument quoted as one
// word by AppleScript's own `quoted form`, so no value is ever part of the script's text. It
// answers on its standard output an error number on the first line, 0 when the command succeeded,
// and on the rest the command's output or macOS's error message.
const PROMPT_SCRIPT: &str = r#"on run argv
    set commandLine to ""
    repeat with argumentIndex from 1 to count of argv
        set commandLine to commandLine & quoted form of item argumentIndex of argv & " "
    end repeat
    try
        set answer to do shell script commandLine with administrator privileges
    on error errorText number errorNumber
        return (errorNumber as text) & linefeed & errorText
    end try
    return "0" & linefeed & answer
end run"#;

// The error number AppleScript answers when the person cancels the prompt.
const USER_CANCELED_NUMBER: i64 = -128;

// The install's root step: the list copied from its private temporary file (`$1`) into place
// (`$2`) owned by root and readable by all, as launchd requires, then loaded into the system domain.
const INSTALL_STEP: &str =
    r#"/usr/bin/install -o root -g wheel -m 644 "$1" "$2" && /bin/launchctl bootstrap system "$2""#;

// The uninstall's root step: the service (`$1`) unloaded, waiting for it to exit, an exit status of
// `$2` meaning it was not loaded, then its list (`$3`) deleted.
const UNINSTALL_STEP: &str =
    r#"{ /bin/launchctl bootout --wait "$1" || test $? -eq "$2"; } && /bin/rm -f "$3""#;

// The system service's property list, as this command line writes it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct SystemServiceList {
    label: String,
    program_arguments: Vec<PathBuf>,
    user_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    associated_bundle_identifiers: Option<Vec<String>>,
    run_at_load: bool,
    exit_time_out: u64,
}

// The one key an installed list is read for, whoever wrote it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InstalledSystemServiceList {
    user_name: Option<String>,
}

impl ServiceRegistration {
    /// Whether this run has root's rights, as under `sudo`, so the system service is installed and
    /// removed directly, with no administrator password prompt.
    pub fn runs_as_root(&self) -> bool {
        geteuid().is_root()
    }

    /// Which account has the system service installed, read from the `UserName` of its list in
    /// `/Library/LaunchDaemons`; with root's rights, this account is the one that ran `sudo`.
    /// Fails when the list cannot be read or this run's account cannot be named.
    pub fn system_service_owner(&self) -> Result<SystemServiceOwner, ServiceRegistrationError> {
        let installed: Option<InstalledSystemServiceList> =
            read_launchd_list(&system_service_list_path())?;
        let Some(installed) = installed else {
            return Ok(SystemServiceOwner::NotInstalled);
        };
        let account = service_account_name(self.runs_as_root())?;
        Ok(if installed.user_name == Some(account) {
            SystemServiceOwner::ThisAccount
        } else {
            SystemServiceOwner::OtherAccount
        })
    }

    /// Installs the system service running `daemon_program` as this account while it is logged
    /// out, attributed to the app in System Settings when `is_app_installed`: the list written to
    /// a private temporary file, then copied into `/Library/LaunchDaemons` and loaded into the
    /// system domain as root, behind the administrator password prompt unless this run has root's
    /// rights. Fails with [`ServiceRegistrationError::Canceled`] when the prompt is canceled, and
    /// otherwise with the step's cause and macOS's own message.
    pub fn install_system_service(
        &self,
        daemon_program: &Path,
        is_app_installed: bool,
    ) -> Result<(), ServiceRegistrationError> {
        let runs_as_root = self.runs_as_root();
        let list = SystemServiceList {
            label: DAEMON_LAUNCHD_LABEL.to_owned(),
            program_arguments: vec![
                daemon_program.to_owned(),
                PathBuf::from(SYSTEM_SERVICE_MODE),
            ],
            user_name: service_account_name(runs_as_root)?,
            associated_bundle_identifiers: is_app_installed
                .then(|| vec![APP_BUNDLE_IDENTIFIER.to_owned()]),
            run_at_load: true,
            exit_time_out: EXIT_TIME_OUT_SECONDS,
        };
        let list_file = write_private_list(&list)?;
        let path = system_service_list_path();
        let command = [
            OsStr::new(SHELL_PROGRAM),
            OsStr::new("-c"),
            OsStr::new(INSTALL_STEP),
            OsStr::new("sh"),
            list_file.path().as_os_str(),
            path.as_os_str(),
        ];
        run_root_step("install the system service", &command, runs_as_root)
    }

    /// Removes the system service: `launchctl bootout` of it in the system domain, which waits for
    /// the service to exit, then its list deleted, as root behind the administrator password
    /// prompt unless this run has root's rights. A service not loaded or a list already gone is
    /// already removed. Fails as [`Self::install_system_service`] fails.
    pub fn uninstall_system_service(&self) -> Result<(), ServiceRegistrationError> {
        let service_target = OsString::from(format!("system/{DAEMON_LAUNCHD_LABEL}"));
        let not_loaded_status = OsString::from(libc::ESRCH.to_string());
        let path = system_service_list_path();
        let command = [
            OsStr::new(SHELL_PROGRAM),
            OsStr::new("-c"),
            OsStr::new(UNINSTALL_STEP),
            OsStr::new("sh"),
            &service_target,
            &not_loaded_status,
            path.as_os_str(),
        ];
        run_root_step("remove the system service", &command, self.runs_as_root())
    }
}

// The system service's list: `/Library/LaunchDaemons/<label>.plist`.
fn system_service_list_path() -> PathBuf {
    Path::new(SYSTEM_LIST_FOLDER).join(format!("{DAEMON_LAUNCHD_LABEL}.plist"))
}

// The account the system service runs as: this run's own, or with root's rights the account that
// ran `sudo`, read from `SUDO_UID` and the user database. Root itself is never that account.
fn service_account_name(runs_as_root: bool) -> Result<String, ServiceRegistrationError> {
    if !runs_as_root {
        return read_account()
            .map(|(name, _shell)| name)
            .map_err(|source| ServiceRegistrationError::Account { source });
    }
    let user_id = std::env::var_os("SUDO_UID")
        .and_then(|value| value.to_str()?.parse::<u32>().ok())
        .filter(|user_id| *user_id != 0)
        .ok_or(ServiceRegistrationError::NoInvokingAccount)?;
    let user = User::from_uid(Uid::from_raw(user_id)).map_err(|errno| {
        ServiceRegistrationError::Account {
            source: io::Error::from(errno),
        }
    })?;
    user.map(|user| user.name)
        .ok_or(ServiceRegistrationError::NoInvokingAccount)
}

// Writes `list` to a new temporary file readable by this account alone, removed when dropped.
fn write_private_list(
    list: &SystemServiceList,
) -> Result<tempfile::NamedTempFile, ServiceRegistrationError> {
    let contents = launchd_list_bytes(list).map_err(|source| ServiceRegistrationError::Write {
        path: std::env::temp_dir(),
        source,
    })?;
    let mut list_file = tempfile::Builder::new()
        .prefix(DAEMON_LAUNCHD_LABEL)
        .suffix(".plist")
        .tempfile()
        .map_err(|source| ServiceRegistrationError::Write {
            path: std::env::temp_dir(),
            source,
        })?;
    list_file
        .write_all(&contents)
        .and_then(|()| list_file.flush())
        .map_err(|source| ServiceRegistrationError::Write {
            path: list_file.path().to_owned(),
            source,
        })?;
    Ok(list_file)
}

// Runs `command` (its program first) as root for `step`: directly when this run has root's rights,
// else behind the administrator password prompt.
fn run_root_step(
    step: &'static str,
    command: &[&OsStr],
    runs_as_root: bool,
) -> Result<(), ServiceRegistrationError> {
    if !runs_as_root {
        return run_behind_prompt(step, PROMPT_SCRIPT, command).map(drop);
    }
    let (program, arguments) = command
        .split_first()
        .expect("every root step names its program");
    let Output { status, stderr, .. } = Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|source| ServiceRegistrationError::Start { step, source })?;
    if status.success() {
        return Ok(());
    }
    Err(ServiceRegistrationError::Refused {
        step,
        status,
        message: String::from_utf8_lossy(&stderr).trim().to_owned(),
    })
}

// Runs `script` through `osascript` with `command` as its arguments for `step`, and answers the
// command's output. A canceled prompt answers `Canceled`; any other error number answers it with
// macOS's message.
fn run_behind_prompt(
    step: &'static str,
    script: &str,
    command: &[&OsStr],
) -> Result<String, ServiceRegistrationError> {
    let Output {
        status,
        stdout,
        stderr,
    } = Command::new(OSASCRIPT_PROGRAM)
        .arg("-e")
        .arg(script)
        .args(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|source| ServiceRegistrationError::Start { step, source })?;
    let refused = |message: String| ServiceRegistrationError::Refused {
        step,
        status,
        message,
    };
    if !status.success() {
        return Err(refused(String::from_utf8_lossy(&stderr).trim().to_owned()));
    }
    let answer = String::from_utf8_lossy(&stdout);
    let answer = answer.strip_suffix('\n').unwrap_or(&answer);
    let (number, text) = answer.split_once('\n').unwrap_or((answer, ""));
    let Ok(number) = number.parse::<i64>() else {
        return Err(refused(format!(
            "osascript answered no error number: {answer}"
        )));
    };
    match number {
        0 => Ok(text.to_owned()),
        USER_CANCELED_NUMBER => Err(ServiceRegistrationError::Canceled),
        _ => Err(ServiceRegistrationError::AdministratorRefused {
            step,
            number,
            message: text.trim().to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The clause that makes `do shell script` draw the administrator password prompt.
    const PRIVILEGE_CLAUSE: &str = " with administrator privileges";

    #[test]
    fn the_prompt_script_passes_a_path_as_one_word() {
        let folder = tempfile::tempdir().expect("the test's temporary folder is made");
        let path = folder.path().join(r#"it's "quoted" \ $HOME.plist"#);
        let script = PROMPT_SCRIPT.replace(PRIVILEGE_CLAUSE, "");
        assert_ne!(
            script, PROMPT_SCRIPT,
            "the script holds the privilege clause"
        );
        let command = [
            OsStr::new("/usr/bin/printf"),
            OsStr::new("%s"),
            path.as_os_str(),
        ];
        let answer = run_behind_prompt("print the path", &script, &command)
            .expect("the script runs the command");
        assert_eq!(Path::new(&answer), path);
    }
}
