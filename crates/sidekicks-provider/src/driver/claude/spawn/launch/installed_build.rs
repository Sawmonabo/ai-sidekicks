//! The installed Claude Code build every process of the driver starts from, behind the one seam a
//! test replaces with a scripted process: the command resolved again at each start, so a relaunch
//! runs whatever build the command names now, and each start's build version read from that
//! very process.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use sidekicks_platforms::PathRules;

use crate::capability::probe::CapabilityProbeExchange;
use crate::command_search::{ProviderCommandSearch, list_command_folders};
use crate::driver::ReportedVersionReading;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::capabilities::read_claude_capabilities;
use crate::driver::claude::mcp::connectors::{
    ClaudeAccountServerAnswers, ClaudeAccountServersReadRequest, read_claude_account_answers,
};
use crate::driver::claude::mcp::sign_in::{ClaudeMcpSignInChannel, ClaudeMcpSignInStart};
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::claude::session::transport::declarations::ClaudeInitializeDeclaration;
use crate::driver::claude::session::transport::readings::{
    ClaudeCreationFiguresReading, ClaudeModelCatalogReading, ClaudeReplyReserveReads,
    ClaudeSessionFolderReadRequest,
};
use crate::driver::claude::spawn::launch::bring_up::{
    ClaudeBringUpRequest, ClaudeSettingsReadback, bring_up_claude_process,
};
use crate::driver::claude::spawn::launch::control_only::{
    CLAUDE_CONTROL_ONLY_ARGUMENTS, ClaudeShortProcess, probe_claude_sign_in,
    read_claude_model_catalog,
};
use crate::driver::claude::spawn::launch::figures::{
    read_claude_creation_figures, read_claude_reply_reserve,
};
use crate::driver::claude::spawn::launch::one_turn::{
    ClaudeOneTurnReply, ClaudeOneTurnRequest, run_claude_one_turn,
};
use crate::driver::claude::spawn::launch::{ClaudeLaunchError, ClaudeProcessLauncher};
use crate::driver::claude::version::read_reported_version;
use crate::driver::contract::{DriverError, GetCapabilitiesResult, SpawnedVersionBindingCarriers};
use crate::process_identity::ProviderProcessIdentity;
use crate::spawned_version::{
    ProviderVersionHandshakeRequest, ResolvedProviderExecutable, read_spawned_version,
    resolve_provider_executable, to_binding_version_carriers,
};

/// A session's process brought up, with what it declared and the build that runs it.
pub(crate) struct ClaudeStartedSession {
    /// The process.
    pub(crate) channel: Arc<dyn ClaudeProcessChannel>,
    /// Its identity in the daemon's spawn count.
    pub(crate) identity: ProviderProcessIdentity,
    /// What its `initialize` reply declared.
    pub(crate) initialize: ClaudeInitializeDeclaration,
    /// What its settings read back.
    pub(crate) settings_readback: ClaudeSettingsReadback,
    /// The build's version and path, read from this process.
    pub(crate) spawned_version: SpawnedVersionBindingCarriers,
}

