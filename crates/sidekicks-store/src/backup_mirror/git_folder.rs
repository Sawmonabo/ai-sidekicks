//! The copy of one git folder: the files that name objects read and staged first, the objects
//! copied under the folder's hold, the staged files placed, and only then the copies the reads did
//! not list removed, so a copy cut short anywhere holds refs over a superset of their objects. A
//! folder no hold covers places its files only once a second read finds its refs unchanged and its
//! copied indexes name nothing that left the copy's reach, since git moves an object by writing its
//! new place first and deletes one outright only once nothing names it.

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use sidekicks_platforms::{remove_tree, rename_replacing};
use sidekicks_std::missing_entry::{MissingEntry as _, is_missing_entry};
use walkdir::WalkDir;

use super::{
    CopiedIndex, CopiedIndexCheck, LevelStop, Leveling, copy_when_changed, in_progress_path,
    is_in_progress_name, is_unchanged_copy, write_in_progress,
};

// The names git gives a git folder's parts.
const HEAD_FILE_NAME: &str = "HEAD";
const OBJECTS_FOLDER_NAME: &str = "objects";
const REFS_FOLDER_NAME: &str = "refs";
const PACKED_REFS_FILE_NAME: &str = "packed-refs";

// The reftable stack's list, placed after the tables it names.
const REFTABLE_LIST_FILE_NAME: &str = "tables.list";

// The parts of an objects folder copied last and read again when an entry vanished.
const LAST_OBJECT_FOLDERS: [&str; 2] = ["pack", "info"];

// How many times `pack` and `info` are read again after an entry vanished before its copy.
const OBJECT_REREADS: usize = 3;

// How many rounds a git folder no hold covers runs before it keeps its last copy.
const ROUNDS: usize = 3;

// The index's file, and the start of a split index's shared file's name, in a git folder and in
// each linked worktree's folder.
const INDEX_FILE_NAME: &str = "index";
const SHARED_INDEX_PREFIX: &str = "sharedindex.";

// The folder in a git folder that holds each linked worktree's own files.
const WORKTREES_FOLDER_NAME: &str = "worktrees";

// One entry of a git folder read for its copy: its path under the folder and what its stat read.
struct ListedEntry {
    relative: PathBuf,
    metadata: fs::Metadata,
}

