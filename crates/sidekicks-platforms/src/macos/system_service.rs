//! The service's system service on macOS, which runs the daemon as its account while that account
//! is logged out: a property list in `/Library/LaunchDaemons` naming the account in `UserName`,
//! loaded into launchd's system domain. Writing and loading it needs root, which a run without it
//! gets from the administrator password prompt, and a run under `sudo` already has. The list
//! reaches root as text and root writes it into a folder of its own before installing it, so no
//! file the account can still change is what root installs.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sidekicks_contracts::app_identity::{APP_BUNDLE_IDENTIFIER, DAEMON_LAUNCHD_LABEL};
use sidekicks_contracts::daemon::lifecycle::SYSTEM_SERVICE_MODE;

use super::administrator_prompt::{SHELL_PROGRAM, run_root_step};
use super::service_registration::{
    EXIT_TIME_OUT_SECONDS, SYSTEM_LIST_FOLDER, ServiceRegistration, is_list_turned_off,
    launchd_list_text, not_loaded_status, read_launchd_list, run_launchctl,
};
use crate::service_registration::{
    ServiceRegistrationError, SystemServiceKickstart, SystemServiceOwner, SystemServiceState,
};
use crate::spawner::Spawner;

// Why this build refuses to install the system service, a cause the refusal names; `None` where
// the probes passed and the build installs it.
const SYSTEM_SERVICE_REFUSAL: Option<&str> = None;

// The install's staging: a folder only its owner (root) can reach made in the system's temporary
// folder and removed when the step ends, and the list's text (`$1`) written into it.
macro_rules! stage_list {
    () => {
        concat!(
            r#"staging="$(/usr/bin/mktemp -d /private/tmp/sidekicks-system-service.XXXXXXXX)" && "#,
            r#"trap '/bin/rm -rf "$staging"' EXIT && "#,
            r#"/usr/bin/printf '%s' "$1" > "$staging/list" && "#,
        )
    };
}

// The install's root step: the staging, then the staged list put in place (`$2`) owned by root
// and readable by all, as launchd requires, the service (`$3`) unloaded if loaded, waiting for it
// to exit, an exit status of `$4` meaning it was not, then enabled, since a label once turned off
// is refused by `bootstrap`, and loaded into the system domain.
const INSTALL_STEP: &str = concat!(
    stage_list!(),
    r#"/usr/bin/install -o root -g wheel -m 644 "$staging/list" "$2" && "#,
    r#"{ /bin/launchctl bootout --wait "$3" || test $? -eq "$4"; } && "#,
    r#"/bin/launchctl enable "$3" && /bin/launchctl bootstrap system "$2""#,
);

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

// The keys an installed list is read for, whoever wrote it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InstalledSystemServiceList {
    user_name: Option<String>,
    program_arguments: Option<Vec<PathBuf>>,
}

