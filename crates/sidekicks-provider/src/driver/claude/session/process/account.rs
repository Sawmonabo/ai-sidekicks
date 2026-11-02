//! The account one Claude Code process runs on, shared by its output reader, its control-frame
//! reader and its session's stream, so a switch the process acknowledges moves it for all three,
//! with the credential store an in-place switch pointed the process at.

use std::sync::{Arc, Mutex};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::mutex_lock::lock;

use crate::driver::claude::account::credentials::SECURE_STORAGE_FOLDER_VARIABLE;

/// The account a process runs on, made at its launch; each clone shares it. Empty for a short read
/// that names no account.
#[derive(Clone, Debug, Default)]
pub(crate) struct ClaudeProcessAccount(Arc<Mutex<ClaudeProcessSignIn>>);

// The account, and the credential store an in-place switch pointed the process at since its start.
#[derive(Debug, Default)]
struct ClaudeProcessSignIn {
    provider_account_id: Option<ProviderAccountId>,
    moved_store: Option<String>,
}

impl ClaudeProcessAccount {
    /// The account of a process launched on `provider_account_id`'s home, `None` naming none.
    pub(crate) fn new(provider_account_id: Option<ProviderAccountId>) -> Self {
        Self(Arc::new(Mutex::new(ClaudeProcessSignIn {
            provider_account_id,
            moved_store: None,
        })))
    }

    /// The account the process runs on now.
    pub(crate) fn read(&self) -> Option<ProviderAccountId> {
        lock(&self.0).provider_account_id.clone()
    }

    /// Moves the process onto `provider_account_id`'s account, for every holder at once.
    pub(crate) fn move_to(&self, provider_account_id: ProviderAccountId) {
        lock(&self.0).provider_account_id = Some(provider_account_id);
    }

    /// Records that an in-place switch pointed the process at the credential store `store`.
    pub(crate) fn point_at_store(&self, store: String) {
        lock(&self.0).moved_store = Some(store);
    }

    /// `spawn_environment`, the one the process started with, as it signs in now: the credential
    /// store an in-place switch pointed the process at takes the place of the one it names.
    pub(crate) fn signed_in_environment(
        &self,
        spawn_environment: &[(String, String)],
    ) -> Vec<(String, String)> {
        let moved_store = lock(&self.0).moved_store.clone();
        spawn_environment
            .iter()
            .map(|(name, value)| match &moved_store {
                Some(store) if name == SECURE_STORAGE_FOLDER_VARIABLE => {
                    (name.clone(), store.clone())
                }
                Some(_) | None => (name.clone(), value.clone()),
            })
            .collect()
    }
}
