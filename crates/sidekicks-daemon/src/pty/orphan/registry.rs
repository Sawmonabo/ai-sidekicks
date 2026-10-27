//! The durable record of every terminal child this daemon started and has not yet seen end, so a
//! daemon that died without draining them can find and end them at its next start. A child is
//! recorded twice: its intent, made durable before it is started and naming the nonce its
//! environment will carry, then its process once it runs, so no child ever exists outside the
//! record, even when the daemon dies between the two. The file is the one source; every change
//! rewrites it whole, crash-safely, one write at a time.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sidekicks_platforms::ProcessRecord;
use tokio::sync::Mutex;

use sidekicks_std::file::atomic_write::{AtomicWriteError, write_file_atomically};

/// The registry's file name in the data folder.
const ORPHAN_REGISTRY_FILE_NAME: &str = "orphan-registry.json";

/// The environment variable that carries a child's nonce, by which a sweep recognizes it.
pub(crate) const SPAWN_NONCE_ENVIRONMENT_NAME: &str = "SIDEKICKS_SPAWN_NONCE";

// The registry file is the person's alone.
const REGISTRY_FILE_MODE: u32 = 0o600;

/// One child the daemon started: the nonce its environment carries and the boot it was started
/// in, and the process once it runs. An entry with no `child` is an intent whose child may or may
/// not have started.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OrphanRegistryEntry {
    /// The nonce the child's environment carries.
    pub(crate) nonce: String,
    /// The boot the child was started in.
    pub(crate) boot_id: String,
    /// The started child, as a later process re-pins it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) child: Option<ProcessRecord>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryFile {
    entries: Vec<OrphanRegistryEntry>,
}

/// What a previous run left in the file. An unreadable or invalid file yields no entries and the
/// reason, so nothing is signaled on the strength of a file that cannot be trusted.
#[derive(Debug, Default)]
pub(crate) struct OrphanRegistryLeftover {
    /// The entries the file held.
    pub(crate) entries: Vec<OrphanRegistryEntry>,
    /// Why the file could not be trusted, when it could not.
    pub(crate) unreadable_cause: Option<String>,
}

/// Why the registry could not be read or written.
#[derive(Debug, thiserror::Error)]
pub(crate) enum OrphanRegistryError {
    /// The file could not be read.
    #[error("the orphan registry could not be read")]
    Read(#[source] io::Error),
    /// The file could not be written.
    #[error(transparent)]
    Write(#[from] AtomicWriteError),
}

/// The registry over one data folder. It starts empty in memory; the first change, or
/// [`OrphanRegistry::forget`], replaces whatever a previous run left. Each change returns once it
/// is durable on disk, and changes are written one at a time, each with the entries as they are.
pub(crate) struct OrphanRegistry {
    file_path: PathBuf,
    entries: Mutex<Vec<OrphanRegistryEntry>>,
}

impl OrphanRegistry {
    /// The registry in `data_folder`.
    pub(crate) fn new(data_folder: &Path) -> Self {
        Self {
            file_path: data_folder.join(ORPHAN_REGISTRY_FILE_NAME),
            entries: Mutex::default(),
        }
    }

    /// Reads what a previous run left; a missing file leaves nothing. Fails when the file exists
    /// but cannot be read.
    pub(crate) async fn read_leftover(
        &self,
    ) -> Result<OrphanRegistryLeftover, OrphanRegistryError> {
        let text = match tokio::fs::read(&self.file_path).await {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(OrphanRegistryLeftover::default());
            }
            Err(error) => return Err(OrphanRegistryError::Read(error)),
        };
        let unreadable = |cause: String| OrphanRegistryLeftover {
            entries: Vec::new(),
            unreadable_cause: Some(cause),
        };
        let file: RegistryFile = match serde_json::from_slice(&text) {
            Ok(file) => file,
            Err(error) => return Ok(unreadable(format!("its contents are invalid ({error})"))),
        };
        // An empty nonce would match a process whose variable is set to nothing.
        if file
            .entries
            .iter()
            .any(|entry| entry.nonce.is_empty() || entry.boot_id.is_empty())
        {
            return Ok(unreadable("an entry names no nonce or no boot".to_owned()));
        }
        Ok(OrphanRegistryLeftover {
            entries: file.entries,
            unreadable_cause: None,
        })
    }

    /// Replaces what a previous run left with this run's entries, none until a child starts.
    /// Fails when the file cannot be written.
    pub(crate) async fn forget(&self) -> Result<(), OrphanRegistryError> {
        let entries = self.entries.lock().await;
        self.write(&entries).await
    }

    /// Records that a child carrying `nonce` is about to start in the boot `boot_id`; returns
    /// once durable. A failed write forgets the intent, since no child will start under it.
    pub(crate) async fn record_intent(
        &self,
        nonce: &str,
        boot_id: &str,
    ) -> Result<(), OrphanRegistryError> {
        let mut entries = self.entries.lock().await;
        entries.push(OrphanRegistryEntry {
            nonce: nonce.to_owned(),
            boot_id: boot_id.to_owned(),
            child: None,
        });
        let written = self.write(&entries).await;
        if written.is_err() {
            entries.pop();
        }
        written
    }

    /// Records the started child of an intent; an intent already retired stays retired. Fails
    /// when the file cannot be written.
    pub(crate) async fn record_child(
        &self,
        nonce: &str,
        child: ProcessRecord,
    ) -> Result<(), OrphanRegistryError> {
        let mut entries = self.entries.lock().await;
        let Some(entry) = entries.iter_mut().find(|entry| entry.nonce == nonce) else {
            return Ok(());
        };
        entry.child = Some(child);
        self.write(&entries).await
    }

    /// Forgets a child that has ended; retiring one twice changes nothing. Fails when the file
    /// cannot be written.
    pub(crate) async fn retire(&self, nonce: &str) -> Result<(), OrphanRegistryError> {
        let mut entries = self.entries.lock().await;
        let count = entries.len();
        entries.retain(|entry| entry.nonce != nonce);
        if entries.len() == count {
            return Ok(());
        }
        self.write(&entries).await
    }

    async fn write(&self, entries: &[OrphanRegistryEntry]) -> Result<(), OrphanRegistryError> {
        let file = RegistryFile {
            entries: entries.to_vec(),
        };
        let mut contents = serde_json::to_vec(&file).expect("the registry serializes as JSON");
        contents.push(b'\n');
        write_file_atomically(&self.file_path, contents, REGISTRY_FILE_MODE).await?;
        Ok(())
    }
}
