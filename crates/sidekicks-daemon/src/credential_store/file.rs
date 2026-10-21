//! The items kept where the operating system's credential store is not used, on Linux where no
//! Secret Service ran when the place was picked and on a Mac whose service runs while the person is
//! logged out: the daemon's one items file, `secrets.json` in its data folder, readable by this
//! account alone (mode 0600). The file holds each value under its keychain service and account, so
//! every service's items share it, and the values in it are not encrypted. It exists exactly while
//! it holds an item: the write that removes the last one deletes it.
//!
//! Every call reads the disk, so no copy of a value stays in memory past the call, and the calls on
//! one file run one at a time, every service's keychain on it sharing one lock, so two writes never
//! lose each other; another process writes the file only while the daemon is stopped, as the data
//! folder's lock ensures. Each write replaces the whole file at once, and the first call on the
//! file deletes the temporary files a write cut short left behind, since each holds every value.
//! An items file that cannot be read refuses every call and is never rewritten, because rewriting
//! it would lose every secret it holds. The text read and the text written are held in buffers
//! that wipe themselves when dropped.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use secrecy::{ExposeSecret, SecretString};
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use tokio::sync::{Mutex, MutexGuard};
use zeroize::Zeroizing;

use crate::cleanup_failures::CleanupFailures;
use crate::credential_store::{KeychainRefusal, SecretKeychain};
use crate::file::atomic_write::write_file_atomically;
use crate::missing_entry::MissingEntry;

const ITEMS_FILE_NAME: &str = "secrets.json";

const ITEMS_FILE_MODE: u32 = 0o600;

const LEFTOVER_REMOVAL: &str = "removing the leftovers of a write cut short";

// Each keychain service's values, by account.
type Items = BTreeMap<String, BTreeMap<String, SecretString>>;

/// The daemon's one `secrets.json` in its data folder: its path and the lock every call on it
/// holds, whichever service's keychain makes the call. One per data folder, every keychain on the
/// file holding a handle to it.
pub(crate) struct SecretItemsFile {
    /// The file's full path.
    file_path: PathBuf,
    /// Held by each call for its whole read and write; `true` once the leftovers of a write cut
    /// short have been removed.
    calls: Mutex<bool>,
}

impl SecretItemsFile {
    /// The items file in `data_folder`, an absolute path to a folder that exists and only this
    /// account can read, as the daemon makes its data folder at start.
    pub(crate) fn new(data_folder: &Path) -> Arc<Self> {
        Arc::new(Self {
            file_path: data_folder.join(ITEMS_FILE_NAME),
            calls: Mutex::new(false),
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

    // Every service's values in the file, nothing when it does not exist yet. An unreadable file
    // refuses the call and is left as it is.
    async fn read_items(&self) -> Result<Items, KeychainRefusal> {
        let text = match tokio::fs::read(&self.file_path).await.none_if_missing() {
            Ok(Some(text)) => Zeroizing::new(text),
            Ok(None) => return Ok(Items::new()),
            Err(failure) => return Err(file_failure(failure)),
        };
        match serde_json::from_slice(&text) {
            Ok(items) => Ok(items),
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
        let length = json_utf8_byte_length(&exposed).map_err(file_failure)?;
        let mut text = Zeroizing::new(Vec::with_capacity(length));
        serde_json::to_writer(&mut *text, &exposed).map_err(file_failure)?;
        write_file_atomically(&self.file_path, text, ITEMS_FILE_MODE)
            .await
            .map_err(file_failure)
    }
}

/// One keychain service's items in the daemon's items file; see the module doc. Every failure of
/// the file refuses the call as the keychain being `unavailable`.
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
        Box::pin(async move {
            let _held = self.items_file.hold().await?;
            let mut items = self.items_file.read_items().await?;
            items
                .entry(self.service.clone())
                .or_default()
                .insert(account.to_owned(), value.clone());
            self.items_file.write_items(&items).await
        })
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        Box::pin(async move {
            let _held = self.items_file.hold().await?;
            let mut items = self.items_file.read_items().await?;
            Ok(items
                .get_mut(&self.service)
                .and_then(|entries| entries.remove(account)))
        })
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        Box::pin(async move {
            let _held = self.items_file.hold().await?;
            let mut items = self.items_file.read_items().await?;
            let was_held = items
                .get_mut(&self.service)
                .is_some_and(|entries| entries.remove(account).is_some());
            if was_held {
                self.items_file.write_items(&items).await?;
            }
            Ok(was_held)
        })
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

    use secrecy::{ExposeSecret, SecretString};
    use sidekicks_contracts::keychain::KeychainRefusalCause;

    use super::SecretItemsFile;
    use crate::credential_store::SecretKeychain;

    const SERVICE: &str = "ai-sidekicks-workflow-secrets";
    const OTHER_SERVICE: &str = "ai-sidekicks-notification-secrets";

    fn items_file(folder: &tempfile::TempDir) -> Arc<SecretItemsFile> {
        SecretItemsFile::new(folder.path())
    }

    /// Mutation: drop the unreadable-file guard (read an unparsable file as holding nothing), so a
    /// write rewrites the file and every secret in it is lost.
    #[tokio::test]
    async fn an_unreadable_items_file_refuses_every_call_and_is_left_byte_for_byte() {
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let items_file = items_file(&folder);
        let text = b"{\"ai-sidekicks-workflow-secrets\": {\"secret\": \"hunter2\"";
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
            text
        );
    }

    /// Mutation: give each keychain its own lock (or none), so the two writes read the same file
    /// and the second replaces the first's value.
    #[tokio::test]
    async fn joined_writes_from_two_services_on_one_file_are_both_kept() {
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let items_file = items_file(&folder);
        let workflow_secrets = items_file.keychain(SERVICE);
        let other_secrets = items_file.keychain(OTHER_SERVICE);
        let (first, second) = (SecretString::from("first"), SecretString::from("second"));

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
            Some("first")
        );
        assert_eq!(
            second_read.as_ref().map(ExposeSecret::expose_secret),
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

        let keychain = items_file(&folder).keychain(SERVICE);
        let read = keychain
            .read("secret")
            .await
            .expect("a missing file reads as empty");

        assert!(read.is_none());
        assert!(!leftover.exists());
    }
}
