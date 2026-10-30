//! `sidekicks daemon status`: the background service's own facts, as text on the person's clock or
//! with `--json` as the service sent them, the exit saying whether it serves (0) or serves with a
//! fault (1). A service on a protocol this command does not speak gets one line naming both
//! protocols; a service that is not answering, where it wrote down why its start failed, gets that
//! reason in place of the client's line, and exits 69 either way.

use std::fs;
use std::io::{self, Write};

use anyhow::Context as _;
use clap::Args;
use garde::Validate as _;
use serde::Deserialize;
use serde_json::value::{RawValue, to_raw_value};
use sidekicks_client::daemon_connection::DaemonConnection;
use sidekicks_client::error::ClientError;
use sidekicks_client::transport::json_rpc::RawRequest;
use sidekicks_contracts::daemon::recovery::{
    DaemonRecoverySession, DaemonRecoverySessionState, DaemonRecoveryState, DaemonRecoveryStatus,
};
use sidekicks_contracts::daemon::service_status::{DaemonCannotStart, ServiceStatusFile};
use sidekicks_contracts::daemon::status::{
    DaemonMachineKey, DaemonMachineKeyState, DaemonProcessState, DaemonRelayDevice,
    DaemonRelayStatus, DaemonSecretsFile, DaemonSecretsFileUnopened, DaemonStatusRead,
    DaemonStatusReadResponse, DaemonWslDistribution, DaemonWslDistributionStatus,
};
use sidekicks_contracts::jsonrpc::negotiation::CURRENT_PROTOCOL_VERSION;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_platforms::daemon_run_folder;
use tokio_util::sync::CancellationToken;

use crate::command_context::CommandContext;
use crate::connected_command::run_connected;
use crate::exit_codes::ExitCode;
use crate::local_time::LocalClock;

/// `daemon status`'s options.
#[derive(Debug, Args)]
pub(crate) struct StatusArgs {
    /// Write the background service's reply as JSON, exactly as it sent it.
    #[arg(long)]
    json: bool,
}

/// Shows the background service's status and answers the exit its state names. Fails as the
/// connection, the call, a reply that does not read, or the write to stdout does; a service not
/// answering whose status file names why writes that reason to stderr and answers 69.
pub(crate) fn show_status<Output: Write, ErrorOutput: Write>(
    args: &StatusArgs,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let clock = if args.json {
        None
    } else {
        Some(LocalClock::read()?)
    };
    let reply =
        match run_connected(async |connection, cancel| read_status(connection, cancel).await) {
            Ok(reply) => reply,
            Err(failure) => return report_cannot_start(failure, context),
        };
    write_status(&reply, clock.as_ref(), &mut context.stdout)
}

/// The status reply as the service sent it, and whether this command speaks its protocol.
enum StatusReply {
    /// The service speaks this command's protocol.
    Compatible(Box<RawValue>),
    /// The service speaks another protocol, named.
    Incompatible {
        json: Box<RawValue>,
        service_protocol: String,
    },
}

/// Reads `daemon.status.read` unread, so `--json` writes the reply as sent and a service on
/// another protocol, whose other members may not read here, still names its state.
async fn read_status(
    connection: &DaemonConnection,
    cancel: &CancellationToken,
) -> anyhow::Result<StatusReply> {
    let request = RawRequest {
        descriptor: const { &<DaemonStatusRead as Method>::DESCRIPTOR },
        params: Some(to_raw_value(&EmptyPayload {})?),
        attachments: Vec::new(),
    };
    let reply = connection.client().call_raw(request, cancel).await?;
    let handshake = connection.initialize_response();
    Ok(if handshake.compatible {
        StatusReply::Compatible(reply.json)
    } else {
        StatusReply::Incompatible {
            json: reply.json,
            service_protocol: handshake.protocol_version.as_str().to_owned(),
        }
    })
}

