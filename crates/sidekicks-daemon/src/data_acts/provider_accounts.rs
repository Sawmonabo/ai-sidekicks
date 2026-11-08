//! The provider accounts a mode acts on with the service stopped: their homes, read on a database
//! connection of the mode's own, the homes an erase deletes, and the bundle their providers'
//! helper-mode legs read.

use std::error::Error;
use std::io;
use std::path::Path;
use std::sync::Arc;

use sidekicks_platforms::Spawner;
use sidekicks_provider::account::homes::{
    AccountHome, HomeToErase, homes_to_erase, query_account_homes,
};
use sidekicks_provider::command_search::ProviderCommandSearch;
use sidekicks_provider::driver::{HelperModeServices, PROVIDERS};
use sidekicks_provider::spawn_environment::ReservedEnvironmentNames;
use sidekicks_store::database::connection::setup::open_database_reader;
use sidekicks_store::database::connection::writer_open::DAEMON_DATABASE_FILE_NAME;
use tokio::runtime::Handle;
use tokio::task::JoinError;
use tokio_util::sync::CancellationToken;

use crate::daemon::login_shell_environment::capture_provider_base_environment;
use crate::data_acts::mode_outcome::ModeFolders;

// The one statement the read of the account homes prepares.
const ACCOUNT_HOMES_STATEMENTS: usize = 1;

/// Why a mode could not reach the provider accounts or what their legs read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ModeAccountsError {
    /// The accounts table, or the marks kept beside the homes, could not be read.
    #[error("the provider accounts could not be read")]
    Read(#[source] Box<dyn Error + Send + Sync>),
    /// The read ended before it answered.
    #[error("the provider accounts were not read")]
    ReadEnded(#[source] JoinError),
    /// The thread the providers' processes start on did not start.
    #[error("the providers' spawner did not start")]
    Spawner(#[source] io::Error),
    /// The login shell's environment could not be read.
    #[error("the providers' environment could not be read")]
    Environment(#[source] io::Error),
}

/// Every account home the accounts table in `data_folder` lists, read on a connection of the
/// mode's own; none when the daemon never made its database. Fails when the table cannot be read.
pub(crate) async fn read_account_homes(
    data_folder: &Path,
) -> Result<Vec<AccountHome>, ModeAccountsError> {
    let database_path = data_folder.join(DAEMON_DATABASE_FILE_NAME);
    tokio::task::spawn_blocking(
        move || -> Result<Vec<AccountHome>, Box<dyn Error + Send + Sync>> {
            if !database_path.try_exists()? {
                return Ok(Vec::new());
            }
            let connection = open_database_reader(&database_path, ACCOUNT_HOMES_STATEMENTS)?;
            Ok(query_account_homes(&connection)?)
        },
    )
    .await
    .map_err(ModeAccountsError::ReadEnded)?
    .map_err(ModeAccountsError::Read)
}

/// Every home an erase of `data_folder` deletes, as [`homes_to_erase`] reads them: the rows the
/// accounts table lists, none when the daemon never made its database, and the marked homes, read
/// either way. Fails when the table or the marks cannot be read.
pub(crate) async fn read_homes_to_erase(
    data_folder: &Path,
) -> Result<Vec<HomeToErase>, ModeAccountsError> {
    let data_folder = data_folder.to_path_buf();
    tokio::task::spawn_blocking(
        move || -> Result<Vec<HomeToErase>, Box<dyn Error + Send + Sync>> {
            let database_path = data_folder.join(DAEMON_DATABASE_FILE_NAME);
            let rows = if database_path.try_exists()? {
                let connection = open_database_reader(&database_path, ACCOUNT_HOMES_STATEMENTS)?;
                query_account_homes(&connection)?
            } else {
                Vec::new()
            };
            Ok(homes_to_erase(rows, &data_folder)?)
        },
    )
    .await
    .map_err(ModeAccountsError::ReadEnded)?
    .map_err(ModeAccountsError::Read)
}

/// What the providers' helper-mode legs read: a spawner of their own on the mode's runtime, the
/// folders, the base environment every provider process starts from, captured from the login
/// shell as a start captures it, and the names every provider sets, so each process on an account
/// home starts as a session's on that home does. Fails when the spawner does not start or the
/// environment cannot be read.
pub(crate) async fn helper_mode_services(
    folders: &ModeFolders,
) -> Result<HelperModeServices, ModeAccountsError> {
    let spawner = Spawner::new(Handle::current()).map_err(ModeAccountsError::Spawner)?;
    let base_environment = capture_provider_base_environment(
        &spawner,
        &folders.home_folder,
        &CancellationToken::new(),
    )
    .await
    .map_err(ModeAccountsError::Environment)?;
    Ok(HelperModeServices {
        command_search: Arc::new(ProviderCommandSearch::new(spawner.clone())),
        spawner,
        data_folder: folders.data_folder.clone(),
        home_folder: folders.home_folder.clone(),
        base_environment: Arc::from(base_environment),
        reserved_names: Arc::new(ReservedEnvironmentNames::of_providers(PROVIDERS)),
    })
}
