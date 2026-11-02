//! The wake helper's install and removal: its program copied to one fixed path, its legacy property
//! list in `/Library/LaunchDaemons` naming that path, the socket launchd holds for it and starts it
//! on, and the log its standard error goes to, both put in place and loaded into launchd's system
//! domain, or unloaded and removed, as root behind one administrator prompt. The helper runs only
//! while a connection wants it, never kept alive.
//!
//! Root installs only what it staged in a folder of its own, so no file the user can still change
//! is what root installs: the program copied there and checked against the hash the service took
//! of it, and the list written there from its text. A service signed by a team also has root check
//! the staged program's signature against that team, read from the service's own signature once
//! its running code is checked to match it, so a program a same-user process put beside the
//! service before the service read it is refused too; a development build signed ad hoc has no
//! team to check, and only the hash.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::app_identity::APP_BUNDLE_IDENTIFIER;

use super::WAKE_HELPER_SOCKET_PATH;
use super::program::WAKE_HELPER_SOCKET_NAME;
use crate::WakeHelperError;
use crate::macos::administrator_prompt::run_behind_administrator_prompt;
use crate::macos::code_signature::{read_own_quotable_team, team_requirement};
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

// The install's staging, its first part: a folder only its owner (root) can reach made in the
// system's temporary folder and removed when the step ends, the program (`$2`) copied into it, its
// SHA-256 checked against `$8`, the hash the service took, and its signature against `$9`, the
// requirement text the service's team makes, where it is not empty, and the list's text (`$4`)
// written into it. Any failed check, `codesign`'s unsigned answer as much as its unmet
// requirement, ends the step.
macro_rules! stage_step {
    () => {
        concat!(
            r#"staging="$(/usr/bin/mktemp -d /private/tmp/sidekicks-wake-helper.XXXXXXXX)" && "#,
            r#"trap '/bin/rm -rf "$staging"' EXIT && /bin/cp "$2" "$staging/program" && "#,
            r#"/usr/bin/printf '%s  %s\n' "$8" "$staging/program" | "#,
            r#"/usr/bin/shasum -a 256 -c -s && "#,
            r#"{ test -z "$9" || "#,
            r#"/usr/bin/codesign --verify --strict -R "=$9" "$staging/program"; } && "#,
            r#"/usr/bin/printf '%s' "$4" > "$staging/list" && "#,
        )
    };
}

// The install's root step: the staging, then the program's folder made (`$1`), the staged program
// put in place (`$3`) and the staged list in place (`$5`), each owned by root as launchd requires,
// any helper loaded before (`$6`) unloaded, waiting for it to exit, an exit status of `$7` meaning
// none was loaded, then the list loaded into the system domain.
const INSTALL_STEP: &str = concat!(
    stage_step!(),
    r#"/bin/mkdir -p "$1" && "#,
    r#"/usr/bin/install -o root -g wheel -m 755 "$staging/program" "$3" && "#,
    r#"/usr/bin/install -o root -g wheel -m 644 "$staging/list" "$5" && "#,
    r#"{ /bin/launchctl bootout --wait "$6" || test $? -eq "$7"; } && "#,
    r#"/bin/launchctl bootstrap system "$5""#,
);

// The removal's root step: the helper (`$1`) unloaded, waiting for it to exit, an exit status of
// `$2` meaning it was not loaded, then its list (`$3`), program (`$4`) and socket (`$5`) deleted.
const UNINSTALL_STEP: &str = concat!(
    r#"{ /bin/launchctl bootout --wait "$1" || test $? -eq "$2"; } && "#,
    r#"/bin/rm -f "$3" "$4" "$5""#,
);

// The socket's mode, 0666, in decimal, as a property list writes it: any local user may connect,
// since the helper checks each connection's user itself.
const WAKE_HELPER_SOCKET_MODE: u16 = 0o666;

