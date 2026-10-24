//! The daemon's secrets for one run: the place picked for them, the check that the place keeps what
//! it is given, the one seal of a Linux plain file once systemd's credential service seals for it,
//! and the erase of every item the app made.
//!
//! - **The pick.** A start with a place record keeps its place. One without picks the operating
//!   system's store on macOS and Windows, the plain file for a Mac's service running while the
//!   person is logged out, and on Linux what a fresh probe through systemd's credential service
//!   shows: the sealed file where it seals bound to no boot state, a plain file found there sealed
//!   once as a later start seals a plain record's, and the plain file where it would bind the seal
//!   to the boot state, where no service listens, or where it refuses in one of the ways that mean
//!   it cannot seal on this computer. Any other failure refuses that call, and the next call probes
//!   again. The record is written before the place serves a call, so a refused first start records
//!   nothing and no call is served from a place left unrecorded. A record that cannot be read
//!   refuses every call and is left as it is.
//! - **The check.** The operating system's store and a plain file: write a random value under a
//!   fresh probe account, read it back, compare, then delete it, a failed delete only logged. The
//!   sealed file: seal a random value, read the key its header names, open it and compare, then
//!   open one existing item per key the file holds. A place that keeps another value refuses every
//!   call until the next start; one locked, missing or not answering refuses that call, and the
//!   next call checks again.
//! - **A sealed file that cannot be opened** is left byte for byte and refuses every call needing a
//!   secret, with the cause the status read names: the service gone or failing, the chip not
//!   available (an item sealed with the chip fails while the probe sealed without it), each checked
//!   again at the next call, or the key changed (an item fails under the key the probe opens with),
//!   latched until the next start. The probe and the open check each take a share of the call's
//!   time, so a service that gives no answer in it is named failing before the call runs out.
//! - **Sealing again.** A later start whose probe seals bound to no boot state seals a plain file's
//!   items once and records the sealed file, and seals again once each item sealed with a weaker
//!   key than the probe's. A pass that would seal any item downward is abandoned and the file kept.
//!
//! Every call answers within its one time, its waits for the place and a check included; a call
//! with no answer in that time reads `locked` from the operating system's store, where a prompt
//! can hold it, and `unavailable` from either file. A sealed write that runs out of time may still
//! land; the items file holds the item from its seal through the file write, so a retry waits for
//! it and is never overwritten by it.

mod erase;
mod sealed_file;
mod state;
mod status;
#[cfg(test)]
mod tests;

use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::daemon::status::{DaemonSecretsFileUnopened, DaemonSecretsPlainReason};
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::SealFailure;
use tokio::sync::RwLock;

use self::sealed_file::{Probe, is_definite_refusal, log_boot_bound};
use self::state::{PlaceState, PlaceView, Readiness, RecordState, Verdict};
use crate::credential_store::file::{FileSecretKeychain, ItemsForm, SecretItemsFile};
use crate::credential_store::os::{
    CredentialStoreAccess, OsCredentialStore, OsSecretKeychain, SEAL_CHECK_TIMEOUT_DIVISOR,
    SecretsOffer,
};
use crate::credential_store::place::{self, PlaceRecord, SecretsPlace};
use crate::credential_store::seal::SecretSeal;
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
    /// What this machine offers for the secrets.
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
    /// What holds the secrets, in words for the service log.
    description: String,
    /// The calls on the operating system's store, where the machine offers one.
    os_store: Option<Arc<OsCredentialStore>>,
    /// systemd's credential service, where the machine offers it.
    seal: Option<Arc<dyn SecretSeal>>,
    /// The items file, kept plain or sealed through `seal` as the place says; the file's lock is
    /// held over the one pass that turns it sealed.
    items_file: Arc<SecretItemsFile>,
    /// The check's account for this run, fresh at each start, so a leftover from another build is
    /// never touched.
    probe_account: String,
    /// How long one secret call may take.
    call_timeout: Duration,
    /// How long the seal service's probe and the sealed file's open check may each take, within a
    /// call's time.
    seal_check_timeout: Duration,
    /// The place and its check, read by every call and written by a pick, a check and a move.
    state: RwLock<PlaceState>,
    /// The place picked and why the sealed file cannot be opened, which `state` writes and the
    /// status read takes without waiting for a call that holds `state`.
    view: Arc<Mutex<PlaceView>>,
}

