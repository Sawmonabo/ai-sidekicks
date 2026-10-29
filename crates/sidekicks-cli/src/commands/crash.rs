//! `sidekicks crash list`: the crash reports this computer keeps, newest first as the daemon
//! sends them, a few lines each: when it crashed in the person's hour cycle, the process type, both
//! versions, the platform, the panic's message and place when a panic ended it, and the stack as
//! `module+offset`, one frame a line.

use std::io::Write;

use anyhow::Context as _;
use clap::Subcommand;
use icu_locale_core::preferences::extensions::unicode::keywords::HourCycle;
use jiff::Zoned;
use jiff::tz::TimeZone;
use sidekicks_contracts::daemon::status::{CrashReport, DaemonCrashReportList};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_platforms::system_hour_cycle;

use crate::command_context::CommandContext;
use crate::connected_command::run_connected;
use crate::exit_codes::ExitCode;

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
    let time_zone = TimeZone::try_system().context("could not read this computer's time zone")?;
    let hour_cycle = system_hour_cycle().context("could not read how this computer shows times")?;
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
        .map(|report| describe_crash_report(report, &time_zone, hour_cycle))
        .collect::<Vec<_>>()
        .join("\n");
    context.stdout.write_all(text.as_bytes())?;
    context.stdout.flush()?;
    Ok(ExitCode::Success)
}

/// `report`'s lines, each ended by a newline, its time in `time_zone` and `hour_cycle`.
fn describe_crash_report(
    report: &CrashReport,
    time_zone: &TimeZone,
    hour_cycle: HourCycle,
) -> String {
    let crashed_at = report.crashed_at.timestamp().map_or_else(
        || report.crashed_at.as_str().to_owned(),
        |instant| clock_time(&instant.to_zoned(time_zone.clone()), hour_cycle),
    );
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

/// `zoned` as its date and its time of day on the person's clock: `14:05` on a 24-hour clock,
/// `2:05 PM` on a 12-hour one, `0:05 PM` on the one that counts from 0 to 11.
fn clock_time(zoned: &Zoned, hour_cycle: HourCycle) -> String {
    let (date, hour, minute) = (zoned.date(), zoned.hour(), zoned.minute());
    if hour_cycle == HourCycle::H23 || hour_cycle == HourCycle::Clock24 {
        return format!("{date} {hour:02}:{minute:02}");
    }
    let period = if hour < 12 { "AM" } else { "PM" };
    let shown_hour = if hour_cycle == HourCycle::H11 {
        hour % 12
    } else {
        (hour + 11) % 12 + 1
    };
    format!("{date} {shown_hour}:{minute:02} {period}")
}
