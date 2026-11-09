//! The telemetry switches every Claude Code process carries in its settings document's `env`: its
//! logs and traces exported to the daemon's receiver with the process's own token where the target
//! is registered, every exporter off before it is, and in both every exporter setting a settings file
//! below the document could carry cancelled, with no prompt, reply or tool content in a record.
//! The person's opt-outs of Anthropic's own telemetry are never touched.

use std::collections::BTreeMap;

use serde::{Serialize, Serializer};

use crate::driver::claude::DESCRIPTOR;
use crate::pricing::receiver::bearers::TelemetryBearer;
use crate::pricing::receiver::{LOGS_PATH_SUFFIX, TRACES_PATH_SUFFIX, TelemetryTarget};

/// The telemetry switches Claude Code reads outside the `OTEL_` names, each set in the document
/// and withheld from the person's environment: the export's on switch and its alias, the flush,
/// shutdown and content bounds, beta tracing and the exporter's diagnostics.
pub(crate) const CLAUDE_TELEMETRY_VARIABLES: [&str; 9] = [
    ENABLE_TELEMETRY,
    ENHANCED_TELEMETRY,
    ENHANCED_TELEMETRY_ALIAS,
    "CLAUDE_CODE_OTEL_FLUSH_TIMEOUT_MS",
    "CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS",
    "CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH",
    "BETA_TRACING_ENDPOINT",
    "ENABLE_BETA_TRACING_DETAILED",
    "CLAUDE_CODE_OTEL_DIAG_STDERR",
];

/// The switch that alone turns the export to a third party on.
const ENABLE_TELEMETRY: &str = "CLAUDE_CODE_ENABLE_TELEMETRY";

/// The switch that adds the trace export beside the logs.
const ENHANCED_TELEMETRY: &str = "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA";

/// The trace switch's alias, read only where the main name is unset, so always cancelled.
const ENHANCED_TELEMETRY_ALIAS: &str = "ENABLE_ENHANCED_TELEMETRY_BETA";

/// The log and trace exporters, `otlp` to the receiver or `none`.
const SIGNAL_EXPORTERS: [&str; 2] = ["OTEL_LOGS_EXPORTER", "OTEL_TRACES_EXPORTER"];

/// The metrics exporter, always off.
const METRICS_EXPORTER: &str = "OTEL_METRICS_EXPORTER";

/// The exporters' protocol, the receiver's binary OTLP/HTTP.
const PROTOCOLS: [&str; 3] = [
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
    "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
];

/// The shared endpoint, set to the receiver's base path.
const BASE_ENDPOINT: &str = "OTEL_EXPORTER_OTLP_ENDPOINT";

/// The log endpoint, the base path with the receiver's log suffix.
const LOGS_ENDPOINT: &str = "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT";

/// The trace endpoint, the base path with the receiver's trace suffix.
const TRACES_ENDPOINT: &str = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";

/// The exporters' headers, each presenting the process's own token.
const HEADERS: [&str; 3] = [
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
];

/// The exporters' compression, none, since the receiver refuses any content encoding.
const COMPRESSIONS: [&str; 3] = [
    "OTEL_EXPORTER_OTLP_COMPRESSION",
    "OTEL_EXPORTER_OTLP_LOGS_COMPRESSION",
    "OTEL_EXPORTER_OTLP_TRACES_COMPRESSION",
];

/// The log and trace batch intervals.
const EXPORT_INTERVALS: [&str; 2] = ["OTEL_LOGS_EXPORT_INTERVAL", "OTEL_TRACES_EXPORT_INTERVAL"];

/// One batch a second while records wait; the processors arm no timer while none do.
const EXPORT_INTERVAL_MS: &str = "1000";

/// The switches that put a prompt, a reply, a tool's input or output, a raw request body or the
/// managed settings into a record, each `0` on every process.
const CONTENT_SWITCHES: [&str; 6] = [
    "OTEL_LOG_USER_PROMPTS",
    "OTEL_LOG_ASSISTANT_RESPONSES",
    "OTEL_LOG_TOOL_DETAILS",
    "OTEL_LOG_TOOL_CONTENT",
    "OTEL_LOG_RAW_API_BODIES",
    "OTEL_LOG_MANAGED_SETTINGS",
];

