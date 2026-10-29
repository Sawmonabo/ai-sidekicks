//! `sidekicks crash list`: the crash reports this computer keeps, newest first as the daemon
//! sends them, a few lines each: when it crashed in the person's hour cycle, the process type, both
//! versions, the platform, the panic's message and place when a panic ended it, and the stack as
//! `module+offset`, one frame a line.

use std::io::Write;

use clap::Subcommand;
use sidekicks_contracts::daemon::status::{CrashReport, DaemonCrashReportList};
use sidekicks_contracts::method_descriptor::EmptyPayload;

use crate::command_context::CommandContext;
use crate::connected_command::run_connected;
use crate::exit_codes::ExitCode;
use crate::local_time::LocalClock;

/// The `crash` commands.
#[derive(Debug, Subcommand)]
pub(crate) enum CrashCommand {
    /// List the crash reports this computer keeps, newest first.
    List,
}

/// Runs a `crash` command and answers its exit code. Fails as the daemon call, the read of the
/// person's time zone or hour cycle, or the write to stdout does.
pub(crate) fn run_crash_command<Output: Write, ErrorOutput: Write>(
    command: &CrashCommand,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    match command {
        CrashCommand::List => list_crash_reports(context),
    }
}

fn list_crash_reports<Output: Write, ErrorOutput: Write>(
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let clock = LocalClock::read()?;
    let response = run_connected(async |connection, cancel| {
        Ok(connection
            .client()
            .call_until::<DaemonCrashReportList>(&EmptyPayload {}, cancel)
            .await?)
    })?;
    // A blank line between reports.
    let text = response
        .reports
        .iter()
        .map(|report| describe_crash_report(report, &clock))
        .collect::<Vec<_>>()
        .join("\n");
    context.stdout.write_all(text.as_bytes())?;
    context.stdout.flush()?;
    Ok(ExitCode::Success)
}

/// `report`'s lines, each ended by a newline, its time on the person's `clock`.
fn describe_crash_report(report: &CrashReport, clock: &LocalClock) -> String {
    let crashed_at = clock.date_and_time(&report.crashed_at);
    let mut lines = vec![
        format!("{crashed_at}  {}", report.process_type.as_str()),
        format!(
            "  app {} · service {} · {}",
            report.app_version.as_str(),
            report.service_version.as_str(),
            report.platform.as_str()
        ),
    ];
    if let Some(panic) = &report.panic {
        lines.push(format!(
            "  panicked at {}: {}",
            panic.location.as_str(),
            panic.message.as_str()
        ));
    }
    lines.extend(
        report
            .stack
            .as_slice()
            .iter()
            .map(|frame| format!("  {}+{:#x}", frame.module.as_str(), frame.offset.get())),
    );
    lines.into_iter().map(|line| line + "\n").collect()
}
