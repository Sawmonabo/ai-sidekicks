//! The daemon's secrets for one run: the place picked for them, the check that the place keeps what
//! it is given, the move of the items file's secrets into a Secret Service once one runs and its
//! default collection is unlocked, and the erase of every item the app made.
//!
//! - **The pick.** A start with a place record keeps its place. One without picks the operating
//!   system's store when it can be reached, else the items file because no Secret Service runs, and
//!   a Mac's service running while the person is logged out picks the file because of that. The
//!   record is written only once the place passes its check, so a refused first start records
//!   nothing. A record that cannot be read refuses every call and is left as it is. A store picked
//!   for this run is opened at each call that needs it and is never traded for the file.
//! - **The check.** Write a random value under a fresh probe account, read it back, compare, then
//!   delete it, a failed delete only logged. A store that keeps another value refuses every call
//!   until the next start; one locked or not reached refuses that call, and the next call checks
//!   again.
//! - **The move.** While the file holds the secrets because no Secret Service ran, each secret call
//!   that finds one running, and each of the store's signals, asks for a settling run, and the call
//!   is served from the file. The run moves the items only once the Secret Service's default
//!   collection exists and is unlocked, so no move raises an unlock prompt, and once the store
//!   passes its check, made outside the place's lock. Only the copy and the deletes hold the calls
//!   behind them, so none writes to a place the move is leaving, and each store call of the copy
//!   answers within the store's quick-answer limit. A refusal before the move records its
//!   direction leaves the file serving; one after leaves the recorded move, which the next call
//!   finishes. A store that keeps another value stops the move until the next start.
//!
//! Every call answers within its one time, its waits for the place and a check included, and a
//! call with no answer in that time reads `locked`.

mod erase;
mod settling;
#[cfg(test)]
mod tests;

use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use tokio::sync::RwLock;

use crate::credential_store::file::{FileSecretKeychain, SecretItemsFile};
use crate::credential_store::items::settling::SettleRuns;
use crate::credential_store::os::{CredentialStoreAccess, OsCredentialStore, OsSecretKeychain};
use crate::credential_store::place::{self, PlaceRecord, SecretsFileReason, SecretsPlace};
use crate::credential_store::service::KeychainService;
use crate::credential_store::{KeychainRefusal, SecretKeychain, holds_value};
use crate::random_hex::random_hex;

// The random bytes of the check's value and of its probe account's name.
const PROBE_VALUE_BYTES: usize = 32;
const PROBE_ACCOUNT_BYTES: usize = 8;

/// What the daemon's start hands its secret items.
pub(crate) struct SecretItemsStart {
    /// The daemon's data folder, which holds the place record and the items file.
    pub(crate) data_folder: PathBuf,
    /// Whether this is a Mac's service running while the person is logged out, which cannot reach
    /// the login keychain.
    pub(crate) runs_while_logged_out: bool,
    /// This machine's credential store.
    pub(crate) access: Arc<dyn CredentialStoreAccess>,
    /// How long one secret call may take, every wait included.
    pub(crate) call_timeout: Duration,
}

/// The daemon's secrets for one run; see the module doc. Built once at the start and shared by
/// every feature, each through its own service's [`ItemsKeychain`].
pub(crate) struct SecretItems {
    /// The place record's path.
    record_path: PathBuf,
    /// Whether this is a Mac's service running while the person is logged out.
    runs_while_logged_out: bool,
    /// This machine's credential store.
    access: Arc<dyn CredentialStoreAccess>,
    /// The calls on the operating system's store.
    os_store: Arc<OsCredentialStore>,
    /// The items file.
    items_file: Arc<SecretItemsFile>,
    /// The check's account for this run, fresh at each start, so a leftover from another build is
    /// never touched.
    probe_account: String,
    /// How long one secret call may take.
    call_timeout: Duration,
    /// The place and its check, read by every call and written by a pick, a check and a move.
    state: RwLock<PlaceState>,
    /// Whether a settling run is under way, so only one runs at a time.
    settle_runs: Mutex<SettleRuns>,
}

// What this run knows of the place.
#[derive(Default)]
struct PlaceState {
    record: RecordState,
    // Where calls go, once picked.
    picked: Option<SecretsPlace>,
    verdict: Verdict,
    // Whether the move is stopped until the next start: a Secret Service kept another value than
    // its check wrote, or the erase emptied the places.
    is_move_stopped: bool,
}

// The place record as this run read it.
#[derive(Default)]
enum RecordState {
    #[default]
    Unread,
    // Why it cannot be read.
    Unreadable(String),
    Absent,
    Present(PlaceRecord),
}

