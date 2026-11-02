//! `sidekicks data restore <backup>`: with the background service stopped and the person's yes,
//! the daemon's own program puts back what the backup holds. The question names when the backup
//! was taken, read from its manifest; `--yes` skips both. The service is left stopped.

use std::ffi::OsString;
use std::io::Write;
use std::path::{self, Path, PathBuf};

use anyhow::Context as _;
use clap::Args;
use sidekicks_contracts::daemon::backup::{
    BackupManifest, DATABASE_RESTORE_MODE, read_backup_manifest,
};
use tokio_util::sync::CancellationToken;

use crate::command_context::CommandContext;
use crate::commands::data::offline_mode::run_offline_command;
use crate::confirmation::{ConfirmationArgs, confirm};
use crate::exit_codes::{CommandFailure, ExitCode};
use crate::local::time::LocalClock;

/// The `data restore` command's argument and option.
#[derive(Debug, Args)]
pub(crate) struct RestoreArgs {
    /// The backup's folder, which holds its manifest and its copy of the data.
    backup: PathBuf,
    #[command(flatten)]
    confirmation: ConfirmationArgs,
}

/// Restores the backup, resolved against the working folder, once the person confirms, and
/// answers success, with the done line on stdout when the restore ran. Fails with
/// [`CommandFailure::BackupUnreadable`] when the question cannot name the backup, and as
/// [`run_offline_command`] does: refused while the service runs, the confirmation unanswerable,
/// the restore refused (with `--yes`, a folder holding no backup as `daemon.backup.notFound`) or
/// failed, or a write to the output failing.
pub(crate) fn restore_data<Output: Write, ErrorOutput: Write>(
    args: &RestoreArgs,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let backup = path::absolute(&args.backup)
        .with_context(|| format!("could not resolve {}", args.backup.display()))?;
    let mut mode_arguments = DATABASE_RESTORE_MODE.map(OsString::from).to_vec();
    mode_arguments.push(backup.clone().into_os_string());
    let prompt = &mut context.stderr;
    let is_restored = run_offline_command(
        "restore",
        async |cancel: &CancellationToken| {
            if args.confirmation.yes {
                return Ok(true);
            }
            let manifest = read_manifest(&backup)?;
            let question = format!(
                "Restore the backup from {}? What this app keeps now is replaced by the backup's \
                 copy.",
                LocalClock::read()?.date_and_time(&manifest.taken_at)
            );
            confirm(&question, &args.confirmation, prompt, cancel).await
        },
        mode_arguments,
    )?;
    if is_restored {
        context.stdout.write_all(
            b"Restored the backup. Start the background service with sidekicks daemon start.\n",
        )?;
        context.stdout.flush()?;
    }
    Ok(ExitCode::Success)
}

/// The manifest in the folder `backup`, read and checked. Fails with
/// [`CommandFailure::BackupUnreadable`] when it is missing, does not read, does not parse or
/// breaks a manifest's rules.
fn read_manifest(backup: &Path) -> anyhow::Result<BackupManifest> {
    let unreadable = |source| CommandFailure::BackupUnreadable {
        backup: backup.to_path_buf(),
        source,
    };
    read_backup_manifest(backup)
        .map_err(|failure| unreadable(Some(failure)))?
        .ok_or_else(|| unreadable(None).into())
}