impl ServiceRegistration {
    /// Why this build refuses to install the system service, in plain words, because a check of
    /// what macOS withholds from it failed; `None` where this build installs it.
    pub fn system_service_refusal(&self) -> Option<&'static str> {
        SYSTEM_SERVICE_REFUSAL
    }

    /// Which account has the system service installed, read from the `UserName` of its list in
    /// `/Library/LaunchDaemons`, and for this account whether the list starts `daemon_program`,
    /// this account's service reading as [`SystemServiceOwner::ThisAccount`] when none is given;
    /// with root's rights, this account is the one that ran `sudo`. Fails when the list cannot be
    /// read or this run's account cannot be named.
    pub fn system_service_owner(
        &self,
        daemon_program: Option<&Path>,
    ) -> Result<SystemServiceOwner, ServiceRegistrationError> {
        let installed: Option<InstalledSystemServiceList> =
            read_launchd_list(&system_service_list_path())?;
        let Some(installed) = installed else {
            return Ok(SystemServiceOwner::NotInstalled);
        };
        if installed.user_name != Some(self.account()?.name) {
            return Ok(SystemServiceOwner::OtherAccount);
        }
        let Some(daemon_program) = daemon_program else {
            return Ok(SystemServiceOwner::ThisAccount);
        };
        let installed_program = installed
            .program_arguments
            .as_ref()
            .and_then(|arguments| arguments.first());
        Ok(
            if installed_program.is_some_and(|program| program == daemon_program) {
                SystemServiceOwner::ThisAccount
            } else {
                SystemServiceOwner::ThisAccountOtherProgram
            },
        )
    }

    /// The program the installed system service starts, read from its list; `None` with no list or
    /// no program named. Fails when the list cannot be read.
    pub fn system_service_program(&self) -> Result<Option<PathBuf>, ServiceRegistrationError> {
        let installed: Option<InstalledSystemServiceList> =
            read_launchd_list(&system_service_list_path())?;
        Ok(installed
            .and_then(|list| list.program_arguments)
            .and_then(|arguments| arguments.into_iter().next()))
    }

    /// Whether the person turned the system service off in Login Items, which launchd does not
    /// honor when asked to start it, so a start reads it first. Blocks on the system's answer.
    /// Fails as [`Self::is_turned_off`] fails.
    pub fn is_system_service_turned_off(&self) -> Result<bool, ServiceRegistrationError> {
        is_list_turned_off(system_service_list_path())
    }

    /// Whether launchd runs the system service, read from `launchctl print system/<label>`: running
    /// where the job's own `pid` line names its process, and not running where it names none or
    /// the job is not loaded. The printed text is no interface Apple keeps, so this is the one
    /// read of it, for a run under `sudo` that cannot reach the service itself. Fails when
    /// `launchctl` cannot be started.
    pub fn read_system_service_state(
        &self,
    ) -> Result<SystemServiceState, ServiceRegistrationError> {
        let service_target = system_service_target();
        let answer = run_launchctl("print", [OsStr::new("print"), service_target.as_os_str()])?;
        if !answer.status.success() {
            return Ok(SystemServiceState::NotRunning);
        }
        Ok(printed_state(&String::from_utf8_lossy(&answer.stdout)))
    }

    /// Starts the system service in launchd's system domain, which needs root's rights; a running
    /// one is left running for [`SystemServiceKickstart::Start`] and ended first for
    /// [`SystemServiceKickstart::Restart`]. Fails with `launchctl kickstart`'s exit status when it
    /// refuses, as it does without root's rights or for a service that is not loaded.
    pub fn kickstart_system_service(
        &self,
        kickstart: SystemServiceKickstart,
    ) -> Result<(), ServiceRegistrationError> {
        let service_target = system_service_target();
        run_launchctl("kickstart", kickstart_arguments(kickstart, &service_target))?
            .succeeded("kickstart")
    }

    /// Installs the system service running `daemon_program` as this account while it is logged
    /// out, attributed to the app in System Settings when `is_attributed_to_app`: the list's text
    /// handed to root, which writes it into a folder of its own, copies it into
    /// `/Library/LaunchDaemons`, unloads any service loaded under the label, enables the label and
    /// loads it into the system domain, behind the administrator password prompt unless this run
    /// has root's rights, the command started on `spawner`'s thread. Fails with
    /// [`ServiceRegistrationError::Canceled`] when the prompt is canceled, and otherwise with the
    /// step's cause and macOS's own message.
    pub async fn install_system_service(
        &self,
        spawner: &Spawner,
        daemon_program: &Path,
        is_attributed_to_app: bool,
    ) -> Result<(), ServiceRegistrationError> {
        let list = SystemServiceList {
            label: DAEMON_LAUNCHD_LABEL.to_owned(),
            program_arguments: vec![
                daemon_program.to_owned(),
                PathBuf::from(SYSTEM_SERVICE_MODE),
            ],
            user_name: self.account()?.name,
            associated_bundle_identifiers: is_attributed_to_app
                .then(|| vec![APP_BUNDLE_IDENTIFIER.to_owned()]),
            run_at_load: true,
            exit_time_out: EXIT_TIME_OUT_SECONDS,
        };
        let path = system_service_list_path();
        let list_text = OsString::from(launchd_list_text(&list).map_err(|source| {
            ServiceRegistrationError::Write {
                path: path.clone(),
                source,
            }
        })?);
        let service_target = system_service_target();
        let not_loaded_status = not_loaded_status();
        let command = [
            OsStr::new(SHELL_PROGRAM),
            OsStr::new("-c"),
            OsStr::new(INSTALL_STEP),
            OsStr::new("sh"),
            &list_text,
            path.as_os_str(),
            &service_target,
            &not_loaded_status,
        ];
        run_root_step(
            spawner,
            "install the system service",
            &command,
            self.runs_as_root(),
        )
        .await?;
        Ok(())
    }

    /// Removes the system service: `launchctl bootout` of it in the system domain, which waits for
    /// the service to exit, then its list deleted, as root behind the administrator password
    /// prompt unless this run has root's rights, the command started on `spawner`'s thread. A
    /// service not loaded or a list already gone is already removed. Fails as
    /// [`Self::install_system_service`] fails.
    pub async fn uninstall_system_service(
        &self,
        spawner: &Spawner,
    ) -> Result<(), ServiceRegistrationError> {
        let service_target = system_service_target();
        let not_loaded_status = not_loaded_status();
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
        run_root_step(
            spawner,
            "remove the system service",
            &command,
            self.runs_as_root(),
        )
        .await?;
        Ok(())
    }
}

