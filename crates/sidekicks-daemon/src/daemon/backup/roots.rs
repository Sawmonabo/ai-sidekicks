//! The places the mirror keeps, listed afresh at each run: the machine's settings file, the chats'
//! managed workspaces, the agent memory folder, the artifact store, whose payloads the restored
//! database names, and each conversation folder its provider's descriptor names in every account
//! home the app manages. No root is wider than what it keeps, since a restore removes from a
//! place whatever its copy lacks.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::FutureExt as _;

use crate::daemon::artifact_methods::ARTIFACTS_FOLDER_NAME;
use crate::daemon::backup::run::MirrorRootsReader;
use crate::daemon::machine::settings::file::machine_settings_file_path;
use sidekicks_provider::account_homes::{account_home_conversation_folders, read_account_homes};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::backup_mirror::{MirrorRoot, MirrorRootError};
use sidekicks_store::data_folder::{agent_memory_folder, data_folder};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_workspace::managed::service::managed_workspaces_folder;

/// A place the mirror would keep that is no root under the home folder.
#[derive(Debug, thiserror::Error)]
#[error("the kept place {} is refused", place.display())]
struct KeptPlaceRefused {
    place: PathBuf,
    #[source]
    source: MirrorRootError,
}

/// Lists, at each run, the places the mirror keeps under `home_folder`, the accounts read through
/// `reads` and charged to the run's meter, each account's conversation folders from its
/// provider's descriptor in `providers`. The listing fails when the accounts cannot be read, or
/// with [`io::ErrorKind::InvalidData`] naming a place that is not under `home_folder`.
pub(crate) fn mirror_roots_reader(
    home_folder: PathBuf,
    reads: Arc<DatabaseReadPool>,
    providers: Arc<ProviderRegistry>,
) -> MirrorRootsReader {
    Arc::new(move |meter| {
        let home_folder = home_folder.clone();
        let reads = Arc::clone(&reads);
        let providers = Arc::clone(&providers);
        async move { read_mirror_roots(&home_folder, &reads, &providers, &meter).await }.boxed()
    })
}

async fn read_mirror_roots(
    home_folder: &Path,
    reads: &DatabaseReadPool,
    providers: &ProviderRegistry,
    meter: &ProcessorMeter,
) -> io::Result<Vec<MirrorRoot>> {
    let data_folder = data_folder(home_folder);
    let mut places = vec![
        (
            "machine-settings".to_owned(),
            machine_settings_file_path(home_folder),
        ),
        (
            "workspaces".to_owned(),
            managed_workspaces_folder(home_folder),
        ),
        ("agent-memory".to_owned(), agent_memory_folder(&data_folder)),
        (
            "artifacts".to_owned(),
            data_folder.join(ARTIFACTS_FOLDER_NAME),
        ),
    ];
    for account_home in read_account_homes(reads, meter)
        .await
        .map_err(io::Error::other)?
    {
        for (components, folder) in
            account_home_conversation_folders(providers, &account_home.provider, &account_home.home)
        {
            let name = format!(
                "account-{}-{}",
                account_home.account_id,
                components.join("-")
            );
            places.push((name, folder));
        }
    }
    places
        .into_iter()
        .map(|(name, place)| {
            MirrorRoot::under_home(name, home_folder, &place).map_err(|source| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    KeptPlaceRefused { place, source },
                )
            })
        })
        .collect()
}
