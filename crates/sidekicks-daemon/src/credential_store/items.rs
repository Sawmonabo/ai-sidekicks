//! The daemon's secrets for one run: the place picked for them, the check that the place keeps what
//! it is given, the move of the items file's secrets into a Secret Service once one runs, and the
//! erase of every item the app made.
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
//!   and each of the store's signals look for one, and once one answers its check the items move
//!   into it. The move holds every call behind it, so none writes to a place the move is leaving.
//!
//! Every call answers within its one time, its waits for the place, a check and a move included,
//! and a call with no answer in that time reads `locked`.

#[cfg(test)]
mod tests;

use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::daemon::data::DaemonDataKeychainUnavailableDetails;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use tokio::sync::RwLock;

use crate::credential_store::file::{FileSecretKeychain, SecretItemsFile};
use crate::credential_store::os::{CredentialStoreAccess, OsCredentialStore, OsSecretKeychain};
use crate::credential_store::place::{self, PlaceRecord, SecretsFileReason, SecretsPlace};
use crate::credential_store::service::KeychainService;
use crate::credential_store::{KeychainRefusal, SecretKeychain, holds_value};
use crate::ipc::domain_error::DomainError;
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
}

// What this run knows of the place.
#[derive(Default)]
struct PlaceState {
    record: RecordState,
    // Where calls go, once picked.
    picked: Option<SecretsPlace>,
    verdict: Verdict,
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

// Whether an erase must reach the operating system's store or sweeps it only when it answers.
enum OperatingSystemSweep {
    Required,
    WhenReachable,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the secret items, checks them in the background, \
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

