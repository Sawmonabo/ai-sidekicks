//! Where the background service keeps an account's secrets, read from the record in its data
//! folder by a command that cannot ask the service, such as one run under `sudo`.

use std::path::Path;

use anyhow::Context as _;
use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
use sidekicks_contracts::daemon::secrets_place::{
    PlaceRecord, SECRETS_PLACE_RECORD_FILE_NAME, read_place_record,
};

/// The record of where the secrets are in the data folder under `home`, or `None` when the
/// service has recorded none. Fails, naming the file, when it cannot be read or does not parse.
pub(crate) fn read_secrets_place(home: &Path) -> anyhow::Result<Option<PlaceRecord>> {
    let path = home
        .join(DAEMON_DATA_FOLDER_NAME)
        .join(SECRETS_PLACE_RECORD_FILE_NAME);
    read_place_record(&path).with_context(|| {
        format!(
            "could not read where the secrets are kept from {}",
            path.display()
        )
    })
}
