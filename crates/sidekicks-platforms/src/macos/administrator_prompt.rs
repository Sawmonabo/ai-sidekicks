//! A command run as root behind the administrator password prompt `osascript` draws, each value
//! reaching the shell as its own word, quoted by `AppleScript`, never as script text.

use std::ffi::OsStr;
use std::process::{Output, Stdio};

use tokio::process::Command;

use crate::WakeHelperError;
use crate::posix::child_command::prepare_child_command;
use crate::spawner::Spawner;

// The program that runs AppleScript, by its full path so no `PATH` entry stands in for it.
const OSASCRIPT_PROGRAM: &str = "/usr/bin/osascript";

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

/// Runs `command` (its program first) as root for `step` behind the administrator password
/// prompt, `osascript` started on `spawner`'s thread, and answers the command's output. Fails with
/// [`WakeHelperError::Canceled`] when the person cancels the prompt, with
/// [`WakeHelperError::AdministratorRefused`] and macOS's message when the command fails, and with
/// [`WakeHelperError::Start`] or [`WakeHelperError::Refused`] when `osascript` cannot run.
pub(crate) async fn run_behind_administrator_prompt(
    spawner: &Spawner,
    step: &'static str,
    command: &[&OsStr],
) -> Result<String, WakeHelperError> {
    run_script(spawner, step, PROMPT_SCRIPT, command).await
}

async fn run_script(
    spawner: &Spawner,
    step: &'static str,
    script: &str,
    command: &[&OsStr],
) -> Result<String, WakeHelperError> {
    let start_failure = |source| WakeHelperError::Start { step, source };
    let mut osascript = Command::new(OSASCRIPT_PROGRAM);
    osascript
        .arg("-e")
        .arg(script)
        .args(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    prepare_child_command(&mut osascript, std::process::id());
    let child = spawner
        .run(move || osascript.spawn())
        .await
        .map_err(start_failure)?
        .map_err(start_failure)?;
    let Output {
        status,
        stdout,
        stderr,
    } = child.wait_with_output().await.map_err(start_failure)?;
    let refused = |message: String| WakeHelperError::Refused {
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
        USER_CANCELED_NUMBER => Err(WakeHelperError::Canceled),
        _ => Err(WakeHelperError::AdministratorRefused {
            step,
            number,
            message: text.trim().to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::path::Path;

    use super::{PROMPT_SCRIPT, run_script};
    use crate::spawner::Spawner;

    // The clause that makes `do shell script` draw the administrator password prompt.
    const PRIVILEGE_CLAUSE: &str = " with administrator privileges";

    /// A path with quotes, a backslash and a `$` reaches the command as one word, unexpanded, so no
    /// value is ever read as script or shell text. Mutation: join the arguments without
    /// `quoted form`.
    #[tokio::test]
    async fn the_wake_helper_prompt_passes_a_path_as_one_word() {
        let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
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
        let answer = run_script(&spawner, "print the path", &script, &command)
            .await
            .expect("the script runs the command");
        assert_eq!(Path::new(&answer), path);
    }
}
