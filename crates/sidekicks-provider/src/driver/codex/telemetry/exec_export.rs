//! The daemon's export on a one-shot `codex exec`, and the responses one exec's export stated,
//! collected for its caller.

use std::time::Duration;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::service::home::CodexHomeKind;
use crate::driver::codex::service::registry::compose_home_exec_switches;
use crate::driver::codex::service::telemetry_switches::{
    compose_command_telemetry_switches, compose_daemon_export_environment,
    compose_daemon_export_overrides,
};
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::exports::{CodexExecResponses, CodexExportTag, CodexExports};
use crate::pricing::receiver::TelemetryTarget;
use crate::pricing::receiver::bearers::TelemetryBearer;

/// How often an exec's exporter sends its batch: short, since a failed exit skips the flush and
/// loses what the last batch held.
const CODEX_EXEC_EXPORT_INTERVAL: Duration = Duration::from_millis(100);

/// The variable the SDK reads its log batch interval from, in milliseconds.
const BATCH_INTERVAL_VARIABLE: &str = "OTEL_BLRP_SCHEDULE_DELAY";

/// Every command the exec runs starts with none of the exec's environment, so none sees its token.
const SHELL_ENVIRONMENT_OFF: &str = "shell_environment_policy.inherit=\"none\"";

/// Where one exec's counts come from, chosen before it starts.
pub(crate) enum CodexExecTelemetry {
    /// Its export to the daemon, which collects the responses its records state.
    DaemonExport {
        /// The `key=value` switches, each passed after a `-c`.
        config_overrides: Vec<String>,
        /// The environment pairs set on the process, past the withhold of the person's settings.
        environment: Vec<(String, String)>,
        /// The exec's tag, token and collected responses, held for the exec's life.
        export: CodexExecExport,
    },
    /// What it prints, with the exporters its home's short commands carry.
    Printed {
        /// The `key=value` switches, each passed after a `-c`.
        config_overrides: Vec<String>,
    },
}

impl CodexExecTelemetry {
    /// The `-c` pairs an exec on a home of `home_kind` starts with: the home's own, then this
    /// telemetry's.
    pub(crate) fn exec_switches(&self, home_kind: &CodexHomeKind) -> Vec<String> {
        let config_overrides = match self {
            Self::DaemonExport {
                config_overrides, ..
            }
            | Self::Printed { config_overrides } => config_overrides,
        };
        compose_home_exec_switches(home_kind, config_overrides.clone())
    }

    /// Sets the export's pairs in `environment`, the exec's launch's, past the withhold of the
    /// person's settings, and answers the export the exec's responses collect in; `None` for an
    /// exec counted from what it prints.
    pub(crate) fn launched(
        self,
        environment: &mut Vec<(String, String)>,
    ) -> Option<CodexExecExport> {
        match self {
            Self::DaemonExport {
                environment: pairs,
                export,
                ..
            } => {
                environment.extend(pairs);
                Some(export)
            }
            Self::Printed { .. } => None,
        }
    }
}

/// One exec's export: its place in the register and the guard of its token, both dropped with
/// it, and the responses its records stated.
pub(crate) struct CodexExecExport {
    _tag: CodexExportTag,
    _bearer: TelemetryBearer,
    responses: CodexExecResponses,
}

impl CodexExecExport {
    /// Takes every response collected so far; after a clean exit, every one the exec exported.
    pub(crate) fn take(&self) -> Vec<CodexCompletedResponse> {
        std::mem::take(&mut *lock(&self.responses))
    }
}

/// The telemetry of an exec on a home of `home_kind`, running on `provider_account_id`: the
/// daemon's export, registered in `exports` under a tag of its own and the token minted for it,
/// on a home the daemon's sessions run on once `target` is registered; else its printed counts,
/// with the switches its home's short commands carry. Fails when the token cannot be minted.
pub(crate) fn compose_exec_telemetry(
    exports: &CodexExports,
    home_kind: &CodexHomeKind,
    target: Option<&TelemetryTarget>,
    provider_account_id: &ProviderAccountId,
) -> Result<CodexExecTelemetry, getrandom::Error> {
    let printed = || CodexExecTelemetry::Printed {
        config_overrides: compose_command_telemetry_switches(home_kind),
    };
    match home_kind {
        CodexHomeKind::Account(_) | CodexHomeKind::ApiKeyAccount(_) | CodexHomeKind::Switching => {
            target.map_or_else(
                || Ok(printed()),
                |target| compose_exec_export(exports, target, provider_account_id),
            )
        }
        CodexHomeKind::CapabilityRead
        | CodexHomeKind::McpSignIn
        | CodexHomeKind::TokenStatusRead
        | CodexHomeKind::PersonalFolder => Ok(printed()),
    }
}

// The exec's export to `target` under a tag `exports` registers, with its own token, its batch
// sent every 100 ms, and its commands' environment empty.
fn compose_exec_export(
    exports: &CodexExports,
    target: &TelemetryTarget,
    provider_account_id: &ProviderAccountId,
) -> Result<CodexExecTelemetry, getrandom::Error> {
    let (tag, responses) = exports.exec_started(provider_account_id);
    let bearer = target
        .bearers()
        .mint(DESCRIPTOR.provider_id(), tag.holder())?;
    let mut config_overrides = compose_daemon_export_overrides(target);
    config_overrides.push(SHELL_ENVIRONMENT_OFF.to_owned());
    let mut environment = compose_daemon_export_environment(&bearer, &tag);
    environment.push((
        BATCH_INTERVAL_VARIABLE.to_owned(),
        CODEX_EXEC_EXPORT_INTERVAL.as_millis().to_string(),
    ));
    Ok(CodexExecTelemetry::DaemonExport {
        config_overrides,
        environment,
        export: CodexExecExport {
            _tag: tag,
            _bearer: bearer,
            responses,
        },
    })
}
