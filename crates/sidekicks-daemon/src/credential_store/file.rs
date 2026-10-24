//! The items kept outside the operating system's credential store, on Linux and on a Mac whose
//! service runs while the person is logged out: the daemon's one items file, `secrets.json` in its
//! data folder, readable by this account alone (mode 0600). The file holds each item under its
//! keychain service and account, so every service's items share it, and names its form: `sealed`,
//! each value sealed to this computer by systemd's credential service under its own name, or
//! `plain`, each value as given. Each call opens the file in the form its keychain keeps and
//! refuses a file in the other or in none; a run serves its calls in one form, and only the pass
//! that seals the file again turns it from one form to the other. It exists exactly while it holds
//! an item: the write that removes the last one deletes it.
//!
//! Every call reads the disk, so no copy of a value stays in memory past the call, and the calls on
//! one file run one at a time, every service's keychain on it sharing one lock, so two writes never
//! lose each other; another process writes the file only while the daemon is stopped, as the data
//! folder's lock ensures. A write seals its value before that lock is taken and a read opens its
//! value after the lock is let go; only the pass that seals the file again holds the lock across
//! its seals, so a call waits for it, while the status read takes the file without the lock and
//! never waits. A write or a removal holds its item from its seal through its file write in a task
//! of its own, so it lands whole even after its caller stops waiting, and before the next call on
//! that item. Each write replaces the whole file at once, and the first call on the file deletes
//! the temporary files a write cut short left behind, since each holds every value. An items file
//! that cannot be read refuses every call and is never rewritten, because rewriting it would lose
//! every secret it holds. The text read and the text written are held in buffers that wipe
//! themselves when dropped.

use std::collections::BTreeMap;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{SealFailure, SealHeader, SealKey};
use tokio::sync::{Mutex, MutexGuard, oneshot};
use zeroize::Zeroizing;

use crate::cleanup_failures::CleanupFailures;
use crate::credential_store::seal::SecretSeal;
use crate::credential_store::{KeychainRefusal, SecretKeychain};
use crate::file::atomic_write::write_file_atomically;
use crate::keyed_lock::KeyedLock;
use crate::missing_entry::MissingEntry;

const ITEMS_FILE_NAME: &str = "secrets.json";

const ITEMS_FILE_MODE: u32 = 0o600;

const LEFTOVER_REMOVAL: &str = "removing the leftovers of a write cut short";

// Each keychain service's stored values, by account: the values themselves in a plain file, their
// sealed blobs in a sealed one.
type Items = BTreeMap<String, BTreeMap<String, SecretString>>;

/// How the items file keeps its values, as its `form` names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ItemsForm {
    /// Each value as given.
    Plain,
    /// Each value sealed to this computer by systemd's credential service.
    Sealed,
}

/// One item of a sealed file as it is stored: its service, its account and its sealed blob, read
/// without opening it.
pub(crate) struct SealedItem {
    /// The keychain service it is filed under.
    pub(crate) service: String,
    /// The account it is filed under.
    pub(crate) account: String,
    /// The blob, which only systemd's credential service opens.
    pub(crate) blob: SecretString,
}

impl SealedItem {
    /// The name the item is sealed under.
    pub(crate) fn name(&self) -> String {
        credential_name(&self.service, &self.account)
    }

    /// What the blob's header says, or `None` when it names no key the daemon knows.
    pub(crate) fn header(&self) -> Option<SealHeader> {
        SealHeader::read(self.blob.expose_secret())
    }
}

/// The items file as the status read takes it, no value kept.
pub(crate) struct ItemsSnapshot {
    /// The form the file names.
    pub(crate) form: ItemsForm,
    /// The key each item of the services asked for is sealed with, one per item: `None` for a
    /// plain item or a key the daemon does not know.
    pub(crate) keys: Vec<Option<SealKey>>,
}

/// What sealing a file's items again did.
#[derive(Debug)]
pub(crate) enum SealPass {
    /// Nothing needed sealing again; the file is as it was.
    Unchanged,
    /// Every item that needed it was sealed again and the file replaced with the sealed form.
    Sealed,
    /// The pass stopped for the reason given, so the file is left as it was.
    Abandoned(PassAbandoned),
}