/// Writes `reply` to `stdout` in one write, as JSON when `clock` is `None` and else as text on
/// `clock`, and answers the exit its state names. A compatible reply is read whole and held to its
/// contract before anything is written; fails as that read or the write does.
fn write_status(
    reply: &StatusReply,
    clock: Option<&LocalClock>,
    stdout: &mut impl Write,
) -> anyhow::Result<ExitCode> {
    let (text, code) = match reply {
        StatusReply::Compatible(json) => {
            let response = serde_json::from_str::<DaemonStatusReadResponse>(json.get())
                .context("the background service's status does not read")?;
            response
                .validate()
                .context("the background service's status breaks its contract")?;
            let text = match clock {
                None => format!("{}\n", json.get()),
                Some(clock) => describe_status(&response, clock),
            };
            (text, exit_code_for_state(Some(response.process_state)))
        }
        StatusReply::Incompatible {
            json,
            service_protocol,
        } => {
            let text = match clock {
                None => format!("{}\n", json.get()),
                Some(_) => format!(
                    "The background service speaks protocol {service_protocol}; this command \
                     speaks {CURRENT_PROTOCOL_VERSION}. Update the one that is older.\n"
                ),
            };
            (text, exit_code_for_state(read_process_state(json)))
        }
    };
    stdout.write_all(text.as_bytes())?;
    stdout.flush()?;
    Ok(code)
}

/// The service's state from a reply on another protocol, read alone; `None` where it is absent or
/// a state this command does not know.
fn read_process_state(json: &RawValue) -> Option<DaemonProcessState> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StatusState {
        process_state: serde_json::Value,
    }

    let state = serde_json::from_str::<StatusState>(json.get()).ok()?;
    serde_json::from_value(state.process_state).ok()
}

/// The exit a status ends with: 1 for a service serving with a fault, else 0, a state this command
/// cannot read among them, since it names no fault.
fn exit_code_for_state(state: Option<DaemonProcessState>) -> ExitCode {
    match state {
        Some(DaemonProcessState::Degraded) => ExitCode::Unhealthy,
        Some(
            DaemonProcessState::Running
            | DaemonProcessState::Starting
            | DaemonProcessState::Stopping,
        )
        | None => ExitCode::Success,
    }
}

/// Where `failure` is the service not answering and its status file names why its start failed,
/// writes that reason to stderr and answers 69; otherwise answers `failure` itself, with why the
/// status file did not read where it is there but does not.
fn report_cannot_start<Output: Write, ErrorOutput: Write>(
    failure: anyhow::Error,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let is_not_answering = matches!(
        failure
            .chain()
            .find_map(|cause| cause.downcast_ref::<ClientError>()),
        Some(ClientError::Unavailable { .. })
    );
    if !is_not_answering {
        return Err(failure);
    }
    let cannot_start = match read_cannot_start() {
        Ok(Some(cannot_start)) => cannot_start,
        Ok(None) => return Err(failure),
        Err(unread) => return Err(failure.context(format!("{unread:#}"))),
    };
    let lines = describe_cannot_start(&cannot_start);
    context.stderr.write_all(lines.as_bytes())?;
    context.stderr.flush()?;
    Ok(ExitCode::Unavailable)
}

/// Why the service's last start failed, from its status file; `None` where it wrote none.
pub(crate) fn read_cannot_start() -> anyhow::Result<Option<DaemonCannotStart>> {
    let run_folder = daemon_run_folder()
        .context("could not find where the background service records why it cannot start")?;
    let path = &run_folder.status_path;
    let text = match fs::read(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "could not read why the background service cannot start from {}",
                    path.display()
                )
            });
        }
    };
    let file = serde_json::from_slice::<ServiceStatusFile>(&text).with_context(|| {
        format!(
            "could not read why the background service cannot start from {}",
            path.display()
        )
    })?;
    Ok(Some(file.cannot_start))
}

