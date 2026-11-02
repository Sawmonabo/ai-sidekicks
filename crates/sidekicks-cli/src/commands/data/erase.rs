//! `sidekicks data erase`: with the background service stopped and the person's yes, the daemon's
//! own program erases everything this app keeps on this computer. A declined question ends the
//! command with nothing erased and nothing printed.

use std::ffi::OsString;
use std::io::Write;

use clap::Args;
use sidekicks_contracts::daemon::data::DATA_ERASE_MODE;
use tokio_util::sync::CancellationToken;

use crate::command_context::CommandContext;
use crate::commands::data::offline_mode::run_offline_command;
use crate::confirmation::{ConfirmationArgs, confirm};
use crate::exit_codes::ExitCode;

/// The question the erase asks before it changes anything.
const ERASE_QUESTION: &str = "Erase everything this app keeps on this computer? Every session, \
                              file, sidekick, workflow and account sign-in goes. Project folders \
                              stay. Backups you made before keep their copy. This cannot be \
                              undone.";

/// The `data erase` command's option.
#[derive(Debug, Args)]
pub(crate) struct EraseArgs {
    #[command(flatten)]
    confirmation: ConfirmationArgs,
}

/// Erases everything once the person confirms, and answers success, with the done line on stdout
/// when the erase ran. Fails as [`run_offline_command`] does: refused while the service runs, the
/// confirmation unanswerable, the erase refused or partly done, or a write to the output failing.
pub(crate) fn erase_data<Output: Write, ErrorOutput: Write>(
    args: &EraseArgs,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let prompt = &mut context.stderr;
    let is_erased = run_offline_command(
        "erase",
        async |cancel: &CancellationToken| {
            confirm(ERASE_QUESTION, &args.confirmation, prompt, cancel).await
        },
        DATA_ERASE_MODE.map(OsString::from).to_vec(),
    )?;
    if is_erased {
        context
            .stdout
            .write_all(b"Erased everything this app keeps on this computer.\n")?;
        context.stdout.flush()?;
    }
    Ok(ExitCode::Success)
}
