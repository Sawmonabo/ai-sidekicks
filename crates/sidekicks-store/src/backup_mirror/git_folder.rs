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

use sidekicks_platforms::{EntryIdentity, entry_identity, remove_tree, rename_replacing};
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

// Git LFS's folder of stored files, copied with the objects rather than staged as a pointer.
const LFS_FOLDER_NAME: &str = "lfs";

// The extension of a pack's file in `objects/pack`.
const PACK_EXTENSION: &str = "pack";

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

// One entry of a git folder read for its copy: its path under the folder, which entry it is and
// what its stat read.
struct ListedEntry {
    relative: PathBuf,
    identity: EntryIdentity,
    metadata: fs::Metadata,
}

// The files a round staged beside their copies, as paths under the git folder, and each folder
// whose copy is a file, which the round builds beside it and puts in its place only as it places
// the staged files.
#[derive(Default)]
struct StagedPointers {
    files: Vec<PathBuf>,
    replaced_folders: Vec<PathBuf>,
}

impl StagedPointers {
    // Where the copy of `relative` is built under `copy`: inside the folder built beside a
    // replaced folder's copy when it lies in one, else at its place.
    fn building_place(&self, copy: &Path, relative: &Path) -> PathBuf {
        for replaced in &self.replaced_folders {
            if let Ok(rest) = relative.strip_prefix(replaced) {
                return in_progress_path(&copy.join(replaced)).join(rest);
            }
        }
        copy.join(relative)
    }

    // Where the staged copy of the file `relative` waits for its place.
    fn staged_file(&self, copy: &Path, relative: &Path) -> PathBuf {
        in_progress_path(&self.building_place(copy, relative))
    }
}

// How a round of a git folder's copy ended: whole, with its objects' copy; with a ref or an object
// moved meanwhile; or with an index git cannot read.
enum RoundEnd {
    Whole(ObjectsCopy),
    Moved,
    Unread,
}

// What a round's copy of a git folder's objects read: every path it listed, and whether an entry
// was still vanishing at the last read, a pack that vanished with no new one listed after it
// included, as git's `multi-pack-index expire` and a folder being deleted both leave it.
struct ObjectsCopy {
    listed: Vec<PathBuf>,
    is_still_vanishing: bool,
}

