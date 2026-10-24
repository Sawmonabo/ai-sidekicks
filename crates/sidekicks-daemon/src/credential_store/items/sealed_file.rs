//! Opening the sealed items file and sealing it again: the probe through systemd's credential
//! service, the one item opened per key the file holds, and the pass that seals a plain file or an
//! item sealed with a weaker key.

use std::collections::BTreeMap;
use std::error::Error;
use std::sync::Arc;

use secrecy::ExposeSecret as _;
use sidekicks_contracts::daemon::status::DaemonSecretsFileUnopened;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{SealFailure, SealHeader};

use super::{PlaceState, SecretItems, log_mismatch, random_value};
use crate::credential_store::file::{SealPass, SealedItem, credential_name, is_weaker};
use crate::credential_store::place::SecretsPlace;
use crate::credential_store::seal::SecretSeal;
use crate::credential_store::service::KeychainService;
use crate::credential_store::{KeychainRefusal, holds_value};

// The refusals a first start reads as systemd's credential service unable to seal on this
// computer, read there and nowhere else: no such user, and a system error for a key it cannot make
// (no chip and a temporary `/var/lib/systemd`, as in most containers) or a build without the
// cryptography it needs. The numbers are Linux's, as the service writes them.
const NO_SUCH_USER: &str = "io.systemd.Credentials.NoSuchUser";
const SYSTEM_ERROR: &str = "io.systemd.System";
const LINUX_ENOTRECOVERABLE: i64 = 131;
const LINUX_EOPNOTSUPP: i64 = 95;

// What a fresh probe through systemd's credential service showed.
pub(super) enum Probe {
    // It sealed and opened the probe's value; the header of the blob it sealed.
    Sealed(SealHeader),
    // It kept another value than the probe gave it.
    Mismatch,
    Failed(SealFailure),
    // It gave no answer within the check's time.
    NoAnswer,
}

impl SecretItems {
    // Seals the plain file's items once, the probe's blob having shown `header`, and records the
    // sealed file; `None` when the pass was abandoned and the plain file stays.
    pub(super) async fn seal_plain_file(
        &self,
        state: &mut PlaceState,
        header: SealHeader,
    ) -> Result<Option<SecretsPlace>, KeychainRefusal> {
        let seal = Arc::clone(self.seal_service()?);
        match self.items_file.seal_again(seal, header).await? {
            SealPass::Unchanged | SealPass::Sealed => {}
            SealPass::Abandoned(why) => {
                tracing::warn!(why, "the secrets stay plain: sealing them was abandoned");
                return Ok(None);
            }
        }
        self.record(state, SecretsPlace::SealedFile).await?;
        tracing::info!(key = ?header.key(), "the daemon's secrets were sealed");
        self.open_sealed(state, header).await?;
        Ok(Some(state.accept(SecretsPlace::SealedFile)))
    }

