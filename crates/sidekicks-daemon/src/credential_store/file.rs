//! The items kept outside the operating system's credential store, on Linux and on a Mac whose
//! service runs while the person is logged out: the daemon's one items file, `secrets.json` in its
//! data folder, readable by this account alone (mode 0600). The file holds each item under its
//! keychain service and account, so every service's items share it, and names its form: `sealed`,
//! each value sealed to this computer by systemd's credential service under its own name, or
//! `plain`, each value as given. A run opens the file in one form and refuses a file in the other or
//! in none. It exists exactly while it holds an item: the write that removes the last one deletes
//! it.
//!
//! Every call reads the disk, so no copy of a value stays in memory past the call, and the calls on
//! one file run one at a time, every service's keychain on it sharing one lock, so two writes never
//! lose each other; another process writes the file only while the daemon is stopped, as the data
//! folder's lock ensures. A value is sealed before that lock is taken and opened after it is let
//! go, so a slow seal never holds another call's file access. A write or a removal holds its item
//! from its seal through its file write in a task of its own, so it lands whole even after its
//! caller stops waiting, and before the next call on that item. Each write replaces the whole file
//! at once, and the first call on the file deletes the temporary files a write cut short left
//! behind, since each holds every value. An items file that cannot be read refuses every call and
//! is never rewritten, because rewriting it would lose every secret it holds. The text read and the
//! text written are held in buffers that wipe themselves when dropped.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_platforms::{SealFailure, SealHeader, SealKey};
use tokio::sync::{Mutex, MutexGuard};
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