impl Leveling<'_> {
    // Copies the git folder `folder` to `copy` whole, in rounds. A round reads the files that name
    // objects (every entry but `objects`, loose refs first and `packed-refs` next, as git reads
    // them) and stages each changed one beside its copy, copies the changed objects under the
    // folder's hold, the loose ones before the packs, places the staged files, and last removes
    // every copy its reads did not list. A folder no hold covers has its files read again before
    // they are placed, and its copied indexes checked against the copy; when a ref moved or an
    // object an index names left the copy's reach the round runs again, and after the last one,
    // or when git cannot read an index, nothing is placed or removed and the folder is named
    // skipped. A folder gone at a round's start, once its hold is taken, or when its objects' copy
    // ends has its copy removed. Each git folder nested among the files (a submodule's) is copied
    // after by a routine of its own.
    pub(super) fn copy_git_folder(&mut self, folder: &Path, copy: &Path) -> Result<(), LevelStop> {
        let mut nested = Vec::new();
        for round in 1..=ROUNDS {
            if !self.is_present(folder)? {
                return self.remove_copy(copy);
            }
            self.make_folder(copy)?;
            nested.clear();
            let pointers = self.list_tree_entries(folder, &[Path::new("")], &mut nested)?;
            let staged = self.stage_pointers(folder, copy, &pointers)?;
            let git_folders = self.git_folders;
            let hold = git_folders.hold(folder, self.stop)?;
            if hold.is_some() && !self.is_present(folder)? {
                return self.remove_copy(copy);
            }
            let objects = self.copy_objects(folder, copy)?;
            let is_gone = !self.is_present(folder)?;
            let is_held = hold.is_some();
            drop(hold);
            if is_gone {
                return self.remove_copy(copy);
            }
            let round_end = if is_held {
                CopiedIndexCheck::Whole
            } else {
                self.read_round_end(folder, copy, &pointers, &staged)?
            };
            match round_end {
                CopiedIndexCheck::Whole => {
                    self.place_pointers(copy, &staged)?;
                    self.remove_unlisted(copy, &pointers, &objects, &nested)?;
                    break;
                }
                CopiedIndexCheck::Moved if round < ROUNDS => self.discard_staged(copy, &staged)?,
                CopiedIndexCheck::Moved | CopiedIndexCheck::Unread => {
                    self.discard_staged(copy, &staged)?;
                    self.report.skipped_folders.push(folder.to_path_buf());
                    break;
                }
            }
        }
        for relative in nested {
            self.copy_git_folder(&folder.join(&relative), &copy.join(&relative))?;
        }
        Ok(())
    }

    // How a round of `folder`, which no hold covers, ended: `Moved` when a second read of its files
    // finds one added, gone or changed since `pointers` listed it, an index aside, which git
    // rewrites at will; else what the check of its copied indexes against the copy found, each
    // index's copy the file `staged` holds for it or the copy's own.
    fn read_round_end(
        &mut self,
        folder: &Path,
        copy: &Path,
        pointers: &[ListedEntry],
        staged: &[PathBuf],
    ) -> Result<CopiedIndexCheck, LevelStop> {
        let again = self.list_tree_entries(folder, &[Path::new("")], &mut Vec::new())?;
        let (before, after) = (compared_entries(pointers), compared_entries(&again));
        let is_changed = before.len() != after.len()
            || before.iter().zip(&after).any(|(before, after)| {
                before.relative != after.relative
                    || before.metadata.is_dir() != after.metadata.is_dir()
                    || (before.metadata.is_file()
                        && !is_unchanged_copy(&after.metadata, &before.metadata, self.precision))
            });
        if is_changed {
            return Ok(CopiedIndexCheck::Moved);
        }
        let indexes: Vec<CopiedIndex> = pointers
            .iter()
            .filter(|entry| is_index_file(&entry.relative))
            .map(|entry| {
                let target = copy.join(&entry.relative);
                CopiedIndex {
                    live: folder.join(&entry.relative),
                    copied: if staged.contains(&entry.relative) {
                        in_progress_path(&target)
                    } else {
                        target
                    },
                }
            })
            .collect();
        let git_folders = self.git_folders;
        Ok(git_folders.check_copied_indexes(
            folder,
            &copy.join(OBJECTS_FOLDER_NAME),
            &indexes,
            self.stop,
        )?)
    }

    // Removes the files `staged` left beside their copies under `copy`, so the copy stays as the
    // last run left it.
    fn discard_staged(&self, copy: &Path, staged: &[PathBuf]) -> Result<(), LevelStop> {
        for relative in staged {
            let in_progress = in_progress_path(&copy.join(relative));
            fs::remove_file(&in_progress)
                .none_if_missing()
                .map_err(|error| self.failed(&in_progress, error))?;
        }
        Ok(())
    }

    // Whether `path` is there.
    fn is_present(&self, path: &Path) -> Result<bool, LevelStop> {
        Ok(fs::symlink_metadata(path)
            .none_if_missing()
            .map_err(|error| self.failed(path, error))?
            .is_some())
    }

    // Removes `copy`, when it is there.
    fn remove_copy(&mut self, copy: &Path) -> Result<(), LevelStop> {
        let copy_metadata = fs::symlink_metadata(copy)
            .none_if_missing()
            .map_err(|error| self.failed(copy, error))?;
        match copy_metadata {
            Some(metadata) => self.remove(copy, metadata.is_dir()),
            None => Ok(()),
        }
    }

    // Makes the folder `copy`, a file in its place removed first.
    fn make_folder(&self, copy: &Path) -> Result<(), LevelStop> {
        let copy_metadata = fs::symlink_metadata(copy)
            .none_if_missing()
            .map_err(|error| self.failed(copy, error))?;
        if copy_metadata.is_some_and(|metadata| !metadata.is_dir()) {
            fs::remove_file(copy).map_err(|error| self.failed(copy, error))?;
        }
        fs::create_dir_all(copy).map_err(|error| self.failed(copy, error))
    }

    // The entries under `folder` a git folder's copy lists, each of `starts` (paths under it) in
    // turn and, for the folder itself (an empty path), every entry but `objects`, loose refs first
    // and `packed-refs` next as git reads them; git's temporaries and lock files are passed over,
    // and each nested git folder is added to `nested` and not walked.
    fn list_tree_entries(
        &self,
        folder: &Path,
        starts: &[&Path],
        nested: &mut Vec<PathBuf>,
    ) -> Result<Vec<ListedEntry>, LevelStop> {
        let mut entries = Vec::new();
        for start in starts {
            if start.as_os_str().is_empty() {
                let mut names = vec![
                    OsString::from(REFS_FOLDER_NAME),
                    PACKED_REFS_FILE_NAME.into(),
                ];
                names.extend(self.read_names(folder)?.into_iter().filter(|name| {
                    ![OBJECTS_FOLDER_NAME, REFS_FOLDER_NAME, PACKED_REFS_FILE_NAME]
                        .iter()
                        .any(|leading| name == leading)
                }));
                for name in names {
                    self.list_tree(folder, Path::new(&name), &mut entries, nested)?;
                }
            } else {
                self.list_tree(folder, start, &mut entries, nested)?;
            }
        }
        Ok(entries)
    }

    // Adds the entry `relative` under `folder` to `entries`, and each entry under it after it, when
    // it is a file or a folder and not one git writes on its way; one gone is passed over.
    fn list_tree(
        &self,
        folder: &Path,
        relative: &Path,
        entries: &mut Vec<ListedEntry>,
        nested: &mut Vec<PathBuf>,
    ) -> Result<(), LevelStop> {
        self.check_stop()?;
        if relative.file_name().is_some_and(is_passed_over_name) {
            return Ok(());
        }
        let path = folder.join(relative);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if is_missing_entry(&error) => return Ok(()),
            Err(error) => return Err(self.failed(&path, error)),
        };
        if metadata.is_file() {
            entries.push(ListedEntry {
                relative: relative.to_path_buf(),
                metadata,
            });
        } else if metadata.is_dir() {
            if is_git_folder(&path) {
                nested.push(relative.to_path_buf());
                return Ok(());
            }
            entries.push(ListedEntry {
                relative: relative.to_path_buf(),
                metadata,
            });
            for name in self.read_names(&path)? {
                self.list_tree(folder, &relative.join(name), entries, nested)?;
            }
        }
        Ok(())
    }

    // The names in `folder` in order, a reftable stack's list after the tables it names; a folder
    // gone holds none.
    fn read_names(&self, folder: &Path) -> Result<Vec<OsString>, LevelStop> {
        let mut names = Vec::new();
        let Some(listing) = fs::read_dir(folder)
            .none_if_missing()
            .map_err(|error| self.failed(folder, error))?
        else {
            return Ok(names);
        };
        for entry in listing {
            names.push(
                entry
                    .map_err(|error| self.failed(folder, error))?
                    .file_name(),
            );
        }
        names.sort_by(|left, right| {
            (left == REFTABLE_LIST_FILE_NAME, left).cmp(&(right == REFTABLE_LIST_FILE_NAME, right))
        });
        Ok(names)
    }

    // Stages each file of `pointers` whose copy under `copy` differs from it beside that copy, each
    // folder made first, and answers the staged files' paths; one gone since its listing is
    // passed over.
    fn stage_pointers(
        &mut self,
        folder: &Path,
        copy: &Path,
        pointers: &[ListedEntry],
    ) -> Result<Vec<PathBuf>, LevelStop> {
        let mut staged = Vec::new();
        for entry in pointers {
            self.check_stop()?;
            let target = copy.join(&entry.relative);
            if entry.metadata.is_dir() {
                self.make_folder(&target)?;
                continue;
            }
            let copy_metadata = fs::symlink_metadata(&target)
                .none_if_missing()
                .map_err(|error| self.failed(&target, error))?;
            if copy_metadata
                .is_some_and(|copied| is_unchanged_copy(&copied, &entry.metadata, self.precision))
            {
                continue;
            }
            let source = folder.join(&entry.relative);
            let written = entry.metadata.modified().and_then(|modified| {
                write_in_progress(&source, &in_progress_path(&target), modified, |from, to| {
                    fs::copy(from, to)
                })
            });
            if self.is_copied(&source, &target, written)? {
                staged.push(entry.relative.clone());
                self.report.copied_files += 1;
                self.report.copied_bytes += entry.metadata.len();
            }
        }
        Ok(staged)
    }

    // Copies the changed entries of the objects folder of `folder` to `copy`, the loose objects
    // and every other entry first and `pack` and `info` last, reading those two again, at most a
    // few times, whenever an entry listed there vanished before its copy, since a repack installs
    // a pack before it removes the ones it replaces. Answers every path listed.
    fn copy_objects(&mut self, folder: &Path, copy: &Path) -> Result<Vec<PathBuf>, LevelStop> {
        let objects = Path::new(OBJECTS_FOLDER_NAME);
        self.make_folder(&copy.join(objects))?;
        let mut listed = vec![objects.to_path_buf()];
        let mut nested = Vec::new();
        let first: Vec<PathBuf> = self
            .read_names(&folder.join(objects))?
            .into_iter()
            .filter(|name| !LAST_OBJECT_FOLDERS.iter().any(|last| name == last))
            .map(|name| objects.join(name))
            .collect();
        let first: Vec<&Path> = first.iter().map(PathBuf::as_path).collect();
        let entries = self.list_tree_entries(folder, &first, &mut nested)?;
        self.copy_listed(folder, copy, &entries)?;
        listed.extend(entries.into_iter().map(|entry| entry.relative));
        let last: Vec<PathBuf> = LAST_OBJECT_FOLDERS
            .iter()
            .map(|name| objects.join(name))
            .collect();
        let last: Vec<&Path> = last.iter().map(PathBuf::as_path).collect();
        for _ in 0..=OBJECT_REREADS {
            let entries = self.list_tree_entries(folder, &last, &mut nested)?;
            let has_vanished = self.copy_listed(folder, copy, &entries)?;
            listed.extend(entries.into_iter().map(|entry| entry.relative));
            if !has_vanished {
                break;
            }
        }
        Ok(listed)
    }

    // Copies each of `entries` under `folder` whose copy under `copy` differs from it, each folder
    // made; answers whether one vanished between its listing and its copy.
    fn copy_listed(
        &mut self,
        folder: &Path,
        copy: &Path,
        entries: &[ListedEntry],
    ) -> Result<bool, LevelStop> {
        let mut has_vanished = false;
        for entry in entries {
            self.check_stop()?;
            let target = copy.join(&entry.relative);
            if entry.metadata.is_dir() {
                self.make_folder(&target)?;
                continue;
            }
            let source = folder.join(&entry.relative);
            let copied =
                fs::symlink_metadata(&target)
                    .none_if_missing()
                    .and_then(|copy_metadata| {
                        copy_when_changed(
                            &source,
                            &entry.metadata,
                            &target,
                            copy_metadata.as_ref(),
                            self.precision,
                        )
                    });
            match copied {
                Ok(false) => {}
                Ok(true) => {
                    self.report.copied_files += 1;
                    self.report.copied_bytes += entry.metadata.len();
                }
                Err(error) => {
                    if self.is_present(&source)? {
                        return Err(self.failed(&target, error));
                    }
                    has_vanished = true;
                }
            }
        }
        Ok(has_vanished)
    }

    // Whether a write of `source`'s copy toward `target` that answered `written` copied it: a
    // failure whose source is gone since passes it over, any other fails.
    fn is_copied(
        &self,
        source: &Path,
        target: &Path,
        written: io::Result<()>,
    ) -> Result<bool, LevelStop> {
        match written {
            Ok(()) => Ok(true),
            Err(error) if self.is_present(source)? => Err(self.failed(target, error)),
            Err(_gone) => Ok(false),
        }
    }

    // Places each staged file of `staged` (paths under `copy`) over its copy, a reftable stack's
    // list last, so it never names a table not yet in place.
    fn place_pointers(&self, copy: &Path, staged: &[PathBuf]) -> Result<(), LevelStop> {
        let (lists, tables_and_others): (Vec<&PathBuf>, Vec<&PathBuf>) =
            staged.iter().partition(|relative| {
                relative.file_name() == Some(OsStr::new(REFTABLE_LIST_FILE_NAME))
            });
        for relative in tables_and_others.into_iter().chain(lists) {
            let target = copy.join(relative);
            if fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.is_dir()) {
                remove_tree(&target).map_err(|error| self.failed(&target, error))?;
            }
            rename_replacing(&in_progress_path(&target), &target)
                .map_err(|error| self.failed(&target, error))?;
        }
        Ok(())
    }

    // Removes each copy under `copy` that `pointers` did not list, then each under its objects
    // folder that `objects` did not list; a nested git folder's copy is its own routine's.
    fn remove_unlisted(
        &mut self,
        copy: &Path,
        pointers: &[ListedEntry],
        objects: &[PathBuf],
        nested: &[PathBuf],
    ) -> Result<(), LevelStop> {
        let pointer_paths: HashSet<&Path> = pointers
            .iter()
            .map(|entry| entry.relative.as_path())
            .collect();
        let mut passed_over: Vec<&Path> = nested.iter().map(PathBuf::as_path).collect();
        passed_over.push(Path::new(OBJECTS_FOLDER_NAME));
        self.remove_unlisted_under(copy, copy, &pointer_paths, &passed_over)?;
        let object_paths: HashSet<&Path> = objects.iter().map(PathBuf::as_path).collect();
        self.remove_unlisted_under(copy, &copy.join(OBJECTS_FOLDER_NAME), &object_paths, &[])
    }

    // Removes each entry under `start`, a folder in `copy`, whose path under `copy` is not in
    // `listed`, never walking into one of `passed_over`.
    fn remove_unlisted_under(
        &mut self,
        copy: &Path,
        start: &Path,
        listed: &HashSet<&Path>,
        passed_over: &[&Path],
    ) -> Result<(), LevelStop> {
        let mut walk = WalkDir::new(start).min_depth(1).into_iter();
        while let Some(entry) = walk.next() {
            self.check_stop()?;
            let entry = entry.map_err(|failure| self.walk_failed(start, failure))?;
            let relative = entry
                .path()
                .strip_prefix(copy)
                .expect("the walk stays under its root");
            let is_folder = entry.file_type().is_dir();
            if passed_over.contains(&relative) {
                if is_folder {
                    walk.skip_current_dir();
                }
                continue;
            }
            if listed.contains(relative) {
                continue;
            }
            if is_folder {
                walk.skip_current_dir();
            }
            self.remove(entry.path(), is_folder)?;
        }
        Ok(())
    }
}