/// The reason's lines, each ended by a newline: one sentence, or a title over one line.
pub(crate) fn describe_cannot_start(cannot_start: &DaemonCannotStart) -> String {
    let lines = match cannot_start {
        DaemonCannotStart::ConnectionNameTaken {} => vec![
            "The background service cannot start because another program on this computer is \
             using its connection. Restarting Windows usually clears it."
                .to_owned(),
        ],
        DaemonCannotStart::TurnedOffInLoginItems {} => vec![
            "The background service cannot start because it is turned off in Login Items. Turn \
             it on in System Settings, then it starts on its own."
                .to_owned(),
        ],
        DaemonCannotStart::SavedSessionsUnrepaired { aside_folder } => vec![
            "Saved sessions could not be repaired".to_owned(),
            "Nothing was changed; restore a backup to go on.".to_owned(),
            format!("Folder  {}", aside_folder.as_str()),
        ],
        DaemonCannotStart::SavedSessionsFromAnotherVersion {} => vec![
            "Saved sessions are from another version".to_owned(),
            "Open the app version that saved them, or restore a backup.".to_owned(),
        ],
    };
    ended_lines(&lines)
}

/// The status as text on `clock`: the service's own lines, then each block it carries, a blank
/// line between blocks.
fn describe_status(response: &DaemonStatusReadResponse, clock: &LocalClock) -> String {
    let mut blocks = vec![describe_service(response, clock)];
    if let Some(relay) = &response.relay
        && let Some(block) = describe_relay(relay)
    {
        blocks.push(block);
    }
    if let Some(wsl) = &response.wsl {
        blocks.push(describe_wsl(wsl.as_slice(), clock));
    }
    if let Some(secrets_file) = &response.secrets_file {
        blocks.push(describe_secrets_file(secrets_file));
    }
    if let Some(machine_key) = response.machine_key {
        blocks.push(describe_machine_key(machine_key));
    }
    blocks
        .iter()
        .map(|block| ended_lines(block))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The service's own lines: its state, start, uptime and version, then each fact on a labelled
/// row, its readings with their times, and its recovery.
fn describe_service(response: &DaemonStatusReadResponse, clock: &LocalClock) -> Vec<String> {
    let state = match response.process_state {
        DaemonProcessState::Running => "Running",
        DaemonProcessState::Starting => "Starting",
        DaemonProcessState::Stopping => "Stopping",
        DaemonProcessState::Degraded => "Degraded",
    };
    let processor = response.processor.as_ref().map_or_else(
        || "Not read yet".to_owned(),
        |reading| {
            format!(
                "{} · Last updated {}",
                describe_percent(reading.percent.get()),
                clock.time(&reading.read_at)
            )
        },
    );
    let memory = response.memory.as_ref().map_or_else(
        || "Not read yet".to_owned(),
        |reading| {
            format!(
                "{} · Last updated {}",
                describe_byte_count(reading.resident_bytes.get()),
                clock.time(&reading.read_at)
            )
        },
    );
    let mut lines = vec![
        format!(
            "{state} · started {} · up {} · version {}",
            clock.date_and_time(&response.started_at),
            describe_duration(response.uptime_ms.get()),
            response.version.as_str()
        ),
        format!("Protocol  {}", response.protocol_version.as_str()),
        format!("Process  {}", response.process_identity.process_id.get()),
        format!("Listening at  {}", response.transport_endpoint.as_str()),
        format!("Data folder  {}", response.data_directory.as_str()),
        format!("Processor  {processor}"),
        format!("Memory  {memory}"),
    ];
    lines.extend(describe_recovery(&response.recovery, clock));
    lines
}

/// The recovery's line, then one line under it for each session that is not healthy.
fn describe_recovery(recovery: &DaemonRecoveryStatus, clock: &LocalClock) -> Vec<String> {
    let overall = match recovery.overall {
        DaemonRecoveryState::Healthy => "Every session takes writes",
        DaemonRecoveryState::Rebuilding => {
            "Rebuilding sessions after the restart; writes wait until it finishes"
        }
        DaemonRecoveryState::Degraded => "Some sessions have damaged history",
        DaemonRecoveryState::Blocked => "Saved sessions cannot be reached; nothing can be written",
    };
    let mut lines = vec![format!("Recovery  {overall}")];
    lines.extend(
        recovery
            .sessions
            .iter()
            .map(|session| describe_recovery_session(session, clock)),
    );
    lines
}

/// One session that is not healthy: its id, where it stands, and the runs that wait on the person.
fn describe_recovery_session(session: &DaemonRecoverySession, clock: &LocalClock) -> String {
    let mut parts = vec![session.session_id.to_string()];
    match session.state {
        DaemonRecoverySessionState::Rebuilding => parts.push("rebuilding".to_owned()),
        DaemonRecoverySessionState::Degraded => {
            parts.push("damaged history".to_owned());
            if let Some(sequence) = session.last_applied_sequence {
                let at = session
                    .last_applied_at
                    .as_ref()
                    .map(|instant| format!(" from {}", clock.date_and_time(instant)))
                    .unwrap_or_default();
                parts.push(format!("opens at event {}{at}", sequence.get()));
            }
            if let Some(sequence) = session.damaged_from_sequence {
                parts.push(format!("damaged from event {}", sequence.get()));
            }
        }
        DaemonRecoverySessionState::Damaged => parts.push("no event can be read".to_owned()),
        DaemonRecoverySessionState::Blocked => parts.push("a run waits on you".to_owned()),
    }
    if let Some(runs) = &session.halted_runs {
        parts.push(count_of(runs.len(), "run needs you", "runs need you"));
    }
    format!("  {}", parts.join(" · "))
}

/// The relay block: each linked device, then the refused pin; `None` with neither, since the block
/// is never printed empty.
fn describe_relay(relay: &DaemonRelayStatus) -> Option<Vec<String>> {
    if relay.devices.is_empty() && !relay.pin_refused {
        return None;
    }
    let mut lines = vec!["Relay".to_owned()];
    lines.extend(relay.devices.iter().map(describe_relay_device));
    if relay.pin_refused {
        lines.push(
            "  refused: the relay's key does not match the one pinned when it was linked"
                .to_owned(),
        );
    }
    Some(lines)
}

/// One linked device: `iPhone · connected · out 0.4 s · in 0.2 s · reconnects 1 · rejected 0`,
/// each frame's age only once a frame went that way.
fn describe_relay_device(device: &DaemonRelayDevice) -> String {
    let mut parts = vec![
        device.name.as_str().to_owned(),
        if device.connected {
            "connected"
        } else {
            "not connected"
        }
        .to_owned(),
    ];
    if let Some(age) = device.last_frame_out_age_ms {
        parts.push(format!("out {}", describe_duration(age.get())));
    }
    if let Some(age) = device.last_frame_in_age_ms {
        parts.push(format!("in {}", describe_duration(age.get())));
    }
    parts.push(format!("reconnects {}", device.reconnect_count.get()));
    parts.push(format!("rejected {}", device.rejected_frame_count.get()));
    format!("  {}", parts.join(" · "))
}

/// The WSL block: `Ubuntu: running · 3 sessions`, `Arch: not answering since 2:14 PM`.
fn describe_wsl(distributions: &[DaemonWslDistribution], clock: &LocalClock) -> Vec<String> {
    let mut lines = vec!["WSL".to_owned()];
    lines.extend(distributions.iter().map(|distribution| {
        let sessions = count_of(
            usize::try_from(distribution.session_count.get()).unwrap_or(usize::MAX),
            "session",
            "sessions",
        );
        let stands = match &distribution.status {
            DaemonWslDistributionStatus::Running {} => format!("running · {sessions}"),
            DaemonWslDistributionStatus::Stopped {} => format!("stopped · {sessions}"),
            DaemonWslDistributionStatus::NotAnswering { since } => {
                format!("not answering since {}", clock.time(since))
            }
        };
        format!("  {}: {stands}", distribution.distro.as_str())
    }));
    lines
}

/// The secrets file's notice: a title over one line, then the file's path on its own row.
fn describe_secrets_file(secrets_file: &DaemonSecretsFile) -> Vec<String> {
    let (title, line, path) = match secrets_file {
        DaemonSecretsFile::SealedWithChip { path, cannot_open } => (
            sealed_title(*cannot_open),
            cannot_open.map_or(
                "Encrypted with the security chip. A disk copy cannot read them.",
                unopened_line,
            ),
            path,
        ),
        DaemonSecretsFile::SealedWithSystemKey { path, cannot_open } => (
            sealed_title(*cannot_open),
            cannot_open.map_or(
                "Encrypted with a system key. A full disk copy could read them.",
                unopened_line,
            ),
            path,
        ),
        DaemonSecretsFile::Plain { path, .. } => (
            "Secrets stored without encryption",
            "Only this account can read them.",
            path,
        ),
    };
    vec![
        title.to_owned(),
        line.to_owned(),
        format!("File  {}", path.as_str()),
    ]
}

fn sealed_title(cannot_open: Option<DaemonSecretsFileUnopened>) -> &'static str {
    match cannot_open {
        None => "Secrets sealed to this computer",
        Some(_) => "Secrets cannot be opened",
    }
}

