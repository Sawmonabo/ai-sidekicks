//! Where the background service keeps an account's secrets, read from the record in its data
//! folder by a command that cannot ask the service, such as one run under `sudo`.

use std::io;
use std::path::Path;

use anyhow::Context as _;
use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
use sidekicks_contracts::daemon::secrets_place::{PlaceRecord, SECRETS_PLACE_RECORD_FILE_NAME};

/// The record of where the secrets are in the data folder under `home`, or `None` when the
/// service has recorded none. Fails, naming the file, when it cannot be read or does not parse.
pub(crate) fn read_secrets_place(home: &Path) -> anyhow::Result<Option<PlaceRecord>> {
    let path = home
        .join(DAEMON_DATA_FOLDER_NAME)
        .join(SECRETS_PLACE_RECORD_FILE_NAME);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(failure) => {
            return Err(anyhow::Error::new(failure).context(format!(
                "could not read where the secrets are kept from {}",
                path.display()
            )));
        }
    };
    serde_json::from_slice(&bytes).map(Some).with_context(|| {
        format!(
            "{} does not read as where the secrets are kept",
            path.display()
        )
    })
}
