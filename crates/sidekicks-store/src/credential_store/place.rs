//! Where this machine keeps the daemon's secrets, recorded in the data folder, and the move of
//! every item from one place to the other.
//!
//! The record, `secrets-place.json` (mode 0600), names the place picked at the first start that
//! accepted one, so a later start keeps it whatever it finds: a start whose credential service is
//! gone or failing would otherwise pick the plain file and strand the sealed items. A later start
//! changes it in one way only, from a Linux plain file to the sealed file once systemd's credential
//! service seals without binding to the boot state, and the relink removes it with a sealed file
//! that cannot be opened, so the place is picked again. It sits in the data folder, never in the
//! database or the settings file, which a backup holds, so a restore onto another machine carries
//! no pick, and an erase removes it with the folder.
//!
//! During a move it also names the move's direction. A move first writes each item at its
//! destination and reads it back, then records the direction, then deletes each item from its
//! source, then records the destination alone. Each step can run again with the same result, so a
//! move a crash stopped partway finishes in the same direction, and an item is deleted only once
//! its copy read back. A move begun from a settled record that a call refuses is put back instead:
//! each item it deleted is written back at its source, each copy is deleted from the destination,
//! and the record names the source alone again, so nothing is left to finish.

use std::path::{Path, PathBuf};

use secrecy::SecretString;

use sidekicks_contracts::daemon::secrets_place::{
    PlaceRecord, SECRETS_PLACE_RECORD_FILE_NAME, SecretsPlace, read_place_record,
};
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::file::atomic_write::write_file_atomically;
use sidekicks_std::missing_entry::MissingEntry;

use crate::credential_store::service::KeychainService;
use crate::credential_store::{KeychainRefusal, SecretKeychain};

const RECORD_FILE_MODE: u32 = 0o600;

/// The record's path in `data_folder`.
pub fn record_path(data_folder: &Path) -> PathBuf {
    data_folder.join(SECRETS_PLACE_RECORD_FILE_NAME)
}

/// The record at `path`, or `None` when there is none. Fails with [`KeychainRefusal`] when it
/// cannot be read or does not parse; the file is then left as it is, since a new pick could strand
/// the items.
pub async fn read_record(path: &Path) -> Result<Option<PlaceRecord>, KeychainRefusal> {
    let record_path = path.to_owned();
    tokio::task::spawn_blocking(move || read_place_record(&record_path))
        .await
        .map_err(|failure| unreadable(path, failure))?
        .map_err(|failure| unreadable(path, failure))
}

/// Replaces the record at `path` with `record` at once. Fails with [`KeychainRefusal`] when the
/// file system refuses.
pub async fn write_record(path: &Path, record: &PlaceRecord) -> Result<(), KeychainRefusal> {
    let text = serde_json::to_vec(record).map_err(|failure| record_failure(path, failure))?;
    write_file_atomically(path, text, RECORD_FILE_MODE)
        .await
        .map_err(|failure| record_failure(path, failure))
}

/// Removes the record at `path`; one already gone is no failure. Fails with [`KeychainRefusal`]
/// when the file system refuses.
pub(crate) async fn remove_record(path: &Path) -> Result<(), KeychainRefusal> {
    tokio::fs::remove_file(path)
        .await
        .none_if_missing()
        .map(drop)
        .map_err(|failure| record_failure(path, failure))
}

/// A move stopped by a refused call, and the record as it left it: the record it started from when
/// it stopped before recording its direction or was put back whole, else the record naming the
/// move.
pub(crate) struct MoveStopped {
    /// The refused call's refusal, naming beside it each step of a put-back that failed.
    pub(crate) refusal: KeychainRefusal,
    /// The record at the path once the move stopped.
    pub(crate) record: PlaceRecord,
}

/// A place's keychain of one service, or the refusal of a place this machine does not offer.
pub(crate) type PlaceKeychain<'place> =
    dyn Fn(KeychainService) -> Result<Box<dyn SecretKeychain>, KeychainRefusal> + Sync + 'place;

// One item a move copied: its service, its account and its value.
type CopiedItem = (KeychainService, String, SecretString);

// How far a move got: the items copied to the destination, whether the record names the move,
// and how many of the copied items were deleted from the source, in the order they were copied.
#[derive(Default)]
struct MoveProgress {
    copied: Vec<CopiedItem>,
    is_recorded: bool,
    deleted: usize,
}