// A write-read-delete check's outcome.
enum Check {
    Accepted,
    Mismatch,
    Refused(KeychainRefusal),
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the secret items, hands each feature its keychain and \
                  status its file, and the erase and the relink call them"
    )
)]
impl SecretItems {
    /// The secret items of the data folder and offer `start` names, nothing picked or checked
    /// yet. Fails with the random source's error when it gives no bytes for the probe account.
    pub(crate) fn new(start: SecretItemsStart) -> Result<Arc<Self>, getrandom::Error> {
        let SecretItemsStart {
            data_folder,
            runs_while_logged_out,
            access,
            call_timeout,
        } = start;
        let probe_account = format!("store-verify-{}", random_hex(PROBE_ACCOUNT_BYTES)?);
        let (os_store, seal) = match access.offer() {
            SecretsOffer::OperatingSystem(open) => {
                (Some(OsCredentialStore::new(open, call_timeout)), None)
            }
            SecretsOffer::SealService(seal) => (None, Some(seal)),
        };
        let view = Arc::new(Mutex::new(PlaceView::default()));
        Ok(Arc::new(Self {
            record_path: place::record_path(&data_folder),
            runs_while_logged_out,
            description: access.description(),
            os_store,
            items_file: SecretItemsFile::new(&data_folder),
            seal,
            probe_account,
            call_timeout,
            seal_check_timeout: call_timeout / SEAL_CHECK_TIMEOUT_DIVISOR,
            state: RwLock::new(PlaceState::new(Arc::clone(&view))),
            view,
        }))
    }

    /// The items filed under `service`.
    pub(crate) fn keychain(self: &Arc<Self>, service: KeychainService) -> ItemsKeychain {
        ItemsKeychain {
            items: Arc::clone(self),
            service,
            os: self
                .os_store
                .as_ref()
                .map(|store| store.keychain(service.as_str())),
            plain: self.items_file.keychain(service.as_str(), None),
            sealed: self.seal.as_ref().map(|seal| {
                self.items_file
                    .keychain(service.as_str(), Some(Arc::clone(seal)))
            }),
        }
    }