/// What the person does while the sealed file cannot be opened, by its cause.
fn unopened_line(cannot_open: DaemonSecretsFileUnopened) -> &'static str {
    match cannot_open {
        DaemonSecretsFileUnopened::KeyChanged => {
            "From another device, remove this computer, then link it again."
        }
        DaemonSecretsFileUnopened::ChipUnavailable => {
            "The security chip is off. Turn it on in the firmware settings."
        }
        DaemonSecretsFileUnopened::SealServiceMissing => {
            "Update the system, or relink this computer from another device."
        }
        DaemonSecretsFileUnopened::SealServiceFailing => {
            "Secrets cannot be read right now. Restart this computer."
        }
    }
}

/// Where this computer's keys for other devices stand, then what the person does about it.
fn describe_machine_key(machine_key: DaemonMachineKey) -> Vec<String> {
    let stands = match machine_key.state {
        DaemonMachineKeyState::Reading => "Still being read",
        DaemonMachineKeyState::NotMinted => "None could be read or made",
        DaemonMachineKeyState::Lost => "The key this computer made is gone",
        DaemonMachineKeyState::Changed => "A different key replaced the one this computer made",
    };
    let mut lines = vec![format!("Keys for other devices  {stands}")];
    lines.extend(machine_key.action().map(str::to_owned));
    lines
}