/// The standard attributes on by default, `session.id` among them; Claude Code reads an empty
/// value as off, so each carries its default instead of a cancel.
const INCLUDED_ATTRIBUTES: [&str; 3] = [
    "OTEL_METRICS_INCLUDE_SESSION_ID",
    "OTEL_METRICS_INCLUDE_ACCOUNT_UUID",
    "OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES",
];

/// The standard attributes off by default, the repository's identity among them.
const EXCLUDED_ATTRIBUTES: [&str; 3] = [
    "OTEL_METRICS_INCLUDE_VERSION",
    "OTEL_METRICS_INCLUDE_ENTRYPOINT",
    "OTEL_METRICS_INCLUDE_REPOSITORY",
];

/// The `OTEL_` settings a lower settings file could carry that the export never uses, each
/// cancelled with `""`, which every reader takes as unset: the client certificates, the
/// timeouts, the batch bounds, the sampler, the resource attributes and the attribute limits.
const CANCELLED_OTEL_SETTINGS: [&str; 28] = [
    "OTEL_EXPORTER_OTLP_CERTIFICATE",
    "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE",
    "OTEL_EXPORTER_OTLP_CLIENT_KEY",
    "OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE",
    "OTEL_EXPORTER_OTLP_LOGS_CLIENT_CERTIFICATE",
    "OTEL_EXPORTER_OTLP_LOGS_CLIENT_KEY",
    "OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE",
    "OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE",
    "OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY",
    "OTEL_EXPORTER_OTLP_TIMEOUT",
    "OTEL_EXPORTER_OTLP_LOGS_TIMEOUT",
    "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
    "OTEL_BSP_EXPORT_TIMEOUT",
    "OTEL_BSP_MAX_QUEUE_SIZE",
    "OTEL_BSP_MAX_EXPORT_BATCH_SIZE",
    "OTEL_BLRP_EXPORT_TIMEOUT",
    "OTEL_BLRP_MAX_QUEUE_SIZE",
    "OTEL_BLRP_MAX_EXPORT_BATCH_SIZE",
    "OTEL_TRACES_SAMPLER",
    "OTEL_TRACES_SAMPLER_ARG",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_SERVICE_NAME",
    "OTEL_ATTRIBUTE_COUNT_LIMIT",
    "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT",
    "OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT",
    "OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT",
    "OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT",
    "OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT",
];

/// No `otelHeadersHelper`: a helper a settings file below the document names would replace the
/// token's headers, so the document always writes `""`, which Claude Code reads as none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NoOtelHeadersHelper;

impl Serialize for NoOtelHeadersHelper {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str("")
    }
}

