//! The Codex home one service runs on, and the three kinds of service the daemon keeps there: one
//! it starts as its own child, the lasting one on the person's own Codex folder that terminals
//! join, and one already there that is not the daemon's, which it only joins; and how the driver
//! resolves the home an account runs in.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::PathRules;

use crate::driver::ProviderAccountReader;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::service::registry::CodexHomeResolver;
use crate::driver::contract::DriverError;
use sidekicks_std::port_registration::PortRegistration;

/// The person's own Codex folder under their home, where `CODEX_HOME` names none.
const CODEX_PERSONAL_HOME_FOLDER_NAME: &str = ".codex";

/// What a Codex home is to the daemon.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodexHomeKind {
    /// The home the app manages for the account it names.
    Account(ProviderAccountId),
    /// The person's own Codex folder, which the daemon runs a service on only while terminal reach
    /// is on.
    PersonalFolder,
    /// An empty folder of the daemon's own that the capability read runs one short-lived service
    /// in, signed in to no account.
    CapabilityRead,
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
    /// The account the home belongs to; `None` for the person's own folder and the capability
    /// read's.
    pub(crate) fn provider_account_id(&self) -> Option<&ProviderAccountId> {
        match &self.kind {
            CodexHomeKind::Account(provider_account_id) => Some(provider_account_id),
            CodexHomeKind::PersonalFolder | CodexHomeKind::CapabilityRead => None,
        }
    }
}

/// Which kind of service a supervisor holds, which decides how it starts, how its end is read and
/// who may stop it. A session's recovery and a conversation's purge read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexServiceKind {
    /// The daemon's own child, prepared as every child of the daemon is, which the daemon's stop
    /// ends and which carries no hook switch: on an account home and on the capability read's.
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

    /// The person's own Codex folder.
    pub(crate) fn personal_home(&self) -> &Path {
        &self.personal_home
    }
}

impl CodexHomeResolver for CodexHomes {
    fn codex_home_for<'call>(
        &'call self,
        provider_account_id: &'call ProviderAccountId,
    ) -> BoxFuture<'call, Result<CodexServiceHome, DriverError>> {
        async move {
            let folders = self
                .provider_accounts
                .require_port()
                .map_err(|error| DriverError::Internal(Box::new(error)))?
                .resolve_account_folders(provider_account_id.clone())
                .await?;
            Ok(CodexServiceHome {
                codex_home: folders.configuration_folder,
                kind: CodexHomeKind::Account(provider_account_id.clone()),
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
