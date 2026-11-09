//! The Codex home one service runs on, and the three kinds of service the daemon keeps there: its
//! own on an account home, the switching home, the capability read's, an MCP sign-in's or a pasted
//! key's status read's, the lasting one on the person's own Codex folder that terminals join, and
//! one already there that is not the daemon's, which it only joins; and how the driver resolves the
//! home an account runs in.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_platforms::PathRules;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::ProviderAccountReader;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::service::registry::CodexHomeResolver;
use crate::driver::contract::error::DriverError;

/// The person's own Codex folder under their home, where `CODEX_HOME` names none.
const CODEX_PERSONAL_HOME_FOLDER_NAME: &str = ".codex";

/// What a Codex home is to the daemon.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodexHomeKind {
    /// The home the app manages for the account it names.
    Account(ProviderAccountId),
    /// The home the app manages for an account signed in with a pasted API key; its service keeps
    /// the key it is handed in memory alone.
    ApiKeyAccount(ProviderAccountId),
    /// The daemon's own home under its data folder, apart from every account home, where the one
    /// switching service runs on tokens the daemon hands it, carrying every session that follows
    /// the provider's current account; it keeps no sign-in of its own.
    Switching,
    /// The person's own Codex folder, which the daemon runs a service on only while terminal reach
    /// is on.
    PersonalFolder,
    /// An empty folder of the daemon's own that the capability read runs one short-lived service
    /// in, signed in to no account.
    CapabilityRead,
    /// A folder of the daemon's own, made for one MCP server's sign-in through Codex's own client
    /// and deleted after it, holding only that server's entry and the sign-in Codex saves.
    McpSignIn,
    /// A folder of the daemon's own that one status read of a pasted API key runs one short-lived
    /// service in.
    TokenStatusRead,
}

/// The Codex home one service runs on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexServiceHome {
    /// The home, absolute.
    pub(crate) codex_home: PathBuf,
    /// What the home is to the daemon.
    pub(crate) kind: CodexHomeKind,
}

impl CodexServiceHome {
    /// The account the home belongs to; `None` for the switching home, the person's own folder
    /// and the folders the capability read, an MCP sign-in and a pasted key's status read run in.
    pub(crate) fn provider_account_id(&self) -> Option<&ProviderAccountId> {
        match &self.kind {
            CodexHomeKind::Account(provider_account_id)
            | CodexHomeKind::ApiKeyAccount(provider_account_id) => Some(provider_account_id),
            CodexHomeKind::Switching
            | CodexHomeKind::PersonalFolder
            | CodexHomeKind::CapabilityRead
            | CodexHomeKind::McpSignIn
            | CodexHomeKind::TokenStatusRead => None,
        }
    }
}

/// The key of a binding's recovery data that names the home holding its conversation.
const CONVERSATION_HOME_KEY: &str = "conversationHome";

/// The value of [`CONVERSATION_HOME_KEY`] for a conversation the switching home holds.
const SWITCHING_CONVERSATION_HOME: &str = "switching";

/// Which home holds a conversation, kept in its binding's recovery data, so its resume and its
/// purge reach the service that holds it whichever account it ran on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexConversationHome {
    /// The home of the account the binding names, which recovery data with no home member means.
    Account,
    /// The switching home.
    Switching,
}

impl CodexConversationHome {
    /// The home a conversation on a service of `home` lives in.
    pub(crate) fn of_service(home: &CodexServiceHome) -> Self {
        match home.kind {
            CodexHomeKind::Switching => Self::Switching,
            CodexHomeKind::Account(_)
            | CodexHomeKind::ApiKeyAccount(_)
            | CodexHomeKind::PersonalFolder
            | CodexHomeKind::CapabilityRead
            | CodexHomeKind::McpSignIn
            | CodexHomeKind::TokenStatusRead => Self::Account,
        }
    }

    /// The home a binding's recovery data `runtime_metadata` names.
    pub(crate) fn read(runtime_metadata: &Map<String, Value>) -> Self {
        match runtime_metadata
            .get(CONVERSATION_HOME_KEY)
            .and_then(Value::as_str)
        {
            Some(SWITCHING_CONVERSATION_HOME) => Self::Switching,
            _ => Self::Account,
        }
    }

    /// Writes the home into recovery data `runtime_metadata`: the switching home by name, the
    /// account's by leaving the member out.
    pub(crate) fn keep_in(self, runtime_metadata: &mut Map<String, Value>) {
        match self {
            Self::Account => {
                runtime_metadata.remove(CONVERSATION_HOME_KEY);
            }
            Self::Switching => {
                runtime_metadata.insert(
                    CONVERSATION_HOME_KEY.to_owned(),
                    Value::from(SWITCHING_CONVERSATION_HOME),
                );
            }
        }
    }
}

