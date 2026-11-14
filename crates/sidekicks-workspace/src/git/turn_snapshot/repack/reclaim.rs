//! The reclaim of a deleted run's objects from a capture folder that stays. A prune marks the
//! folder before it deletes the run's refs, one empty file per run in `reclaims/`, and the next
//! sweep pass repacks the folder, with nothing attached, from every capture the store still holds
//! there: every ref the folder holds, the points its caller hands it and each kept index's
//! entries. A pack written or touched within the hour is left as it is, since a capture under way
//! may have found an object in it; the marks go once the folder holds nothing outside that set.

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_platforms::create_private_folder;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_std::scheduler::budget::run_blocking;
use tokio::time::Instant;

use super::answers::read_object_ids;
use super::leftovers::STALE_LEFTOVER_AGE;
use super::{
    CapturePacking, FOLD_TIMEOUT, PACK_EXTENSION, PACK_INDEX_EXTENSION,
    PACK_REVERSE_INDEX_EXTENSION, PACK_SEGMENT, PACK_SIZE_LIMIT_PIN, PATH_WALK_PIN, PackingError,
    SnapshotPoint, pack_name_base,
};
use crate::git::cat_file::object_lines;
use crate::git::process::GitCall;
use crate::git::turn_snapshot::capture::CORE_FSYNC_PIN;
use crate::git::turn_snapshot::capture_folder::{
    CaptureFolder, INDEXES_SEGMENT, OBJECTS_SEGMENT, in_git_folder, is_scratch_index_file_name,
};
use crate::git::turn_snapshot::capture_steps::joined;
use crate::git::turn_snapshot::refs::build_run_snapshot_ref_prefix;
use crate::git::turn_snapshot::retention::RunContextKey;

/// The folder in a capture folder holding one empty file per run whose refs a prune deletes from
/// it and whose objects a sweep has yet to reclaim, each named for the run's key.
const RECLAIMS_SEGMENT: &str = "reclaims";

/// The name prefix an old pack takes while the reclaim checks it is untouched before removing it:
/// a `tmp_` name, which the leftovers' clearing removes an hour on should the daemon stop between.
const RECLAIM_PACK_PREFIX: &str = "tmp_reclaim_";

/// One pack of the folder, by its data file, and when it was last written.
struct FolderPack {
    /// The pack's `.pack` file.
    data_file: PathBuf,
    /// Its modified time when listed.
    modified: SystemTime,
}

/// The commits a reclaim keeps beside the folder's refs and kept indexes: the points recorded on
/// its repository, and every other commit its owner's windows recorded.
pub(super) struct ReclaimKept<'a> {
    pub(super) points: &'a [SnapshotPoint],
    pub(super) commits: &'a [GitObjectId],
}

impl CapturePacking {
    /// Marks the capture folder of the owner whose folder is `owner_folder`, for the repository
    /// whose common git folder is `common_folder`, as holding the objects of run `run_key`, whose
    /// refs are about to be deleted there, so the next sweep pass reclaims them; an owner with no
    /// capture folder there has nothing to mark. Fails as the file system does.
    pub async fn mark_reclaim_due(
        &self,
        owner_folder: &Path,
        common_folder: &Path,
        run_key: RunContextKey,
    ) -> io::Result<()> {
        let Some(capture_folder) =
            CaptureFolder::open_existing(self, owner_folder, common_folder).await?
        else {
            return Ok(());
        };
        let reclaims = capture_folder.folder().join(RECLAIMS_SEGMENT);
        joined(
            tokio::task::spawn_blocking(move || {
                create_private_folder(&reclaims)?;
                fs::write(reclaims.join(run_key.to_string()), b"")
            })
            .await,
        )
    }

    /// The marks of the capture folder `folder` whose run has no ref left under its prefix, the
    /// ones a reclaim is due for; a mark whose run still has refs waits for its prune's delete,
    /// and a mark whose name is no run key is due. Fails as listing the marks or git does.
    pub(super) async fn read_due_marks(
        &self,
        place: Option<&Place>,
        folder: &Path,
        _hold: &KeyHold<'_, PathBuf>,
    ) -> Result<Vec<PathBuf>, PackingError> {
        let reclaims = folder.join(RECLAIMS_SEGMENT);
        let marks = joined(run_blocking(move || list_marks(&reclaims)).await)
            .map_err(PackingError::Folder)?;
        let mut due = Vec::new();
        for (mark, name) in marks {
            let run_key = name
                .to_str()
                .and_then(|name| name.parse::<RunContextKey>().ok());
            let has_refs = match run_key {
                Some(run_key) => {
                    let prefix = build_run_snapshot_ref_prefix(run_key);
                    let arguments = in_git_folder(
                        folder,
                        &[],
                        &[
                            "for-each-ref",
                            "--count=1",
                            "--format=%(refname)",
                            prefix.as_str(),
                        ],
                    );
                    let output = self.git.run(place, GitCall::read(arguments)).await?;
                    !output.stdout.is_empty()
                }
                None => false,
            };
            if !has_refs {
                due.push(mark);
            }
        }
        Ok(due)
    }

