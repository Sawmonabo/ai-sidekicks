//! Where this machine keeps the daemon's secrets, recorded in the data folder, and the move of
//! every item from one place to the other.
//!
//! The record, `secrets-place.json` (mode 0600), names the place picked at the first start that
//! accepted one, so a later start keeps it whatever it finds: a Linux start before login finds no
//! Secret Service, and picking again would strand the items kept in it. It sits in the data folder,
//! never in the database or the settings file, which a backup holds, so a restore onto another
//! machine carries no pick, and an erase removes it with the folder.
//!
//! During a move it also names the move's direction. A move first writes each item at its
//! destination and reads it back, then records the direction, then deletes each item from its
//! source, then records the destination alone. Each step can run again with the same result, so a
//! move stopped partway, by a crash or a refused call, finishes in the same direction, and an item
//! is deleted only once its copy read back.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sidekicks_contracts::keychain::KeychainRefusalCause;

use crate::credential_store::service::KeychainService;
use crate::credential_store::{KeychainRefusal, SecretKeychain};
use crate::file::atomic_write::write_file_atomically;
use crate::missing_entry::MissingEntry;

const RECORD_FILE_NAME: &str = "secrets-place.json";

const RECORD_FILE_MODE: u32 = 0o600;

/// Where the daemon's secrets are kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum SecretsPlace {
    /// The operating system's credential store.
    OperatingSystem,
    /// The daemon's items file, and why.
    File {
        /// Why the file holds the secrets.
        reason: SecretsFileReason,
    },
}

/// Why the daemon's items file holds the secrets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SecretsFileReason {
    /// No Secret Service ran on Linux when the place was picked; the items move into one once one
    /// runs.
    NoSecretService,
    /// The Mac's service runs while the person is logged out, where the login keychain cannot be
    /// reached; the items move back only when that service is uninstalled.
    LoggedOutService,
}

/// The record in the data folder: the place, and during a move its destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlaceRecord {
    /// Where the secrets are, or during a move where they come from.
    pub(crate) place: SecretsPlace,
    /// Where a move under way takes them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) moving_to: Option<SecretsPlace>,
}

impl PlaceRecord {
    /// The record of secrets kept in `place`, with no move under way.
    pub(crate) fn settled(place: SecretsPlace) -> Self {
        Self {
            place,
            moving_to: None,
        }
    }

    /// Whether the record names the operating system's store, as the place or a move's end.
    pub(crate) fn names_operating_system(self) -> bool {
        self.place == SecretsPlace::OperatingSystem
            || self.moving_to == Some(SecretsPlace::OperatingSystem)
    }
}

/// The record's path in `data_folder`.
pub(crate) fn record_path(data_folder: &Path) -> PathBuf {
    data_folder.join(RECORD_FILE_NAME)
}

/// The record at `path`, or `None` when there is none. Fails with [`KeychainRefusal`] when it
/// cannot be read or does not parse; the file is then left as it is, since a new pick could strand
/// the items.
pub(crate) async fn read_record(path: &Path) -> Result<Option<PlaceRecord>, KeychainRefusal> {
    let text = match tokio::fs::read(path).await.none_if_missing() {
        Ok(Some(text)) => text,
        Ok(None) => return Ok(None),
        Err(failure) => return Err(unreadable(path, failure)),
    };
    serde_json::from_slice(&text)
        .map(Some)
        .map_err(|failure| unreadable(path, failure))
}

/// Replaces the record at `path` with `record` at once. Fails with [`KeychainRefusal`] when the
/// file system refuses.
pub(crate) async fn write_record(path: &Path, record: &PlaceRecord) -> Result<(), KeychainRefusal> {
    let text = serde_json::to_vec(record).map_err(|failure| record_failure(path, failure))?;
    write_file_atomically(path, text, RECORD_FILE_MODE)
        .await
        .map_err(|failure| record_failure(path, failure))
}

/// A move stopped by a refused call, and the record as it left it: the record it started from when
/// it stopped before recording its direction, else the record naming the move.
pub(crate) struct MoveStopped {
    /// The refused call's refusal.
    pub(crate) refusal: KeychainRefusal,
    /// The record at the path once the move stopped.
    pub(crate) record: PlaceRecord,
}

/// Moves every item from the keychains `from` gives to those `to` gives, as the module doc says,
/// recording at `path` the move from `record.place` to `destination`. Fails with [`MoveStopped`] at
/// the first call refused: before any item is deleted the record is left as it was, and after, it
/// names the move, which the next try finishes.
pub(crate) async fn move_items(
    path: &Path,
    record: PlaceRecord,
    destination: SecretsPlace,
    from: &(dyn Fn(KeychainService) -> Box<dyn SecretKeychain> + Sync),
    to: &(dyn Fn(KeychainService) -> Box<dyn SecretKeychain> + Sync),
) -> Result<(), MoveStopped> {
    let mut copied = Vec::new();
    for service in KeychainService::ALL
        .into_iter()
        .filter(|service| service.is_moved())
    {
        let (source, target) = (from(service), to(service));
        for account in source.accounts().await.map_err(stopped_at(record))? {
            // A listed account with no value holds nothing to move.
            let Some(value) = source.read(&account).await.map_err(stopped_at(record))? else {
                continue;
            };
            target
                .seal(&account, &value)
                .await
                .map_err(stopped_at(record))?;
            copied.push((service, account));
        }
    }
    let moving = PlaceRecord {
        place: record.place,
        moving_to: Some(destination),
    };
    if record.moving_to.is_none() {
        write_record(path, &moving)
            .await
            .map_err(stopped_at(record))?;
    }
    for (service, account) in copied {
        from(service)
            .remove(&account)
            .await
            .map_err(stopped_at(moving))?;
    }
    write_record(path, &PlaceRecord::settled(destination))
        .await
        .map_err(stopped_at(moving))
}

// The stop of a move that left `record` at the record's path.
fn stopped_at(record: PlaceRecord) -> impl FnOnce(KeychainRefusal) -> MoveStopped {
    move |refusal| MoveStopped { refusal, record }
}

// The refusal for a record that cannot be read, naming the file.
fn unreadable(
    path: &Path,
    failure: impl Into<Box<dyn std::error::Error + Send + Sync>>,
) -> KeychainRefusal {
    KeychainRefusal::new(
        KeychainRefusalCause::Unavailable,
        format!(
            "{} cannot be read, so where the secrets are is not known and it is left as it is",
            path.display()
        ),
    )
    .with_failure(failure)
}

// The refusal for a record that cannot be written.
fn record_failure(
    path: &Path,
    failure: impl Into<Box<dyn std::error::Error + Send + Sync>>,
) -> KeychainRefusal {
    KeychainRefusal::new(
        KeychainRefusalCause::Unavailable,
        format!("{} could not be written", path.display()),
    )
    .with_failure(failure)
}