    // Serves one call within the call's time: waits for the place, settles it when it is not, then
    // runs `call` on the keychain of the place while no move can start.
    async fn serve<'call, Answer: Send>(
        self: &'call Arc<Self>,
        keychain: &'call ItemsKeychain,
        call: impl FnOnce(
            &'call dyn SecretKeychain,
        ) -> BoxFuture<'call, Result<Answer, KeychainRefusal>>
        + Send,
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
            let answer = call(keychain.at(place)?).await;
            drop(state);
            answer
        })
        .await
        .unwrap_or_else(|_elapsed| {
            Err(KeychainRefusal::new(
                self.timeout_cause(),
                format!("the keychain gave no answer within {:?}", self.call_timeout),
            ))
        });
        if let Err(refusal) = &answer {
            tracing::warn!(
                service = keychain.service.as_str(),
                error = refusal as &(dyn Error + 'static),
                "a keychain call was refused"
            );
        }
        answer
    }

    // The cause of a call that ran out of time: `locked` where the operating system's store held
    // it, since a prompt can, and `unavailable` from either file, which nothing unlocks. A call
    // that ran out before the place was picked counts the store this run would pick first.
    fn timeout_cause(&self) -> KeychainRefusalCause {
        let is_os_store = match PlaceView::read(&self.view).picked {
            Some(place) => place == SecretsPlace::OperatingSystem,
            None => self.os_store.is_some() && !self.runs_while_logged_out,
        };
        if is_os_store {
            KeychainRefusalCause::Locked
        } else {
            KeychainRefusalCause::Unavailable
        }
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
                    "the secrets' place record cannot be read, so every secret call is refused \
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
        match state.readiness() {
            Readiness::Ready(place) => return Ok(place),
            Readiness::Refused(refusal) => return Err(refusal),
            Readiness::Unsettled => {}
        }
        let record = match &state.record {
            RecordState::Present(record) => Some(*record),
            RecordState::Unread | RecordState::Unreadable(_) | RecordState::Absent => None,
        };
        let place = match record {
            Some(
                record @ PlaceRecord {
                    moving_to: Some(destination),
                    ..
                },
            ) => self.finish_move(state, record, destination).await?,
            Some(record) => self.settle_recorded(state, record.place).await?,
            None => self.settle_first(state).await?,
        };
        tracing::info!(
            place = ?place,
            is_recorded = matches!(state.record, RecordState::Present(_)),
            store = self.description,
            "the daemon's secrets have their place"
        );
        Ok(place)
    }

    // Picks the place at a first start, checks it and records it once it passes.
    async fn settle_first(&self, state: &mut PlaceState) -> Result<SecretsPlace, KeychainRefusal> {
        let place = if self.runs_while_logged_out {
            SecretsPlace::LoggedOutServiceFile
        } else if let Some(seal) = &self.seal {
            match self.probe(seal.as_ref()).await? {
                Probe::Sealed(header) if !header.is_boot_bound() => {
                    // A plain file left with no record is sealed once, as a plain record's is.
                    if self.items_file.form_on_disk().await? == Some(ItemsForm::Plain) {
                        return self
                            .seal_plain_file(state, header)
                            .await?
                            .ok_or_else(sealing_abandoned);
                    }
                    self.open_sealed(state, header).await?;
                    self.record(state, SecretsPlace::SealedFile).await?;
                    return Ok(state.accept(SecretsPlace::SealedFile));
                }
                Probe::Sealed(header) => {
                    log_boot_bound(header);
                    plain_file_place(DaemonSecretsPlainReason::BootBound)
                }
                Probe::Failed(SealFailure::NoService(failure)) => {
                    tracing::warn!(
                        error = &failure as &(dyn Error + 'static),
                        file = %self.items_file.file_path().display(),
                        "systemd's credential service is not running, so the secrets are kept \
                         plain in the items file"
                    );
                    plain_file_place(DaemonSecretsPlainReason::NoSealService)
                }
                Probe::Failed(failure) if is_definite_refusal(&failure) => {
                    tracing::warn!(
                        error = &failure as &(dyn Error + 'static),
                        file = %self.items_file.file_path().display(),
                        "systemd's credential service cannot seal on this computer, so the \
                         secrets are kept plain in the items file"
                    );
                    plain_file_place(DaemonSecretsPlainReason::SealFailed)
                }
                Probe::Failed(failure) => return Err(seal_refused(failure)),
                Probe::NoAnswer => return Err(self.no_answer()),
                Probe::Mismatch => {
                    state.verdict = Verdict::Mismatch;
                    log_mismatch();
                    return Err(mismatch());
                }
            }
        } else {
            SecretsPlace::OperatingSystem
        };
        self.check_written(state, place).await?;
        self.record(state, place).await?;
        Ok(state.accept(place))
    }

    // Checks the place `recorded` names, sealing a Linux plain file once the service seals for it
    // and recording a plain file's reason again when this start's probe gives another.
    async fn settle_recorded(
        &self,
        state: &mut PlaceState,
        recorded: SecretsPlace,
    ) -> Result<SecretsPlace, KeychainRefusal> {
        let reason = match recorded {
            SecretsPlace::OperatingSystem | SecretsPlace::LoggedOutServiceFile => {
                self.check_written(state, recorded).await?;
                return Ok(state.accept(recorded));
            }
            SecretsPlace::SealedFile => return self.settle_sealed(state).await,
            SecretsPlace::PlainFile { reason } => reason,
        };
        let Some(seal) = &self.seal else {
            self.check_written(state, recorded).await?;
            return Ok(state.accept(recorded));
        };
        // A pass that sealed the file and stopped before its record leaves the sealed form under
        // this record, which moves with no seal.
        if self.items_file.form_on_disk().await? == Some(ItemsForm::Sealed) {
            self.record(state, SecretsPlace::SealedFile).await?;
            return self.settle_sealed(state).await;
        }
        // The reason this start's probe gives, where it gives one.
        let reason_now = match self.probe(seal.as_ref()).await? {
            Probe::Sealed(header) if !header.is_boot_bound() => {
                if let Some(place) = self.seal_plain_file(state, header).await? {
                    return Ok(place);
                }
                None
            }
            Probe::Sealed(header) => {
                log_boot_bound(header);
                Some(DaemonSecretsPlainReason::BootBound)
            }
            Probe::Failed(SealFailure::NoService(failure)) => {
                tracing::info!(
                    error = &failure as &(dyn Error + 'static),
                    "systemd's credential service is not running, so the secrets stay plain"
                );
                Some(DaemonSecretsPlainReason::NoSealService)
            }
            Probe::Failed(failure) => {
                tracing::info!(
                    error = &failure as &(dyn Error + 'static),
                    "systemd's credential service did not seal the check's value, so the secrets \
                     stay plain until a later start"
                );
                None
            }
            Probe::NoAnswer => {
                tracing::info!(
                    timeout = ?self.seal_check_timeout,
                    "systemd's credential service gave no answer in time, so the secrets stay \
                     plain until a later start"
                );
                None
            }
            Probe::Mismatch => {
                log_mismatch();
                None
            }
        };
        let place = match reason_now {
            Some(now) if now != reason => {
                let place = plain_file_place(now);
                self.record(state, place).await?;
                place
            }
            Some(_) | None => recorded,
        };
        self.check_written(state, place).await?;
        Ok(state.accept(place))
    }

    // Runs the write-read-delete check on `place`; the caller accepts it once its record names
    // it. Fails with the refusal the caller answers with.
    async fn check_written(
        &self,
        state: &mut PlaceState,
        place: SecretsPlace,
    ) -> Result<(), KeychainRefusal> {
        match self.check(place).await {
            Check::Accepted => Ok(()),
            Check::Mismatch => {
                state.verdict = Verdict::Mismatch;
                log_mismatch();
                Err(mismatch())
            }
            Check::Refused(refusal) => Err(refusal),
        }
    }

    // Records `place` when the record names another, keeping this run's record in step.
    async fn record(
        &self,
        state: &mut PlaceState,
        place: SecretsPlace,
    ) -> Result<(), KeychainRefusal> {
        let record = PlaceRecord::settled(place);
        if !matches!(&state.record, RecordState::Present(present) if *present == record) {
            place::write_record(&self.record_path, &record).await?;
            state.record = RecordState::Present(record);
        }
        Ok(())
    }

    // Finishes the move `record` names into `destination`, checked first. On success the
    // destination serves, checked, and a file left behind is deleted. Fails with the refusal,
    // leaving `state` as it was when the move stopped before recording its direction, and otherwise
    // the recorded move, which the next call finishes.
    async fn finish_move(
        &self,
        state: &mut PlaceState,
        record: PlaceRecord,
        destination: SecretsPlace,
    ) -> Result<SecretsPlace, KeychainRefusal> {
        match self.check(destination).await {
            Check::Accepted => {}
            Check::Mismatch => return Err(mismatch()),
            Check::Refused(refusal) => return Err(refusal),
        }
        let from = |service| self.place_keychain(record.place, service);
        let to = |service| self.place_keychain(destination, service);
        if let Err(stopped) =
            place::move_items(&self.record_path, record, destination, &from, &to).await
        {
            if stopped.record != record {
                state.reset(RecordState::Present(stopped.record));
            }
            return Err(stopped.refusal);
        }
        if matches!(record.place, SecretsPlace::LoggedOutServiceFile)
            && let Err(refusal) = self.items_file.remove_all().await
        {
            tracing::warn!(
                error = &refusal as &(dyn Error + 'static),
                "the items file the secrets left could not be deleted"
            );
        }
        state.record = RecordState::Present(PlaceRecord::settled(destination));
        tracing::info!(place = ?destination, "the daemon's secrets moved");
        Ok(state.accept(destination))
    }

    // Writes a random value under this run's probe account in `place`, reads it back, compares
    // and deletes it.
    async fn check(&self, place: SecretsPlace) -> Check {
        let value = match random_value() {
            Ok(value) => value,
            Err(refusal) => return Check::Refused(refusal),
        };
        let keychain = match self.place_keychain(place, KeychainService::Probe) {
            Ok(keychain) => keychain,
            Err(refusal) => return Check::Refused(refusal),
        };
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
                "the store check's item could not be deleted; an erase removes it"
            );
        }
        if holds_value(kept.as_ref(), &value) {
            Check::Accepted
        } else {
            Check::Mismatch
        }
    }

    // The keychain of `service` in `place`. Fails with [`KeychainRefusal`] where this machine
    // does not offer the place.
    fn place_keychain(
        &self,
        place: SecretsPlace,
        service: KeychainService,
    ) -> Result<Box<dyn SecretKeychain>, KeychainRefusal> {
        Ok(match place {
            SecretsPlace::OperatingSystem => Box::new(
                self.os_store
                    .as_ref()
                    .ok_or_else(not_offered)?
                    .keychain(service.as_str()),
            ),
            SecretsPlace::SealedFile => Box::new(
                self.items_file
                    .keychain(service.as_str(), Some(Arc::clone(self.seal_service()?))),
            ),
            SecretsPlace::PlainFile { .. } | SecretsPlace::LoggedOutServiceFile => {
                Box::new(self.items_file.keychain(service.as_str(), None))
            }
        })
    }

    // systemd's credential service. Fails with [`KeychainRefusal`] where it is not offered.
    fn seal_service(&self) -> Result<&Arc<dyn SecretSeal>, KeychainRefusal> {
        self.seal.as_ref().ok_or_else(not_offered)
    }
}

/// One keychain service's items wherever this run keeps them; every call waits for the place
/// inside its one time.
pub(crate) struct ItemsKeychain {
    /// The run's secret items.
    items: Arc<SecretItems>,
    /// The service the items are filed under.
    service: KeychainService,
    /// The service's items in the operating system's store, where the machine offers one.
    os: Option<OsSecretKeychain>,
    /// The service's items in the items file kept plain.
    plain: FileSecretKeychain,
    /// The service's items in the items file sealed, where systemd's credential service is
    /// offered.
    sealed: Option<FileSecretKeychain>,
}

impl ItemsKeychain {
    // The service's keychain in `place`. Fails with [`KeychainRefusal`] where this machine does
    // not offer the place.
    fn at(&self, place: SecretsPlace) -> Result<&dyn SecretKeychain, KeychainRefusal> {
        Ok(match place {
            SecretsPlace::OperatingSystem => self.os.as_ref().ok_or_else(not_offered)?,
            SecretsPlace::SealedFile => self.sealed.as_ref().ok_or_else(not_offered)?,
            SecretsPlace::PlainFile { .. } | SecretsPlace::LoggedOutServiceFile => &self.plain,
        })
    }
}

impl SecretKeychain for ItemsKeychain {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        Box::pin(
            self.items
                .serve(self, move |keychain| keychain.write(account, value)),
        )
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        Box::pin(
            self.items
                .serve(self, move |keychain| keychain.read(account)),
        )
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        Box::pin(
            self.items
                .serve(self, move |keychain| keychain.remove(account)),
        )
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        Box::pin(self.items.serve(self, |keychain| keychain.accounts()))
    }
}

// A plain Linux file kept for `reason`.
fn plain_file_place(reason: DaemonSecretsPlainReason) -> SecretsPlace {
    SecretsPlace::PlainFile { reason }
}

// A random value for a check.
fn random_value() -> Result<SecretString, KeychainRefusal> {
    random_hex(PROBE_VALUE_BYTES)
        .map(SecretString::from)
        .map_err(|failure| {
            KeychainRefusal::new(
                KeychainRefusalCause::Unavailable,
                "the system gave no random bytes for the store's check",
            )
            .with_failure(failure)
        })
}

fn log_mismatch() {
    tracing::error!(
        "the secrets' place kept another value than the one written, so every secret call is \
         refused until the next start"
    );
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

fn cannot_open(cause: DaemonSecretsFileUnopened) -> KeychainRefusal {
    let why = match cause {
        DaemonSecretsFileUnopened::SealServiceMissing => {
            "systemd's credential service is not running"
        }
        DaemonSecretsFileUnopened::SealServiceFailing => {
            "systemd's credential service does not answer"
        }
        DaemonSecretsFileUnopened::ChipUnavailable => "the security chip cannot be used",
        DaemonSecretsFileUnopened::KeyChanged => "the key they were sealed with is gone",
    };
    KeychainRefusal::new(
        KeychainRefusalCause::Unavailable,
        format!("the sealed secrets cannot be opened: {why}"),
    )
}

fn seal_refused(failure: SealFailure) -> KeychainRefusal {
    KeychainRefusal::new(
        KeychainRefusalCause::Unavailable,
        "systemd's credential service did not seal the check's value",
    )
    .with_failure(failure)
}

fn sealing_abandoned() -> KeychainRefusal {
    KeychainRefusal::new(
        KeychainRefusalCause::Unavailable,
        "sealing the plain items file was abandoned, so the next call tries again",
    )
}

fn not_offered() -> KeychainRefusal {
    KeychainRefusal::new(
        KeychainRefusalCause::Unavailable,
        "the secrets are recorded in a place this computer does not offer",
    )
}
