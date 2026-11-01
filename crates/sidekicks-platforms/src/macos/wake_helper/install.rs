//! The wake helper's install and removal: its program copied to one fixed path, its legacy property
//! list in `/Library/LaunchDaemons` naming that path and keeping the helper's standard error in a
//! log, both put in place and loaded into launchd's system domain, or unloaded and removed, as
//! root behind one administrator prompt.

use std::ffi::{OsStr, OsString};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sidekicks_contracts::app_identity::APP_BUNDLE_IDENTIFIER;

use super::program::WAKE_HELPER_SOCKET_PATH;
use crate::WakeHelperError;
use crate::macos::administrator_prompt::run_behind_administrator_prompt;
use crate::spawner::Spawner;

/// Where the helper's program is installed, which the install copies it to and its property list
/// runs.
pub(crate) const WAKE_HELPER_PROGRAM_PATH: &str =
    "/Library/PrivilegedHelperTools/sidekicks-wake-helper";

// Where launchd keeps the helper's standard error, which carries its failure lines.
const WAKE_HELPER_LOG_PATH: &str = "/Library/Logs/sidekicks-wake-helper.log";

// The folder launchd reads the system domain's property lists from.
const SYSTEM_LIST_FOLDER: &str = "/Library/LaunchDaemons";

// The shell each root step runs in, its values passed as the shell's own arguments.
const SHELL_PROGRAM: &str = "/bin/sh";

// The install's root step: the program's folder made (`$1`), the program (`$2`) copied into place
// (`$3`) and the list from its private temporary file (`$4`) into place (`$5`), each owned by root
// as launchd requires, any helper loaded before (`$6`) unloaded, waiting for it to exit, an exit
// status of `$7` meaning none was loaded, then the list loaded into the system domain.
const INSTALL_STEP: &str = concat!(
    r#"/bin/mkdir -p "$1" && /usr/bin/install -o root -g wheel -m 755 "$2" "$3" && "#,
    r#"/usr/bin/install -o root -g wheel -m 644 "$4" "$5" && "#,
    r#"{ /bin/launchctl bootout --wait "$6" || test $? -eq "$7"; } && "#,
    r#"/bin/launchctl bootstrap system "$5""#,
);

// The removal's root step: the helper (`$1`) unloaded, waiting for it to exit, an exit status of
// `$2` meaning it was not loaded, then its list (`$3`), program (`$4`) and socket (`$5`) deleted
// and the socket's folder (`$6`) removed once empty.
const UNINSTALL_STEP: &str = concat!(
    r#"{ /bin/launchctl bootout --wait "$1" || test $? -eq "$2"; } && "#,
    r#"/bin/rm -f "$3" "$4" "$5" && { /bin/rmdir "$6" 2>/dev/null || test ! -d "$6"; }"#,
);

// The helper's property list, as the install writes it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct WakeHelperList {
    label: String,
    program_arguments: [&'static str; 1],
    associated_bundle_identifiers: [&'static str; 1],
    run_at_load: bool,
    keep_alive: bool,
    standard_error_path: &'static str,
}

/// The helper's property list in `/Library/LaunchDaemons`, named for its label.
pub(crate) fn wake_helper_list_path() -> PathBuf {
    Path::new(SYSTEM_LIST_FOLDER).join(format!("{}.plist", wake_helper_label()))
}

// The helper's launchd label: the app's identifier with the helper's name, so launchd's and the
// login items' records of the app and of the helper never collide.
fn wake_helper_label() -> String {
    format!("{APP_BUNDLE_IDENTIFIER}.wake-helper")
}

/// Installs `helper_program` at the helper's path with its property list and loads it, as root
/// behind the administrator prompt. Fails as the prompt fails, and with [`WakeHelperError::File`]
/// when the list's temporary file cannot be written.
pub(crate) async fn install(
    spawner: &Spawner,
    helper_program: &Path,
) -> Result<(), WakeHelperError> {
    let list = WakeHelperList {
        label: wake_helper_label(),
        program_arguments: [WAKE_HELPER_PROGRAM_PATH],
        associated_bundle_identifiers: [APP_BUNDLE_IDENTIFIER],
        run_at_load: true,
        keep_alive: true,
        standard_error_path: WAKE_HELPER_LOG_PATH,
    };
    let list_file = write_private_list(&list)?;
    let program_folder = Path::new(WAKE_HELPER_PROGRAM_PATH)
        .parent()
        .expect("the helper's path names its folder");
    let list_path = wake_helper_list_path();
    let service_target = service_target();
    let not_loaded_status = not_loaded_status();
    let command = [
        OsStr::new(SHELL_PROGRAM),
        OsStr::new("-c"),
        OsStr::new(INSTALL_STEP),
        OsStr::new("sh"),
        program_folder.as_os_str(),
        helper_program.as_os_str(),
        OsStr::new(WAKE_HELPER_PROGRAM_PATH),
        list_file.path().as_os_str(),
        list_path.as_os_str(),
        &service_target,
        &not_loaded_status,
    ];
    run_behind_administrator_prompt(spawner, "install the wake helper", &command)
        .await
        .map(drop)
}

/// Unloads the helper and deletes its list, program and socket, as root behind the administrator
/// prompt; a helper not loaded or files already gone are already removed. Fails as the prompt
/// fails.
pub(crate) async fn uninstall(spawner: &Spawner) -> Result<(), WakeHelperError> {
    let socket_folder = Path::new(WAKE_HELPER_SOCKET_PATH)
        .parent()
        .expect("the helper's socket path names its folder");
    let list_path = wake_helper_list_path();
    let service_target = service_target();
    let not_loaded_status = not_loaded_status();
    let command = [
        OsStr::new(SHELL_PROGRAM),
        OsStr::new("-c"),
        OsStr::new(UNINSTALL_STEP),
        OsStr::new("sh"),
        &service_target,
        &not_loaded_status,
        list_path.as_os_str(),
        OsStr::new(WAKE_HELPER_PROGRAM_PATH),
        OsStr::new(WAKE_HELPER_SOCKET_PATH),
        socket_folder.as_os_str(),
    ];
    run_behind_administrator_prompt(spawner, "remove the wake helper", &command)
        .await
        .map(drop)
}

// The helper in launchd's system domain, as `launchctl bootout` names it.
fn service_target() -> OsString {
    OsString::from(format!("system/{}", wake_helper_label()))
}

// The exit status `launchctl bootout` answers for a service that is not loaded.
fn not_loaded_status() -> OsString {
    OsString::from(libc::ESRCH.to_string())
}

// Writes `list` to a new temporary file readable by this account alone, removed when dropped.
fn write_private_list(list: &WakeHelperList) -> Result<tempfile::NamedTempFile, WakeHelperError> {
    let write_failure = |path: PathBuf| move |source| WakeHelperError::File { path, source };
    let mut contents = Vec::new();
    plist::to_writer_xml(&mut contents, list).map_err(|source| WakeHelperError::File {
        path: wake_helper_list_path(),
        source: std::io::Error::new(std::io::ErrorKind::InvalidInput, source),
    })?;
    let mut list_file = tempfile::Builder::new()
        .prefix(&wake_helper_label())
        .suffix(".plist")
        .tempfile()
        .map_err(write_failure(std::env::temp_dir()))?;
    list_file
        .write_all(&contents)
        .and_then(|()| list_file.flush())
        .map_err(write_failure(list_file.path().to_owned()))?;
    Ok(list_file)
}
