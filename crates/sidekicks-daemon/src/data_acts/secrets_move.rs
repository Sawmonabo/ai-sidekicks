//! The modes that move the daemon's own secrets between the login keychain and the items file of a
//! Mac's service running while the person is logged out, run from the person's login session.
//!
//! - **`secrets move files|keychain`** holds the data folder's lock, so it is refused while a
//!   service runs, and moves every item into the place it names, each written, read back and then
//!   deleted from its source, the place record naming the move until the last delete. A move
//!   stopped partway finishes in the same direction at the next start.
//! - **`secrets check keychain`** takes no lock and changes nothing the service keeps: it writes,
//!   reads back and deletes one value under an account of its own, so it runs while the service
//!   that runs while the person is logged out holds the folder.
//!
//! Each installs no log and answers one JSON object on its standard output.

use std::path::PathBuf;
use std::process::ExitCode;

use sidekicks_contracts::daemon::mode_outcome::DaemonModeOutcome;
use sidekicks_contracts::daemon::secrets_place::SecretsMoveDestination;

use crate::data_acts::mode_outcome::{
    hold_data_folder, login_session_secret_items, run_data_folder_mode, store_unavailable,
    write_mode_outcome,
};

/// Runs `secrets move <destination>`. Exits 0 once every item is in the place `destination`
/// names; exits 1 with `daemon.dataFolder.held` while the data folder is held,
/// `daemon.data.storeUnavailable` when a place refuses or the secrets sit outside the pair, an
/// internal error for a word no destination has, or, when the outcome cannot be written, that
/// failure on standard error.
pub(crate) fn run_secrets_move_mode(destination: &str) -> ExitCode {
    let Some(destination) = SecretsMoveDestination::from_word(destination) else {
        return write_mode_outcome(
            "move",
            &DaemonModeOutcome::failed(format!("the secrets have no place named {destination}")),
        );
    };
    run_data_folder_mode("move", move |data_folder| {
        move_secrets(data_folder, destination)
    })
}

/// Runs `secrets check keychain`, holding no lock. Exits 0 once the login keychain took, gave back
/// and deleted a value; exits 1 with `daemon.data.storeUnavailable` when it refused or kept another
/// value, or, when the outcome cannot be written, that failure on standard error.
pub(crate) fn run_keychain_check_mode() -> ExitCode {
    run_data_folder_mode("check", |data_folder| async move {
        let secret_items = match login_session_secret_items(data_folder) {
            Ok(secret_items) => secret_items,
            Err(outcome) => return outcome,
        };
        match secret_items
            .check_destination(SecretsMoveDestination::OperatingSystem)
            .await
        {
            Ok(()) => DaemonModeOutcome::Result(()),
            Err(refusal) => store_unavailable(refusal),
        }
    })
}

// Holds `data_folder` and moves the secrets into `destination` under that hold.
async fn move_secrets(
    data_folder: PathBuf,
    destination: SecretsMoveDestination,
) -> DaemonModeOutcome<()> {
    let _lock = match hold_data_folder(&data_folder).await {
        Ok(lock) => lock,
        Err(outcome) => return outcome,
    };
    let secret_items = match login_session_secret_items(data_folder) {
        Ok(secret_items) => secret_items,
        Err(outcome) => return outcome,
    };
    match secret_items.move_to(destination).await {
        Ok(()) => DaemonModeOutcome::Result(()),
        Err(refusal) => store_unavailable(refusal),
    }
}
