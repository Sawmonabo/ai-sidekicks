//! The telemetry switches each Codex process the daemon launches carries for its kind of home: a
//! service running the daemon's sessions exports its logs to the daemon's receiver with its
//! launch's own token and tag, every exporter off on a read service, on the executor, on the
//! calibration run and on a short command on a home of the daemon's own, and nothing on the
//! person's own folder's terminal service or short commands, which keep the person's own settings.

use serde_json::json;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::service::command_line::write_config_override;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceKind};
use crate::driver::codex::telemetry::exports::CodexExportTag;
use crate::pricing::receiver::bearers::TelemetryBearer;
use crate::pricing::receiver::{LOGS_PATH_SUFFIX, TelemetryTarget};

/// The log exporter's key, set to the daemon's receiver.
const EXPORTER_KEY: &str = "otel.exporter";

/// The log exporter off.
const EXPORTER_OFF: &str = "otel.exporter=\"none\"";

/// The trace exporter off.
const TRACE_EXPORTER_OFF: &str = "otel.trace_exporter=\"none\"";

/// The metrics exporter off, never Codex's own default destination.
const METRICS_EXPORTER_OFF: &str = "otel.metrics_exporter=\"none\"";

/// Every exporter off, in the order a command line carries them.
const EXPORTERS_OFF: [&str; 3] = [EXPORTER_OFF, TRACE_EXPORTER_OFF, METRICS_EXPORTER_OFF];

/// What the daemon's export leaves out of each record: the prompt, tool results, the agent's
/// replies, guardian assessments and streamed deltas.
const RECORD_CONTENT_OFF: [&str; 5] = [
    "otel.log_user_prompt=false",
    "otel.tool_result.max_bytes=0",
    "otel.log_agent_responses=false",
    "otel.log_guardian_assessments=false",
    "otel.log_sse_deltas=false",
];

/// The OTLP/HTTP encoding the receiver reads.
const OTLP_HTTP_PROTOCOL: &str = "binary";

/// The environment variable the log exporter reads its headers from.
const LOGS_HEADERS_VARIABLE: &str = "OTEL_EXPORTER_OTLP_LOGS_HEADERS";

/// The environment variable the SDK reads a process's resource attributes from.
const RESOURCE_ATTRIBUTES_VARIABLE: &str = "OTEL_RESOURCE_ATTRIBUTES";

/// The telemetry switches of one Codex service's launch.
#[derive(Default)]
pub(crate) struct TelemetrySwitches {
    /// The `key=value` switches, each passed after a `-c`.
    pub(crate) config_overrides: Vec<String>,
    /// The environment pairs set on the process, past the withhold of the person's settings.
    pub(crate) environment: Vec<(String, String)>,
    /// The guard of the launch's own token where it exports to the daemon, which the launch's
    /// process keeps until it ends.
    pub(crate) bearer: Option<TelemetryBearer>,
}

/// The switches a service of `service_kind` on a home of `home_kind` launches with: the daemon's
/// export, the launch's own token minted for `tag` and the tag itself where the daemon's sessions
/// run and `target` is registered, every exporter off on a read service and before `target` is
/// registered, and none on the person's own folder's terminal service. Fails when the token
/// cannot be minted.
pub(crate) fn compose_telemetry_switches(
    home_kind: &CodexHomeKind,
    service_kind: CodexServiceKind,
    target: Option<&TelemetryTarget>,
    tag: &CodexExportTag,
) -> Result<TelemetrySwitches, getrandom::Error> {
    match home_kind {
        CodexHomeKind::Account(_) | CodexHomeKind::ApiKeyAccount(_) | CodexHomeKind::Switching => {
            target.map_or_else(
                || Ok(exporters_off()),
                |target| compose_daemon_export(target, tag),
            )
        }
        CodexHomeKind::CapabilityRead
        | CodexHomeKind::McpSignIn
        | CodexHomeKind::TokenStatusRead => Ok(exporters_off()),
        CodexHomeKind::PersonalFolder => Ok(match service_kind {
            // A read's transient service on the folder.
            CodexServiceKind::Account => exporters_off(),
            CodexServiceKind::Terminal | CodexServiceKind::Joined => TelemetrySwitches::default(),
        }),
    }
}

/// The `key=value` switches a short command on a home of `home_kind` carries: every exporter off
/// on a home of the daemon's own, and none on the person's own folder.
pub(crate) fn compose_command_telemetry_switches(home_kind: &CodexHomeKind) -> Vec<String> {
    match home_kind {
        CodexHomeKind::Account(_)
        | CodexHomeKind::ApiKeyAccount(_)
        | CodexHomeKind::Switching
        | CodexHomeKind::CapabilityRead
        | CodexHomeKind::McpSignIn
        | CodexHomeKind::TokenStatusRead => exporters_off_overrides(),
        CodexHomeKind::PersonalFolder => Vec::new(),
    }
}

// The log export to `target`, with traces, metrics and each record's content off, and the token
// minted for the launch's `tag` and the tag itself in the process's environment, the token never
// on its command line. Fails when the token cannot be minted.
fn compose_daemon_export(
    target: &TelemetryTarget,
    tag: &CodexExportTag,
) -> Result<TelemetrySwitches, getrandom::Error> {
    let bearer = target
        .bearers()
        .mint(DESCRIPTOR.provider_id(), tag.holder())?;
    let exporter = json!({
        "otlp-http": {
            "endpoint": format!(
                "{}{LOGS_PATH_SUFFIX}",
                target.base_endpoint(&DESCRIPTOR.provider_id())
            ),
            "protocol": OTLP_HTTP_PROTOCOL,
        }
    });
    let mut config_overrides = vec![write_config_override(EXPORTER_KEY, &exporter)];
    config_overrides.extend(
        [TRACE_EXPORTER_OFF, METRICS_EXPORTER_OFF]
            .into_iter()
            .chain(RECORD_CONTENT_OFF)
            .map(str::to_owned),
    );
    Ok(TelemetrySwitches {
        config_overrides,
        environment: vec![
            (LOGS_HEADERS_VARIABLE.to_owned(), bearer.exporter_headers()),
            (
                RESOURCE_ATTRIBUTES_VARIABLE.to_owned(),
                tag.resource_attributes(),
            ),
        ],
        bearer: Some(bearer),
    })
}

fn exporters_off() -> TelemetrySwitches {
    TelemetrySwitches {
        config_overrides: exporters_off_overrides(),
        environment: Vec::new(),
        bearer: None,
    }
}

/// Every exporter off, as the `key=value` switches a process on a scratch home of the daemon's own
/// carries.
pub(crate) fn exporters_off_overrides() -> Vec<String> {
    EXPORTERS_OFF.into_iter().map(str::to_owned).collect()
}