// Whether an entry named `name` is on its way and is never copied: git's temporary (`tmp_…`,
// `.tmp-…`) or lock file, or the mirror's own copy on its way.
fn is_passed_over_name(name: &OsStr) -> bool {
    let bytes = name.as_encoded_bytes();
    bytes.starts_with(b"tmp_")
        || bytes.starts_with(b".tmp-")
        || bytes.ends_with(b".lock")
        || is_in_progress_name(name)
}

// Whether `folder` is a git folder by git's own rule, without its read of `HEAD`'s text: it holds
// a `HEAD` file, an `objects` folder and a `refs` folder. A stat that fails reads as no git folder,
// and the plain copy then meets the failure itself.
pub(super) fn is_git_folder(folder: &Path) -> bool {
    let is = |name: &str, is_kind: fn(&fs::Metadata) -> bool| {
        fs::symlink_metadata(folder.join(name)).is_ok_and(|metadata| is_kind(&metadata))
    };
    is(HEAD_FILE_NAME, fs::Metadata::is_file)
        && is(OBJECTS_FOLDER_NAME, fs::Metadata::is_dir)
        && is(REFS_FOLDER_NAME, fs::Metadata::is_dir)
}

// The entries of `entries` a second read compares, every one but an index's parts.
fn compared_entries(entries: &[ListedEntry]) -> Vec<&ListedEntry> {
    entries
        .iter()
        .filter(|entry| !is_index_part(&entry.relative))
        .collect()
}

// Whether `relative`, a path in a git folder, is a part of an index git reads there: the index
// file, or a split index's shared file, in the folder or in a linked worktree's folder.
fn is_index_part(relative: &Path) -> bool {
    relative.file_name().is_some_and(|name| {
        name == INDEX_FILE_NAME
            || name
                .as_encoded_bytes()
                .starts_with(SHARED_INDEX_PREFIX.as_bytes())
    }) && is_index_level(relative)
}

// Whether `relative`, a path in a git folder, is an index git reads there.
fn is_index_file(relative: &Path) -> bool {
    relative.file_name() == Some(OsStr::new(INDEX_FILE_NAME)) && is_index_level(relative)
}

// Whether `relative` lies where git keeps an index: in the git folder itself, or in a linked
// worktree's folder.
fn is_index_level(relative: &Path) -> bool {
    let folders: Vec<Component<'_>> = relative
        .parent()
        .map(|parent| parent.components().collect())
        .unwrap_or_default();
    match folders.as_slice() {
        [] => true,
        [Component::Normal(worktrees), Component::Normal(_)] => *worktrees == WORKTREES_FOLDER_NAME,
        _ => false,
    }
}