/// Which kind of service a supervisor holds, which decides how it starts, how its end is read and
/// who may stop it. A session's recovery and a conversation's purge read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexServiceKind {
    /// The daemon's own service with no hook switch: on an account home or the switching home a
    /// lasting service kept in its record, which a daemon restart keeps running and the next start
    /// joins, and on the capability read's home and an MCP sign-in's the daemon's own child, which
    /// the daemon's stop ends.
    Account,
    /// The lasting service on the person's own Codex folder that terminals join: started by the
    /// daemon in a session of its own with the daemon's two hooks, kept in its record, outliving a
    /// daemon restart.
    Terminal,
    /// A service on the person's own Codex folder that is not the daemon's: Codex's own managed
    /// daemon while it is in use, or a lasting service answering on the socket whose record this
    /// daemon cannot pin (an inference: a live service the daemon cannot pin is never signaled).
    /// The daemon only connects to it and never stops it.
    Joined,
}

impl CodexServiceKind {
    /// Whether the daemon started the process and so reads its exit as a crash and restarts it.
    pub(crate) const fn is_daemons_own(self) -> bool {
        match self {
            Self::Account | Self::Terminal => true,
            Self::Joined => false,
        }
    }

    /// Whether a session on this kind of service runs the daemon's hooks: on a terminal service
    /// only while the daemon's program dispatches its hook mode, as `dispatches_hook_mode` says; on
    /// an account service none, since no tool server's route is wired; on a joined one never, the
    /// service not being the daemon's.
    pub(crate) const fn runs_daemon_hooks(self, dispatches_hook_mode: bool) -> bool {
        match self {
            Self::Terminal => dispatches_hook_mode,
            Self::Account | Self::Joined => false,
        }
    }

    /// Whether a service of this kind starts with Codex's own browser tool off: the daemon's own
    /// service, whose sessions browse through the daemon's browser tools; never the terminal
    /// service on the person's own Codex folder, whose terminals keep what the person chose, nor
    /// one the daemon only joins.
    pub(crate) const fn is_codex_browser_off(self) -> bool {
        match self {
            Self::Account => true,
            Self::Terminal | Self::Joined => false,
        }
    }
}

/// The homes the driver's services run on: an account the app manages runs in its own folder, and
/// the person's own Codex folder is terminal reach's alone.
pub(crate) struct CodexHomes {
    provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
    personal_home: PathBuf,
}

impl CodexHomes {
    /// The homes resolved through `provider_accounts`, the person's own folder named by
    /// `base_environment`'s `CODEX_HOME`, else `.codex` under `home_folder`.
    pub(crate) fn new(
        provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
        base_environment: &[(String, String)],
        home_folder: &Path,
    ) -> Self {
        Self {
            provider_accounts,
            personal_home: read_codex_personal_home(base_environment, home_folder),
        }
    }
}

impl CodexHomeResolver for CodexHomes {
    fn codex_home_for<'call>(
        &'call self,
        provider_account_id: &'call ProviderAccountId,
    ) -> BoxFuture<'call, Result<CodexServiceHome, DriverError>> {
        async move {
            let accounts = self
                .provider_accounts
                .require_port()
                .map_err(|error| DriverError::Internal(Box::new(error)))?;
            let folders = accounts
                .resolve_account_folders(provider_account_id.clone())
                .await?;
            let mode = accounts
                .read_observed_auth_mode(provider_account_id.clone())
                .await
                .map_err(DriverError::Internal)?;
            let kind = if mode == Some(ProviderAuthMode::ApiKey) {
                CodexHomeKind::ApiKeyAccount(provider_account_id.clone())
            } else {
                CodexHomeKind::Account(provider_account_id.clone())
            };
            Ok(CodexServiceHome {
                codex_home: folders.configuration_folder,
                kind,
            })
        }
        .boxed()
    }

    fn terminal_reach_home(&self) -> CodexServiceHome {
        CodexServiceHome {
            codex_home: self.personal_home.clone(),
            kind: CodexHomeKind::PersonalFolder,
        }
    }
}

// The person's own Codex folder: the login shell's `CODEX_HOME` where it names one, else `.codex`
// under their home.
fn read_codex_personal_home(base_environment: &[(String, String)], home_folder: &Path) -> PathBuf {
    let rules = PathRules::NATIVE;
    let keys: Vec<_> = DESCRIPTOR
        .credential_home_environment_names
        .iter()
        .map(|name| rules.environment_name_key(name))
        .collect();
    base_environment
        .iter()
        .find(|(name, value)| !value.is_empty() && keys.contains(&rules.environment_name_key(name)))
        .map_or_else(
            || home_folder.join(CODEX_PERSONAL_HOME_FOLDER_NAME),
            |(_, value)| PathBuf::from(value),
        )
}