    /// Picks the place, checks it, and moves the items file's secrets into a Secret Service that
    /// now runs, as the start asks in the background and each of the store's signals asks again; a
    /// refusal is logged and the next secret call tries again.
    pub(crate) async fn settle(&self) {
        let mut state = self.state.write().await;
        if let Err(refusal) = self.settle_held(&mut state, true).await {
            tracing::warn!(
                error = &refusal as &(dyn Error + 'static),
                "The secrets' place is not ready; the next secret call tries again"
            );
        }
    }

    /// The items file's path while it holds a secret, for the status read. Fails with the file
    /// system's error when that cannot be told.
    pub(crate) async fn secrets_file(&self) -> io::Result<Option<PathBuf>> {
        Ok(self
            .items_file
            .holds_items()
            .await?
            .then(|| self.items_file.file_path().to_path_buf()))
    }

    /// Lists every service's items in every place the erase must empty, before the erase answers,
    /// so a locked store raises its unlock prompt while the person is at the screen. Fails with
    /// [`KeychainRefusal`] when the record names the operating system's store and that store is
    /// locked or cannot be used; nothing is erased then.
    pub(crate) async fn check_for_erase(&self) -> Result<(), KeychainRefusal> {
        let _state = self.state.write().await;
        let sweep = self.operating_system_sweep().await;
        if matches!(sweep, OperatingSystemSweep::Required)
            || self.access.check_reachable().await.is_ok()
        {
            for service in KeychainService::ALL {
                if let Err(refusal) = self.os_store.check_items(service.as_str()).await {
                    self.skip_sweep(&sweep, refusal)?;
                    break;
                }
            }
        }
        Ok(())
    }

    /// Deletes every item the app made: each service's items in the operating system's store,
    /// probe leftovers and items it cannot name included, and the items file. The store is swept
    /// when the record names it, and otherwise when it answers, since items can be left there by
    /// a data folder removed by hand. Fails with [`KeychainRefusal`] at the first item the store
    /// that must be emptied refuses, before the data folder goes, so the erase can run again.
    pub(crate) async fn erase_all(&self) -> Result<(), KeychainRefusal> {
        let _state = self.state.write().await;
        let sweep = self.operating_system_sweep().await;
        if matches!(sweep, OperatingSystemSweep::Required)
            || self.access.check_reachable().await.is_ok()
        {
            for service in KeychainService::ALL {
                if let Err(refusal) = self.os_store.erase_items(service.as_str()).await {
                    self.skip_sweep(&sweep, refusal)?;
                    break;
                }
            }
        }
        self.items_file.remove_all().await
    }

    // Serves one call within the call's time: waits for the place, settles it when it is not, then
    // runs `call` on it while no move can start.
    async fn serve<'call, Answer: Send>(
        &'call self,
        service: KeychainService,
        call: impl FnOnce(SecretsPlace) -> BoxFuture<'call, Result<Answer, KeychainRefusal>> + Send,
    ) -> Result<Answer, KeychainRefusal> {
        let answer = tokio::time::timeout(self.call_timeout, async {
            let mut may_move = true;
            let (_state, place) = loop {
                let state = self.state.read().await;
                match self.readiness(&state, may_move).await {
                    Readiness::Ready(place) => break (state, place),
                    Readiness::Refused(refusal) => return Err(refusal),
                    Readiness::Unsettled => {}
                }
                drop(state);
                let mut state = self.state.write().await;
                self.settle_held(&mut state, may_move).await?;
                may_move = false;
            };
            call(place).await
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

    // What a call may do with the place as it stands; a file kept because no Secret Service ran
    // is unsettled once one answers, when `may_move`.
    async fn readiness(&self, state: &PlaceState, may_move: bool) -> Readiness {
        match &state.record {
            RecordState::Unread => return Readiness::Unsettled,
            RecordState::Unreadable(reason) => {
                return Readiness::Refused(unreadable_record(reason));
            }
            RecordState::Absent | RecordState::Present(_) => {}
        }
        let Some(place) = state.picked else {
            return Readiness::Unsettled;
        };
        match state.verdict {
            Verdict::Mismatch => return Readiness::Refused(mismatch()),
            Verdict::Unchecked => return Readiness::Unsettled,
            Verdict::Accepted => {}
        }
        if may_move && is_waiting_for_secret_service(place) && self.is_store_reachable().await {
            return Readiness::Unsettled;
        }
        Readiness::Ready(place)
    }

    // Reads the record, picks the place, checks it, and when `may_move` moves the file's items into
    // a Secret Service that now answers. Fails with the refusal the caller answers with.
    async fn settle_held(
        &self,
        state: &mut PlaceState,
        may_move: bool,
    ) -> Result<(), KeychainRefusal> {
        if matches!(state.record, RecordState::Unread) {
            state.record = match place::read_record(&self.record_path).await {
                Ok(Some(record)) => RecordState::Present(record),
                Ok(None) => RecordState::Absent,
                Err(refusal) => {
                    tracing::error!(
                        error = &refusal as &(dyn Error + 'static),
                        "The secrets' place record cannot be read, so every secret call is \
                         refused until it is fixed"
                    );
                    RecordState::Unreadable(refusal.reason().to_owned())
                }
            };
        }
        if let RecordState::Unreadable(reason) = &state.record {
            return Err(unreadable_record(reason));
        }
        let place = match state.picked {
            Some(place) => place,
            None => self.pick(state).await?,
        };
        match state.verdict {
            Verdict::Mismatch => return Err(mismatch()),
            Verdict::Accepted => {}
            Verdict::Unchecked => match self.check(place).await {
                Check::Accepted => {
                    if matches!(state.record, RecordState::Absent) {
                        let record = PlaceRecord::settled(place);
                        place::write_record(&self.record_path, &record).await?;
                        state.record = RecordState::Present(record);
                    }
                    state.verdict = Verdict::Accepted;
                }
                Check::Mismatch => {
                    state.verdict = Verdict::Mismatch;
                    tracing::error!(
                        place = ?place,
                        "The secrets' place kept another value than the one written, so every \
                         secret call is refused until the next start"
                    );
                    return Err(mismatch());
                }
                Check::Refused(refusal) => return Err(refusal),
            },
        }
        if may_move && is_waiting_for_secret_service(place) && self.is_store_reachable().await {
            let record = PlaceRecord::settled(place);
            if let Err(refusal) = self
                .move_items(state, record, SecretsPlace::OperatingSystem)
                .await
            {
                tracing::warn!(
                    error = &refusal as &(dyn Error + 'static),
                    "The secrets stay in the items file: their move into the Secret Service was \
                     refused, and the next secret call or signal tries again"
                );
            }
        }
        Ok(())
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
                    self.move_items(state, record, destination).await?;
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
                                 file until one runs"
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

    // Checks `destination`, then moves every item from `record`'s place into it. On success the
    // destination serves, already checked, and a file left behind is deleted; on a refusal the
    // record is read again at the next call, since the move may have recorded its direction.
    async fn move_items(
        &self,
        state: &mut PlaceState,
        record: PlaceRecord,
        destination: SecretsPlace,
    ) -> Result<(), KeychainRefusal> {
        let moved = async {
            match self.check(destination).await {
                Check::Accepted => {}
                Check::Mismatch => return Err(mismatch()),
                Check::Refused(refusal) => return Err(refusal),
            }
            let from = |service| self.place_keychain(record.place, service);
            let to = |service| self.place_keychain(destination, service);
            place::move_items(&self.record_path, record, destination, &from, &to).await
        }
        .await;
        if let Err(refusal) = moved {
            *state = PlaceState::default();
            return Err(refusal);
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

    async fn is_store_reachable(&self) -> bool {
        self.access.check_reachable().await.is_ok()
    }

    // Whether the erase must reach the operating system's store: when the record names it. With
    // no record, or one that cannot be read, the store is swept only when it answers.
    async fn operating_system_sweep(&self) -> OperatingSystemSweep {
        match place::read_record(&self.record_path).await {
            Ok(Some(record)) if record.names_operating_system() => OperatingSystemSweep::Required,
            Ok(Some(_) | None) | Err(_) => OperatingSystemSweep::WhenReachable,
        }
    }

    // A store the erase must empty refuses with `refusal`; one it sweeps only when it answers is
    // left, logged.
    fn skip_sweep(
        &self,
        sweep: &OperatingSystemSweep,
        refusal: KeychainRefusal,
    ) -> Result<(), KeychainRefusal> {
        match sweep {
            OperatingSystemSweep::Required => Err(refusal),
            OperatingSystemSweep::WhenReachable => {
                tracing::info!(
                    error = &refusal as &(dyn Error + 'static),
                    file = %self.items_file.file_path().display(),
                    "The erase leaves the operating system's store, which does not hold the \
                     secrets and does not answer"
                );
                Ok(())
            }
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

/// The erase's refusal for a store check that failed before its answer:
/// `daemon.data.keychainUnavailable` with the cause.
#[expect(dead_code, reason = "the erase answers a refused store check with it")]
pub(crate) fn erase_refused(refusal: KeychainRefusal) -> DomainError {
    let cause = refusal.cause();
    let (message, failure) = refusal.into_failure();
    let refused = DomainError::new(message, RefusalCode::DaemonDataKeychainUnavailable)
        .with_detail(DaemonDataKeychainUnavailableDetails { cause });
    match failure {
        Some(failure) => refused.with_source(failure),
        None => refused,
    }
}

// Whether `place` is the file kept only because no Secret Service ran, which moves into one.
fn is_waiting_for_secret_service(place: SecretsPlace) -> bool {
    place
        == SecretsPlace::File {
            reason: SecretsFileReason::NoSecretService,
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
