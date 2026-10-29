//! `sidekicks data export <folder>`: the background service exports everything it keeps into a new
//! folder, its progress on stderr one line each time it changes, and the folder it wrote on stdout
//! once it is done. A Ctrl-C stops the export, and the command ends as the Ctrl-C does.

use std::io::Write;
use std::path::{self, PathBuf};

use anyhow::{Context as _, anyhow};
use clap::Args;
use futures::StreamExt as _;
use sidekicks_client::error::ClientError;
use sidekicks_client::transport::json_rpc::JsonRpcClient;
use sidekicks_contracts::daemon::data::{
    DaemonDataExportCancel, DaemonDataExportCancelRequest, DaemonDataExportStart,
    DaemonDataExportStartRequest, DaemonDataExportSubscribe, DaemonDataExportSubscribeRequest,
    DataExportJobId, DataExportProgress,
};
use sidekicks_contracts::free_form_string::FilesystemPath;

use crate::command_context::CommandContext;
use crate::connected_command::run_connected;
use crate::exit_codes::ExitCode;

/// The `data export` command's argument.
#[derive(Debug, Args)]
pub(crate) struct ExportArgs {
    /// The new folder to export into; it must not exist yet.
    folder: PathBuf,
}

/// Exports into the folder, resolved against the working folder, and answers success once the
/// service finished it. Fails as the path cannot be sent, as the service refuses or fails the
/// export, as a write to the output fails, and as a canceled call after a Ctrl-C.
pub(crate) fn export_data<Output: Write, ErrorOutput: Write>(
    args: &ExportArgs,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let folder = path::absolute(&args.folder)
        .with_context(|| format!("could not resolve {}", args.folder.display()))?;
    let destination = folder
        .into_os_string()
        .into_string()
        .map_err(|folder| anyhow!("the folder's path is not text: {}", folder.display()))
        .and_then(|folder| {
            FilesystemPath::new(folder.clone())
                .with_context(|| format!("the folder's path cannot be sent: {folder}"))
        })?;
    let stderr = &mut context.stderr;
    let exported = run_connected(async |connection, cancel| {
        let client = connection.client();
        // Not canceled by the token: an export the service started is canceled by its id below.
        let job_id = client
            .call::<DaemonDataExportStart>(&DaemonDataExportStartRequest { destination })
            .await?
            .job_id;
        let request = DaemonDataExportSubscribeRequest { job_id };
        let (_, mut progress) = tokio::select! {
            opened = client.subscribe::<DaemonDataExportSubscribe>(&request) => opened?,
            () = cancel.cancelled() => return cancel_export(client, job_id).await,
        };
        let mut sessions_total = None;
        loop {
            let emission = tokio::select! {
                emission = progress.next() => emission,
                () = cancel.cancelled() => return cancel_export(client, job_id).await,
            };
            match emission.ok_or_else(|| {
                anyhow!(
                    "the background service stopped telling the export's progress before it ended"
                )
            })?? {
                DataExportProgress::Running {
                    sessions_exported,
                    sessions_total: total,
                } => {
                    sessions_total = Some(total.get());
                    let line = format!(
                        "Exporting… {} of {}.\n",
                        sessions_exported.get(),
                        describe_session_count(total.get())
                    );
                    stderr.write_all(line.as_bytes())?;
                    stderr.flush()?;
                }
                DataExportProgress::Completed { path, .. } => {
                    return Ok(describe_export(sessions_total, path.as_str()));
                }
                DataExportProgress::Failed { message } => {
                    return Err(anyhow!("the export failed: {}", message.as_str()));
                }
                DataExportProgress::Canceled { path } => {
                    return Err(anyhow!(
                        "the export was canceled; {} holds what was written before it stopped",
                        path.as_str()
                    ));
                }
            }
        }
    })?;
    context.stdout.write_all(exported.as_bytes())?;
    context.stdout.flush()?;
    Ok(ExitCode::Success)
}

/// Asks the service to stop `job_id` after the person's Ctrl-C, then fails as the canceled call
/// the Ctrl-C ending is read from; fails as the cancel does when the service refuses it.
async fn cancel_export<T>(client: &JsonRpcClient, job_id: DataExportJobId) -> anyhow::Result<T> {
    // `call`, not `call_until`: the token is already canceled, which would send nothing.
    client
        .call::<DaemonDataExportCancel>(&DaemonDataExportCancelRequest { job_id })
        .await?;
    Err(ClientError::Canceled.into())
}

/// The done line: the sessions the last progress counted, else none named, when the export
/// ended before its first progress reached the command.
fn describe_export(sessions_total: Option<u64>, path: &str) -> String {
    match sessions_total {
        Some(total) => format!("Exported {} to {path}.\n", describe_session_count(total)),
        None => format!("Exported the sessions to {path}.\n"),
    }
}

fn describe_session_count(count: u64) -> String {
    if count == 1 {
        "1 session".to_owned()
    } else {
        format!("{count} sessions")
    }
}
