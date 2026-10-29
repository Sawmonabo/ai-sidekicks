//! The `data` commands, which act on everything the background service keeps for the person.

pub(crate) mod export;

use std::io::Write;

use clap::Subcommand;

use crate::command_context::CommandContext;
use crate::commands::data::export::{ExportArgs, export_data};
use crate::exit_codes::ExitCode;

/// The `data` commands.
#[derive(Debug, Subcommand)]
pub(crate) enum DataCommand {
    /// Export every session and the files they hold into a new folder.
    Export(ExportArgs),
}

/// Runs a `data` command and answers its exit code; fails as the command does.
pub(crate) fn run_data_command<Output: Write, ErrorOutput: Write>(
    command: &DataCommand,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    match command {
        DataCommand::Export(args) => export_data(args, context),
    }
}
