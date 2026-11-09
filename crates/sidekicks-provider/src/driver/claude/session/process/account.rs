//! The account one Claude Code process runs on, shared by its output reader, its control-frame
//! reader and its session's stream, so a move onto another account moves it for all three.

use std::sync::{Arc, Mutex};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::mutex_lock::lock;

/// The account a process runs on, made at its launch; each clone shares it. Empty for a short read
/// that names no account.
#[derive(Clone, Debug, Default)]
pub(crate) struct ClaudeProcessAccount(Arc<Mutex<ClaudeProcessSignIn>>);

// The account the process launched on and the one it runs on now.
#[derive(Debug, Default)]
struct ClaudeProcessSignIn {
    launch_account: Option<ProviderAccountId>,
    provider_account_id: Option<ProviderAccountId>,
}

impl ClaudeProcessAccount {
    /// The account of a process launched on `provider_account_id`'s home, `None` naming none.
    pub(crate) fn new(provider_account_id: Option<ProviderAccountId>) -> Self {
        Self(Arc::new(Mutex::new(ClaudeProcessSignIn {
            launch_account: provider_account_id.clone(),
            provider_account_id,
        })))
    }

    /// Whether the process launched on `provider_account_id`'s account, so what it read at its
    /// start, its model catalog among them, is that account's.
    pub(crate) fn is_launched_on(&self, provider_account_id: &ProviderAccountId) -> bool {
        lock(&self.0).launch_account.as_ref() == Some(provider_account_id)
    }

    /// The account the process runs on now.
    pub(crate) fn read(&self) -> Option<ProviderAccountId> {
        lock(&self.0).provider_account_id.clone()
    }

    /// Moves the process onto `provider_account_id`'s account, for every holder at once.
    pub(crate) fn move_to(&self, provider_account_id: ProviderAccountId) {
        lock(&self.0).provider_account_id = Some(provider_account_id);
    }
}
