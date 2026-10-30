//! The Claude Code processes that keep nothing: brought up only to answer control requests, with
//! no hooks and no conversation kept, for the sign-in probe, the model catalog and the build's
//! version, an account's MCP servers and the MCP server probe, each in the daemon's own empty
//! folder unless a read needs another. Each is closed once its reads are done, as a session closes.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use tokio::sync::{Mutex, mpsc};

use crate::driver::claude::hooks::registration::compose_claude_initialize_request;
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::process::{
    ClaudeCodeProcess, ClaudeProcessEnd, ClaudeProcessLaunch, ClaudeProcessListener,
    ClaudeStreamFrame,
};
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::{
    ClaudeContextUsageDetail, ClaudeControlRequest, ClaudeInitializePlugin,
    ClaudeInitializePluginKind,
};
use crate::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
use crate::driver::claude::session::transport::readings::ClaudeModelCatalogReading;
use crate::driver::claude::spawn::launch::{ClaudeLaunchError, ClaudeProcessLauncher};
use crate::driver::claude::spawn::system_prompt::claude_appended_system_prompt_arguments;
use crate::spawned_version::ResolvedProviderExecutable;

/// The command line of a process that keeps nothing.
pub(crate) const CLAUDE_CONTROL_ONLY_ARGUMENTS: [&str; 7] = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
];

/// The command line of a process that keeps nothing, with the daemon's appended system prompt,
/// on `model` where given.
pub(crate) fn compose_claude_control_only_arguments(model: Option<&str>) -> Vec<String> {
    let mut arguments: Vec<String> = CLAUDE_CONTROL_ONLY_ARGUMENTS
        .into_iter()
        .chain(claude_appended_system_prompt_arguments())
        .map(str::to_owned)
        .collect();
    if let Some(model) = model {
        arguments.extend(["--model".to_owned(), model.to_owned()]);
    }
    arguments
}

/// What one short process wrote, in the order read.
pub(crate) enum ClaudeShortProcessArrival {
    /// A stream frame.
    Frame(Box<ClaudeStreamFrame>),
    /// A request it waits on, or its withdrawal of one.
    Request(ClaudeInboundRequestEvent),
    /// Its end.
    Exit,
}

/// Hands each arrival of a short process to the one reading it, until that reader is gone.
pub(super) struct ForwardedArrivals {
    sender: mpsc::UnboundedSender<ClaudeShortProcessArrival>,
    is_reader_gone: AtomicBool,
}

impl ForwardedArrivals {
    /// A listener forwarding to the receiver it comes with.
    pub(super) fn open() -> (
        Arc<Self>,
        mpsc::UnboundedReceiver<ClaudeShortProcessArrival>,
    ) {
        let (sender, arrivals) = mpsc::unbounded_channel();
        let forwarded = Self {
            sender,
            is_reader_gone: AtomicBool::new(false),
        };
        (Arc::new(forwarded), arrivals)
    }

    // Hands `arrival` on; once the reader is gone, says so once and drops every later arrival.
    fn forward(&self, arrival: ClaudeShortProcessArrival) {
        if self.is_reader_gone.load(Ordering::Relaxed) {
            return;
        }
        if self.sender.send(arrival).is_err() && !self.is_reader_gone.swap(true, Ordering::Relaxed)
        {
            tracing::debug!(
                "a short Claude Code process wrote after its reads ended; its later output is \
                 dropped"
            );
        }
    }
}

impl ClaudeProcessListener for ForwardedArrivals {
    fn take_frame(&self, frame: ClaudeStreamFrame) {
        self.forward(ClaudeShortProcessArrival::Frame(Box::new(frame)));
    }

    fn take_request(&self, event: ClaudeInboundRequestEvent) {
        self.forward(ClaudeShortProcessArrival::Request(event));
    }

    fn take_exit(&self, _end: ClaudeProcessEnd) {
        self.forward(ClaudeShortProcessArrival::Exit);
    }

    fn is_turn_ending(&self, _frame: &ClaudeStreamFrame) -> bool {
        true
    }
}

/// A short process and what it writes.
pub(crate) struct ClaudeShortProcess {
    /// The process.
    pub(crate) process: Arc<ClaudeCodeProcess>,
    /// What it writes, in order; one reader at a time.
    pub(crate) arrivals: Mutex<mpsc::UnboundedReceiver<ClaudeShortProcessArrival>>,
}

impl ClaudeShortProcess {
    /// Starts `executable` with `arguments` in `working_folder`, under `provider_account_id`'s
    /// account where given. Fails as the launcher's start does.
    pub(crate) async fn start(
        launcher: &ClaudeProcessLauncher,
        executable: &ResolvedProviderExecutable,
        arguments: Vec<String>,
        working_folder: PathBuf,
        provider_account_id: Option<ProviderAccountId>,
    ) -> Result<Self, ClaudeLaunchError> {
        let (listener, arrivals) = ForwardedArrivals::open();
        let process = launcher
            .start(
                ClaudeProcessLaunch {
                    start: executable.start.clone(),
                    arguments,
                    environment: executable.environment.clone(),
                    working_folder,
                    provider_session_id: mint_uuid_v7().to_string(),
                    provider_account_id,
                },
                listener,
                None,
            )
            .await?;
        Ok(Self {
            process,
            arrivals: Mutex::new(arrivals),
        })
    }