/// Why a pass sealing the items file again stopped with the file left as it was.
#[derive(Debug)]
pub(crate) enum PassAbandoned {
    /// systemd's credential service refused to seal or open an item.
    Refused(SealFailure),
    /// A seal or an unseal gave no answer within the pass's time for it.
    NoAnswer,
    /// A new seal came back weaker than allowed or bound to the boot state.
    Weaker,
}

/// Why the items file was not read under its lock: the file itself cannot be read or is not an
/// items file, which no later call of this run changes, or the call is refused for another cause.
pub(crate) enum ItemsReadFailure {
    /// The file cannot be read or does not parse as an items file; it is left as it is.
    Unreadable(KeychainRefusal),
    /// The leftovers of a write cut short could not be removed, or the file is in another form
    /// than the call opens.
    Refused(KeychainRefusal),
}

impl From<ItemsReadFailure> for KeychainRefusal {
    fn from(failure: ItemsReadFailure) -> Self {
        match failure {
            ItemsReadFailure::Unreadable(refusal) | ItemsReadFailure::Refused(refusal) => refusal,
        }
    }
}

// The file's text as read.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemsText {
    form: ItemsForm,
    items: Items,
}

// The file's text as written, each stored value exposed for the write alone.
#[derive(Serialize)]
struct ItemsTextWritten<'items> {
    form: ItemsForm,
    items: BTreeMap<&'items str, BTreeMap<&'items str, &'items str>>,
}

/// The daemon's one `secrets.json` in its data folder: its path, the lock every call on it holds,
/// whichever service's keychain makes the call and in whichever form, and the hold each write keeps
/// on its item. One per data folder, every keychain on the file holding a handle to it; each
/// keychain and each pass names the form it keeps the file in.
pub(crate) struct SecretItemsFile {
    /// The file's full path.
    file_path: PathBuf,
    /// Held by each call for its whole read and write; `true` once the leftovers of a write cut
    /// short have been removed.
    calls: Mutex<bool>,
    /// Held by each write and removal on an item, by service and account, from its seal through
    /// its file write.
    items: Arc<KeyedLock<(String, String)>>,
}

impl SecretItemsFile {
    /// The items file in `data_folder`, an absolute path to a folder that exists and only this
    /// account can read, as the daemon makes its data folder at start.
    pub(crate) fn new(data_folder: &Path) -> Arc<Self> {
        Arc::new(Self {
            file_path: data_folder.join(ITEMS_FILE_NAME),
            calls: Mutex::new(false),
            items: Arc::new(KeyedLock::new()),
        })
    }

    /// The items file's full path, which the daemon names to the person while it holds secrets.
    pub(crate) fn file_path(&self) -> &Path {
        &self.file_path
    }

    /// The items filed under `service` in this file, sharing its one lock with every other
    /// service's: each value sealed through `seal` in the sealed form, or kept as given in the
    /// plain form without one.
    pub(crate) fn keychain(
        self: &Arc<Self>,
        service: &str,
        seal: Option<Arc<dyn SecretSeal>>,
    ) -> FileSecretKeychain {
        FileSecretKeychain {
            items_file: Arc::clone(self),
            service: service.to_owned(),
            seal,
        }
    }

    /// The file as it stands on disk, read without its lock, so the read waits for no call and,
    /// while a pass seals the file again, sees the file that pass started from, since each write
    /// replaces the whole file at once. `None` when there is none. Fails with [`KeychainRefusal`]
    /// when it cannot be read or is not an items file.
    pub(crate) async fn snapshot(
        &self,
        services: &[&str],
    ) -> Result<Option<ItemsSnapshot>, KeychainRefusal> {
        Ok(self.read_text().await?.map(|text| {
            let form = text.form;
            let keys = text
                .items
                .into_iter()
                .filter(|(service, _)| services.contains(&service.as_str()))
                .flat_map(|(_, entries)| entries.into_values())
                .map(|stored| match form {
                    ItemsForm::Sealed => {
                        SealHeader::read(stored.expose_secret()).map(SealHeader::key)
                    }
                    ItemsForm::Plain => None,
                })
                .collect();
            ItemsSnapshot { form, keys }
        }))
    }

    /// Deletes the file, every item in it with it, and the leftovers of any write cut short; one
    /// already gone is no failure. Fails with [`KeychainRefusal`] when the file system refuses.
    pub(crate) async fn remove_all(&self) -> Result<(), KeychainRefusal> {
        let _held = self.hold().await?;
        tokio::fs::remove_file(&self.file_path)
            .await
            .none_if_missing()
            .map(drop)
            .map_err(file_failure)
    }

