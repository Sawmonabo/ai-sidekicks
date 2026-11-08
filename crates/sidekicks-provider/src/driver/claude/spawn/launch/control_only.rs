//! The Claude Code processes that keep nothing: brought up only to answer control requests, with
//! no hooks and no conversation kept, for the sign-in probe, the model catalog and the build's
//! version, an account's MCP servers and the MCP server probe, each in the daemon's own empty
//! folder unless a read needs another. Each is closed once its reads are done, as a session closes.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use secrecy::SecretString;
use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use tokio::sync::{Mutex, mpsc};

use crate::driver::claude::hooks::registration::compose_claude_initialize_request;
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::process::account::ClaudeProcessAccount;
use crate::driver::claude::session::process::{
    ClaudeCodeProcess, ClaudeProcessEnd, ClaudeProcessLaunch, ClaudeProcessListener,
    ClaudeStreamFrame,
};
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::{
    ClaudeContextUsageDetail, ClaudeControlRequest,
};
use crate::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
use crate::driver::claude::session::transport::readings::ClaudeModelCatalogReading;
use crate::driver::claude::spawn::launch::{ClaudeLaunchError, ClaudeProcessLauncher};
use crate::driver::claude::spawn::settings::ClaudeSpawnSettings;
use crate::driver::claude::spawn::system_prompt::claude_appended_system_prompt_arguments;
use crate::lenient_json::read_is_non_empty_text;
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
    /// account where given, handed `token` where given and else the account's sealed one, with a
    /// short process's settings, every hook of the person's off where `are_hooks_off`. Fails as
    /// the launcher's start does.
    pub(crate) async fn start(
        launcher: &ClaudeProcessLauncher,
        executable: &ResolvedProviderExecutable,
        arguments: Vec<String>,
        working_folder: PathBuf,
        provider_account_id: Option<ProviderAccountId>,
        token: Option<SecretString>,
        are_hooks_off: bool,
    ) -> Result<Self, ClaudeLaunchError> {
        let (listener, arrivals) = ForwardedArrivals::open();
        let process = launcher
            .start(
                ClaudeProcessLaunch {
                    start: executable.start.clone(),
                    arguments,
                    settings: ClaudeSpawnSettings::short_process(are_hooks_off),
                    environment: executable.environment.clone(),
                    working_folder,
                    provider_session_id: mint_uuid_v7().to_string(),
                    account: ClaudeProcessAccount::new(provider_account_id),
                    token,
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
    /// `None`, on `model` and under `provider_account_id`'s account where given, handed `token`
    /// as [`Self::start`] hands it. Fails as the launcher's start does.
    pub(crate) async fn start_control_only(
        launcher: &ClaudeProcessLauncher,
        executable: &ResolvedProviderExecutable,
        working_folder: Option<PathBuf>,
        model: Option<&str>,
        provider_account_id: Option<ProviderAccountId>,
        token: Option<SecretString>,
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
            token,
            false,
        )
        .await
    }

    /// Sends `initialize` with no hooks and answers its reply. Fails as `send_initialize` does.
    pub(crate) async fn initialize(&self) -> Result<Option<Box<RawValue>>, ClaudeSessionError> {
        Ok(self
            .process
            .send_initialize(compose_claude_initialize_request(None, Vec::new()))
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

// The account's email is read only as whether it is a non-empty string, never kept.
#[derive(Deserialize)]
struct AccountSources {
    #[serde(rename = "tokenSource", default)]
    token_source: Option<Value>,
    #[serde(rename = "apiKeySource", default)]
    api_key_source: Option<Value>,
    #[serde(default, deserialize_with = "read_is_non_empty_text")]
    email: bool,
}

/// How an `initialize` reply's account says a process is signed in: the source Claude Code names
/// for its token and for its API key, each `None` where it names none, and whether it names the
/// account's email, which is never kept.
#[derive(Default)]
pub(crate) struct ClaudeSignInSources {
    token_source: Option<String>,
    api_key_source: Option<String>,
    has_email: bool,
}

impl ClaudeSignInSources {
    /// The source of the process's sign-in token, where it names one other than `none`, Claude
    /// Code's word for no token.
    pub(crate) fn token_source(&self) -> Option<&str> {
        self.token_source
            .as_deref()
            .filter(|source| *source != CLAUDE_NO_SIGN_IN_SOURCE)
    }

    /// The source of the process's API key, where it names one other than `none`.
    pub(crate) fn api_key_source(&self) -> Option<&str> {
        self.api_key_source
            .as_deref()
            .filter(|source| *source != CLAUDE_NO_SIGN_IN_SOURCE)
    }

    /// Whether the reply named the account's email.
    pub(crate) fn has_email(&self) -> bool {
        self.has_email
    }

    /// How the process is signed in, by the first source named: its token's, else its API key's.
    /// Fails with `AuthenticationRequired` when that source is `none` or no source is named.
    pub(crate) fn into_signed_in_detail(self) -> Result<String, ClaudeLaunchError> {
        match self.token_source.or(self.api_key_source) {
            Some(source) if source != CLAUDE_NO_SIGN_IN_SOURCE => {
                Ok(format!("signed in through {source}"))
            }
            Some(_) | None => Err(ClaudeSessionError::AuthenticationRequired {
                detail: "Claude Code names no sign-in on this home.".to_owned(),
            }
            .into()),
        }
    }
}

// The source an `initialize` reply names for a sign-in it does not have.
const CLAUDE_NO_SIGN_IN_SOURCE: &str = "none";

/// Brings a process up on the executable's home with nothing kept, under `provider_account_id`'s
/// account where given and handed `token` as [`ClaudeShortProcess::start`] hands it, and answers
/// the sign-in sources its `initialize` reply's account names, a blank one read as unnamed and a
/// reply naming no account as signed out. Fails as the start or `initialize` does, and with
/// `InitializeUnreadable` where the reply cannot be read.
pub(crate) async fn probe_claude_sign_in(
    launcher: &ClaudeProcessLauncher,
    executable: &ResolvedProviderExecutable,
    provider_account_id: Option<ProviderAccountId>,
    token: Option<SecretString>,
) -> Result<ClaudeSignInSources, ClaudeLaunchError> {
    let short = ClaudeShortProcess::start_control_only(
        launcher,
        executable,
        None,
        None,
        provider_account_id,
        token,
    )
    .await?;
    let reply = short.initialize().await;
    short.close().await;
    let sources = reply?
        .map(|reply| serde_json::from_str::<InitializeAccount>(reply.get()))
        .transpose()
        .map_err(ClaudeLaunchError::InitializeUnreadable)?
        .and_then(|reply| reply.account);
    let named = |source: Option<Value>| {
        source.and_then(|source| {
            source
                .as_str()
                .filter(|source| !source.is_empty())
                .map(str::to_owned)
        })
    };
    Ok(sources
        .map(|sources| ClaudeSignInSources {
            token_source: named(sources.token_source),
            api_key_source: named(sources.api_key_source),
            has_email: sources.email,
        })
        .unwrap_or_default())
}

/// Reads the model catalog from a process that keeps nothing on `provider_account_id`'s account:
/// its `initialize` reply and the context usage of the model it runs. Fails as the start or a
/// request does.
pub(crate) async fn read_claude_model_catalog(
    launcher: &ClaudeProcessLauncher,
    executable: &ResolvedProviderExecutable,
    provider_account_id: ProviderAccountId,
) -> Result<ClaudeModelCatalogReading, ClaudeLaunchError> {
    let short = ClaudeShortProcess::start_control_only(
        launcher,
        executable,
        None,
        None,
        Some(provider_account_id),
        None,
    )
    .await?;
    let read = async {
        Ok::<_, ClaudeSessionError>(ClaudeModelCatalogReading {
            initialize: short.initialize().await?,
            context_usage: short.read_context_usage().await?,
        })
    }
    .await;
    short.close().await;
    Ok(read?)
}
