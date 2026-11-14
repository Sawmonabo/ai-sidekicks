//! The places the mirror keeps, listed afresh at each run: the machine's settings file, the chats'
//! managed workspaces, the agent memory folder, the artifact store, whose payloads the restored
//! database names, every session's storage folder, with its checkpoint copies and capture folders,
//! each conversation folder its provider's descriptor names in every account home the app manages
//! and in each provider's switching home, the clones each session kept on another volume, copied
//! from that volume while it is mounted and restored as plain copies into the data folder, and each
//! workflow run's capture folders. No root is wider than what it keeps, since a restore removes
//! from a place whatever its copy lacks.

use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::account::homes::{
    account_home_conversation_folders, read_account_homes, switching_homes,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_session::checkpoints::store::shadows::{VolumeFolder, every_volume_folder};
use sidekicks_session::checkpoints::volume_folders::{
    VolumeFolderState, read_volume_folder_state, restored_clone_folder,
};
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_std::scheduler::budget::run_blocking;
use sidekicks_store::backup_mirror::{MirrorRoot, MirrorRootError};
use sidekicks_store::data_folder::{
    agent_memory_folder, data_folder, read_workflow_run_folders, session_storage_root,
};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_workspace::git::turn_snapshot::capture_folder::CAPTURES_SEGMENT;
use sidekicks_workspace::managed::service::managed_workspaces_folder;

use crate::daemon::artifact_methods::ARTIFACTS_FOLDER_NAME;
use crate::daemon::backup::run::MirrorRootsReader;
use crate::daemon::machine_settings::file::machine_settings_file_path;

/// A place the mirror would keep that is no root under the home folder.
#[derive(Debug, thiserror::Error)]
#[error("the kept place {} is refused", place.display())]
struct KeptPlaceRefused {
    place: PathBuf,
    #[source]
    source: MirrorRootError,
}

/// Why the sessions' folders on other volumes could not be read for the mirror.
#[derive(Debug, thiserror::Error)]
enum VolumeCloneFoldersReadError {
    /// The read pool did not run the read.
    #[error("the read pool did not read the sessions' folders on other volumes")]
    Pool(#[from] DatabaseReadError),
    /// SQLite refused the read, or a stored column does not read as its type.
    #[error("the sessions' folders on other volumes could not be read")]
    Query(#[from] rusqlite::Error),
}

/// Lists, at each run, the places the mirror keeps under `home_folder`, the accounts and the
/// sessions' folders on other volumes read through `reads`, each account's conversation folders
/// from its provider's descriptor in `providers`. The listing fails when the accounts or the
/// folders cannot be read, when the folders' state reads do not finish, or with
/// [`io::ErrorKind::InvalidData`] naming a place that is not under `home_folder`.
pub(crate) fn mirror_roots_reader(
    home_folder: PathBuf,
    reads: Arc<DatabaseReadPool>,
    providers: Arc<ProviderRegistry>,
) -> MirrorRootsReader {
    Arc::new(move || {
        let home_folder = home_folder.clone();
        let reads = Arc::clone(&reads);
        let providers = Arc::clone(&providers);
        async move { read_mirror_roots(&home_folder, &reads, &providers).await }.boxed()
    })
}

async fn read_mirror_roots(
    home_folder: &Path,
    reads: &DatabaseReadPool,
    providers: &ProviderRegistry,
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
        ("sessions".to_owned(), session_storage_root(&data_folder)),
    ];
    for account_home in read_account_homes(reads).await.map_err(io::Error::other)? {
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
    for switching_home in switching_homes(providers, &data_folder) {
        for (components, folder) in account_home_conversation_folders(
            providers,
            &switching_home.provider,
            &switching_home.home,
        ) {
            let name = format!(
                "switching-{}-{}",
                switching_home.provider,
                components.join("-")
            );
            places.push((name, folder));
        }
    }
    let mut roots = places
        .into_iter()
        .map(|(name, place)| {
            MirrorRoot::under_home(name, home_folder, &place)
                .map_err(|source| refused(place, source))
        })
        .collect::<io::Result<Vec<_>>>()?;
    let volume_folders = reads
        .read(ReadLength::Short, |connection| {
            every_volume_folder(connection).map_err(VolumeCloneFoldersReadError::from)
        })
        .await
        .map_err(io::Error::other)?;
    let read_data_folder = data_folder.clone();
    let volume_folders = run_blocking(move || {
        volume_folders
            .into_iter()
            .map(|(session_id, volume_folder)| {
                let restored =
                    restored_clone_folder(&read_data_folder, &session_id, &volume_folder.volume_id);
                let state = read_volume_folder_state(&volume_folder).and_then(|state| {
                    let is_restored_present =
                        fs::symlink_metadata(&restored).none_if_missing()?.is_some();
                    Ok((state, is_restored_present))
                });
                (session_id, volume_folder, restored, state)
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(io::Error::other)?;
    for (session_id, volume_folder, restored, state) in volume_folders {
        let (state, is_restored_present) = match state {
            Ok((state, is_restored_present)) => (Some(state), is_restored_present),
            Err(error) => {
                tracing::warn!(
                    folder = volume_folder.folder.as_str(),
                    error = &error as &(dyn Error + 'static),
                    "a session's folder on another volume could not be read, so its copy is kept"
                );
                (None, false)
            }
        };
        let root = volume_clone_root(
            home_folder,
            &data_folder,
            &session_id,
            &volume_folder,
            state,
            is_restored_present,
        )
        .map_err(|source| refused(restored, source))?;
        roots.push(root);
    }
    let workflows_home = home_folder.to_path_buf();
    let workflows_data_folder = data_folder.clone();
    let workflow_roots =
        run_blocking(move || workflow_capture_roots(&workflows_home, &workflows_data_folder))
            .await
            .map_err(io::Error::other)??;
    roots.extend(workflow_roots);
    Ok(roots)
}

// One root per workflow run's folder in `data_folder` that holds a captures folder, named for its
// workflow and its run, its place that captures folder alone, since the run's folder and the
// workflows' folder also hold the run's working files and each version's packages. Blocking.
fn workflow_capture_roots(home: &Path, data_folder: &Path) -> io::Result<Vec<MirrorRoot>> {
    let mut roots = Vec::new();
    for run in read_workflow_run_folders(data_folder)? {
        let captures = run.folder.join(CAPTURES_SEGMENT);
        if fs::symlink_metadata(&captures).none_if_missing()?.is_none() {
            continue;
        }
        let name = format!("workflow-captures-{}-{}", run.definition, run.run);
        let root = MirrorRoot::under_home(name, home, &captures)
            .map_err(|source| refused(captures, source))?;
        roots.push(root);
    }
    Ok(roots)
}

// The listing's failure for `place`, which `source` refused as a root.
fn refused(place: PathBuf, source: MirrorRootError) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        KeptPlaceRefused { place, source },
    )
}

// The root of the clones `session_id` kept in `volume_folder`, restored into its folder in
// `data_folder`: copied from the volume folder while it is there, else from the restored copy
// where one exists, else kept as the last run left it, as when `state` is `None`, a failed read.
fn volume_clone_root(
    home: &Path,
    data_folder: &Path,
    session_id: &SessionId,
    volume_folder: &VolumeFolder,
    state: Option<VolumeFolderState>,
    is_restored_present: bool,
) -> Result<MirrorRoot, MirrorRootError> {
    let place = restored_clone_folder(data_folder, session_id, &volume_folder.volume_id);
    let volume_name = place
        .file_name()
        .and_then(OsStr::to_str)
        .expect("a restored clone folder ends in its volume's hex name");
    let name = format!(
        "restored-clones-{}-{volume_name}",
        session_id.text().as_str()
    );
    let root = MirrorRoot::under_home(name, home, &place)?;
    Ok(match state {
        Some(VolumeFolderState::Mounted { is_present: true }) => {
            root.copied_from(PathBuf::from(volume_folder.folder.as_str()))
        }
        Some(_) if is_restored_present => root,
        Some(_) | None => root.kept_as_is(),
    })
}

#[cfg(test)]
mod tests;