/// What sealing a file's items again did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SealPass {
    /// Nothing needed sealing again; the file is as it was.
    Unchanged,
    /// Every item that needed it was sealed again and the file replaced with the sealed form.
    Sealed,
    /// A seal failed or came back weaker than allowed, so the file is left as it was.
    Abandoned(&'static str),
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

/// The daemon's one `secrets.json` in its data folder: its path, its form, the lock every call on
/// it holds, whichever service's keychain makes the call, and the hold each write keeps on its
/// item. One per data folder, every keychain on the file holding a handle to it.
pub(crate) struct SecretItemsFile {
    /// The file's full path.
    file_path: PathBuf,
    /// The seal each value goes through, or `None` for a plain file.
    seal: Option<Arc<dyn SecretSeal>>,
    /// Held by each call for its whole read and write; `true` once the leftovers of a write cut
    /// short have been removed.
    calls: Mutex<bool>,
    /// Held by each write and removal on an item, by service and account, from its seal through
    /// its file write.
    items: Arc<KeyedLock<(String, String)>>,
}

impl SecretItemsFile {
    /// The plain items file in `data_folder`, an absolute path to a folder that exists and only
    /// this account can read, as the daemon makes its data folder at start.
    pub(crate) fn new(data_folder: &Path) -> Arc<Self> {
        Self::with_seal(data_folder, None)
    }

    /// The sealed items file in `data_folder`, each value put through `seal`.
    pub(crate) fn sealed(data_folder: &Path, seal: Arc<dyn SecretSeal>) -> Arc<Self> {
        Self::with_seal(data_folder, Some(seal))
    }

    fn with_seal(data_folder: &Path, seal: Option<Arc<dyn SecretSeal>>) -> Arc<Self> {
        Arc::new(Self {
            file_path: data_folder.join(ITEMS_FILE_NAME),
            seal,
            calls: Mutex::new(false),
            items: Arc::new(KeyedLock::new()),
        })
    }

    /// The items file's full path, which the daemon names to the person while it holds secrets.
    pub(crate) fn file_path(&self) -> &Path {
        &self.file_path
    }

    /// The items filed under `service` in this file, sharing its one lock with every other
    /// service's.
    pub(crate) fn keychain(self: &Arc<Self>, service: &str) -> FileSecretKeychain {
        FileSecretKeychain {
            items_file: Arc::clone(self),
            service: service.to_owned(),
        }
    }

    /// Whether the file holds an item filed under one of `services`; a file that cannot be read
    /// counts as holding one, since it may.
    pub(crate) async fn holds_items(&self, services: &[&str]) -> bool {
        let _held = self.calls.lock().await;
        match self.read_items().await {
            Ok(items) => services.iter().any(|service| {
                items
                    .get(*service)
                    .is_some_and(|entries| !entries.is_empty())
            }),
            Err(_unreadable) => true,
        }
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
        match removed {
            Ok(Ok(())) => Ok(()),
            Ok(Err(failure)) => Err(file_failure(failure)),
            Err(interrupted) => Err(file_failure(interrupted)),
        }
    }

    // The form this run keeps the file in.
    fn form(&self) -> ItemsForm {
        if self.seal.is_some() {
            ItemsForm::Sealed
        } else {
            ItemsForm::Plain
        }
    }

    /// The form the file on disk names, or `None` when there is none. Fails with
    /// [`KeychainRefusal`] when it cannot be read or is not an items file.
    pub(crate) async fn form_on_disk(&self) -> Result<Option<ItemsForm>, KeychainRefusal> {
        let _held = self.hold().await?;
        Ok(self.read_text().await?.map(|text| text.form))
    }

    /// Every item of the sealed file with its blob, opening none. Fails with [`KeychainRefusal`]
    /// when the file cannot be read or is in another form than this run keeps.
    pub(crate) async fn sealed_items(&self) -> Result<Vec<SealedItem>, KeychainRefusal> {
        let _held = self.hold().await?;
        let items = self.read_items().await?;
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

    /// Seals into one new sealed file, written at once, every value of a plain file and every
    /// blob of a sealed file whose key is weaker than `probe`'s, the start's fresh seal. Never
    /// seals downward: the pass is abandoned, the file left as it was, when a seal fails or a new
    /// blob is weaker than `probe`'s, than the blob it replaces, or bound to the boot state. A blob
    /// whose key the daemon does not know is kept as it is. Fails with [`KeychainRefusal`] when
    /// the file cannot be read or written; the file is then left as it was.
    pub(crate) async fn seal_again(&self, probe: SealHeader) -> Result<SealPass, KeychainRefusal> {
        let seal = self
            .seal
            .as_ref()
            .expect("only the sealed items file is sealed again");
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
                        Some(old) if is_weaker(old.key(), probe.key()) => {
                            match seal.unseal(&name, stored.expose_secret()).await {
                                Ok(value) => (value, probe.key()),
                                Err(_failure) => {
                                    return Ok(SealPass::Abandoned("an item did not open"));
                                }
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
                let Ok(blob) = seal.seal(&name, &value).await else {
                    return Ok(SealPass::Abandoned("a seal failed"));
                };
                match SealHeader::read(&blob) {
                    Some(new) if !is_weaker(new.key(), floor) && !new.is_boot_bound() => {}
                    Some(_) | None => {
                        return Ok(SealPass::Abandoned(
                            "a new seal is weaker than allowed or bound to the boot state",
                        ));
                    }
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
        self.write_items(&sealed).await?;
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
    // cannot be read, or is in another form than this run keeps, refuses the call and is left as it
    // is.
    async fn read_items(&self) -> Result<Items, KeychainRefusal> {
        match self.read_text().await? {
            None => Ok(Items::new()),
            Some(read) if read.form == self.form() => Ok(read.items),
            Some(_other_form) => Err(KeychainRefusal::new(
                KeychainRefusalCause::Unavailable,
                format!(
                    "{} keeps its secrets in another form than this run opens, so it is left as \
                     it is",
                    self.file_path.display()
                ),
            )),
        }
    }

    // Replaces the file with `items` at once, written from a buffer sized before it is filled so
    // no partial copy of a value is left behind by its growth; with no item left the file is
    // deleted.
    async fn write_items(&self, items: &Items) -> Result<(), KeychainRefusal> {
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
            form: self.form(),
            items: exposed,
        };
        let length = json_utf8_byte_length(&written).map_err(file_failure)?;
        let mut text = Zeroizing::new(Vec::with_capacity(length));
        serde_json::to_writer(&mut *text, &written).map_err(file_failure)?;
        write_file_atomically(&self.file_path, text, ITEMS_FILE_MODE)
            .await
            .map_err(file_failure)
    }

    // Keeps `value` under `service` and `account`: sealed first, outside the file's lock, in a
    // sealed file.
    async fn write_item(
        &self,
        service: &str,
        account: &str,
        value: &SecretString,
    ) -> Result<(), KeychainRefusal> {
        let stored = match &self.seal {
            Some(seal) => SecretString::from(
                seal.seal(&credential_name(service, account), value)
                    .await
                    .map_err(seal_failure)?,
            ),
            None => value.clone(),
        };
        let _held = self.hold().await?;
        let mut items = self.read_items().await?;
        items
            .entry(service.to_owned())
            .or_default()
            .insert(account.to_owned(), stored);
        self.write_items(&items).await
    }

    // Removes the item under `service` and `account`; `false` when none was held.
    async fn remove_item(&self, service: &str, account: &str) -> Result<bool, KeychainRefusal> {
        let _held = self.hold().await?;
        let mut items = self.read_items().await?;
        let was_held = items
            .get_mut(service)
            .is_some_and(|entries| entries.remove(account).is_some());
        if was_held {
            self.write_items(&items).await?;
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
                move |answer| {
                    tracing::warn!(
                        service = logged_service,
                        is_answered = answer.is_ok(),
                        "An items file write landed after its caller stopped waiting"
                    );
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

/// One keychain service's items in the daemon's items file; see the module doc. Every failure of
/// the file or the seal refuses the call as the keychain being `unavailable`.
pub(crate) struct FileSecretKeychain {
    /// The items file, shared with every other service's keychain on it.
    items_file: Arc<SecretItemsFile>,
    /// The keychain service the items are filed under.
    service: String,
}

impl SecretKeychain for FileSecretKeychain {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        let items_file = Arc::clone(&self.items_file);
        let (service, account_owned, value) =
            (self.service.clone(), account.to_owned(), value.clone());
        Box::pin(
            self.items_file
                .change_item(&self.service, account, async move {
                    items_file
                        .write_item(&service, &account_owned, &value)
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
                let mut items = self.items_file.read_items().await?;
                items
                    .get_mut(&self.service)
                    .and_then(|entries| entries.remove(account))
            };
            match (stored, &self.items_file.seal) {
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
        let (service, account_owned) = (self.service.clone(), account.to_owned());
        Box::pin(
            self.items_file
                .change_item(&self.service, account, async move {
                    items_file.remove_item(&service, &account_owned).await
                }),
        )
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        Box::pin(async move {
            let _held = self.items_file.hold().await?;
            let items = self.items_file.read_items().await?;
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

/// Whether `key` is weaker than `than`: the system key alone beside a key that holds the security
/// chip.
pub(crate) fn is_weaker(key: SealKey, than: SealKey) -> bool {
    !key.uses_chip() && than.uses_chip()
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
mod tests {
    use std::error::Error;
    use std::sync::Arc;
    use std::time::Duration;

    use rstest::rstest;
    use secrecy::{ExposeSecret, SecretString};
    use sidekicks_contracts::keychain::KeychainRefusalCause;

    use super::SecretItemsFile;
    use crate::credential_store::SecretKeychain;
    use crate::credential_store::seal::TestSeal;

    const SERVICE: &str = "ai-sidekicks-workflow-secrets";
    const OTHER_SERVICE: &str = "ai-sidekicks-notification-secrets";

    // The items file in `folder`, sealed through `seal` or plain.
    fn items_file(
        folder: &tempfile::TempDir,
        seal: Option<&Arc<TestSeal>>,
    ) -> Arc<SecretItemsFile> {
        match seal {
            Some(seal) => SecretItemsFile::sealed(folder.path(), Arc::clone(seal) as _),
            None => SecretItemsFile::new(folder.path()),
        }
    }

    /// A file this run cannot read refuses every call, names none of its values, and is left byte
    /// for byte: one cut short, one with no form (an older build's), and one in the other form,
    /// so a sealed run never serves or rewrites a plain file, nor a plain run a sealed one.
    /// Mutations: read an unparsable or formless file as holding nothing (a write then rewrites
    /// it and every secret is lost); drop the form check (a sealed run then serves plain values).
    #[rstest]
    #[case::cut_short(
        false,
        r#"{"form":"plain","items":{"ai-sidekicks-workflow-secrets":{"secret":"hunter2""#
    )]
    #[case::no_form(false, r#"{"ai-sidekicks-workflow-secrets":{"secret":"hunter2"}}"#)]
    #[case::plain_under_a_sealed_run(
        true,
        r#"{"form":"plain","items":{"ai-sidekicks-workflow-secrets":{"secret":"hunter2"}}}"#
    )]
    #[case::sealed_under_a_plain_run(
        false,
        r#"{"form":"sealed","items":{"ai-sidekicks-workflow-secrets":{"secret":"aHVudGVyMg=="}}}"#
    )]
    #[tokio::test]
    async fn an_unreadable_items_file_refuses_every_call_and_is_left_byte_for_byte(
        #[case] is_sealed: bool,
        #[case] text: &str,
    ) {
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let seal = is_sealed.then(TestSeal::new);
        let items_file = items_file(&folder, seal.as_ref());
        std::fs::write(items_file.file_path(), text).expect("the test writes the file");
        let keychain = items_file.keychain(SERVICE);
        let value = SecretString::from("new-value");

        let refusals = [
            keychain.write("secret", &value).await.err(),
            keychain.read("secret").await.err(),
            keychain.remove("secret").await.err(),
        ];
        for refusal in refusals {
            let refusal = refusal.expect("an unreadable items file refuses the call");
            assert_eq!(refusal.cause(), KeychainRefusalCause::Unavailable);
            let mut chain: Vec<String> = vec![refusal.to_string(), format!("{refusal:?}")];
            let mut source = refusal.source();
            while let Some(failure) = source {
                chain.push(failure.to_string());
                chain.push(format!("{failure:?}"));
                source = failure.source();
            }
            assert!(chain.iter().all(|text| !text.contains("hunter2")));
        }
        assert_eq!(
            std::fs::read(items_file.file_path()).expect("the file is still there"),
            text.as_bytes()
        );
    }

    /// Two services' writes joined on one file are both kept and read back, and a sealed file
    /// holds neither value as written. Mutations: give each keychain its own lock (or none), so
    /// the second write replaces the first's value; keep the value in place of its sealed blob.
    #[rstest]
    #[case::plain(false)]
    #[case::sealed(true)]
    #[tokio::test]
    async fn joined_writes_from_two_services_on_one_file_are_both_kept(#[case] is_sealed: bool) {
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let seal = is_sealed.then(TestSeal::new);
        let items_file = items_file(&folder, seal.as_ref());
        let workflow_secrets = items_file.keychain(SERVICE);
        let other_secrets = items_file.keychain(OTHER_SERVICE);
        let (first, second) = (
            SecretString::from("first-value"),
            SecretString::from("second-value"),
        );

        let (first_write, second_write) = tokio::join!(
            workflow_secrets.write("secret", &first),
            other_secrets.write("secret", &second),
        );
        first_write.expect("the first write is kept");
        second_write.expect("the second write is kept");

        let first_read = workflow_secrets
            .read("secret")
            .await
            .expect("the file reads");
        let second_read = other_secrets.read("secret").await.expect("the file reads");
        assert_eq!(
            first_read.as_ref().map(ExposeSecret::expose_secret),
            Some("first-value")
        );
        assert_eq!(
            second_read.as_ref().map(ExposeSecret::expose_secret),
            Some("second-value")
        );
        let text =
            std::fs::read_to_string(items_file.file_path()).expect("the test reads the file");
        assert_eq!(
            !text.contains("first-value") && !text.contains("second-value"),
            is_sealed
        );
    }

    /// A sealed write held past its caller's time, then a retry with another value: the retry
    /// seals only after the late write lands, so the item holds the retry's value. Mutation: hold
    /// no item from the seal through the file write, so the retry lands first and the late write
    /// overwrites it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_late_seal_lands_before_the_retry_and_never_overwrites_it() {
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let seal = TestSeal::new();
        let keychain = Arc::new(items_file(&folder, Some(&seal)).keychain(SERVICE));
        let release = seal.hold_next_seal();

        let scenario = async {
            let first = SecretString::from("first");
            let late =
                tokio::time::timeout(Duration::from_millis(200), keychain.write("secret", &first));
            let (late, ()) = tokio::join!(late, seal.wait_for_seals(1));
            assert!(late.is_err(), "the held write is given up");
            let retry = tokio::spawn({
                let keychain = Arc::clone(&keychain);
                async move {
                    keychain
                        .write("secret", &SecretString::from("second"))
                        .await
                }
            });
            // Long enough for a retry that took the item to reach the seal.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let seals_before_release = seal.seals();
            drop(release);
            let retry = retry.await.expect("the retry's task ends");
            (retry, seals_before_release)
        };
        let (retry, seals_before_release) = tokio::time::timeout(Duration::from_secs(5), scenario)
            .await
            .expect("every call answers within its time");

        retry.expect("the retry is written once the late write lands");
        assert_eq!(seals_before_release, 1);
        let kept = keychain.read("secret").await.expect("the file reads");
        assert_eq!(
            kept.as_ref().map(ExposeSecret::expose_secret),
            Some("second")
        );
    }

    /// Mutation: skip the leftovers' removal, so a write cut short leaves every value it held on
    /// disk.
    #[tokio::test]
    async fn the_first_call_removes_a_cut_short_writes_leftover() {
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let leftover = folder.path().join("secrets.json.a1b2c3.tmp");
        std::fs::write(&leftover, b"{}").expect("the test writes a leftover");

        let keychain = items_file(&folder, None).keychain(SERVICE);
        let read = keychain
            .read("secret")
            .await
            .expect("a missing file reads as empty");

        assert!(read.is_none());
        assert!(!leftover.exists());
    }
}
