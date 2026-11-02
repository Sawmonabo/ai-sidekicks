//! The `data` commands, which act on everything the background service keeps for the person.

pub(crate) mod erase;
pub(crate) mod export;
pub(crate) mod offline_mode;
pub(crate) mod restore;

use std::io::Write;

use clap::Subcommand;

use crate::command_context::CommandContext;
use crate::commands::data::erase::{EraseArgs, erase_data};
use crate::commands::data::export::{ExportArgs, export_data};
use crate::commands::data::restore::{RestoreArgs, restore_data};
use crate::exit_codes::ExitCode;

/// The `data` commands.
#[derive(Debug, Subcommand)]
pub(crate) enum DataCommand {
    /// Erase everything this app keeps on this computer, with the background service stopped.
    Erase(EraseArgs),
    /// Export every session and the files they hold into a new folder.
    Export(ExportArgs),
    /// Put back what a backup holds, with the background service stopped.
    Restore(RestoreArgs),
}

/// Runs a `data` command and answers its exit code; fails as the command does.
pub(crate) fn run_data_command<Output: Write, ErrorOutput: Write>(
    command: &DataCommand,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    match command {
        DataCommand::Erase(args) => erase_data(args, context),
        DataCommand::Export(args) => export_data(args, context),
        DataCommand::Restore(args) => restore_data(args, context),
    }
}