    // Waits for the file behind every call already holding or waiting for it, then removes the
    // leftovers of a write cut short once per daemon run.
    async fn hold(&self) -> Result<MutexGuard<'_, bool>, KeychainRefusal> {
        let mut has_removed_leftovers = self.calls.lock().await;
        if !*has_removed_leftovers {
            self.remove_leftover_temporary_files().await?;
            *has_removed_leftovers = true;
        }
        Ok(has_removed_leftovers)
    }

    // A write cut short leaves `secrets.json.<random>.tmp` beside the file.
    async fn remove_leftover_temporary_files(&self) -> Result<(), KeychainRefusal> {
        let folder = self
            .file_path
            .parent()
            .expect("the items file's path ends in its name after the data folder")
            .to_path_buf();
        let removed = tokio::task::spawn_blocking(move || remove_leftovers_in(&folder)).await;
        let failure: Box<dyn std::error::Error + Send + Sync> = match removed {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(failure)) => failure.into(),
            Err(interrupted) => interrupted.into(),
        };
        Err(KeychainRefusal::new(
            KeychainRefusalCause::Unavailable,
            "the leftovers of an items file write cut short could not be removed",
        )
        .with_failure(failure))
    }

    /// The form the file on disk names, or `None` when there is none. Fails with
    /// [`ItemsReadFailure`], `Unreadable` when the file cannot be read or is not an items file.
    pub(crate) async fn form_on_disk(&self) -> Result<Option<ItemsForm>, ItemsReadFailure> {
        let _held = self.hold().await.map_err(ItemsReadFailure::Refused)?;
        let text = self
            .read_text()
            .await
            .map_err(ItemsReadFailure::Unreadable)?;
        Ok(text.map(|text| text.form))
    }

    /// Every item of the sealed file with its blob, opening none. Fails with
    /// [`ItemsReadFailure`], `Unreadable` when the file cannot be read or is not an items file and
    /// `Refused` when it is plain.
    pub(crate) async fn sealed_items(&self) -> Result<Vec<SealedItem>, ItemsReadFailure> {
        let _held = self.hold().await.map_err(ItemsReadFailure::Refused)?;
        let items = match self.read_text().await {
            Ok(None) => Items::new(),
            Ok(Some(read)) if read.form == ItemsForm::Sealed => read.items,
            Ok(Some(_plain)) => return Err(ItemsReadFailure::Refused(self.other_form())),
            Err(unreadable) => return Err(ItemsReadFailure::Unreadable(unreadable)),
        };
        Ok(items
            .into_iter()
            .flat_map(|(service, entries)| {
                entries.into_iter().map(move |(account, blob)| SealedItem {
                    service: service.clone(),
                    account,
                    blob,
                })
            })
            .collect())
    }

    /// Seals into one new sealed file, written at once, every value of a plain file and every blob
    /// of a sealed file whose key is weaker than `probe`'s, the start's fresh seal, each seal and
    /// unseal given `time`. Never seals downward: the pass is abandoned, the file left as it was,
    /// when a seal or unseal fails or runs out of `time`, or a new blob is weaker than `probe`'s,
    /// than the blob it replaces, or bound to the boot state. A blob whose key the daemon does not
    /// know is kept as it is. The pass runs in a task of its own that holds the file's lock until
    /// it ends, so it lands whole even after its caller stops waiting, and a later call on the file
    /// waits for it rather than starting another. Fails with [`KeychainRefusal`] when the file
    /// cannot be read or written; the file is then left as it was.
    pub(crate) async fn seal_again(
        self: &Arc<Self>,
        seal: Arc<dyn SecretSeal>,
        probe: SealHeader,
        time: Duration,
    ) -> Result<SealPass, KeychainRefusal> {
        // The caller holds the receiver while it waits and drops it when it stops waiting.
        let (still_waiting, _caller_waits) = oneshot::channel::<()>();
        let items_file = Arc::clone(self);
        tokio::spawn(async move {
            let pass = items_file.seal_held(seal.as_ref(), probe, time).await;
            if still_waiting.is_closed() {
                match &pass {
                    Ok(pass) => tracing::info!(
                        pass = ?pass,
                        "the items file's seal pass ended after its caller stopped waiting"
                    ),
                    Err(refusal) => tracing::warn!(
                        error = refusal as &(dyn Error + 'static),
                        "the items file's seal pass failed after its caller stopped waiting"
                    ),
                }
            }
            pass
        })
        .await
        .unwrap_or_else(|interrupted| Err(file_failure(interrupted)))
    }

    // The pass `seal_again` runs, holding the file's lock from its read through its write.
    async fn seal_held(
        &self,
        seal: &dyn SecretSeal,
        probe: SealHeader,
        time: Duration,
    ) -> Result<SealPass, KeychainRefusal> {
        let _held = self.hold().await?;
        let Some(text) = self.read_text().await? else {
            return Ok(SealPass::Unchanged);
        };
        let mut sealed = Items::new();
        let mut is_changed = false;
        for (service, entries) in text.items {
            for (account, stored) in entries {
                let name = credential_name(&service, &account);
                let (value, floor) = match text.form {
                    ItemsForm::Plain => (stored, probe.key()),
                    ItemsForm::Sealed => match SealHeader::read(stored.expose_secret()) {
                        Some(old) if old.key() < probe.key() => {
                            match within_pass_time(time, seal.unseal(&name, stored.expose_secret()))
                                .await
                            {
                                Ok(value) => (value, probe.key()),
                                Err(abandoned) => return Ok(SealPass::Abandoned(abandoned)),
                            }
                        }
                        Some(_) | None => {
                            sealed
                                .entry(service.clone())
                                .or_default()
                                .insert(account, stored);
                            continue;
                        }
                    },
                };
                let blob = match within_pass_time(time, seal.seal(&name, &value)).await {
                    Ok(blob) => blob,
                    Err(abandoned) => return Ok(SealPass::Abandoned(abandoned)),
                };
                match SealHeader::read(&blob) {
                    Some(new) if new.key() >= floor && !new.is_boot_bound() => {}
                    Some(_) | None => return Ok(SealPass::Abandoned(PassAbandoned::Weaker)),
                }
                sealed
                    .entry(service.clone())
                    .or_default()
                    .insert(account, SecretString::from(blob));
                is_changed = true;
            }
        }
        if !is_changed && text.form == ItemsForm::Sealed {
            return Ok(SealPass::Unchanged);
        }
        self.write_items(&sealed, ItemsForm::Sealed).await?;
        Ok(SealPass::Sealed)
    }

    // The file's text in whatever form it names, `None` when it does not exist yet. A file that
    // cannot be read refuses the call and is left as it is.
    async fn read_text(&self) -> Result<Option<ItemsText>, KeychainRefusal> {
        let text = match tokio::fs::read(&self.file_path).await.none_if_missing() {
            Ok(Some(text)) => Zeroizing::new(text),
            Ok(None) => return Ok(None),
            Err(failure) => return Err(file_failure(failure)),
        };
        match serde_json::from_slice::<ItemsText>(&text) {
            Ok(read) => Ok(Some(read)),
            // The parser's message can quote the file's text, which holds secret values, so it is
            // never kept.
            Err(_quotes_the_text) => Err(KeychainRefusal::new(
                KeychainRefusalCause::Unavailable,
                format!(
                    "{} is not an items file, so it is left as it is",
                    self.file_path.display()
                ),
            )),
        }
    }

    // Every service's stored values in the file, nothing when it does not exist yet. A file that
    // cannot be read, or is in another form than `form`, refuses the call and is left as it is.
    async fn read_items(&self, form: ItemsForm) -> Result<Items, KeychainRefusal> {
        match self.read_text().await? {
            None => Ok(Items::new()),
            Some(read) if read.form == form => Ok(read.items),
            Some(_other_form) => Err(self.other_form()),
        }
    }

    // The refusal of a call that finds the file in another form than it opens.
    fn other_form(&self) -> KeychainRefusal {
        KeychainRefusal::new(
            KeychainRefusalCause::Unavailable,
            format!(
                "{} keeps its secrets in another form than this call opens, so it is left as it is",
                self.file_path.display()
            ),
        )
    }

    // Replaces the file with `items` in `form` at once, written from a buffer sized before it is
    // filled so no partial copy of a value is left behind by its growth; with no item left the
    // file is deleted.
    async fn write_items(&self, items: &Items, form: ItemsForm) -> Result<(), KeychainRefusal> {
        let exposed: BTreeMap<&str, BTreeMap<&str, &str>> = items
            .iter()
            .filter(|(_, entries)| !entries.is_empty())
            .map(|(service, entries)| {
                let values = entries
                    .iter()
                    .map(|(account, value)| (account.as_str(), value.expose_secret()))
                    .collect();
                (service.as_str(), values)
            })
            .collect();
        if exposed.is_empty() {
            return tokio::fs::remove_file(&self.file_path)
                .await
                .none_if_missing()
                .map(drop)
                .map_err(file_failure);
        }
        let written = ItemsTextWritten {
            form,
            items: exposed,
        };
        let length = json_utf8_byte_length(&written).map_err(file_failure)?;
        let mut text = Zeroizing::new(Vec::with_capacity(length));
        serde_json::to_writer(&mut *text, &written).map_err(file_failure)?;
        write_file_atomically(&self.file_path, text, ITEMS_FILE_MODE)
            .await
            .map_err(file_failure)
    }

    // Keeps `value` under `service` and `account`: sealed first through `seal`, outside the file's
    // lock, in the sealed form, or as given in the plain form without one.
    async fn write_item(
        &self,
        service: &str,
        account: &str,
        value: &SecretString,
        seal: Option<&dyn SecretSeal>,
    ) -> Result<(), KeychainRefusal> {
        let stored = match seal {
            Some(seal) => SecretString::from(
                seal.seal(&credential_name(service, account), value)
                    .await
                    .map_err(seal_failure)?,
            ),
            None => value.clone(),
        };
        let form = form_of(seal);
        let _held = self.hold().await?;
        let mut items = self.read_items(form).await?;
        items
            .entry(service.to_owned())
            .or_default()
            .insert(account.to_owned(), stored);
        self.write_items(&items, form).await
    }

    // Removes the item under `service` and `account` from the file in `form`; `false` when none
    // was held.
    async fn remove_item(
        &self,
        service: &str,
        account: &str,
        form: ItemsForm,
    ) -> Result<bool, KeychainRefusal> {
        let _held = self.hold().await?;
        let mut items = self.read_items(form).await?;
        let was_held = items
            .get_mut(service)
            .is_some_and(|entries| entries.remove(account).is_some());
        if was_held {
            self.write_items(&items, form).await?;
        }
        Ok(was_held)
    }

    // Runs `change` on the item under `service` and `account` in a task of its own that holds the
    // item until the change lands, even after the caller stops waiting.
    async fn change_item<Answer: Send + 'static>(
        self: &Arc<Self>,
        service: &str,
        account: &str,
        change: impl Future<Output = Result<Answer, KeychainRefusal>> + Send + 'static,
    ) -> Result<Answer, KeychainRefusal> {
        let logged_service = service.to_owned();
        let landed = self
            .items
            .run_held(
                (service.to_owned(), account.to_owned()),
                change,
                move |answer| match answer {
                    Ok(_) => tracing::warn!(
                        service = logged_service,
                        "an items file write landed after its caller stopped waiting"
                    ),
                    Err(refusal) => tracing::warn!(
                        service = logged_service,
                        error = refusal as &(dyn Error + 'static),
                        "an items file write failed after its caller stopped waiting"
                    ),
                },
            )
            .await;
        match landed {
            Ok(Some(answer)) => answer,
            // A task skips its change only once its caller stopped waiting.
            Ok(None) => Err(KeychainRefusal::new(
                KeychainRefusalCause::Unavailable,
                "the items file call ended without an answer",
            )),
            Err(interrupted) => Err(KeychainRefusal::new(
                KeychainRefusalCause::Unavailable,
                "the items file call ended without an answer",
            )
            .with_failure(interrupted)),
        }
    }
}

