//! The account one Claude Code process runs on, shared by its output reader, its control-frame
//! reader and its session's stream, so a switch the process acknowledges moves it for all three,
//! with the credential store an in-place switch pointed the process at and when each move was
//! made, so a request its export states later is charged to the account it ran on.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::unix_time::read_unix_time_ms;

use crate::driver::claude::account::credentials::SECURE_STORAGE_FOLDER_VARIABLE;

// How many of a process's account moves are kept for the requests its export states after them;
// past it the oldest folds into the account before every kept move.
const MOVES_KEPT: usize = 16;

/// The account a process runs on, made at its launch; each clone shares it. Empty for a short read
/// that names no account.
#[derive(Clone, Debug, Default)]
pub(crate) struct ClaudeProcessAccount(Arc<Mutex<ClaudeProcessSignIn>>);

// The account the process launched on, the one it runs on now, the credential store an in-place
// switch pointed the process at since its start, and its latest moves, each by the Unix
// millisecond it was made at, after the account it ran on before every kept one.
#[derive(Debug, Default)]
struct ClaudeProcessSignIn {
    launch_account: Option<ProviderAccountId>,
    provider_account_id: Option<ProviderAccountId>,
    moved_store: Option<String>,
    account_before_moves: Option<ProviderAccountId>,
    moves: VecDeque<(u64, ProviderAccountId)>,
}

impl ClaudeProcessAccount {
    /// The account of a process launched on `provider_account_id`'s home, `None` naming none.
    pub(crate) fn new(provider_account_id: Option<ProviderAccountId>) -> Self {
        Self(Arc::new(Mutex::new(ClaudeProcessSignIn {
            launch_account: provider_account_id.clone(),
            account_before_moves: provider_account_id.clone(),
            provider_account_id,
            moved_store: None,
            moves: VecDeque::new(),
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

    /// The account the process ran on at `at_ms`, in Unix milliseconds.
    pub(crate) fn read_at(&self, at_ms: u64) -> Option<ProviderAccountId> {
        let sign_in = lock(&self.0);
        sign_in
            .moves
            .iter()
            .rev()
            .find(|(moved_at_ms, _)| *moved_at_ms <= at_ms)
            .map(|(_, moved_to)| moved_to.clone())
            .or_else(|| sign_in.account_before_moves.clone())
    }

    /// Moves the process onto `provider_account_id`'s account now, for every holder at once.
    pub(crate) fn move_to(&self, provider_account_id: ProviderAccountId) {
        let mut sign_in = lock(&self.0);
        if sign_in.moves.len() >= MOVES_KEPT
            && let Some((_, oldest)) = sign_in.moves.pop_front()
        {
            sign_in.account_before_moves = Some(oldest);
        }
        sign_in
            .moves
            .push_back((read_unix_time_ms(), provider_account_id.clone()));
        sign_in.provider_account_id = Some(provider_account_id);
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