// The helper's property list, as the install writes it: launchd starts the helper on demand, when
// a connection reaches its socket, so no key keeps it alive or starts it at load.
#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct WakeHelperList {
    label: String,
    program_arguments: [&'static str; 1],
    associated_bundle_identifiers: [&'static str; 1],
    sockets: BTreeMap<&'static str, WakeHelperSocket>,
    standard_error_path: &'static str,
}

// The one socket launchd binds for the helper, under the name the helper asks launchd for.
#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct WakeHelperSocket {
    sock_path_name: &'static str,
    sock_path_mode: u16,
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

/// Installs `helper_program`, as it reads now, at the helper's path with its property list and
/// loads it, as root behind the administrator prompt; a program changed after that read, or one
/// not signed by this service's own team where the service has one, is refused by the prompt's
/// step. Fails as the prompt fails, with [`WakeHelperError::Signature`] when this service's own
/// signature cannot be read, and with [`WakeHelperError::File`] when the program cannot be read or
/// the list cannot be written.
pub(crate) async fn install(
    spawner: &Spawner,
    helper_program: &Path,
) -> Result<(), WakeHelperError> {
    let list_contents = list_text(&wake_helper_list())?;
    let signature_requirement = OsString::from(
        read_own_quotable_team()
            .map_err(WakeHelperError::Signature)?
            .map(|team| team_requirement(&team))
            .unwrap_or_default(),
    );
    let program =
        tokio::fs::read(helper_program)
            .await
            .map_err(|source| WakeHelperError::File {
                path: helper_program.to_owned(),
                source,
            })?;
    let program_hash = OsString::from(sha256_hex(&program));
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
        OsStr::new(&list_contents),
        list_path.as_os_str(),
        &service_target,
        &not_loaded_status,
        &program_hash,
        &signature_requirement,
    ];
    run_behind_administrator_prompt(spawner, "install the wake helper", &command)
        .await
        .map(drop)
}

/// Unloads the helper and deletes its list, program and socket, as root behind the administrator
/// prompt; a helper not loaded or files already gone are already removed. Fails as the prompt
/// fails.
pub(crate) async fn uninstall(spawner: &Spawner) -> Result<(), WakeHelperError> {
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
    ];
    run_behind_administrator_prompt(spawner, "remove the wake helper", &command)
        .await
        .map(drop)
}

// The helper's property list: its label, program and app, and the socket it is started on.
fn wake_helper_list() -> WakeHelperList {
    WakeHelperList {
        label: wake_helper_label(),
        program_arguments: [WAKE_HELPER_PROGRAM_PATH],
        associated_bundle_identifiers: [APP_BUNDLE_IDENTIFIER],
        sockets: BTreeMap::from([(
            WAKE_HELPER_SOCKET_NAME,
            WakeHelperSocket {
                sock_path_name: WAKE_HELPER_SOCKET_PATH,
                sock_path_mode: WAKE_HELPER_SOCKET_MODE,
            },
        )]),
        standard_error_path: WAKE_HELPER_LOG_PATH,
    }
}

// The helper in launchd's system domain, as `launchctl bootout` names it.
fn service_target() -> OsString {
    OsString::from(format!("system/{}", wake_helper_label()))
}

// The exit status `launchctl bootout` answers for a service that is not loaded.
fn not_loaded_status() -> OsString {
    OsString::from(libc::ESRCH.to_string())
}

// The text of `list` as its property list file holds it.
fn list_text(list: &WakeHelperList) -> Result<String, WakeHelperError> {
    let mut contents = Vec::new();
    plist::to_writer_xml(&mut contents, list).map_err(unwritable_list)?;
    String::from_utf8(contents).map_err(unwritable_list)
}