    // Probes the service for the recorded sealed file and opens it.
    pub(super) async fn settle_sealed(
        &self,
        state: &mut PlaceState,
    ) -> Result<SecretsPlace, KeychainRefusal> {
        let Some(seal) = &self.seal else {
            return Err(state.refuse_opening(DaemonSecretsFileUnopened::SealServiceMissing));
        };
        match self.probe(seal.as_ref()).await? {
            Probe::Sealed(header) => {
                self.open_sealed(state, header).await?;
                Ok(state.accept(SecretsPlace::SealedFile))
            }
            Probe::Failed(SealFailure::NoService(failure)) => {
                tracing::warn!(
                    error = &failure as &(dyn Error + 'static),
                    "systemd's credential service is not running, so the sealed secrets cannot \
                     be opened"
                );
                Err(state.refuse_opening(DaemonSecretsFileUnopened::SealServiceMissing))
            }
            Probe::Failed(failure) => {
                tracing::warn!(
                    error = &failure as &(dyn Error + 'static),
                    "systemd's credential service did not seal the check's value, so the sealed \
                     secrets cannot be opened now"
                );
                Err(state.refuse_opening(DaemonSecretsFileUnopened::SealServiceFailing))
            }
            Probe::NoAnswer => {
                tracing::warn!(
                    timeout = ?self.seal_check_timeout,
                    "systemd's credential service gave no answer in time, so the sealed secrets \
                     cannot be opened now"
                );
                Err(state.refuse_opening(DaemonSecretsFileUnopened::SealServiceFailing))
            }
            Probe::Mismatch => {
                log_mismatch();
                Err(state.latch_opening(DaemonSecretsFileUnopened::SealServiceFailing))
            }
        }
    }

    // Opens one item of the sealed file per key it holds, the probe's blob having shown `probe`,
    // then seals again once each item sealed with a weaker key than the probe's; the caller accepts
    // the sealed file once its record names it. Fails with the refusal the caller answers with.
    pub(super) async fn open_sealed(
        &self,
        state: &mut PlaceState,
        probe: SealHeader,
    ) -> Result<(), KeychainRefusal> {
        let seal = self.seal_service()?;
        let mut samples = BTreeMap::new();
        let mut is_any_weaker = false;
        for item in self.items_file.sealed_items().await? {
            if item.service == KeychainService::Probe.as_str() {
                continue;
            }
            let key = item.header().map(SealHeader::key);
            is_any_weaker |= key.is_some_and(|key| is_weaker(key, probe.key()));
            samples.entry(key).or_insert(item);
        }
        let opened = tokio::time::timeout(
            self.seal_check_timeout,
            open_samples(seal.as_ref(), samples.into_values(), probe),
        )
        .await;
        let cause = match opened {
            Ok(cause) => cause,
            Err(_elapsed) => {
                tracing::warn!(
                    timeout = ?self.seal_check_timeout,
                    "systemd's credential service opened no item in time, so the sealed secrets \
                     cannot be opened now"
                );
                Some(DaemonSecretsFileUnopened::SealServiceFailing)
            }
        };
        if let Some(cause) = cause {
            return Err(state.refuse_opening(cause));
        }
        if is_any_weaker {
            match self.items_file.seal_again(Arc::clone(seal), probe).await? {
                SealPass::Unchanged | SealPass::Sealed => {}
                SealPass::Abandoned(why) => tracing::warn!(
                    why,
                    "the items sealed with a weaker key stay as they are: sealing them again was \
                     abandoned"
                ),
            }
        }
        tracing::info!(
            key = ?probe.key(),
            pcr_mask = probe.pcr_mask(),
            "systemd's credential service seals the daemon's secrets"
        );
        Ok(())
    }

    // Seals a random value under this run's probe account, reads the key its blob names, opens it
    // and compares, within the check's time. Fails with [`KeychainRefusal`] only when the system
    // gives no random bytes.
    pub(super) async fn probe(&self, seal: &dyn SecretSeal) -> Result<Probe, KeychainRefusal> {
        let value = random_value()?;
        let name = credential_name(KeychainService::Probe.as_str(), &self.probe_account);
        let probed = tokio::time::timeout(self.seal_check_timeout, async {
            let blob = match seal.seal(&name, &value).await {
                Ok(blob) => blob,
                Err(failure) => return Probe::Failed(failure),
            };
            let Some(header) = SealHeader::read(&blob) else {
                return Probe::Failed(SealFailure::Broken(
                    "the check's sealed value names no key the daemon knows",
                ));
            };
            match seal.unseal(&name, &blob).await {
                Ok(opened) if holds_value(Some(&opened), &value) => Probe::Sealed(header),
                Ok(_other) => Probe::Mismatch,
                Err(failure) => Probe::Failed(failure),
            }
        })
        .await;
        Ok(probed.unwrap_or(Probe::NoAnswer))
    }

    // The refusal of a first start whose probe gave no answer in time; nothing is recorded, so the
    // next call probes again.
    pub(super) fn no_answer(&self) -> KeychainRefusal {
        KeychainRefusal::new(
            KeychainRefusalCause::Unavailable,
            format!(
                "systemd's credential service gave no answer within {:?}",
                self.seal_check_timeout
            ),
        )
    }
}

// Opens each of `samples`, the probe's blob having shown `probe`, and answers why the first that
// fails does not open, or `None` when every one opens.
async fn open_samples(
    seal: &dyn SecretSeal,
    samples: impl Iterator<Item = SealedItem>,
    probe: SealHeader,
) -> Option<DaemonSecretsFileUnopened> {
    for item in samples {
        let Err(failure) = seal.unseal(&item.name(), item.blob.expose_secret()).await else {
            continue;
        };
        let cause = match &failure {
            SealFailure::NoService(_) => DaemonSecretsFileUnopened::SealServiceMissing,
            SealFailure::Failed(_) | SealFailure::Broken(_) => {
                DaemonSecretsFileUnopened::SealServiceFailing
            }
            // An item stronger than the probe's key was sealed with a chip this start cannot use,
            // or, both holding the chip, by a newer systemd than this one; an item no stronger
            // lost the key it was sealed with.
            SealFailure::Refused { .. } => match item.header().map(SealHeader::key) {
                Some(item_key) if is_weaker(probe.key(), item_key) && !probe.key().uses_chip() => {
                    DaemonSecretsFileUnopened::ChipUnavailable
                }
                Some(item_key) if is_weaker(probe.key(), item_key) => {
                    DaemonSecretsFileUnopened::SealServiceMissing
                }
                Some(_) | None => DaemonSecretsFileUnopened::KeyChanged,
            },
        };
        tracing::error!(
            error = &failure as &(dyn Error + 'static),
            service = item.service,
            key = ?item.header().map(SealHeader::key),
            probe_key = ?probe.key(),
            cause = ?cause,
            "an item of the sealed secrets does not open, so every secret call is refused"
        );
        return Some(cause);
    }
    None
}

// Whether `failure` is one a first start reads as the service unable to seal on this computer.
pub(super) fn is_definite_refusal(failure: &SealFailure) -> bool {
    match failure {
        SealFailure::Refused { error, errno } => {
            error == NO_SUCH_USER
                || (error == SYSTEM_ERROR
                    && matches!(*errno, Some(LINUX_ENOTRECOVERABLE | LINUX_EOPNOTSUPP)))
        }
        SealFailure::NoService(_) | SealFailure::Failed(_) | SealFailure::Broken(_) => false,
    }
}

pub(super) fn log_boot_bound(header: SealHeader) {
    tracing::warn!(
        key = ?header.key(),
        pcr_mask = header.pcr_mask(),
        "systemd's credential service binds each seal to the boot state, which a Secure Boot \
         update changes, so the secrets stay plain until a later start seals them unbound"
    );
}
