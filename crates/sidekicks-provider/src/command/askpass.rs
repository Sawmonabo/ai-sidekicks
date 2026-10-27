//! The `sidekicks-command-askpass` mode git and ssh run, by its link's name, when a command an
//! agent runs needs an answer from the person: a password, a key's passphrase or whether to trust a
//! host's key. It tells the daemon over the conversation's channel that its prompt is open, the
//! prompt's words being its own argument, which the daemon reads; it prints the answer the daemon
//! seals back as one line and exits 0, and exits 1 printing nothing for an empty answer, the end of
//! input, as a closed prompt window does, so git or ssh reads the prompt as canceled.

use std::ffi::OsString;
use std::io::{self, Write as _};
use std::process::ExitCode;

use crate::command::channel::party::{ChannelParty, PartyStart};
use crate::command::channel::{DaemonRequest, PartyRecord};
use sidekicks_std::standard_error::write_error_line;

/// The name of the link git and ssh run as their askpass, which reaches this mode.
pub const COMMAND_ASKPASS_PROGRAM_NAME: &str = "sidekicks-command-askpass";

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