// The picked place's check.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Verdict {
    #[default]
    Unchecked,
    Accepted,
    Mismatch,
}

// What a call may do now.
enum Readiness {
    Ready(SecretsPlace),
    Refused(KeychainRefusal),
    Unsettled,
}

// A check's outcome.
enum Check {
    Accepted,
    Mismatch,
    Refused(KeychainRefusal),
}

impl PlaceState {
    // What a call may do with the place as it stands.
    fn readiness(&self) -> Readiness {
        match &self.record {
            RecordState::Unread => return Readiness::Unsettled,
            RecordState::Unreadable(reason) => {
                return Readiness::Refused(unreadable_record(reason));
            }
            RecordState::Absent | RecordState::Present(_) => {}
        }
        let Some(place) = self.picked else {
            return Readiness::Unsettled;
        };
        match self.verdict {
            Verdict::Mismatch => Readiness::Refused(mismatch()),
            Verdict::Unchecked => Readiness::Unsettled,
            Verdict::Accepted => Readiness::Ready(place),
        }
    }

    // Whether a settling run may move the items: they sit in the file because no Secret Service
    // ran, and no Secret Service has kept another value this run.
    fn is_waiting_to_move(&self, place: SecretsPlace) -> bool {
        !self.is_move_stopped
            && place
                == SecretsPlace::File {
                    reason: SecretsFileReason::NoSecretService,
                }
    }

    // Whether a run made with no person's call may settle the place: only a file kept because no
    // Secret Service ran, picked or recorded with no move under way, and waiting to move, so such a
    // run never writes the check's probe into a Secret Service.
    fn can_settle_in_background(&self) -> bool {
        match (self.picked, &self.record) {
            (Some(place), _) => self.is_waiting_to_move(place),
            (None, RecordState::Present(record)) if record.moving_to.is_none() => {
                self.is_waiting_to_move(record.place)
            }
            (
                None,
                RecordState::Present(_)
                | RecordState::Unread
                | RecordState::Unreadable(_)
                | RecordState::Absent,
            ) => false,
        }
    }
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the secret items, settles them in the background, \
                  hands each feature its keychain and status its file, and the erase calls them"
    )
)]
impl SecretItems {
    /// The secret items of the data folder and store `start` names, nothing picked or checked
    /// yet. Fails with the random source's error when it gives no bytes for the probe account.
    pub(crate) fn new(start: SecretItemsStart) -> Result<Arc<Self>, getrandom::Error> {
        let probe_account = format!("store-verify-{}", random_hex(PROBE_ACCOUNT_BYTES)?);
        Ok(Arc::new(Self {
            record_path: place::record_path(&start.data_folder),
            runs_while_logged_out: start.runs_while_logged_out,
            os_store: OsCredentialStore::new(Arc::clone(&start.access), start.call_timeout),
            access: start.access,
            items_file: SecretItemsFile::new(&start.data_folder),
            probe_account,
            call_timeout: start.call_timeout,
            state: RwLock::new(PlaceState::default()),
            settle_runs: Mutex::new(SettleRuns::default()),
        }))
    }

    /// The items filed under `service`.
    pub(crate) fn keychain(self: &Arc<Self>, service: KeychainService) -> ItemsKeychain {
        ItemsKeychain {
            items: Arc::clone(self),
            service,
            os: self.os_store.keychain(service.as_str()),
            file: self.items_file.keychain(service.as_str()),
        }
    }

    /// The items file's path while it holds an item a move would carry, for the status read; a
    /// file that cannot be read counts, since it may hold one.
    pub(crate) async fn secrets_file(&self) -> Option<PathBuf> {
        let moved_services: Vec<&str> = KeychainService::ALL
            .into_iter()
            .filter(|service| service.is_moved())
            .map(KeychainService::as_str)
            .collect();
        self.items_file
            .holds_items(&moved_services)
            .await
            .then(|| self.items_file.file_path().to_path_buf())
    }