/// Every Claude Code process the driver starts, each on the build the command names at that start.
pub(crate) trait ClaudeProcessStarts: Send + Sync {
    /// Brings a session's process up. Fails as the command's resolution, the bring-up or the
    /// version read fails, the process then ended.
    fn start_session<'a>(
        &'a self,
        request: ClaudeBringUpRequest<'a>,
    ) -> BoxFuture<'a, Result<ClaudeStartedSession, ClaudeLaunchError>>;

    /// Reads a session's creation figures in one process that keeps nothing.
    fn read_creation_figures(
        &self,
        place: ClaudeSessionFolderReadRequest,
        read_models: HashSet<String>,
    ) -> BoxFuture<'static, Result<ClaudeCreationFiguresReading, ClaudeLaunchError>>;

    /// Reads one model's reply reserve in one process that keeps nothing.
    fn read_reply_reserve(
        &self,
        place: ClaudeSessionFolderReadRequest,
    ) -> BoxFuture<'static, Result<ClaudeReplyReserveReads, ClaudeLaunchError>>;

    /// Runs one unkept turn.
    fn run_one_turn<'a>(
        &'a self,
        request: ClaudeOneTurnRequest<'a>,
    ) -> BoxFuture<'a, Result<ClaudeOneTurnReply, ClaudeLaunchError>>;

    /// Asks a process that keeps nothing, started in `environment`, how it is signed in.
    fn probe_sign_in(
        &self,
        environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<String, ClaudeLaunchError>>;

    /// Reads the model catalog from a process that keeps nothing, started in `environment`.
    fn read_model_catalog(
        &self,
        environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<ClaudeModelCatalogReading, ClaudeLaunchError>>;

    /// Reads the installed build's version and probes its capabilities, both from one process
    /// that keeps nothing, started in `environment`. Fails with the driver's error.
    fn read_capabilities(
        &self,
        environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<GetCapabilitiesResult, DriverError>>;

    /// Takes one account's `mcp_status` and `get_settings` answers from a process that keeps
    /// nothing, started as `request` names.
    fn read_account_servers(
        &self,
        request: ClaudeAccountServersReadRequest,
    ) -> BoxFuture<'_, Result<ClaudeAccountServerAnswers, ClaudeLaunchError>>;

    /// Brings up, initialized, the one process that keeps nothing of an MCP server's sign-in,
    /// started as `start` names and loading only the server its file declares; the caller drives
    /// it and closes it.
    fn start_mcp_sign_in(
        &self,
        start: ClaudeMcpSignInStart,
    ) -> BoxFuture<'_, Result<ClaudeMcpSignInChannel, ClaudeLaunchError>>;

    /// Stops every live process and starts none after.
    fn stop_every_process(&self) -> BoxFuture<'_, ()>;
}

/// The build the configured command names, resolved at every start, run through one launcher.
pub(crate) struct ClaudeInstalledBuild {
    launcher: Arc<ClaudeProcessLauncher>,
    command_search: Arc<ProviderCommandSearch>,
    home_folder: PathBuf,
}

impl ClaudeInstalledBuild {
    /// The build `command_search` finds below `home_folder` when the environment's `PATH` holds
    /// none, started through `launcher`.
    pub(crate) fn new(
        launcher: Arc<ClaudeProcessLauncher>,
        command_search: Arc<ProviderCommandSearch>,
        home_folder: PathBuf,
    ) -> Self {
        Self {
            launcher,
            command_search,
            home_folder,
        }
    }

    // The build the command names in `environment` now.
    async fn resolve(
        command_search: &ProviderCommandSearch,
        home_folder: &std::path::Path,
        environment: Vec<(String, String)>,
    ) -> Result<ResolvedProviderExecutable, DriverError> {
        let command = DESCRIPTOR
            .command_lookup(PathRules::NATIVE)
            .and_then(|lookup| lookup.names.first())
            .map_or_else(String::new, |name| (*name).to_owned());
        let search_folders = list_command_folders(&DESCRIPTOR, home_folder, &environment);
        resolve_provider_executable(
            command_search,
            &DESCRIPTOR.provider_id(),
            command,
            environment,
            search_folders,
        )
        .await
    }
}

impl ClaudeProcessStarts for ClaudeInstalledBuild {
    fn start_session<'a>(
        &'a self,
        request: ClaudeBringUpRequest<'a>,
    ) -> BoxFuture<'a, Result<ClaudeStartedSession, ClaudeLaunchError>> {
        async move {
            let environment = request.spawn.legs.spawn_environment.clone();
            let executable =
                Self::resolve(&self.command_search, &self.home_folder, environment).await?;
            let brought_up = bring_up_claude_process(&self.launcher, &executable, request).await?;
            let process = brought_up.process;
            let handshake_process = Arc::clone(&process);
            let version = read_spawned_version(
                &ProviderVersionHandshakeRequest {
                    provider: DESCRIPTOR.provider_id(),
                    executable,
                    client_name: DESCRIPTOR.id,
                },
                async move |_request: &ProviderVersionHandshakeRequest| {
                    read_version_text(&*handshake_process).await
                },
            )
            .await;
            match version {
                Ok(version) => Ok(ClaudeStartedSession {
                    identity: process.identity(),
                    channel: process,
                    initialize: brought_up.initialize,
                    settings_readback: brought_up.settings_readback,
                    spawned_version: to_binding_version_carriers(&version),
                }),
                Err(error) => {
                    process.terminate().await;
                    Err(error.into())
                }
            }
        }
        .boxed()
    }

    fn read_creation_figures(
        &self,
        place: ClaudeSessionFolderReadRequest,
        read_models: HashSet<String>,
    ) -> BoxFuture<'static, Result<ClaudeCreationFiguresReading, ClaudeLaunchError>> {
        let (launcher, command_search) =
            (Arc::clone(&self.launcher), Arc::clone(&self.command_search));
        let home_folder = self.home_folder.clone();
        async move {
            let executable = Self::resolve(
                &command_search,
                &home_folder,
                place.spawn_environment.clone(),
            )
            .await?;
            read_claude_creation_figures(&launcher, &executable, &place, read_models).await
        }
        .boxed()
    }

    fn read_reply_reserve(
        &self,
        place: ClaudeSessionFolderReadRequest,
    ) -> BoxFuture<'static, Result<ClaudeReplyReserveReads, ClaudeLaunchError>> {
        let (launcher, command_search) =
            (Arc::clone(&self.launcher), Arc::clone(&self.command_search));
        let home_folder = self.home_folder.clone();
        async move {
            let executable = Self::resolve(
                &command_search,
                &home_folder,
                place.spawn_environment.clone(),
            )
            .await?;
            read_claude_reply_reserve(&launcher, &executable, &place).await
        }
        .boxed()
    }

    fn run_one_turn<'a>(
        &'a self,
        request: ClaudeOneTurnRequest<'a>,
    ) -> BoxFuture<'a, Result<ClaudeOneTurnReply, ClaudeLaunchError>> {
        async move {
            let environment = request.spawn.legs.spawn_environment.clone();
            let executable =
                Self::resolve(&self.command_search, &self.home_folder, environment).await?;
            run_claude_one_turn(&self.launcher, &executable, request).await
        }
        .boxed()
    }

    fn probe_sign_in(
        &self,
        environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<String, ClaudeLaunchError>> {
        async move {
            let executable =
                Self::resolve(&self.command_search, &self.home_folder, environment).await?;
            probe_claude_sign_in(&self.launcher, &executable).await
        }
        .boxed()
    }

    fn read_model_catalog(
        &self,
        environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<ClaudeModelCatalogReading, ClaudeLaunchError>> {
        async move {
            let executable =
                Self::resolve(&self.command_search, &self.home_folder, environment).await?;
            read_claude_model_catalog(&self.launcher, &executable).await
        }
        .boxed()
    }

    fn read_capabilities(
        &self,
        environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<GetCapabilitiesResult, DriverError>> {
        async move {
            let executable =
                Self::resolve(&self.command_search, &self.home_folder, environment).await?;
            let request = ProviderVersionHandshakeRequest {
                provider: DESCRIPTOR.provider_id(),
                client_name: DESCRIPTOR.id,
                executable,
            };
            let short = ClaudeShortProcess::start_control_only(
                &self.launcher,
                &request.executable,
                None,
                None,
                None,
            )
            .await?;
            let read = async {
                short.initialize().await.map_err(ClaudeLaunchError::from)?;
                let process = Arc::clone(&short.process);
                let version = read_spawned_version(
                    &request,
                    async move |_request: &ProviderVersionHandshakeRequest| {
                        read_version_text(&*process).await
                    },
                )
                .await?;
                read_claude_capabilities(
                    &version,
                    &mut ClaudeProbeExchange {
                        channel: &*short.process,
                    },
                )
                .await
            }
            .await;
            short.close().await;
            read
        }
        .boxed()
    }

    fn read_account_servers(
        &self,
        request: ClaudeAccountServersReadRequest,
    ) -> BoxFuture<'_, Result<ClaudeAccountServerAnswers, ClaudeLaunchError>> {
        async move {
            let executable =
                Self::resolve(&self.command_search, &self.home_folder, request.environment).await?;
            read_claude_account_answers(
                &self.launcher,
                &executable,
                request.provider_account_id,
                request.working_folder,
            )
            .await
        }
        .boxed()
    }

    fn start_mcp_sign_in(
        &self,
        start: ClaudeMcpSignInStart,
    ) -> BoxFuture<'_, Result<ClaudeMcpSignInChannel, ClaudeLaunchError>> {
        async move {
            let executable =
                Self::resolve(&self.command_search, &self.home_folder, start.environment).await?;
            let arguments = CLAUDE_CONTROL_ONLY_ARGUMENTS
                .into_iter()
                .map(str::to_owned)
                .chain([
                    "--strict-mcp-config".to_owned(),
                    "--mcp-config".to_owned(),
                    start.servers_file.to_string_lossy().into_owned(),
                ])
                .collect();
            let short = ClaudeShortProcess::start(
                &self.launcher,
                &executable,
                arguments,
                start.folder,
                Some(start.provider_account_id),
            )
            .await?;
            if let Err(error) = short.initialize().await {
                short.close().await;
                return Err(error.into());
            }
            Ok(short.process as ClaudeMcpSignInChannel)
        }
        .boxed()
    }

    fn stop_every_process(&self) -> BoxFuture<'_, ()> {
        self.launcher.stop_every_process().boxed()
    }
}