    /// Repacks the capture folder `folder`, with nothing attached, from what its refs, the commits
    /// `kept` names and its kept indexes reach, dropping every pack older than an hour that
    /// held anything else, then removes `due_marks` once the folder holds nothing outside that
    /// set. Every git call shares one fold's time bound. Fails with the step's failure, the marks
    /// kept.
    pub(super) async fn reclaim(
        &self,
        place: Option<&Place>,
        folder: &Path,
        kept: &ReclaimKept<'_>,
        due_marks: &[PathBuf],
        _hold: &KeyHold<'_, PathBuf>,
    ) -> Result<(), PackingError> {
        let started = Instant::now();
        let kept = self.read_kept_objects(place, folder, kept, started).await?;
        let pack_folder = folder.join(OBJECTS_SEGMENT).join(PACK_SEGMENT);
        let listed_folder = pack_folder.clone();
        let packs = joined(run_blocking(move || list_packs(&listed_folder)).await)
            .map_err(PackingError::Folder)?;
        let cutoff = SystemTime::now()
            .checked_sub(STALE_LEFTOVER_AGE)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        // A pack written or touched within the hour may hold what a capture whose row or ref
        // lands after the reads above relies on.
        let older: Vec<FolderPack> = packs
            .into_iter()
            .filter(|pack| pack.modified <= cutoff)
            .collect();
        let mut is_dropping = false;
        for pack in &older {
            let index = pack.data_file.with_extension(PACK_INDEX_EXTENSION);
            let index_bytes = joined(run_blocking(move || fs::read(index)).await)
                .map_err(PackingError::Folder)?;
            let arguments = in_git_folder(folder, &[], &["show-index"]);
            let output = self
                .git
                .run_within(
                    place,
                    GitCall::read(arguments).with_input(index_bytes),
                    remaining(started),
                )
                .await?;
            if read_show_index(&output.stdout)?
                .iter()
                .any(|object| !kept.contains(object))
            {
                is_dropping = true;
                break;
            }
        }
        if is_dropping {
            let mut arguments = in_git_folder(
                folder,
                &[&CORE_FSYNC_PIN, &PACK_SIZE_LIMIT_PIN, &PATH_WALK_PIN],
                &["pack-objects", "-q", "--non-empty"],
            );
            arguments.push(pack_name_base(folder));
            let call = GitCall::read(arguments).with_input(object_lines(&kept));
            let output = self.git.run_within(place, call, remaining(started)).await?;
            let new_pack = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            joined(run_blocking(move || remove_old_packs(&pack_folder, older, &new_pack)).await)
                .map_err(PackingError::Folder)?;
            self.prune_packed(place, folder).await?;
        }
        let arguments = in_git_folder(
            folder,
            &[],
            &[
                "cat-file",
                "--batch-all-objects",
                "--batch-check=%(objectname)",
                "--unordered",
            ],
        );
        let output = self
            .git
            .run_within(place, GitCall::read(arguments), remaining(started))
            .await?;
        // A fresh pack, or a capture under way, may still hold what the deleted run alone reached;
        // the marks stay for the next pass then.
        let is_reclaimed = read_object_ids(&output.stdout, "cat-file")?
            .iter()
            .all(|object| kept.contains(object));
        if is_reclaimed {
            let marks = due_marks.to_vec();
            joined(run_blocking(move || remove_marks(&marks)).await)
                .map_err(PackingError::Folder)?;
        }
        Ok(())
    }

    // Every object of `folder` its refs, the commits `kept` names and its kept indexes reach, the
    // folder alone attached, so what the captures borrow from the repository is left out; a
    // commit the folder lacks is skipped.
    async fn read_kept_objects(
        &self,
        place: Option<&Place>,
        folder: &Path,
        kept: &ReclaimKept<'_>,
        started: Instant,
    ) -> Result<HashSet<GitObjectId>, PackingError> {
        const LISTING: [&str; 5] = [
            "rev-list",
            "--objects",
            "--no-object-names",
            "--no-walk",
            "--missing=allow-any",
        ];
        let mut arguments = LISTING.to_vec();
        arguments.extend(["--all", "--stdin"]);
        let commits = object_lines(
            kept.points
                .iter()
                .map(|point| &point.commit)
                .chain(kept.commits),
        );
        let call = GitCall::read(in_git_folder(folder, &[], &arguments)).with_input(commits);
        let output = self.git.run_within(place, call, remaining(started)).await?;
        let mut kept: HashSet<GitObjectId> = read_object_ids(&output.stdout, "rev-list")?
            .into_iter()
            .collect();
        let indexes = folder.join(INDEXES_SEGMENT);
        let kept_indexes = joined(run_blocking(move || list_kept_indexes(&indexes)).await)
            .map_err(PackingError::Folder)?;
        // A command capture under way reuses its kept index's entries without writing them again.
        let mut arguments = LISTING.to_vec();
        arguments.extend(["--indexed-objects", "--stdin"]);
        for index in kept_indexes {
            let call = GitCall::read(in_git_folder(folder, &[], &arguments))
                .with_environment("GIT_INDEX_FILE", index)
                .with_input(Vec::new());
            let output = self.git.run_within(place, call, remaining(started)).await?;
            kept.extend(read_object_ids(&output.stdout, "rev-list")?);
        }
        Ok(kept)
    }
}

