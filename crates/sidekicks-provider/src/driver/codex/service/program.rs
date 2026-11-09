//! The installed Codex build every service starts from: the command resolved again at each start,
//! in the environment the home's processes take, so a restart runs what the command names now. On
//! every home the daemon owns that environment withholds the person's telemetry settings.

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_platforms::PathRules;

use crate::command_search::{ProviderCommandSearch, list_command_folders};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::supervisor::CodexProgramResolver;
use crate::driver::contract::error::DriverError;
use crate::spawn_environment::{
    ProviderEnvironmentRequest, ReservedEnvironmentNames, SessionEnvironment,
    WithheldEnvironmentNames, build_provider_process_environment,
};
use crate::spawned_version::{ResolvedProviderExecutable, resolve_provider_executable};

// The person's telemetry settings a service's process on a daemon-owned home never inherits, so
// its exports reach only the daemon's receiver.
const DAEMON_HOME_TELEMETRY_WITHHELD: WithheldEnvironmentNames<'static> =
    WithheldEnvironmentNames {
        prefixes: &["OTEL_"],
        names: &[],
    };

// What a service's process on a home of `kind` withholds: the person's telemetry settings on every
// home the daemon owns, nothing on the person's own folder, which keeps theirs.
fn telemetry_withheld(kind: &CodexHomeKind) -> WithheldEnvironmentNames<'static> {
    match kind {
        CodexHomeKind::Account(_)
        | CodexHomeKind::ApiKeyAccount(_)
        | CodexHomeKind::Switching
        | CodexHomeKind::CapabilityRead
        | CodexHomeKind::McpSignIn
        | CodexHomeKind::TokenStatusRead => DAEMON_HOME_TELEMETRY_WITHHELD,
        CodexHomeKind::PersonalFolder => WithheldEnvironmentNames::NONE,
    }
}

/// The build the configured Codex command names, resolved at every start in the home's
/// environment: the login shell's, with the home as `CODEX_HOME`.
pub(crate) struct CodexInstalledProgram {
    command_search: Arc<ProviderCommandSearch>,
    home_folder: PathBuf,
    base_environment: Arc<[(String, String)]>,
    reserved_names: Arc<ReservedEnvironmentNames>,
}

impl CodexInstalledProgram {
    /// The build `command_search` finds below `home_folder` when the environment's `PATH` holds
    /// none, each start's environment composed from `base_environment`.
    pub(crate) fn new(
        command_search: Arc<ProviderCommandSearch>,
        home_folder: PathBuf,
        base_environment: Arc<[(String, String)]>,
        reserved_names: Arc<ReservedEnvironmentNames>,
    ) -> Self {
        Self {
            command_search,
            home_folder,
            base_environment,
            reserved_names,
        }
    }
}

impl CodexProgramResolver for CodexInstalledProgram {
    fn resolve<'call>(
        &'call self,
        home: &'call CodexServiceHome,
    ) -> BoxFuture<'call, Result<ResolvedProviderExecutable, DriverError>> {
        async move {
            let credential_homes: Vec<(String, String)> = DESCRIPTOR
                .credential_home_environment_names
                .iter()
                .map(|name| {
                    (
                        (*name).to_owned(),
                        home.codex_home.to_string_lossy().into_owned(),
                    )
                })
                .collect();
            let environment = build_provider_process_environment(
                &ProviderEnvironmentRequest {
                    session: SessionEnvironment {
                        base: &self.base_environment,
                        every_project_rows: &[],
                        project_rows: &[],
                        reserved_names: &self.reserved_names,
                        rules: PathRules::NATIVE,
                    },
                    descriptor: &DESCRIPTOR,
                    deny_env_vars: &[],
                    credential_homes: &credential_homes,
                },
                &[],
                telemetry_withheld(&home.kind),
            )
            .map_err(|error| DriverError::Internal(Box::new(error)))?;
            let command = DESCRIPTOR
                .command_lookup(PathRules::NATIVE)
                .and_then(|lookup| lookup.names.first())
                .map_or_else(String::new, |name| (*name).to_owned());
            let search_folders = list_command_folders(&DESCRIPTOR, &self.home_folder, &environment);
            resolve_provider_executable(
                &self.command_search,
                &DESCRIPTOR.provider_id(),
                command,
                environment,
                search_folders,
                &[],
            )
            .await
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_platforms::PathRules;

    use super::telemetry_withheld;
    use crate::driver::codex::DESCRIPTOR;
    use crate::driver::codex::service::home::CodexHomeKind;
    use crate::runtime_binding::test_store::test_provider_account_id;
    use crate::spawn_environment::{
        ProviderEnvironmentRequest, ReservedEnvironmentNames, SessionEnvironment,
        build_provider_process_environment,
    };

    // A service on an account's home loses the person's exporter settings and one on the person's
    // own folder keeps them. Killed by withholding on the person's folder, and by withholding on no
    // home.
    #[rstest]
    #[case::account_home(CodexHomeKind::Account(test_provider_account_id()), None)]
    #[case::personal_folder(CodexHomeKind::PersonalFolder, Some("authorization=person"))]
    fn a_daemon_owned_home_withholds_the_persons_telemetry(
        #[case] kind: CodexHomeKind,
        #[case] kept_headers: Option<&str>,
    ) {
        let base = vec![(
            "OTEL_EXPORTER_OTLP_HEADERS".to_owned(),
            "authorization=person".to_owned(),
        )];
        let reserved_names = ReservedEnvironmentNames::of_providers(&[&DESCRIPTOR]);
        let request = ProviderEnvironmentRequest {
            session: SessionEnvironment {
                base: &base,
                every_project_rows: &[],
                project_rows: &[],
                reserved_names: &reserved_names,
                rules: PathRules::Posix,
            },
            descriptor: &DESCRIPTOR,
            deny_env_vars: &[],
            credential_homes: &[],
        };

        let environment =
            build_provider_process_environment(&request, &[], telemetry_withheld(&kind))
                .expect("the service's environment builds");

        assert_eq!(
            PathRules::Posix.environment_value(&environment, "OTEL_EXPORTER_OTLP_HEADERS"),
            kept_headers
        );
    }
}
