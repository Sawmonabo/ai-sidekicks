//! The settling run, made with no person's call: for a file kept because no Secret Service ran, the
//! pick and its check under the place's lock, then the move of its secrets into a Secret Service,
//! one run at a time, a request made during a run running it once more when it ends. Any other
//! place, or none recorded yet, is settled inside the next call.

use std::error::Error;
use std::sync::{Arc, MutexGuard, PoisonError};

use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::CredentialStore;

use crate::credential_store::items::{Check, SecretItems, Verdict};
use crate::credential_store::place::{PlaceRecord, SecretsPlace};
use crate::credential_store::service::KeychainService;
use crate::credential_store::{KeychainRefusal, SecretKeychain};

// Whether a settling run is under way and whether another was asked for during it.
#[derive(Default)]
pub(super) struct SettleRuns {
    is_running: bool,
    is_rerun_asked: bool,
}

impl SecretItems {
    /// Settles a file kept because no Secret Service ran, picked or recorded with no move under
    /// way: checks it and moves its secrets into a Secret Service that runs with its default
    /// collection unlocked. One run at a time: a request while one runs asks it to run once more
    /// when it ends and returns at once. A refusal is logged, and the next request tries again.
    pub(super) async fn settle(&self) {
        {
            let mut runs = self.lock_settle_runs();
            if runs.is_running {
                runs.is_rerun_asked = true;
                return;
            }
            runs.is_running = true;
        }
        loop {
            self.settle_once().await;
            let mut runs = self.lock_settle_runs();
            if !std::mem::take(&mut runs.is_rerun_asked) {
                runs.is_running = false;
                return;
            }
        }
    }

    /// Asks for a settling run in a task of its own, as a secret call does and as the start does
    /// at each of the store's signals.
    pub(crate) fn nudge(self: &Arc<Self>) {
        let items = Arc::clone(self);
        tokio::spawn(async move { items.settle().await });
    }

    // The runs' state, kept whole if a run panicked holding it.
    fn lock_settle_runs(&self) -> MutexGuard<'_, SettleRuns> {
        self.settle_runs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    // One settling run: the pick and its check, then the move when the items wait for it; nothing
    // when the place is no file waiting to move, which the next call settles.
    async fn settle_once(&self) {
        let place = {
            let mut state = self.state.write().await;
            self.read_record_once(&mut state).await;
            if !state.can_settle_in_background() {
                return;
            }
            match self.settle_held(&mut state).await {
                Ok(place) if state.is_waiting_to_move(place) => place,
                Ok(_settled) => return,
                Err(refusal) => {
                    tracing::warn!(
                        error = &refusal as &(dyn Error + 'static),
                        "The secrets' place is not ready; the next secret call tries again"
                    );
                    return;
                }
            }
        };
        if let Err(refusal) = self.move_into_secret_service(place).await {
            tracing::warn!(
                error = &refusal as &(dyn Error + 'static),
                "The secrets stay in the items file: their move into the Secret Service was \
                 refused, and the next secret call or signal tries again"
            );
        }
    }

    // Moves the items from `place`, the file, into a Secret Service that runs with its default
    // collection unlocked and passes its check, the check made outside the place's lock and the
    // copy's store calls each answered within 2 s. Fails with the refusal that stopped it.
    async fn move_into_secret_service(&self, place: SecretsPlace) -> Result<(), KeychainRefusal> {
        if self.access.check_reachable().await.is_err() {
            return Ok(());
        }
        match self.access.is_unlocked().await {
            Ok(true) => {}
            Ok(false) => {
                tracing::info!(
                    "The Secret Service's default collection is locked or missing, so the secrets \
                     stay in the items file until it is unlocked"
                );
                return Ok(());
            }
            Err(unreachable) => {
                return Err(KeychainRefusal::new(
                    KeychainRefusalCause::Unavailable,
                    "the Secret Service did not say whether its default collection is unlocked",
                )
                .with_failure(unreachable));
            }
        }
        match self.check(SecretsPlace::OperatingSystem).await {
            Check::Accepted => {}
            Check::Mismatch => {
                self.state.write().await.is_move_stopped = true;
                tracing::error!(
                    "The Secret Service kept another value than the one written, so the secrets \
                     stay in the items file until the next start"
                );
                return Ok(());
            }
            Check::Refused(refusal) => return Err(refusal),
        }
        let mut state = self.state.write().await;
        // A pick, a move or an erase may have changed the place while the check ran.
        if state.picked != Some(place)
            || state.verdict != Verdict::Accepted
            || !state.is_waiting_to_move(place)
        {
            return Ok(());
        }
        let to = |service: KeychainService| -> Box<dyn SecretKeychain> {
            Box::new(
                self.os_store
                    .keychain_within(service.as_str(), CredentialStore::QUICK_ANSWER_LIMIT),
            )
        };
        self.move_items(
            &mut state,
            PlaceRecord::settled(place),
            SecretsPlace::OperatingSystem,
            &to,
        )
        .await
    }
}