/// `count` with the noun its number takes: `1 session`, `3 sessions`.
fn count_of(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// A share of the machine in percent: whole where it is, else to one decimal, `3%`, `0.4%`.
fn describe_percent(percent: f64) -> String {
    let rounded = (percent * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}%")
    } else {
        format!("{rounded:.1}%")
    }
}

/// A byte count in the largest binary unit it reaches, to one decimal under 100: `212 MiB`,
/// `1.5 GiB`, `512 B`.
fn describe_byte_count(byte_count: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    #[expect(
        clippy::cast_precision_loss,
        reason = "a safe integer of bytes, shown to one decimal at most"
    )]
    let mut scaled = byte_count as f64;
    let mut unit = 0;
    while scaled >= 1024.0 && unit < UNITS.len() - 1 {
        scaled /= 1024.0;
        unit += 1;
    }
    if unit == 0 || (scaled * 10.0).round() / 10.0 >= 100.0 {
        format!("{scaled:.0} {}", UNITS[unit])
    } else {
        format!("{scaled:.1} {}", UNITS[unit])
    }
}

/// A duration in milliseconds: tenths of a second under a minute, `0.4 s`, else whole units from
/// the hour down, `6 m 41 s`, `3 h 12 m 5 s`, each truncated so a span never claims a boundary it
/// did not cross.
fn describe_duration(milliseconds: u64) -> String {
    if milliseconds < 60_000 {
        let tenths = milliseconds / 100;
        return format!("{}.{} s", tenths / 10, tenths % 10);
    }
    let seconds = milliseconds / 1_000;
    let (hours, minutes, seconds) = (seconds / 3_600, seconds % 3_600 / 60, seconds % 60);
    if hours > 0 {
        format!("{hours} h {minutes} m {seconds} s")
    } else {
        format!("{minutes} m {seconds} s")
    }
}