    // Serves one call within the call's time: waits for the place, settles it when it is not, then
    // runs `call` on it while no move can start, asking for a settling run when the items wait for
    // a Secret Service that now runs.
    async fn serve<'call, Answer: Send>(
        self: &'call Arc<Self>,
        service: KeychainService,
        call: impl FnOnce(SecretsPlace) -> BoxFuture<'call, Result<Answer, KeychainRefusal>> + Send,
    ) -> Result<Answer, KeychainRefusal> {
        let answer = tokio::time::timeout(self.call_timeout, async {
            let (state, place) = loop {
                let state = self.state.read().await;
                match state.readiness() {
                    Readiness::Ready(place) => break (state, place),
                    Readiness::Refused(refusal) => return Err(refusal),
                    Readiness::Unsettled => {}
                }
                drop(state);
                let mut state = self.state.write().await;
                self.settle_held(&mut state).await?;
            };
            if state.is_waiting_to_move(place) && self.access.check_reachable().await.is_ok() {
                self.nudge();
            }
            let answer = call(place).await;
            drop(state);
            answer
        })
        .await
        .unwrap_or_else(|_elapsed| {
            Err(KeychainRefusal::new(
                KeychainRefusalCause::Locked,
                format!("the keychain gave no answer within {:?}", self.call_timeout),
            ))
        });
        if let Err(refusal) = &answer {
            tracing::warn!(
                service = service.as_str(),
                error = refusal as &(dyn Error + 'static),
                "A keychain call was refused"
            );
        }
        answer
    }

    // Reads the place record into `state` when this run has not read it yet.
    async fn read_record_once(&self, state: &mut PlaceState) {
        if !matches!(state.record, RecordState::Unread) {
            return;
        }
        state.record = match place::read_record(&self.record_path).await {
            Ok(Some(record)) => RecordState::Present(record),
            Ok(None) => RecordState::Absent,
            Err(refusal) => {
                tracing::error!(
                    error = &refusal as &(dyn Error + 'static),
                    "The secrets' place record cannot be read, so every secret call is refused \
                     until it is fixed"
                );
                RecordState::Unreadable(refusal.reason().to_owned())
            }
        };
    }

    // Reads the record, picks the place and checks it, as far as each is not done yet, and answers
    // the place calls go to. Fails with the refusal the caller answers with.
    async fn settle_held(&self, state: &mut PlaceState) -> Result<SecretsPlace, KeychainRefusal> {
        self.read_record_once(state).await;
        if let RecordState::Unreadable(reason) = &state.record {
            return Err(unreadable_record(reason));
        }
        let place = match state.picked {
            Some(place) => place,
            None => self.pick(state).await?,
        };
        match state.verdict {
            Verdict::Mismatch => Err(mismatch()),
            Verdict::Accepted => Ok(place),
            Verdict::Unchecked => match self.check(place).await {
                Check::Accepted => {
                    if matches!(state.record, RecordState::Absent) {
                        let record = PlaceRecord::settled(place);
                        place::write_record(&self.record_path, &record).await?;
                        state.record = RecordState::Present(record);
                    }
                    state.verdict = Verdict::Accepted;
                    Ok(place)
                }
                Check::Mismatch => {
                    state.verdict = Verdict::Mismatch;
                    tracing::error!(
                        place = ?place,
                        "The secrets' place kept another value than the one written, so every \
                         secret call is refused until the next start"
                    );
                    Err(mismatch())
                }
                Check::Refused(refusal) => Err(refusal),
            },
        }
    }

    // Picks this run's place from the record, finishing a move the record names first, or with no
    // record from what this machine offers now, and logs it.
    async fn pick(&self, state: &mut PlaceState) -> Result<SecretsPlace, KeychainRefusal> {
        let recorded = match &state.record {
            RecordState::Present(record) => Some(*record),
            RecordState::Unread | RecordState::Unreadable(_) | RecordState::Absent => None,
        };
        let place = match recorded {
            Some(record) => match record.moving_to {
                Some(destination) => {
                    match self.check(destination).await {
                        Check::Accepted => {}
                        Check::Mismatch => return Err(mismatch()),
                        Check::Refused(refusal) => return Err(refusal),
                    }
                    let to = |service| self.place_keychain(destination, service);
                    self.move_items(state, record, destination, &to).await?;
                    destination
                }
                None => record.place,
            },
            None => {
                if self.runs_while_logged_out {
                    SecretsPlace::File {
                        reason: SecretsFileReason::LoggedOutService,
                    }
                } else {
                    match self.access.check_reachable().await {
                        Ok(()) => SecretsPlace::OperatingSystem,
                        Err(unreachable) => {
                            tracing::warn!(
                                error = &unreachable as &(dyn Error + 'static),
                                file = %self.items_file.file_path().display(),
                                "No Secret Service answers, so the secrets are kept in the items \
                                 file until one runs and its default collection is unlocked"
                            );
                            SecretsPlace::File {
                                reason: SecretsFileReason::NoSecretService,
                            }
                        }
                    }
                }
            }
        };
        state.picked = Some(place);
        let store = self.access.description().await;
        tracing::info!(
            place = ?place,
            is_recorded = matches!(state.record, RecordState::Present(_)),
            store,
            "The daemon's secrets have their place"
        );
        Ok(place)
    }

    // Moves every item from `record`'s place into `destination`, already checked, through the
    // keychains `to` gives. On success the destination serves, checked, and a file left behind is
    // deleted. Fails with the refusal, leaving `state` as it was when the move stopped before
    // recording its direction, and otherwise the recorded move, which the next call finishes.
    async fn move_items(
        &self,
        state: &mut PlaceState,
        record: PlaceRecord,
        destination: SecretsPlace,
        to: &(dyn Fn(KeychainService) -> Box<dyn SecretKeychain> + Sync),
    ) -> Result<(), KeychainRefusal> {
        let from = |service| self.place_keychain(record.place, service);
        if let Err(stopped) =
            place::move_items(&self.record_path, record, destination, &from, to).await
        {
            if stopped.record != record {
                *state = PlaceState {
                    record: RecordState::Present(stopped.record),
                    ..PlaceState::default()
                };
            }
            return Err(stopped.refusal);
        }
        if matches!(record.place, SecretsPlace::File { .. })
            && let Err(refusal) = self.items_file.remove_all().await
        {
            tracing::warn!(
                error = &refusal as &(dyn Error + 'static),
                "The items file the secrets left could not be deleted"
            );
        }
        *state = PlaceState {
            record: RecordState::Present(PlaceRecord::settled(destination)),
            picked: Some(destination),
            verdict: Verdict::Accepted,
            is_move_stopped: false,
        };
        tracing::info!(place = ?destination, "The daemon's secrets moved");
        Ok(())
    }

    // Writes a random value under this run's probe account in `place`, reads it back, compares
    // and deletes it.
    async fn check(&self, place: SecretsPlace) -> Check {
        let value = match random_hex(PROBE_VALUE_BYTES) {
            Ok(value) => SecretString::from(value),
            Err(failure) => {
                return Check::Refused(
                    KeychainRefusal::new(
                        KeychainRefusalCause::Unavailable,
                        "the system gave no random bytes for the store's check",
                    )
                    .with_failure(failure),
                );
            }
        };
        let keychain = self.place_keychain(place, KeychainService::Probe);
        if let Err(refusal) = keychain.write(&self.probe_account, &value).await {
            return Check::Refused(refusal);
        }
        let kept = match keychain.read(&self.probe_account).await {
            Ok(kept) => kept,
            Err(refusal) => return Check::Refused(refusal),
        };
        if let Err(refusal) = keychain.remove(&self.probe_account).await {
            tracing::warn!(
                error = &refusal as &(dyn Error + 'static),
                "The store check's item could not be deleted; an erase removes it"
            );
        }
        if holds_value(kept.as_ref(), &value) {
            Check::Accepted
        } else {
            Check::Mismatch
        }
    }

    // The keychain of `service` in `place`.
    fn place_keychain(
        &self,
        place: SecretsPlace,
        service: KeychainService,
    ) -> Box<dyn SecretKeychain> {
        match place {
            SecretsPlace::OperatingSystem => Box::new(self.os_store.keychain(service.as_str())),
            SecretsPlace::File { .. } => Box::new(self.items_file.keychain(service.as_str())),
        }
    }
}

/// One keychain service's items wherever this run keeps them; every call waits for the place
/// inside its one time.
pub(crate) struct ItemsKeychain {
    /// The run's secret items.
    items: Arc<SecretItems>,
    /// The service the items are filed under.
    service: KeychainService,
    /// The service's items in the operating system's store.
    os: OsSecretKeychain,
    /// The service's items in the items file.
    file: FileSecretKeychain,
}

impl ItemsKeychain {
    // The service's keychain in `place`.
    fn at(&self, place: SecretsPlace) -> &dyn SecretKeychain {
        match place {
            SecretsPlace::OperatingSystem => &self.os,
            SecretsPlace::File { .. } => &self.file,
        }
    }
}

impl SecretKeychain for ItemsKeychain {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        Box::pin(self.items.serve(self.service, move |place| {
            self.at(place).write(account, value)
        }))
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        Box::pin(
            self.items
                .serve(self.service, move |place| self.at(place).read(account)),
        )
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        Box::pin(
            self.items
                .serve(self.service, move |place| self.at(place).remove(account)),
        )
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        Box::pin(
            self.items
                .serve(self.service, move |place| self.at(place).accounts()),
        )
    }
}

fn unreadable_record(reason: &str) -> KeychainRefusal {
    KeychainRefusal::new(KeychainRefusalCause::Unavailable, reason.to_owned())
}

fn mismatch() -> KeychainRefusal {
    KeychainRefusal::new(
        KeychainRefusalCause::Unavailable,
        "the store kept another value than the one written, so it is not used until the next start",
    )
}