/// One keychain service's items in the daemon's items file, in one form; see the module doc.
/// Every failure of the file or the seal refuses the call as the keychain being `unavailable`.
pub(crate) struct FileSecretKeychain {
    /// The items file, shared with every other service's keychain on it.
    items_file: Arc<SecretItemsFile>,
    /// The keychain service the items are filed under.
    service: String,
    /// The seal each value goes through in the sealed form, or `None` for the plain form.
    seal: Option<Arc<dyn SecretSeal>>,
}

impl FileSecretKeychain {
    // The form this keychain keeps the file in.
    fn form(&self) -> ItemsForm {
        form_of(self.seal.as_deref())
    }
}

impl SecretKeychain for FileSecretKeychain {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        let items_file = Arc::clone(&self.items_file);
        let (service, account_owned, value, seal) = (
            self.service.clone(),
            account.to_owned(),
            value.clone(),
            self.seal.clone(),
        );
        Box::pin(
            self.items_file
                .change_item(&self.service, account, async move {
                    items_file
                        .write_item(&service, &account_owned, &value, seal.as_deref())
                        .await
                }),
        )
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        Box::pin(async move {
            let stored = {
                let _held = self.items_file.hold().await?;
                let mut items = self.items_file.read_items(self.form()).await?;
                items
                    .get_mut(&self.service)
                    .and_then(|entries| entries.remove(account))
            };
            match (stored, &self.seal) {
                (Some(blob), Some(seal)) => seal
                    .unseal(
                        &credential_name(&self.service, account),
                        blob.expose_secret(),
                    )
                    .await
                    .map(Some)
                    .map_err(seal_failure),
                (stored, _) => Ok(stored),
            }
        })
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        let items_file = Arc::clone(&self.items_file);
        let (service, account_owned, form) =
            (self.service.clone(), account.to_owned(), self.form());
        Box::pin(
            self.items_file
                .change_item(&self.service, account, async move {
                    items_file.remove_item(&service, &account_owned, form).await
                }),
        )
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        Box::pin(async move {
            let _held = self.items_file.hold().await?;
            let items = self.items_file.read_items(self.form()).await?;
            Ok(items
                .get(&self.service)
                .map(|entries| entries.keys().cloned().collect())
                .unwrap_or_default())
        })
    }
}

