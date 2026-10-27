//! The secrets file as the status read reports it: its path, how its secrets are protected, why a
//! Linux plain file is plain and, while the sealed file cannot be opened, why. The read waits for
//! no call: it takes the run's view of the place and reads the file without its lock.

use sidekicks_contracts::daemon::status::{DaemonSecretsFile, DaemonSecretsFileUnopened};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_platforms::SealKey;

use super::SecretItems;
use super::state::PlaceView;
use crate::credential_store::KeychainRefusal;
use crate::credential_store::file::{ItemsForm, ItemsSnapshot};
use crate::credential_store::place::{self, SecretsPlace};
use crate::credential_store::service::KeychainService;

impl SecretItems {
    /// The items file for the status read: its path, how its secrets are protected, why a Linux
    /// plain file is plain and, while the sealed file cannot be opened, why. `None` while the
    /// secrets are in the operating system's store or the file holds no item a move would carry.
    /// Calls no seal, opens no item and waits for no call; a file that cannot be read counts as
    /// holding one. Fails with the path's [`TextError`] when the file's path is no wire path.
    pub async fn secrets_file(&self) -> Result<Option<DaemonSecretsFile>, TextError> {
        let moved_services: Vec<&str> = KeychainService::ALL
            .into_iter()
            .filter(|service| service.is_moved())
            .map(KeychainService::as_str)
            .collect();
        let PlaceView {
            picked,
            cannot_open,
        } = PlaceView::read(&self.view);
        let place = match picked {
            Some(place) => Some(place),
            None => match place::read_record(&self.record_path).await {
                Ok(Some(record)) => Some(record.place),
                Ok(None) => None,
                Err(_unreadable) => None,
            },
        };
        let snapshot = self.items_file.snapshot(&moved_services).await;
        let is_sealed = match place {
            Some(SecretsPlace::OperatingSystem) => return Ok(None),
            Some(SecretsPlace::SealedFile) => true,
            Some(SecretsPlace::PlainFile { .. } | SecretsPlace::LoggedOutServiceFile) => false,
            None => matches!(&snapshot, Ok(Some(file)) if file.form == ItemsForm::Sealed),
        };
        let path =
            || FilesystemPath::new(self.items_file.file_path().to_string_lossy().into_owned());
        if is_sealed {
            let Some(is_sealed_with_chip) = is_sealed_with_chip(&snapshot, cannot_open) else {
                return Ok(None);
            };
            let path = path()?;
            return Ok(Some(if is_sealed_with_chip {
                DaemonSecretsFile::SealedWithChip { path, cannot_open }
            } else {
                DaemonSecretsFile::SealedWithSystemKey { path, cannot_open }
            }));
        }
        if !holds_items(&snapshot) {
            return Ok(None);
        }
        let reason = match place {
            Some(SecretsPlace::PlainFile { reason }) => Some(reason),
            Some(
                SecretsPlace::OperatingSystem
                | SecretsPlace::SealedFile
                | SecretsPlace::LoggedOutServiceFile,
            )
            | None => None,
        };
        Ok(Some(DaemonSecretsFile::Plain {
            path: path()?,
            reason,
        }))
    }
}

// Whether the file holds an item; one that cannot be read counts as holding one, since it may.
fn holds_items(snapshot: &Result<Option<ItemsSnapshot>, KeychainRefusal>) -> bool {
    match snapshot {
        Ok(Some(file)) => !file.keys.is_empty(),
        Ok(None) => false,
        Err(_unreadable) => true,
    }
}

// Whether every item of the sealed file is sealed with the chip, the weakest key any of them names
// deciding, a key the daemon does not know or a file that cannot be read counting as the system
// key; `None` while it holds no item and opens.
fn is_sealed_with_chip(
    snapshot: &Result<Option<ItemsSnapshot>, KeychainRefusal>,
    cannot_open: Option<DaemonSecretsFileUnopened>,
) -> Option<bool> {
    let keys = match snapshot {
        Ok(Some(file)) => Some(file.keys.as_slice()),
        Ok(None) => Some([].as_slice()),
        Err(_unreadable) => None,
    };
    match keys {
        Some(keys) if keys.is_empty() && cannot_open.is_none() => None,
        Some(keys) => {
            Some(!keys.is_empty() && keys.iter().all(|key| key.is_some_and(SealKey::uses_chip)))
        }
        None => Some(false),
    }
}