/// `lines`, each ended by a newline.
fn ended_lines(lines: &[String]) -> String {
    lines.iter().map(|line| format!("{line}\n")).collect()
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;
    use serde_json::value::RawValue;
    use sidekicks_contracts::daemon::status::DaemonStatusReadResponse;

    use super::{StatusReply, write_status};
    use crate::exit_codes::ExitCode;

    /// A status reply carrying every member the response has, in `process_state`.
    fn every_member(process_state: &str) -> String {
        json!({
            "processState": process_state,
            "processIdentity": {
                "processId": 4242,
                "bootId": "5f0c6d2e-boot",
                "processStartTime": "1761743760"
            },
            "version": "0.1.0",
            "protocolVersion": "2026-05-01",
            "transportEndpoint": "/run/user/501/ai-sidekicks/daemon.sock",
            "startedAt": "2026-10-29T13:16:00.000Z",
            "uptimeMs": 11_525_000,
            "dataDirectory": "/home/person/.ai-sidekicks",
            "processor": { "percent": 3.5, "readAt": "2026-10-29T16:28:05.000Z" },
            "memory": { "residentBytes": 222_298_112, "readAt": "2026-10-29T16:28:05.000Z" },
            "recovery": {
                "overall": "degraded",
                "sessions": [{
                    "sessionId": "01923c5e-7a1b-7c3d-8e4f-0123456789ab",
                    "state": "degraded",
                    "lastAppliedSequence": 41,
                    "lastAppliedAt": "2026-10-29T12:58:00.000Z",
                    "damagedFromSequence": 42,
                    "failureCategory": "localPersistenceFailure",
                    "recoveryCondition": "recoveryNeeded",
                    "haltedRuns": [{
                        "runId": "01923c5e-7a1b-7c3d-8e4f-0123456789ac",
                        "recoveryCondition": "recoveryNeeded",
                        "failureCategory": "providerFailure"
                    }]
                }]
            },
            "relay": {
                "devices": [{
                    "name": "iPhone",
                    "connected": true,
                    "lastFrameOutAgeMs": 400,
                    "lastFrameInAgeMs": 200,
                    "reconnectCount": 1,
                    "rejectedFrameCount": 0
                }],
                "pinRefused": true
            },
            "wsl": [{
                "distro": "Ubuntu",
                "status": { "state": "notAnswering", "since": "2026-10-29T14:14:00.000Z" },
                "sessionCount": 3
            }],
            "secretsFile": {
                "protection": "sealedWithChip",
                "path": "/home/person/.ai-sidekicks/secrets.json",
                "cannotOpen": "keyChanged"
            },
            "machineKey": { "state": "notMinted", "cause": "locked" }
        })
        .to_string()
    }

    fn written(reply: &StatusReply) -> (String, ExitCode) {
        let mut stdout = Vec::new();
        let code = write_status(reply, None, &mut stdout).expect("the status is written");
        (String::from_utf8(stdout).expect("UTF-8"), code)
    }

    #[test]
    fn a_status_with_every_member_goes_out_unchanged_as_json() {
        let sent = every_member("running");
        let response = serde_json::from_str::<DaemonStatusReadResponse>(&sent)
            .expect("the reply reads as the response");
        assert!(response.relay.is_some() && response.wsl.is_some());
        assert!(response.secrets_file.is_some() && response.machine_key.is_some());
        let reply = StatusReply::Compatible(
            RawValue::from_string(sent.clone()).expect("the reply is JSON"),
        );

        let (stdout, code) = written(&reply);

        assert_eq!(stdout, format!("{sent}\n"));
        assert_eq!(code, ExitCode::Success);
        insta::assert_snapshot!(stdout);
    }

    #[rstest]
    #[case::running("running", ExitCode::Success)]
    #[case::starting("starting", ExitCode::Success)]
    #[case::stopping("stopping", ExitCode::Success)]
    #[case::degraded("degraded", ExitCode::Unhealthy)]
    fn a_status_exits_as_its_state_names(#[case] state: &str, #[case] expected: ExitCode) {
        let reply = StatusReply::Compatible(
            RawValue::from_string(every_member(state)).expect("the reply is JSON"),
        );

        let (_, code) = written(&reply);

        assert_eq!(code, expected);
    }
}