/// The `env` pairs of a process's settings document: the logs and traces exported to the target's
/// receiver with the process's own bearer where `export` names both, every exporter off where it
/// is `None`, and in both every other exporter setting cancelled, each content switch `0` and each
/// standard attribute at its default.
pub(crate) fn compose_claude_telemetry_switches(
    export: Option<(&TelemetryTarget, &TelemetryBearer)>,
) -> BTreeMap<&'static str, String> {
    let mut switches: BTreeMap<&'static str, String> = CLAUDE_TELEMETRY_VARIABLES
        .into_iter()
        .chain(CANCELLED_OTEL_SETTINGS)
        .map(|name| (name, String::new()))
        .collect();
    let set =
        |switches: &mut BTreeMap<&'static str, String>, names: &[&'static str], value: &str| {
            switches.extend(names.iter().map(|name| (*name, value.to_owned())));
        };
    set(&mut switches, &CONTENT_SWITCHES, "0");
    set(&mut switches, &INCLUDED_ATTRIBUTES, "true");
    set(&mut switches, &EXCLUDED_ATTRIBUTES, "false");
    set(&mut switches, &[METRICS_EXPORTER], "none");
    let Some((target, bearer)) = export else {
        set(&mut switches, &SIGNAL_EXPORTERS, "none");
        for names in [&PROTOCOLS[..], &HEADERS, &COMPRESSIONS, &EXPORT_INTERVALS] {
            set(&mut switches, names, "");
        }
        set(
            &mut switches,
            &[BASE_ENDPOINT, LOGS_ENDPOINT, TRACES_ENDPOINT],
            "",
        );
        return switches;
    };
    let base = target.base_endpoint(&DESCRIPTOR.provider_id());
    set(&mut switches, &[ENABLE_TELEMETRY, ENHANCED_TELEMETRY], "1");
    set(&mut switches, &SIGNAL_EXPORTERS, "otlp");
    set(&mut switches, &PROTOCOLS, "http/protobuf");
    set(&mut switches, &HEADERS, &bearer.exporter_headers());
    set(&mut switches, &COMPRESSIONS, "none");
    set(&mut switches, &EXPORT_INTERVALS, EXPORT_INTERVAL_MS);
    set(
        &mut switches,
        &[LOGS_ENDPOINT],
        &format!("{base}{LOGS_PATH_SUFFIX}"),
    );
    set(
        &mut switches,
        &[TRACES_ENDPOINT],
        &format!("{base}{TRACES_PATH_SUFFIX}"),
    );
    set(&mut switches, &[BASE_ENDPOINT], &base);
    switches
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;

    use super::{
        BASE_ENDPOINT, CONTENT_SWITCHES, HEADERS, LOGS_ENDPOINT, SIGNAL_EXPORTERS, TRACES_ENDPOINT,
        compose_claude_telemetry_switches,
    };
    use crate::driver::claude::DESCRIPTOR;
    use crate::pricing::receiver::TelemetryTarget;
    use crate::pricing::receiver::bearers::{TelemetryBearers, TelemetryHolderId};

    // Killed by a base without `/telemetry/claude`, a pair missing from the no-target case, a
    // content switch left out, and the session switch cancelled with `""`, which drops
    // `session.id` from every event.
    #[rstest]
    #[case::with_target(true)]
    #[case::with_none(false)]
    fn the_export_reaches_only_the_receiver_and_stops_with_no_target(#[case] has_target: bool) {
        let bearers = Arc::new(TelemetryBearers::default());
        let bearer = bearers
            .mint(DESCRIPTOR.provider_id(), TelemetryHolderId::new(1))
            .expect("a token mints");
        let target = TelemetryTarget::new(43_210, bearers);
        let export = has_target.then_some((&target, &bearer));

        let switches = compose_claude_telemetry_switches(export);

        let value = |name: &str| {
            switches
                .get(name)
                .unwrap_or_else(|| panic!("{name} is set"))
                .as_str()
        };
        if let Some((_target, bearer)) = export {
            let headers = bearer.exporter_headers();
            assert_eq!(
                value(BASE_ENDPOINT),
                "http://127.0.0.1:43210/telemetry/claude"
            );
            assert_eq!(
                value(LOGS_ENDPOINT),
                "http://127.0.0.1:43210/telemetry/claude/v1/logs"
            );
            assert_eq!(
                value(TRACES_ENDPOINT),
                "http://127.0.0.1:43210/telemetry/claude/v1/traces"
            );
            for name in HEADERS {
                assert_eq!(value(name), headers.as_str());
            }
            for name in SIGNAL_EXPORTERS {
                assert_eq!(value(name), "otlp");
            }
        } else {
            for name in SIGNAL_EXPORTERS {
                assert_eq!(value(name), "none");
            }
            for name in [BASE_ENDPOINT, LOGS_ENDPOINT, TRACES_ENDPOINT]
                .into_iter()
                .chain(HEADERS)
            {
                assert_eq!(value(name), "", "{name} is cancelled");
            }
            assert_eq!(value("CLAUDE_CODE_ENABLE_TELEMETRY"), "");
            assert!(
                !switches.values().any(|value| value.contains("Bearer")),
                "no pair carries a token"
            );
        }
        assert_eq!(value("OTEL_METRICS_EXPORTER"), "none");
        for name in CONTENT_SWITCHES {
            assert_eq!(value(name), "0", "{name} is off");
        }
        assert_eq!(value("OTEL_METRICS_INCLUDE_SESSION_ID"), "true");
        assert_eq!(value("OTEL_METRICS_INCLUDE_REPOSITORY"), "false");
    }
}