// What is left of the fold's bound since `started`.
fn remaining(started: Instant) -> std::time::Duration {
    FOLD_TIMEOUT.saturating_sub(started.elapsed())
}

// The ids `show-index` lists in `stdout`, the second field of each line.
fn read_show_index(stdout: &[u8]) -> Result<Vec<GitObjectId>, PackingError> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            line.split(' ')
                .nth(1)
                .and_then(|id| GitObjectId::new(id.to_owned()))
                .ok_or(PackingError::UnreadableAnswer {
                    command: "show-index",
                    reason: "a line does not name an object id second",
                })
        })
        .collect()
}

// Each mark in `reclaims` with its name; none when the folder is missing. Blocking.
fn list_marks(reclaims: &Path) -> io::Result<Vec<(PathBuf, OsString)>> {
    let Some(entries) = fs::read_dir(reclaims).none_if_missing()? else {
        return Ok(Vec::new());
    };
    entries
        .map(|entry| entry.map(|entry| (entry.path(), entry.file_name())))
        .collect()
}

// Each kept index in `indexes`: a file with no extension that is no scratch index. Blocking.
fn list_kept_indexes(indexes: &Path) -> io::Result<Vec<PathBuf>> {
    let Some(entries) = fs::read_dir(indexes).none_if_missing()? else {
        return Ok(Vec::new());
    };
    let mut kept = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_none()
            && !is_scratch_index_file_name(&entry.file_name())
            && entry.file_type()?.is_file()
        {
            kept.push(path);
        }
    }
    Ok(kept)
}

// Each `pack-*.pack` in `pack_folder` with its modified time. Blocking.
fn list_packs(pack_folder: &Path) -> io::Result<Vec<FolderPack>> {
    let Some(entries) = fs::read_dir(pack_folder).none_if_missing()? else {
        return Ok(Vec::new());
    };
    let mut packs = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let is_pack = entry.file_name().to_str().is_some_and(|name| {
            name.starts_with(&format!("{PACK_SEGMENT}-"))
                && path
                    .extension()
                    .is_some_and(|extension| extension == PACK_EXTENSION)
        });
        if is_pack {
            packs.push(FolderPack {
                modified: entry.metadata()?.modified()?,
                data_file: path,
            });
        }
    }
    Ok(packs)
}

// Removes each of `older` but the pack `new_pack` names: its data file is first renamed to a
// temporary name and its time read again, and a pack a capture touched since it was listed is
// renamed back and kept; once renamed, a capture's touch of it fails and git writes that object
// loose. Blocking.
fn remove_old_packs(pack_folder: &Path, older: Vec<FolderPack>, new_pack: &str) -> io::Result<()> {
    let new_pack_name = format!("{PACK_SEGMENT}-{new_pack}.{PACK_EXTENSION}");
    for pack in older {
        let Some(name) = pack.data_file.file_name() else {
            continue;
        };
        if name.to_str() == Some(new_pack_name.as_str()) {
            continue;
        }
        let mut renamed_name = OsString::from(RECLAIM_PACK_PREFIX);
        renamed_name.push(name);
        let renamed = pack_folder.join(renamed_name);
        fs::rename(&pack.data_file, &renamed)?;
        if fs::metadata(&renamed)?.modified()? != pack.modified {
            fs::rename(&renamed, &pack.data_file)?;
            continue;
        }
        fs::remove_file(pack.data_file.with_extension(PACK_INDEX_EXTENSION))?;
        fs::remove_file(pack.data_file.with_extension(PACK_REVERSE_INDEX_EXTENSION))
            .none_if_missing()?;
        fs::remove_file(&renamed)?;
    }
    Ok(())
}

// Removes each of `marks`; one already gone is none. Blocking.
fn remove_marks(marks: &[PathBuf]) -> io::Result<()> {
    for mark in marks {
        fs::remove_file(mark).none_if_missing()?;
    }
    Ok(())
}