// The system service's list: `/Library/LaunchDaemons/<label>.plist`.
fn system_service_list_path() -> PathBuf {
    Path::new(SYSTEM_LIST_FOLDER).join(format!("{DAEMON_LAUNCHD_LABEL}.plist"))
}

// `launchctl`'s arguments that kickstart `service_target` as `kickstart` asks: `-k` ends a running
// service first.
fn kickstart_arguments(kickstart: SystemServiceKickstart, service_target: &OsStr) -> Vec<&OsStr> {
    match kickstart {
        SystemServiceKickstart::Start => vec![OsStr::new("kickstart"), service_target],
        SystemServiceKickstart::Restart => {
            vec![OsStr::new("kickstart"), OsStr::new("-k"), service_target]
        }
    }
}

// The job's state from `launchctl print`'s text: its process from the job's own `pid` line, one
// tab in, where a nested section's lines sit deeper.
fn printed_state(printed: &str) -> SystemServiceState {
    printed
        .lines()
        .find_map(|line| line.strip_prefix("\tpid = ")?.trim().parse::<u32>().ok())
        .map_or(SystemServiceState::NotRunning, |process_id| {
            SystemServiceState::Running { process_id }
        })
}

// The system service in launchd's system domain, as `launchctl` names it.
fn system_service_target() -> OsString {
    OsString::from(format!("system/{DAEMON_LAUNCHD_LABEL}"))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::process::Command;

    use rstest::rstest;

    use super::{kickstart_arguments, printed_state};
    use crate::service_registration::{SystemServiceKickstart, SystemServiceState};

    // Fails when a job with a process reads as not running (the start would then report a failed
    // start of a running service), or when a pid line inside a nested section, such as an
    // endpoint's, reads as the job's own process (a stopped job would read as started).
    #[rstest]
    #[case::running(
        "system/label = {\n\tactive count = 1\n\tstate = running\n\tpid = 4321\n}\n",
        SystemServiceState::Running { process_id: 4321 }
    )]
    #[case::stopped(
        "system/label = {\n\tstate = not running\n\tendpoints = {\n\t\tpid = 77\n\t}\n}\n",
        SystemServiceState::NotRunning
    )]
    fn only_the_job_s_own_pid_line_reads_as_running(
        #[case] printed: &str,
        #[case] expected: SystemServiceState,
    ) {
        assert_eq!(printed_state(printed), expected);
    }

    // Fails when a restart's kickstart leaves a service launchd still counts as running alone (no
    // `-k`), which the restart's stop half may leave it as, or when a start ends a running one.
    #[rstest]
    #[case::start(SystemServiceKickstart::Start, &["kickstart", "system/label"])]
    #[case::restart(SystemServiceKickstart::Restart, &["kickstart", "-k", "system/label"])]
    fn a_restart_alone_ends_a_running_service_first(
        #[case] kickstart: SystemServiceKickstart,
        #[case] expected: &[&str],
    ) {
        let arguments = kickstart_arguments(kickstart, OsStr::new("system/label"));

        assert_eq!(
            arguments,
            expected.iter().map(OsStr::new).collect::<Vec<_>>()
        );
    }

    /// Root installs the list it was given as text, byte for byte, from the folder it staged it
    /// in, whatever quotes, backslashes, `$` or line breaks the text holds. Mutation: read the
    /// list from a path argument (`/bin/cat "$1"` in place of `printf`).
    #[test]
    fn the_staged_list_is_the_text_root_was_given() {
        let text = "<string>it's \"quoted\" \\ $HOME</string>\n<key>next</key>";
        let staged = Command::new("/bin/sh")
            .arg("-c")
            .arg(concat!(stage_list!(), r#"/bin/cat "$staging/list""#))
            .arg("sh")
            .arg(text)
            .output()
            .expect("the shell runs");

        assert!(staged.status.success(), "{staged:?}");
        assert_eq!(staged.stdout, text.as_bytes());
    }
}
