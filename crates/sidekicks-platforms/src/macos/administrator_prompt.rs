//! A command run as root for one step: directly when this run already has root's rights, as under
//! `sudo`, and otherwise behind the administrator password prompt `osascript` draws, each value
//! reaching the shell as its own word, quoted by `AppleScript`, never as script text.

use std::ffi::OsStr;
use std::io;
use std::process::{ExitStatus, Output, Stdio};

use tokio::process::Command;

use crate::posix::child_command::prepare_child_command;
use crate::spawner::Spawner;

/// The shell each root step runs in, its values passed as the shell's own arguments.
pub(crate) const SHELL_PROGRAM: &str = "/bin/sh";

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

/// Why a step run as root failed, which the caller's own error takes over variant for variant.
#[derive(Debug, thiserror::Error)]
pub(crate) enum AdministratorPromptError {
    /// The command, or the program that draws the administrator prompt, could not be started.
    #[error("the administrator step could not be started to {step}")]
    Start {
        /// The step it was started for, such as `install the wake helper`.
        step: &'static str,
        /// Why it could not start.
        #[source]
        source: io::Error,
    },
    /// The command run directly as root, or the program that draws the prompt, exited with a
    /// failure: its exit status and what it wrote on its error stream.
    #[error("the administrator step failed to {step} ({status}): {message}")]
    Refused {
        /// The step, such as `install the wake helper`.
        step: &'static str,
        /// Its exit status.
        status: ExitStatus,
        /// What it wrote on its error stream, trimmed.
        message: String,
    },
    /// The person canceled the administrator prompt.
    #[error("the administrator password was not given")]
    Canceled,
    /// The command run behind the prompt failed: the error number and message macOS answered,
    /// which for a failed command are its exit status and what it wrote on its error stream.
    #[error("the administrator step to {step} failed ({number}): {message}")]
    AdministratorRefused {
        /// The step, such as `install the wake helper`.
        step: &'static str,
        /// The error number macOS answered.
        number: i64,
        /// The message macOS answered, trimmed.
        message: String,
    },
}

/// Runs `command` (its program first) as root for `step` behind the administrator password
/// prompt, `osascript` started on `spawner`'s thread, and answers the command's output. Fails with
/// [`AdministratorPromptError::Canceled`] when the person cancels the prompt, with
/// [`AdministratorPromptError::AdministratorRefused`] and macOS's message when the command fails,
/// and with [`AdministratorPromptError::Start`] or [`AdministratorPromptError::Refused`] when
/// `osascript` cannot run.
pub(crate) async fn run_behind_administrator_prompt(
    spawner: &Spawner,
    step: &'static str,
    command: &[&OsStr],
) -> Result<String, AdministratorPromptError> {
    run_script(spawner, step, PROMPT_SCRIPT, command).await
}

/// Runs `command` (its program first) as root for `step` and answers its output: directly, started
/// on `spawner`'s thread, when this run `runs_as_root`, else behind the administrator password
/// prompt. Fails as [`run_behind_administrator_prompt`] does, and with
/// [`AdministratorPromptError::Refused`] when the command run directly exits with a failure.
pub(crate) async fn run_root_step(
    spawner: &Spawner,
    step: &'static str,
    command: &[&OsStr],
    runs_as_root: bool,
) -> Result<String, AdministratorPromptError> {
    if !runs_as_root {
        return run_behind_administrator_prompt(spawner, step, command).await;
    }
    let (program, arguments) = command
        .split_first()
        .expect("every root step names its program");
    let mut root_command = Command::new(program);
    root_command.args(arguments);
    let stdout = run_to_end(spawner, step, root_command).await?;
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

async fn run_script(
    spawner: &Spawner,
    step: &'static str,
    script: &str,
    command: &[&OsStr],
) -> Result<String, AdministratorPromptError> {
    let mut osascript = Command::new(OSASCRIPT_PROGRAM);
    osascript.arg("-e").arg(script).args(command);
    let stdout = run_to_end(spawner, step, osascript).await?;
    let answer = String::from_utf8_lossy(&stdout);
    let answer = answer.strip_suffix('\n').unwrap_or(&answer);
    let (number, text) = answer.split_once('\n').unwrap_or((answer, ""));
    let Ok(number) = number.parse::<i64>() else {
        return Err(AdministratorPromptError::Refused {
            step,
            status: ExitStatus::default(),
            message: format!("osascript answered no error number: {answer}"),
        });
    };
    match number {
        0 => Ok(text.to_owned()),
        USER_CANCELED_NUMBER => Err(AdministratorPromptError::Canceled),
        _ => Err(AdministratorPromptError::AdministratorRefused {
            step,
            number,
            message: text.trim().to_owned(),
        }),
    }
}

// Starts `command` on `spawner`'s thread with no input, waits for it and answers its standard
// output; an exit with a failure is refused with its status and its error stream.
async fn run_to_end(
    spawner: &Spawner,
    step: &'static str,
    mut command: Command,
) -> Result<Vec<u8>, AdministratorPromptError> {
    let start_failure = |source| AdministratorPromptError::Start { step, source };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    prepare_child_command(&mut command, std::process::id());
    let child = spawner
        .run(move || command.spawn())
        .await
        .map_err(start_failure)?
        .map_err(start_failure)?;
    let Output {
        status,
        stdout,
        stderr,
    } = child.wait_with_output().await.map_err(start_failure)?;
    if !status.success() {
        return Err(AdministratorPromptError::Refused {
            step,
            status,
            message: String::from_utf8_lossy(&stderr).trim().to_owned(),
        });
    }
    Ok(stdout)
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
    /// value of the wake helper's or the system service's root step is ever read as script or
    /// shell text. Mutation: join the arguments without `quoted form`.
    #[tokio::test]
    async fn the_administrator_prompt_passes_a_path_as_one_word() {
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
