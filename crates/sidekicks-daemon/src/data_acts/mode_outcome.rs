//! What the modes of the daemon's own program that act on the data folder with the service stopped
//! share, each failure answered as the mode's outcome: the run on the home folder's data folder,
//! the hold on that folder, the secret items of the person's login session, a keychain that cannot
//! be used, a step that failed before the mode changed anything, and the outcome's one JSON line.

use std::collections::BTreeMap;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use sidekicks_contracts::daemon::data::DaemonDataStoreUnavailableDetails;
use sidekicks_contracts::daemon::mode_outcome::DaemonModeOutcome;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_ipc::domain_error::refusal_fields;
use sidekicks_platforms::{create_private_folder, secret_store_offer};
use sidekicks_std::error_description::describe_error;
use sidekicks_std::standard_error::write_error_line;
use sidekicks_std::standard_output::write_json_line;
use sidekicks_store::credential_store::KeychainRefusal;
use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
use sidekicks_store::credential_store::os::{KEYCHAIN_CALL_TIMEOUT, SystemCredentialStore};
use sidekicks_store::data_folder::data_folder;
use sidekicks_store::data_folder::lock::{DataFolderLock, DataFolderLockError};

/// The folders a mode acts on: the person's home folder and the data folder in it.
pub(crate) struct ModeFolders {
    /// The person's home folder.
    pub(crate) home_folder: PathBuf,
    /// The daemon's data folder in it.
    pub(crate) data_folder: PathBuf,
}

/// Runs `act` on the home folder and its data folder on a runtime of the mode's own, then writes
/// its outcome on standard output. Exits 0 with a result and 1 with an error, or when the outcome
/// cannot be written, that failure on standard error; `mode` names the mode in a failure.
pub(crate) fn run_data_folder_mode<Act>(
    mode: &str,
    act: impl FnOnce(ModeFolders) -> Act,
) -> ExitCode
where
    Act: Future<Output = DaemonModeOutcome<()>>,
{
    let outcome = match std::env::home_dir() {
        None => DaemonModeOutcome::failed(format!("the {mode} found no home folder")),
        Some(home) => match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime.block_on(act(ModeFolders {
                data_folder: data_folder(&home),
                home_folder: home,
            })),
            Err(failure) => not_started(&format!("the {mode}'s runtime did not start"), &failure),
        },
    };
    write_mode_outcome(mode, &outcome)
}

/// Writes `outcome` on standard output as one JSON line. Exits 0 with a result and 1 with an
/// error, or when the outcome cannot be written, that failure on standard error; `mode` names the
/// mode in that failure.
pub(crate) fn write_mode_outcome(mode: &str, outcome: &DaemonModeOutcome<()>) -> ExitCode {
    let exit_code = match outcome {
        DaemonModeOutcome::Result(()) => ExitCode::SUCCESS,
        DaemonModeOutcome::Error(_) => ExitCode::FAILURE,
    };
    if let Err(failure) = write_json_line(outcome) {
        write_error_line(&format!(
            "the {mode}'s outcome could not be written: {}",
            describe_error(&failure)
        ));
        return ExitCode::FAILURE;
    }
    exit_code
}

/// Makes `data_folder` when it is missing and takes its lock. Fails with `daemon.dataFolder.held`
/// while a service or another mode holds it, and with an internal error naming the step otherwise.
pub(crate) async fn hold_data_folder(
    data_folder: &Path,
) -> Result<DataFolderLock, DaemonModeOutcome<()>> {
    let locked_folder = data_folder.to_path_buf();
    tokio::task::spawn_blocking(move || {
        create_private_folder(&locked_folder).map_err(|failure| {
            not_started(
                &format!(
                    "the data folder {} could not be made",
                    locked_folder.display()
                ),
                &failure,
            )
        })?;
        DataFolderLock::take(&locked_folder).map_err(|failure| match failure {
            DataFolderLockError::Held(held) => held.mode_refusal(),
            DataFolderLockError::Lock { .. } | DataFolderLockError::RecordProcessId { .. } => {
                not_started("the data folder could not be held", &failure)
            }
        })
    })
    .await
    .unwrap_or_else(|ended| {
        Err(not_started(
            "the data folder's lock was not taken",
            &io::Error::other(ended),
        ))
    })
}

/// The secret items of `data_folder` in the system's store, as the person's login session reaches
/// them, since every such mode runs from the person's own command line. Fails with an internal
/// error when the system gives no random bytes.
pub(crate) fn login_session_secret_items(
    data_folder: PathBuf,
) -> Result<Arc<SecretItems>, DaemonModeOutcome<()>> {
    SecretItems::new(SecretItemsStart {
        data_folder,
        runs_while_logged_out: false,
        access: Arc::new(SystemCredentialStore {
            offer: secret_store_offer(),
        }),
        call_timeout: KEYCHAIN_CALL_TIMEOUT,
    })
    .map_err(|failure| not_started("the secrets could not be reached", &failure))
}

/// The refusal of a keychain the mode cannot use: the socket's `daemon.data.storeUnavailable`, with
/// the keychain's cause as its field.
pub(crate) fn store_unavailable(refusal: KeychainRefusal) -> DaemonModeOutcome<()> {
    let message = describe_error(&refusal);
    let (cause, _failure) = refusal.into_cause_and_failure();
    keychain_unavailable(cause, message)
}

/// `daemon.data.storeUnavailable` with `cause` as its field and `message` as its text.
pub(crate) fn keychain_unavailable(
    cause: KeychainRefusalCause,
    message: String,
) -> DaemonModeOutcome<()> {
    let fields: BTreeMap<String, AnyValue> =
        refusal_fields(DaemonDataStoreUnavailableDetails { cause })
            .into_iter()
            .map(|(name, value)| (name, AnyValue(value)))
            .collect();
    DaemonModeOutcome::refused(RefusalCode::DaemonDataStoreUnavailable, message, fields)
}

/// A failure before the mode changed anything, naming the `step` that failed.
pub(crate) fn not_started(step: &str, failure: &(dyn Error + 'static)) -> DaemonModeOutcome<()> {
    DaemonModeOutcome::failed(format!("{step}: {}", describe_error(failure)))
}