/// Moves every item from the keychains `from` gives to those `to` gives, as the module doc says,
/// recording at `path` the move from `record`'s place to `destination`. Fails with
/// [`MoveStopped`] at the first call refused. A move from a settled `record` is then put back, the
/// record at `record` again unless an item could not be written back, when it names the move; a
/// recorded move the call finishes is left recorded, which the next try finishes.
pub(crate) async fn move_items(
    path: &Path,
    record: PlaceRecord,
    destination: SecretsPlace,
    from: &PlaceKeychain<'_>,
    to: &PlaceKeychain<'_>,
) -> Result<(), MoveStopped> {
    let mut progress = MoveProgress::default();
    let Err(refusal) = copy_and_delete(path, record, destination, from, to, &mut progress).await
    else {
        return Ok(());
    };
    let moving = PlaceRecord::moving(record.place(), destination);
    let stopped_record = if progress.is_recorded { moving } else { record };
    if record.moving_to().is_some() {
        return Err(MoveStopped {
            refusal,
            record: stopped_record,
        });
    }
    let (record, failures) = put_back(path, record, from, to, &progress).await;
    Err(MoveStopped {
        refusal: name_put_back_failures(refusal, &failures),
        record: record.unwrap_or(stopped_record),
    })
}

// Copies every item to its destination, records the move, deletes each from its source and
// records the destination alone, noting in `progress` how far it got. Fails at the first call
// refused.
async fn copy_and_delete(
    path: &Path,
    record: PlaceRecord,
    destination: SecretsPlace,
    from: &PlaceKeychain<'_>,
    to: &PlaceKeychain<'_>,
    progress: &mut MoveProgress,
) -> Result<(), KeychainRefusal> {
    for service in KeychainService::ALL
        .into_iter()
        .filter(|service| service.is_moved())
    {
        let source = from(service)?;
        let target = to(service)?;
        for account in source.accounts().await? {
            // A listed account with no value holds nothing to move.
            let Some(value) = source.read(&account).await? else {
                continue;
            };
            target.write_verified(&account, &value).await?;
            progress.copied.push((service, account, value));
        }
    }
    if record.moving_to().is_none() {
        write_record(path, &PlaceRecord::moving(record.place(), destination)).await?;
    }
    progress.is_recorded = true;
    for (service, account, _value) in &progress.copied {
        from(*service)?.remove(account).await?;
        progress.deleted += 1;
    }
    write_record(path, &PlaceRecord::settled(destination)).await
}

// Puts a move from the settled `record` that `progress` describes back: each item deleted is
// written back at its source, each copy whose item is whole at its source is deleted from the
// destination, and once every item is whole at its source a recorded move's record is written
// back to `record`. Answers the record written, if any, and each step that failed.
async fn put_back(
    path: &Path,
    record: PlaceRecord,
    from: &PlaceKeychain<'_>,
    to: &PlaceKeychain<'_>,
    progress: &MoveProgress,
) -> (Option<PlaceRecord>, Vec<KeychainRefusal>) {
    let mut failures = Vec::new();
    let mut is_whole_at_source = true;
    for (index, (service, account, value)) in progress.copied.iter().enumerate() {
        if index < progress.deleted {
            let written_back = match from(*service) {
                Ok(source) => source.write_verified(account, value).await,
                Err(refusal) => Err(refusal),
            };
            if let Err(refusal) = written_back {
                is_whole_at_source = false;
                failures.push(refusal);
                continue;
            }
        }
        let copy_deleted = match to(*service) {
            Ok(target) => target.remove(account).await.map(drop),
            Err(refusal) => Err(refusal),
        };
        failures.extend(copy_deleted.err());
    }
    if !progress.is_recorded || !is_whole_at_source {
        return (None, failures);
    }
    match write_record(path, &record).await {
        Ok(()) => (Some(record), failures),
        Err(refusal) => {
            failures.push(refusal);
            (None, failures)
        }
    }
}

// `refusal` with each of `failures`, the put-back's failed steps, named beside its reason.
fn name_put_back_failures(
    mut refusal: KeychainRefusal,
    failures: &[KeychainRefusal],
) -> KeychainRefusal {
    if failures.is_empty() {
        return refusal;
    }
    let named: Vec<String> = failures
        .iter()
        .map(|failure| describe_error(failure))
        .collect();
    refusal.reason = format!(
        "{}; the move could not be put back whole: {}",
        refusal.reason,
        named.join("; ")
    )
    .into();
    refusal
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

// The refusal for a record that cannot be written or removed.
fn record_failure(
    path: &Path,
    failure: impl Into<Box<dyn std::error::Error + Send + Sync>>,
) -> KeychainRefusal {
    KeychainRefusal::new(
        KeychainRefusalCause::Unavailable,
        format!("{} could not be written or removed", path.display()),
    )
    .with_failure(failure)
}

#[cfg(test)]
mod tests;