    /// Starts a process that keeps nothing in `working_folder`, the daemon's empty folder where
    /// `None`, on `model` and under `provider_account_id`'s account where given. Fails as the
    /// launcher's start does.
    pub(crate) async fn start_control_only(
        launcher: &ClaudeProcessLauncher,
        executable: &ResolvedProviderExecutable,
        working_folder: Option<PathBuf>,
        model: Option<&str>,
        provider_account_id: Option<ProviderAccountId>,
    ) -> Result<Self, ClaudeLaunchError> {
        let working_folder = match working_folder {
            Some(folder) => folder,
            None => launcher.control_only_folder().await?,
        };
        Self::start(
            launcher,
            executable,
            compose_claude_control_only_arguments(model),
            working_folder,
            provider_account_id,
        )
        .await
    }

    /// Sends `initialize`, listing `plugin_folders`, the folders the process was started with,
    /// and answers its reply. Fails as `send_initialize` does.
    pub(crate) async fn initialize(
        &self,
        plugin_folders: &[PathBuf],
    ) -> Result<Option<Box<RawValue>>, ClaudeSessionError> {
        let plugins = plugin_folders
            .iter()
            .map(|folder| ClaudeInitializePlugin {
                kind: ClaudeInitializePluginKind::Local,
                path: folder.to_string_lossy().into_owned(),
            })
            .collect();
        Ok(self
            .process
            .send_initialize(compose_claude_initialize_request(None, Vec::new(), plugins))
            .await?
            .response)
    }

    /// Reads the process's context usage; `None` where Claude Code refused the read, which a build
    /// without it does, so no window is ever guessed. Fails as any other request does.
    pub(crate) async fn read_context_usage(
        &self,
    ) -> Result<Option<Box<RawValue>>, ClaudeSessionError> {
        match self
            .process
            .send_control_request(ClaudeControlRequest::GetContextUsage {
                detail: ClaudeContextUsageDetail::Summary,
            })
            .await
        {
            Ok(answer) => Ok(answer.response),
            Err(ClaudeSessionError::ControlRequestRefused { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Closes the process as a session closes: its input closed, then stopped past the request
    /// deadline.
    pub(crate) async fn close(self) {
        self.process.close().await;
    }
}

// The members of an `initialize` reply's `account` the sign-in probe reads.
#[derive(Deserialize)]
struct InitializeAccount {
    #[serde(default)]
    account: Option<AccountSources>,
}

#[derive(Deserialize)]
struct AccountSources {
    #[serde(rename = "tokenSource", default)]
    token_source: Option<Value>,
    #[serde(rename = "apiKeySource", default)]
    api_key_source: Option<Value>,
}

/// Brings a process up on the person's own home with nothing kept and answers how the
/// `initialize` reply's account says it is signed in. Fails with `AuthenticationRequired` when it
/// names no sign-in source, and as the start or `initialize` does.
pub(crate) async fn probe_claude_sign_in(
    launcher: &ClaudeProcessLauncher,
    executable: &ResolvedProviderExecutable,
) -> Result<String, ClaudeLaunchError> {
    let short =
        ClaudeShortProcess::start_control_only(launcher, executable, None, None, None).await?;
    let reply = short.initialize(&[]).await;
    short.close().await;
    let sources = reply?
        .and_then(|reply| serde_json::from_str::<InitializeAccount>(reply.get()).ok())
        .and_then(|reply| reply.account);
    let source = sources.and_then(|sources| {
        [sources.token_source, sources.api_key_source]
            .into_iter()
            .flatten()
            .find_map(|source| {
                source
                    .as_str()
                    .filter(|source| !source.is_empty())
                    .map(str::to_owned)
            })
    });
    match source {
        Some(source) if source != "none" => Ok(format!("signed in through {source}")),
        Some(_) | None => Err(ClaudeSessionError::AuthenticationRequired {
            detail: "Claude Code names no sign-in on this home.".to_owned(),
        }
        .into()),
    }
}

/// Reads the model catalog from a process that keeps nothing: its `initialize` reply and the
/// context usage of the model it runs. Fails as the start or a request does.
pub(crate) async fn read_claude_model_catalog(
    launcher: &ClaudeProcessLauncher,
    executable: &ResolvedProviderExecutable,
) -> Result<ClaudeModelCatalogReading, ClaudeLaunchError> {
    let short =
        ClaudeShortProcess::start_control_only(launcher, executable, None, None, None).await?;
    let read = async {
        Ok::<_, ClaudeSessionError>(ClaudeModelCatalogReading {
            initialize: short.initialize(&[]).await?,
            context_usage: short.read_context_usage().await?,
        })
    }
    .await;
    short.close().await;
    Ok(read?)
}