/// The name an item is sealed under: its service, then the SHA-256 of its account in hexadecimal,
/// so every name is one systemd accepts and a blob opens only in its own item's place.
pub(crate) fn credential_name(service: &str, account: &str) -> String {
    format!(
        "{service}.{}",
        base16ct::lower::encode_string(&Sha256::digest(account.as_bytes()))
    )
}

// The form a keychain sealing through `seal`, or keeping values as given without one, keeps.
fn form_of(seal: Option<&dyn SecretSeal>) -> ItemsForm {
    if seal.is_some() {
        ItemsForm::Sealed
    } else {
        ItemsForm::Plain
    }
}

// Runs one seal or unseal of a pass within `time`; the pass stops when it fails or runs out.
async fn within_pass_time<Answer>(
    time: Duration,
    call: impl Future<Output = Result<Answer, SealFailure>>,
) -> Result<Answer, PassAbandoned> {
    match tokio::time::timeout(time, call).await {
        Ok(answer) => answer.map_err(PassAbandoned::Refused),
        Err(_elapsed) => Err(PassAbandoned::NoAnswer),
    }
}

// The refusal for a seal that failed, kept as the source; nothing on Linux can be unlocked.
fn seal_failure(failure: SealFailure) -> KeychainRefusal {
    KeychainRefusal::new(
        KeychainRefusalCause::Unavailable,
        "systemd's credential service could not seal or open the secret",
    )
    .with_failure(failure)
}

