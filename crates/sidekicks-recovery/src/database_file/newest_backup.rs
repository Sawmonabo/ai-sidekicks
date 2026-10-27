//! The newest backup's database copy, where the person keeps backups. Each backup is a folder of
//! the backup folder holding its manifest and its database copy side by side; the newest is the one
//! whose manifest was taken last. A folder whose manifest does not read is no backup.

use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use garde::Validate as _;
use sidekicks_contracts::daemon::backup::{
    BACKUP_DATABASE_FILE_NAME, BACKUP_MANIFEST_FILE_NAME, BackupManifest,
};
use sidekicks_std::missing_entry::MissingEntry as _;
use tracing::warn;

/// Why a backup's manifest could not be read.
#[derive(Debug, thiserror::Error)]
pub enum BackupManifestError {
    /// The file system refused the read.
    #[error("the backup's manifest could not be read")]
    Read(#[source] io::Error),
    /// The manifest is not JSON, or not a manifest.
    #[error("the backup's manifest does not parse")]
    Parse(#[source] serde_json::Error),
    /// The manifest breaks a manifest's rules.
    #[error("the backup's manifest breaks a manifest's rules")]
    Check(#[source] garde::Report),
}

/// The manifest of the backup in `backup_path`, `None` when it has none, read on the calling
/// thread. Fails when the file system refuses the read or the manifest does not parse or check.
pub fn read_backup_manifest(
    backup_path: &Path,
) -> Result<Option<BackupManifest>, BackupManifestError> {
    let Some(manifest_bytes) = fs::read(backup_path.join(BACKUP_MANIFEST_FILE_NAME))
        .none_if_missing()
        .map_err(BackupManifestError::Read)?
    else {
        return Ok(None);
    };
    let manifest: BackupManifest =
        serde_json::from_slice(&manifest_bytes).map_err(BackupManifestError::Parse)?;
    manifest.validate().map_err(BackupManifestError::Check)?;
    Ok(Some(manifest))
}

/// The newest backup's database copy in `backup_folder`, `None` when the folder holds none. A
/// backup whose manifest is missing is passed over, and one whose manifest or time does not read,
/// or that holds no database copy, is passed over and named in the service log; any other
/// file-system failure fails the call. Reads on the calling thread.
pub(crate) fn find_newest_backup_database(backup_folder: &Path) -> io::Result<Option<PathBuf>> {
    let Some(entries) = fs::read_dir(backup_folder).none_if_missing()? else {
        return Ok(None);
    };
    let mut newest: Option<(i64, PathBuf)> = None;
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let backup_path = entry.path();
        let Some(taken_at) = read_taken_at(&backup_path)? else {
            continue;
        };
        if newest
            .as_ref()
            .is_some_and(|(newest_taken_at, _)| taken_at <= *newest_taken_at)
        {
            continue;
        }
        let database_path = backup_path.join(BACKUP_DATABASE_FILE_NAME);
        if !fs::exists(&database_path)? {
            warn!(
                backup = %backup_path.display(),
                "the backup holds no database copy and is passed over"
            );
            continue;
        }
        newest = Some((taken_at, database_path));
    }
    Ok(newest.map(|(_, database_path)| database_path))
}

// When the backup in `backup_path` was taken, in Unix milliseconds by its manifest; `None` when it
// has none that reads.
fn read_taken_at(backup_path: &Path) -> io::Result<Option<i64>> {
    let manifest = match read_backup_manifest(backup_path) {
        Ok(manifest) => manifest,
        Err(BackupManifestError::Read(failure)) => return Err(failure),
        Err(error @ (BackupManifestError::Parse(_) | BackupManifestError::Check(_))) => {
            warn!(
                backup = %backup_path.display(),
                error = &error as &(dyn Error + 'static),
                "the backup's manifest does not read and the backup is passed over"
            );
            return Ok(None);
        }
    };
    let Some(manifest) = manifest else {
        return Ok(None);
    };
    let taken_at = manifest.taken_at.unix_millisecond();
    if taken_at.is_none() {
        warn!(
            backup = %backup_path.display(),
            taken_at = manifest.taken_at.as_str(),
            "the backup's manifest names a time that does not read and the backup is passed over"
        );
    }
    Ok(taken_at)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use serde_json::json;

    use super::find_newest_backup_database;

    // Writes a backup folder named `name`, with `manifest` as its manifest's bytes when given and a
    // database copy when `has_database`.
    fn write_backup(backup_folder: &Path, name: &str, manifest: Option<&[u8]>, has_database: bool) {
        let backup_path = backup_folder.join(name);
        fs::create_dir(&backup_path).expect("the backup's folder is made");
        if let Some(manifest) = manifest {
            fs::write(backup_path.join("manifest.json"), manifest)
                .expect("the manifest is written");
        }
        if has_database {
            fs::write(backup_path.join("daemon.db"), b"SQLite").expect("the copy is written");
        }
    }

    fn manifest(taken_at: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "backupId": "backup",
            "takenAt": taken_at,
            "appVersion": "0.1.0",
            "serviceVersion": "0.1.0",
            "totalBytes": 6,
            "computerName": "Studio",
        }))
        .expect("a JSON value writes")
    }

    #[test]
    fn finds_the_greatest_taken_at_among_the_backups_that_read() {
        let backup_folder = tempfile::tempdir().expect("a scratch folder is made");
        let backups = backup_folder.path();
        write_backup(
            backups,
            "older",
            Some(&manifest("2026-10-01T08:00:00.000Z")),
            true,
        );
        // Newer than every backup that reads, but each is passed over.
        write_backup(
            backups,
            "no-copy",
            Some(&manifest("2026-10-12T08:00:00.000Z")),
            false,
        );
        write_backup(backups, "not-json", Some(b"{"), true);
        write_backup(
            backups,
            "not-a-manifest",
            Some(br#"{"takenAt":"2026-10-12T08:00:00Z"}"#),
            true,
        );
        write_backup(
            backups,
            "bad-time",
            Some(&manifest("2026-02-30T08:00:00.000Z")),
            true,
        );
        write_backup(backups, "no-manifest", None, true);
        fs::write(backups.join("notes.txt"), b"not a backup").expect("the file is written");
        // Two backups taken at the same time: the first one read wins.
        write_backup(
            backups,
            "tie-one",
            Some(&manifest("2026-10-10T08:00:00.000Z")),
            true,
        );
        write_backup(
            backups,
            "tie-two",
            Some(&manifest("2026-10-10T08:00:00+00:00")),
            true,
        );
        let first_tie = fs::read_dir(backups)
            .expect("the backup folder lists")
            .map(|entry| entry.expect("an entry lists").file_name())
            .find(|name| name == "tie-one" || name == "tie-two")
            .expect("both ties are listed");

        assert_eq!(
            find_newest_backup_database(backups).expect("the backup folder reads"),
            Some(backups.join(first_tie).join("daemon.db"))
        );
        assert_eq!(
            find_newest_backup_database(&backups.join("missing"))
                .expect("a missing backup folder reads as none"),
            None
        );
    }
}
