//! The `sidekicks-command-askpass` mode git and ssh run, by its link's name, when a command an
//! agent runs needs an answer from the person: a password, a key's passphrase or whether to trust a
//! host's key. It tells the daemon over the conversation's channel that its prompt is open, the
//! prompt's words being its own argument, which the daemon reads; it prints the answer the daemon
//! seals back as one line and exits 0, and exits 1 printing nothing for an empty answer, the end of
//! input, as a closed prompt window does, so git or ssh reads the prompt as canceled.

use std::env::consts::EXE_SUFFIX;
use std::ffi::OsString;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use sidekicks_std::standard_error::write_error_line;

use crate::command::channel::party::{ChannelParty, PartyStart};
use crate::command::channel::{DaemonRequest, PartyRecord};

/// The name of the link git and ssh run as their askpass, which reaches this mode.
pub const COMMAND_ASKPASS_PROGRAM_NAME: &str = "sidekicks-command-askpass";

/// The variable that keeps git from asking on a terminal, and its value, as git's own calls set it.
pub(crate) use sidekicks_workspace::git::process::GIT_TERMINAL_PROMPT_OFF;

/// The command askpass's link beside `daemon_program`, the running daemon's own program.
pub fn command_askpass_program_path(daemon_program: &Path) -> PathBuf {
    daemon_program.with_file_name(format!("{COMMAND_ASKPASS_PROGRAM_NAME}{EXE_SUFFIX}"))
}

/// The variables that send a command's git and ssh prompts to the askpass at
/// `askpass_program`, which raises them on the command's row.
pub(crate) fn command_prompt_environment(askpass_program: &Path) -> [(&'static str, String); 3] {
    let program = askpass_program.to_string_lossy().into_owned();
    [
        ("GIT_ASKPASS", program.clone()),
        ("SSH_ASKPASS", program),
        ("SSH_ASKPASS_REQUIRE", "force".to_owned()),
    ]
}

/// Runs the askpass with this process's own arguments: 0 having printed the answer, 1 with nothing
/// printed when no channel is named, the channel fails or the answer is the end of input.
pub fn run_command_askpass() -> ExitCode {
    let process_arguments: Vec<OsString> = std::env::args_os().collect();
    match ask_daemon(&process_arguments) {
        Ok(Some(answer)) => {
            let mut output = io::stdout().lock();
            match writeln!(output, "{answer}").and_then(|()| output.flush()) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    write_error_line(&format!(
                        "sidekicks-command-askpass could not print its answer: {error}"
                    ));
                    ExitCode::FAILURE
                }
            }
        }
        Ok(None) => ExitCode::FAILURE,
        Err(error) => {
            write_error_line(&format!(
                "sidekicks-command-askpass could not reach the daemon, so the prompt is canceled: \
                 {error}"
            ));
            ExitCode::FAILURE
        }
    }
}

/// Joins the channel, tells the daemon the prompt is open, and waits for its answer; `None` for
/// no channel or the end of input. Fails with the channel's error.
fn ask_daemon(process_arguments: &[OsString]) -> io::Result<Option<String>> {
    let party = match ChannelParty::join(process_arguments)? {
        PartyStart::Joined(party) => party,
        PartyStart::Unchanneled => return Ok(None),
    };
    let ChannelParty {
        mut records,
        mut requests,
    } = *party;
    records.send(&PartyRecord::Asking {})?;
    loop {
        match requests.next_request(None).map_err(io::Error::other)? {
            Some(DaemonRequest::Answer { text }) => {
                return Ok(Some(text).filter(|text| !text.is_empty()));
            }
            Some(DaemonRequest::Go {} | DaemonRequest::Stop {}) | None => {}
        }
    }
}

#[cfg(test)]
mod tests;