impl Leveling<'_> {
    // Copies the git folder `folder` to `copy` whole, in rounds. A round reads the files that name
    // objects (every entry but `objects`, loose refs first and `packed-refs` next, as git reads
    // them) and stages each changed one beside its copy, copies the changed objects under the
    // folder's hold, the loose ones before the packs, places the staged files, and last removes
    // every copy its reads did not list. A held folder has its refs read again once the hold is
    // taken; a folder no hold covers has its files read again before they are placed, and its
    // copied indexes checked against the copy. When a ref moved, an object an index names left
    // the copy's reach or an object was still vanishing at the last read, the round runs again,
    // and after the last one, or when git cannot read an index, nothing is placed or removed and
    // the folder is named skipped. A folder gone at a round's start, once its hold is taken, or
    // when its objects' copy ends no longer a git folder, has its copy removed; a pack that vanished
    // with none to replace it runs the round again, since git removes packs it no longer needs. Each git folder nested among the files (a submodule's) is copied
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
            // A ref moved between its read and the hold could name objects the hold's writer
            // removed meanwhile, so the round runs again.
            let has_refs_moved = hold.is_some() && self.has_refs_moved(folder, &pointers)?;
            let objects = if has_refs_moved {
                None
            } else {
                Some(self.copy_objects(folder, copy)?)
            };
            let is_held = hold.is_some();
            drop(hold);
            let round_end = match objects {
                None => RoundEnd::Moved,
                Some(_) if !is_git_folder(folder) => return self.remove_copy(copy),
                Some(objects) if objects.is_still_vanishing => RoundEnd::Moved,
                Some(objects) if is_held => RoundEnd::Whole(objects),
                Some(objects) => match self.read_round_end(folder, copy, &pointers, &staged)? {
                    CopiedIndexCheck::Whole => RoundEnd::Whole(objects),
                    CopiedIndexCheck::Moved => RoundEnd::Moved,
                    CopiedIndexCheck::Unread => RoundEnd::Unread,
                },
            };
            match round_end {
                RoundEnd::Whole(objects) => {
                    self.place_pointers(copy, &staged)?;
                    self.remove_unlisted(copy, &pointers, &objects.listed, &nested)?;
                    break;
                }
                RoundEnd::Moved if round < ROUNDS => self.discard_staged(copy, &staged)?,
                RoundEnd::Moved | RoundEnd::Unread => {
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

    // Whether a read of `folder`'s refs, its `refs` folder and `packed-refs`, finds one added,
    // gone or changed since `pointers` listed it.
    fn has_refs_moved(&self, folder: &Path, pointers: &[ListedEntry]) -> Result<bool, LevelStop> {
        let starts = [
            Path::new(REFS_FOLDER_NAME),
            Path::new(PACKED_REFS_FILE_NAME),
        ];
        let again = self.list_tree_entries(folder, &starts, &mut Vec::new())?;
        let before: Vec<&ListedEntry> = pointers
            .iter()
            .filter(|entry| starts.iter().any(|start| entry.relative.starts_with(start)))
            .collect();
        Ok(!is_same_listing(&before, &again.iter().collect::<Vec<_>>()))
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
        staged: &StagedPointers,
    ) -> Result<CopiedIndexCheck, LevelStop> {
        let again = self.list_tree_entries(folder, &[Path::new("")], &mut Vec::new())?;
        if !is_same_listing(&compared_entries(pointers), &compared_entries(&again)) {
            return Ok(CopiedIndexCheck::Moved);
        }
        let indexes: Vec<CopiedIndex> = pointers
            .iter()
            .filter(|entry| is_index_file(&entry.relative))
            .map(|entry| CopiedIndex {
                live: folder.join(&entry.relative),
                copied: if staged.files.contains(&entry.relative) {
                    staged.staged_file(copy, &entry.relative)
                } else {
                    copy.join(&entry.relative)
                },
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

    // Removes the folders and files `staged` built beside their copies under `copy`, so the copy
    // stays as the last run left it.
    fn discard_staged(&self, copy: &Path, staged: &StagedPointers) -> Result<(), LevelStop> {
        for relative in &staged.replaced_folders {
            let built = in_progress_path(&copy.join(relative));
            remove_tree(&built)
                .none_if_missing()
                .map_err(|error| self.failed(&built, error))?;
        }
        for relative in &staged.files {
            let in_progress = staged.staged_file(copy, relative);
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
    // turn and, for the folder itself (an empty path), every entry but `objects` and `lfs`, loose
    // refs first and `packed-refs` next as git reads them; git's temporaries and lock files are
    // passed over, and each nested git folder is added to `nested` and not walked.
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
                    ![
                        OBJECTS_FOLDER_NAME,
                        LFS_FOLDER_NAME,
                        REFS_FOLDER_NAME,
                        PACKED_REFS_FILE_NAME,
                    ]
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
        let read = match entry_identity(&path) {
            Ok(read) => read,
            Err(error) if is_missing_entry(&error) => return Ok(()),
            Err(error) => return Err(self.failed(&path, error)),
        };
        let listed = ListedEntry {
            relative: relative.to_path_buf(),
            identity: read.identity,
            metadata: read.metadata,
        };
        if listed.metadata.is_file() {
            entries.push(listed);
        } else if listed.metadata.is_dir() {
            if is_git_folder(&path) {
                nested.push(relative.to_path_buf());
                return Ok(());
            }
            entries.push(listed);
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
    // missing folder made first and a folder whose copy is a file built beside it, so nothing the
    // copy holds changes before the round places its files; one gone since its listing is passed
    // over.
    fn stage_pointers(
        &mut self,
        folder: &Path,
        copy: &Path,
        pointers: &[ListedEntry],
    ) -> Result<StagedPointers, LevelStop> {
        let mut staged = StagedPointers::default();
        for entry in pointers {
            self.check_stop()?;
            let target = staged.building_place(copy, &entry.relative);
            if entry.metadata.is_dir() {
                let copy_metadata = fs::symlink_metadata(&target)
                    .none_if_missing()
                    .map_err(|error| self.failed(&target, error))?;
                let built = match copy_metadata {
                    Some(metadata) if metadata.is_dir() => continue,
                    Some(_file) => {
                        // A run cut short may have left the folder built beside the file.
                        let built = in_progress_path(&target);
                        remove_tree(&built)
                            .none_if_missing()
                            .map_err(|error| self.failed(&built, error))?;
                        staged.replaced_folders.push(entry.relative.clone());
                        built
                    }
                    None => target,
                };
                fs::create_dir_all(&built).map_err(|error| self.failed(&built, error))?;
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
                staged.files.push(entry.relative.clone());
                self.report.copied_files += 1;
                self.report.copied_bytes += entry.metadata.len();
            }
        }
        Ok(staged)
    }

    // Copies the changed entries of the objects folder of `folder` to `copy`, Git LFS's stored
    // files with them, the loose objects and every other entry first and `pack` and `info` last,
    // reading those two again, at most a few times, whenever an entry listed there vanished before
    // its copy, since a repack installs a pack before it removes the ones it replaces.
    fn copy_objects(&mut self, folder: &Path, copy: &Path) -> Result<ObjectsCopy, LevelStop> {
        let objects = Path::new(OBJECTS_FOLDER_NAME);
        self.make_folder(&copy.join(objects))?;
        let mut listed = vec![objects.to_path_buf()];
        let mut nested = Vec::new();
        let mut first: Vec<PathBuf> = self
            .read_names(&folder.join(objects))?
            .into_iter()
            .filter(|name| !LAST_OBJECT_FOLDERS.iter().any(|last| name == last))
            .map(|name| objects.join(name))
            .collect();
        first.push(PathBuf::from(LFS_FOLDER_NAME));
        let first: Vec<&Path> = first.iter().map(PathBuf::as_path).collect();
        let entries = self.list_tree_entries(folder, &first, &mut nested)?;
        self.copy_listed(folder, copy, &entries)?;
        listed.extend(entries.into_iter().map(|entry| entry.relative));
        let last: Vec<PathBuf> = LAST_OBJECT_FOLDERS
            .iter()
            .map(|name| objects.join(name))
            .collect();
        let last: Vec<&Path> = last.iter().map(PathBuf::as_path).collect();
        let mut copied = ObjectsCopy {
            listed,
            is_still_vanishing: false,
        };
        // The packs the read before listed, when one of them vanished before its copy.
        let mut packs_before_vanished: Option<HashSet<PathBuf>> = None;
        for _ in 0..=OBJECT_REREADS {
            let entries = self.list_tree_entries(folder, &last, &mut nested)?;
            #[cfg(test)]
            super::tests::pass_object_listing();
            let packs: HashSet<PathBuf> = entries
                .iter()
                .filter(|entry| is_pack_file(&entry.relative))
                .map(|entry| entry.relative.clone())
                .collect();
            if packs_before_vanished
                .as_ref()
                .is_some_and(|before| packs.is_subset(before))
            {
                // Still vanishing: the round runs again, and a folder being deleted is found gone.
                break;
            }
            let vanished = self.copy_listed(folder, copy, &entries)?;
            copied
                .listed
                .extend(entries.into_iter().map(|entry| entry.relative));
            copied.is_still_vanishing = !vanished.is_empty();
            if !copied.is_still_vanishing {
                break;
            }
            packs_before_vanished = vanished
                .iter()
                .any(|relative| is_pack_file(relative))
                .then_some(packs);
        }
        Ok(copied)
    }

    // Copies each of `entries` under `folder` whose copy under `copy` differs from it, each folder
    // made; answers each that vanished between its listing and its copy.
    fn copy_listed(
        &mut self,
        folder: &Path,
        copy: &Path,
        entries: &[ListedEntry],
    ) -> Result<Vec<PathBuf>, LevelStop> {
        let mut vanished = Vec::new();
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
                    vanished.push(entry.relative.clone());
                }
            }
        }
        Ok(vanished)
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

    // Puts each folder `staged` built beside a file's copy in that file's place, then places each
    // staged file over its copy, a reftable stack's list last, so it never names a table not yet
    // in place.
    fn place_pointers(&self, copy: &Path, staged: &StagedPointers) -> Result<(), LevelStop> {
        for relative in &staged.replaced_folders {
            let target = copy.join(relative);
            fs::remove_file(&target)
                .none_if_missing()
                .map_err(|error| self.failed(&target, error))?;
            fs::rename(in_progress_path(&target), &target)
                .map_err(|error| self.failed(&target, error))?;
        }
        let (lists, tables_and_others): (Vec<&PathBuf>, Vec<&PathBuf>) =
            staged.files.iter().partition(|relative| {
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

    // Removes each copy under `copy` that neither `pointers` nor `objects` listed, the objects
    // folder walked on its own; a nested git folder's copy is its own routine's.
    fn remove_unlisted(
        &mut self,
        copy: &Path,
        pointers: &[ListedEntry],
        objects: &[PathBuf],
        nested: &[PathBuf],
    ) -> Result<(), LevelStop> {
        let listed: HashSet<&Path> = pointers
            .iter()
            .map(|entry| entry.relative.as_path())
            .chain(objects.iter().map(PathBuf::as_path))
            .collect();
        let mut passed_over: Vec<&Path> = nested.iter().map(PathBuf::as_path).collect();
        passed_over.push(Path::new(OBJECTS_FOLDER_NAME));
        self.remove_unlisted_under(copy, copy, &listed, &passed_over)?;
        self.remove_unlisted_under(copy, &copy.join(OBJECTS_FOLDER_NAME), &listed, &[])
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

// Whether two reads of a git folder list the same entries, each the same entry with the same
// length and modification time, compared exactly since both are live readings.
fn is_same_listing(before: &[&ListedEntry], after: &[&ListedEntry]) -> bool {
    before.len() == after.len()
        && before.iter().zip(after).all(|(before, after)| {
            before.relative == after.relative
                && before.identity == after.identity
                && before.metadata.is_dir() == after.metadata.is_dir()
                && (before.metadata.is_dir()
                    || (before.metadata.len() == after.metadata.len()
                        && matches!(
                            (before.metadata.modified(), after.metadata.modified()),
                            (Ok(before), Ok(after)) if before == after
                        )))
        })
}

// Whether `relative`, a path in a git folder, is a pack's file.
fn is_pack_file(relative: &Path) -> bool {
    relative.extension() == Some(OsStr::new(PACK_EXTENSION))
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