// The refusal for a failure of the file system or of the file's write, kept as the source.
fn file_failure(failure: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> KeychainRefusal {
    KeychainRefusal::new(
        KeychainRefusalCause::Unavailable,
        "the items file could not be used",
    )
    .with_failure(failure)
}

// Removes every `secrets.json.*.tmp` in `folder`; one already gone is no failure. Every removal is
// tried, the first failure returned with the others beside it.
fn remove_leftovers_in(folder: &Path) -> Result<(), CleanupFailures<io::Error>> {
    let prefix = format!("{ITEMS_FILE_NAME}.");
    let mut failures = Vec::new();
    let entries = match std::fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(failure) => return Err(CleanupFailures::new(failure, Vec::new(), LEFTOVER_REMOVAL)),
    };
    for entry in entries {
        let removed = entry.and_then(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&prefix) && name.ends_with(".tmp") {
                std::fs::remove_file(entry.path())
                    .none_if_missing()
                    .map(drop)
            } else {
                Ok(())
            }
        });
        if let Err(failure) = removed {
            failures.push(failure);
        }
    }
    let mut failures = failures.into_iter();
    match failures.next() {
        None => Ok(()),
        Some(first) => Err(CleanupFailures::new(
            first,
            failures.collect(),
            LEFTOVER_REMOVAL,
        )),
    }
}

#[cfg(test)]
mod tests;
