//! `sidekicks open <address>`: hands a `sidekicks://` address to the app the system registered for
//! it. Only the exact address form the app writes is passed on, so no other address or path ever
//! reaches the system's opener.

use std::io;

use anyhow::Context as _;
use clap::error::ErrorKind;
use clap::{Args, CommandFactory as _};
use sidekicks_contracts::app_link::parse_app_link;

use crate::exit_codes::ExitCode;
use crate::program::Cli;

/// The `open` command's argument.
#[derive(Debug, Args)]
pub(crate) struct OpenArgs {
    /// The `sidekicks://` address of a session or a workflow run.
    address: String,
}

/// No app on this computer is registered for `sidekicks://` addresses.
#[derive(Debug, thiserror::Error)]
#[error(
    "No app on this computer opens sidekicks:// addresses. Install the AI Sidekicks app, then try \
     again."
)]
pub(crate) struct AddressHandlerMissingError;

/// Opens the address through the system and answers success. Fails with clap's usage refusal
/// when the argument is not a `sidekicks://` address, with [`AddressHandlerMissingError`] when no
/// app is registered for one, and as the system's call fails otherwise.
pub(crate) fn open(args: &OpenArgs) -> anyhow::Result<ExitCode> {
    open_with(&args.address, sidekicks_platforms::open_address)
}

/// [`open`] with the system's opener passed in, which is called only with an address the app's
/// parser accepts.
fn open_with(
    address: &str,
    opener: impl FnOnce(&str) -> io::Result<()>,
) -> anyhow::Result<ExitCode> {
    if parse_app_link(address).is_none() {
        let mut command = Cli::command();
        // Built first, so the subcommand's usage names the program before it.
        command.build();
        let open_command = command
            .find_subcommand_mut("open")
            .expect("the program has the open command");
        return Err(open_command
            .error(
                ErrorKind::ValueValidation,
                format!("not a sidekicks:// address: {address}"),
            )
            .into());
    }
    match opener(address) {
        Ok(()) => Ok(ExitCode::Success),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Err(AddressHandlerMissingError.into())
        }
        Err(error) => Err(error).context("could not open the address"),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::open_with;
    use crate::command_context::CommandContext;
    use crate::exit_codes::{ExitCode, ProcessEnding};
    use crate::program::report_failure;

    #[test]
    fn open_refuses_an_address_that_is_not_a_sidekicks_one_and_opens_nothing() {
        let was_opened = Cell::new(false);
        let failure = open_with("https://example.com/session/1", |_| {
            was_opened.set(true);
            Ok(())
        })
        .expect_err("the address is refused");
        let mut context = CommandContext {
            stdout: Vec::new(),
            stderr: Vec::new(),
            is_stdout_styled: false,
            is_stderr_styled: false,
        };

        let ending = report_failure(&failure, &mut context);

        assert!(!was_opened.get(), "the opener was called");
        assert_eq!(ending, ProcessEnding::Exit(ExitCode::Usage));
        assert_eq!(context.stdout, b"");
        let stderr = String::from_utf8(context.stderr).expect("UTF-8");
        assert!(
            stderr.contains("Usage: sidekicks open <ADDRESS>"),
            "{stderr}"
        );
    }
}