// The list's file failure for `source`, why its text could not be made.
fn unwritable_list(source: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> WakeHelperError {
    WakeHelperError::File {
        path: wake_helper_list_path(),
        source: std::io::Error::new(std::io::ErrorKind::InvalidInput, source),
    }
}

// The SHA-256 of `bytes` in lowercase hex, as `shasum` writes it.
fn sha256_hex(bytes: &[u8]) -> String {
    base16ct::lower::encode_string(&Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::{Command, Output};

    use super::{list_text, sha256_hex, wake_helper_list};
    use crate::macos::code_signature::team_requirement;

    // Runs the install's staging over `program` with `hash` as the hash the service took and
    // `requirement` as the signature's requirement text, empty for none, then prints what it
    // staged: the program, then the list.
    fn stage(program: &Path, hash: &str, requirement: &str) -> Output {
        Command::new("/bin/sh")
            .arg("-c")
            .arg(concat!(
                stage_step!(),
                r#"/bin/cat "$staging/program" "$staging/list""#
            ))
            .arg("sh")
            .arg("/unused")
            .arg(program)
            .arg("/unused")
            .arg("<plist/>")
            .args(["/unused", "/unused", "/unused", hash, requirement])
            .output()
            .expect("the shell runs")
    }

    /// Root goes on only with the staged copy whose hash is the one the service took, so a program
    /// changed after the service read it stops the install before anything is placed. Mutation:
    /// drop the hash check from the staging.
    #[test]
    fn the_staging_refuses_a_program_changed_after_its_hash_was_taken() {
        let folder = tempfile::tempdir().expect("the test's temporary folder is made");
        let program = folder.path().join("sidekicks-wake-helper");
        let read = b"the helper the service read";
        std::fs::write(&program, read).expect("the test writes the program");
        let hash = sha256_hex(read);

        let staged = stage(&program, &hash, "");
        assert!(staged.status.success(), "{staged:?}");
        assert_eq!(staged.stdout, b"the helper the service read<plist/>");

        std::fs::write(&program, b"a program put in its place").expect("the test swaps it");
        let refused = stage(&program, &hash, "");
        assert!(!refused.status.success(), "the changed program was staged");
        assert!(refused.stdout.is_empty(), "the step went on: {refused:?}");
    }

    /// With a requirement, root goes on only with a staged program whose signature meets it, even
    /// when its hash is the one the service took: a program put beside the service before the
    /// service read it, unsigned, signed by another, or a signed one with a byte changed, stops
    /// the install. A system program meets `anchor apple` and stands in for the team's own.
    /// Mutation: drop the signature check from the staging.
    #[test]
    fn the_staging_refuses_a_program_not_signed_as_the_requirement_says() {
        let folder = tempfile::tempdir().expect("the test's temporary folder is made");
        let signed = std::fs::read("/usr/bin/true").expect("the system program reads");
        let mut changed = signed.clone();
        // The first slice's offset in a universal program, past whose header a byte is changed.
        let slice = if changed[..4] == [0xca, 0xfe, 0xba, 0xbe] {
            usize::try_from(u32::from_be_bytes([
                changed[16],
                changed[17],
                changed[18],
                changed[19],
            ]))
            .expect("the offset fits")
        } else {
            0
        };
        changed[slice + 64] ^= 0xff;
        let other_team = team_requirement("ABCDE12345");
        let cases = [
            (
                "signed by another team",
                signed.clone(),
                other_team.as_str(),
                false,
            ),
            (
                "unsigned",
                b"a program put in its place".to_vec(),
                "anchor apple",
                false,
            ),
            ("changed after signing", changed, "anchor apple", false),
            ("signed as asked", signed, "anchor apple", true),
        ];

        for (case, bytes, requirement, is_met) in cases {
            let program = folder.path().join("sidekicks-wake-helper");
            std::fs::write(&program, &bytes).expect("the test writes the program");
            let staged = stage(&program, &sha256_hex(&bytes), requirement);
            assert_eq!(staged.status.success(), is_met, "{case}: {staged:?}");
            assert_eq!(staged.stdout.is_empty(), !is_met, "{case}: {staged:?}");
        }
    }

    /// launchd starts the helper on its socket alone: the list names the socket at its path and
    /// keeps no key that keeps the helper alive or starts it at load. Mutation: put `KeepAlive`
    /// back in the list.
    #[test]
    fn the_list_starts_the_helper_on_its_socket_and_never_keeps_it_alive() {
        let text = list_text(&wake_helper_list()).expect("the list writes");
        let list = plist::Value::from_reader_xml(text.as_bytes())
            .expect("the list reads")
            .into_dictionary()
            .expect("the list is a dictionary");

        let socket = list
            .get("Sockets")
            .and_then(plist::Value::as_dictionary)
            .and_then(|sockets| sockets.get(super::WAKE_HELPER_SOCKET_NAME))
            .and_then(plist::Value::as_dictionary)
            .expect("the list names the helper's socket");
        assert_eq!(
            socket.get("SockPathName").and_then(plist::Value::as_string),
            Some(super::WAKE_HELPER_SOCKET_PATH)
        );
        assert_eq!(
            socket
                .get("SockPathMode")
                .and_then(plist::Value::as_unsigned_integer),
            Some(0o666)
        );
        assert!(list.get("KeepAlive").is_none(), "{text}");
        assert!(list.get("RunAtLoad").is_none(), "{text}");
    }
}