// The version text a process's `get_binary_version` reply carries: the canonical version alone,
// else the reply's text.
async fn read_version_text(channel: &dyn ClaudeProcessChannel) -> Result<String, DriverError> {
    let answer = channel
        .send_control_request(ClaudeControlRequest::GetBinaryVersion {})
        .await
        .map_err(DriverError::from)?;
    let reply = answer
        .response
        .and_then(|reply| serde_json::from_str::<Value>(reply.get()).ok())
        .unwrap_or(Value::Null);
    Ok(match read_reported_version(&reply) {
        ReportedVersionReading::Version(version) => version,
        ReportedVersionReading::UnreadableReply(text) if !text.is_empty() => text,
        ReportedVersionReading::UnreadableReply(_) => reply.to_string(),
    })
}

// Each capability probe sent on a process that keeps nothing, its reply in the wire's own shape.
struct ClaudeProbeExchange<'a> {
    channel: &'a dyn ClaudeProcessChannel,
}

impl CapabilityProbeExchange for ClaudeProbeExchange<'_> {
    fn exchange(
        &mut self,
        probe_name: &'static str,
    ) -> BoxFuture<'_, Result<Value, Box<dyn std::error::Error + Send + Sync>>> {
        async move {
            let request = ClaudeControlRequest::probe(probe_name).ok_or_else(|| {
                format!("Claude Code has no control request for probe {probe_name}")
            })?;
            match self.channel.send_control_request(request).await {
                Ok(answer) => Ok(json!({
                    "subtype": "success",
                    "response": answer
                        .response
                        .and_then(|reply| serde_json::from_str::<Value>(reply.get()).ok())
                        .unwrap_or(Value::Null),
                })),
                Err(ClaudeSessionError::ControlRequestRefused { provider_error, .. }) => {
                    Ok(json!({"subtype": "error", "error": provider_error}))
                }
                Err(error) => Err(Box::new(error) as Box<dyn std::error::Error + Send + Sync>),
            }
        }
        .boxed()
    }
}
