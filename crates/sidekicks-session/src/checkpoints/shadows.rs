//! The shadows of files over 10 MiB, which are never hashed: each is a copy-on-write clone of the
//! file, taken from the open file after its facts are read, in the owner's `captures/large`
//! folder or, when the file sits on another volume, in the session's own folder on that volume. A
//! later capture compares the file's facts with the shadow's to tell whether it changed. Every call
//! blocks on the file system, so the caller runs it off the async workers.

use std::collections::HashMap;
use std::error::Error;
use std::fs::{self, File};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{
    CloneRefusal, FileFacts, RegularFileOpen, Volume, VolumeId, create_missing_private_folders,
    create_private_folder, create_volume_folder, file_facts, file_facts_of, open_regular_file,
    read_volume, real_path,
};
use sidekicks_std::file::clone_open_file::{CloneOpenFileError, clone_open_file};
use sidekicks_std::file::time_precision::{COARSEST_TIME_PRECISION, probe_time_precision};
use sidekicks_std::missing_entry::is_gone;
use sidekicks_workspace::git::turn_snapshot::capture_folder::CAPTURES_SEGMENT;

use crate::checkpoints::schema::NotKeptReason;
use crate::checkpoints::store::shadows::{Shadow, ShadowContent, ShadowId, VolumeFolder};

/// The folder under the captures folder that holds the clones on the owner's volume.
const LARGE_SEGMENT: &str = "large";

/// Where one session's shadows are cloned: the owner's `captures/large` folder, and the session's
/// own folders on other volumes with each clone folder's time precision once probed. Made once per
/// session and kept for its life, so a folder is found or made and probed once.
#[derive(Debug)]
pub struct ShadowPlaces {
    /// The session whose shadows these are.
    session_id: SessionId,
    /// `<owner>/captures/large`.
    capture_folder: PathBuf,
    /// The session's folders, `<user folder>/<session id>`, on each volume other than the owner's.
    session_folders: HashMap<VolumeId, Vec<VolumeFolder>>,
    /// The time precision of each folder a clone went to.
    time_precisions: HashMap<PathBuf, Duration>,
}

/// What a shadow's take found at the file.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::large_enum_variant,
    reason = "a take is answered once per large file and moved straight into its capture's write"
)]
pub enum ShadowTaken {
    /// Nothing, or a folder on its way that is no folder: there is no file to shadow.
    Gone,
    /// The file's shadow, a clone or why none was kept.
    Taken {
        /// The shadow, for the capture's write to record.
        shadow: Shadow,
        /// The session's folder on another volume this take cloned into or made, whether or not
        /// the clone was kept, which the write records, once per session, so the purge removes
        /// it: named on every take, so a folder a failed write left unrecorded is recorded later.
        volume_folder: Option<VolumeFolder>,
    },
}

/// Whether a file changed since its shadow was taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShadowComparison {
    /// Every fact is the shadow's, and no time is too close to the shadow's capture to trust.
    Unchanged,
    /// A fact differs or could not be read, or a time is too close to the capture to trust.
    Changed,
}

impl ShadowPlaces {
    /// The places of `session_id`'s shadows under `owner_folder`, knowing the session's folders on
    /// other volumes that its rows hold. Makes `captures/large` there, readable by its owner alone.
    /// Fails with the make's error.
    pub fn open(
        owner_folder: &Path,
        session_id: SessionId,
        volume_folders: Vec<VolumeFolder>,
    ) -> io::Result<Self> {
        let capture_folder = large_folder(owner_folder);
        create_missing_private_folders(&capture_folder)?;
        let mut session_folders: HashMap<VolumeId, Vec<VolumeFolder>> = HashMap::new();
        for known in volume_folders {
            session_folders
                .entry(known.volume_id.clone())
                .or_default()
                .push(known);
        }
        Ok(Self {
            session_id,
            capture_folder,
            session_folders,
            time_precisions: HashMap::new(),
        })
    }

    /// Shadows the file at `relative` under the checkout's real path `checkout_real_path`, `path`
    /// being the two joined as its rows record it, at the capture's clock `taken_at`. The file's
    /// facts are read from the open file before the clone, so a write between the two reads as a
    /// change. Never fails: a step that fails keeps no clone and says so in the shadow.
    pub fn take_shadow(
        &mut self,
        checkout_real_path: &Path,
        relative: &Path,
        path: FilesystemPath,
        taken_at: jiff::Timestamp,
    ) -> ShadowTaken {
        let shadow_id = ShadowId::mint();
        let placed = match self.place(&mut NativeFiles, shadow_id, checkout_real_path, relative) {
            Placement::Gone => return ShadowTaken::Gone,
            Placement::Placed(placed) => placed,
        };
        let time_precision = match &placed.clone_folder {
            Some(folder) => self.time_precision_of(folder),
            // Nothing may be written where no clone went, so its precision is not probed.
            None => COARSEST_TIME_PRECISION,
        };
        ShadowTaken::Taken {
            shadow: Shadow {
                shadow_id,
                session_id: self.session_id,
                path,
                content: placed.content,
                facts: placed.facts,
                taken_at,
                time_precision,
            },
            volume_folder: placed.volume_folder,
        }
    }

    // Opens the file, reads its facts and clones it, into the capture folder, else into the
    // session's folder on the file's volume, found or made. A shadow named `shadow_id` keeps its
    // clone under that name.
    fn place(
        &mut self,
        files: &mut impl ShadowFiles,
        shadow_id: ShadowId,
        checkout: &Path,
        relative: &Path,
    ) -> Placement {
        let file = match files.open(checkout, relative) {
            Ok(RegularFileOpen::Opened(file)) => file,
            Ok(RegularFileOpen::Gone) => return Placement::Gone,
            Ok(RegularFileOpen::Link) => {
                log_failure(
                    relative,
                    "open",
                    &io::Error::new(
                        ErrorKind::InvalidInput,
                        "the path names a link, not a regular file",
                    ),
                );
                return not_kept(
                    NotKeptReason::SymbolicLink,
                    files.facts_at(&checkout.join(relative)).ok(),
                );
            }
            Ok(RegularFileOpen::SpecialFile) => {
                log_failure(
                    relative,
                    "open",
                    &io::Error::new(
                        ErrorKind::InvalidInput,
                        "the path names a special file, not a regular file",
                    ),
                );
                return not_kept(
                    NotKeptReason::NotARegularFile,
                    files.facts_at(&checkout.join(relative)).ok(),
                );
            }
            Err(error) => {
                log_failure(relative, "open", &error);
                return not_kept(
                    NotKeptReason::Failed,
                    files.facts_at(&checkout.join(relative)).ok(),
                );
            }
        };
        let facts = match files.facts_of(&file) {
            Ok(facts) => facts,
            Err(error) => {
                log_failure(relative, "read the facts of", &error);
                return not_kept(NotKeptReason::Failed, None);
            }
        };
        let in_capture_folder = clone_into(files, &file, &self.capture_folder, shadow_id);
        match in_capture_folder {
            Ok(clone_path) => {
                return Placement::Placed(PlacedShadow {
                    content: ShadowContent::Cloned {
                        clone_path,
                        volume_id: None,
                    },
                    facts: Some(facts),
                    clone_folder: Some(self.capture_folder.clone()),
                    volume_folder: None,
                });
            }
            Err(CloneOpenFileError::Refused(CloneRefusal::Unsupported)) => {
                return not_kept(NotKeptReason::TooLarge, Some(facts));
            }
            Err(CloneOpenFileError::Refused(CloneRefusal::AcrossVolumes)) => {}
            Err(CloneOpenFileError::Failed(error)) => {
                log_failure(relative, "clone", &error);
                return not_kept(NotKeptReason::Failed, Some(facts));
            }
        }
        let volume = match files.read_volume(&checkout.join(relative)) {
            Ok(volume) => volume,
            // A volume that names no id, as a network share, holds no folder of the session.
            Err(error) if error.kind() == ErrorKind::Unsupported => {
                return not_kept(NotKeptReason::TooLarge, Some(facts));
            }
            Err(error) => {
                log_failure(relative, "read the volume of", &error);
                return not_kept(NotKeptReason::Failed, Some(facts));
            }
        };
        let volume_folder = match self.known_folder(&volume.id, checkout) {
            Some(known) => known,
            None => match self.make_session_folder(files, &volume, checkout) {
                Ok(Some(made)) => made,
                Ok(None) => return not_kept(NotKeptReason::NoPlaceOnVolume, Some(facts)),
                Err(error) => {
                    log_failure(
                        relative,
                        "make the session's folder on the volume of",
                        &error,
                    );
                    return not_kept(NotKeptReason::Failed, Some(facts));
                }
            },
        };
        // The folder is named whatever the clone answers, so it is recorded and purged with the
        // session.
        let folder = PathBuf::from(volume_folder.folder.as_str());
        let content = match clone_into(files, &file, &folder, shadow_id) {
            Ok(clone_path) => ShadowContent::Cloned {
                clone_path,
                volume_id: Some(volume.id),
            },
            Err(CloneOpenFileError::Refused(CloneRefusal::Unsupported)) => ShadowContent::NotKept {
                reason: NotKeptReason::TooLarge,
            },
            // The folder was read on the file's volume, so a clone refused across volumes is no
            // reason the file could not be kept but a failure.
            Err(CloneOpenFileError::Refused(CloneRefusal::AcrossVolumes)) => {
                log_failure(
                    relative,
                    "clone",
                    &io::Error::other("the session's folder is on another volume than the file"),
                );
                ShadowContent::NotKept {
                    reason: NotKeptReason::Failed,
                }
            }
            Err(CloneOpenFileError::Failed(error)) => {
                log_failure(relative, "clone", &error);
                ShadowContent::NotKept {
                    reason: NotKeptReason::Failed,
                }
            }
        };
        let clone_folder = matches!(content, ShadowContent::Cloned { .. }).then_some(folder);
        Placement::Placed(PlacedShadow {
            content,
            facts: Some(facts),
            clone_folder,
            volume_folder: Some(volume_folder),
        })
    }

    // The session's known folder on `volume_id` that lies outside `checkout`, whose own files
    // never hold a clone.
    fn known_folder(&self, volume_id: &VolumeId, checkout: &Path) -> Option<VolumeFolder> {
        self.session_folders
            .get(volume_id)?
            .iter()
            .find(|known| !Path::new(known.folder.as_str()).starts_with(checkout))
            .cloned()
    }

    // Makes the session's folder in this user's folder on `volume`, outside `checkout`, learns it
    // and answers its row. `None` where the volume holds no place outside the checkout.
    fn make_session_folder(
        &mut self,
        files: &mut impl ShadowFiles,
        volume: &Volume,
        checkout: &Path,
    ) -> io::Result<Option<VolumeFolder>> {
        let Some(user_folder) = files.create_volume_folder(volume, checkout)? else {
            return Ok(None);
        };
        let folder = user_folder.join(self.session_id.text().as_str());
        let row = VolumeFolder {
            volume_id: volume.id.clone(),
            folder: recorded_path(&folder)?,
        };
        files.create_session_folder(&folder)?;
        self.session_folders
            .entry(volume.id.clone())
            .or_default()
            .push(row.clone());
        Ok(Some(row))
    }

    /// Removes `shadow`'s clone, a clone already gone included; a shadow that kept none removes
    /// nothing. Fails with `InvalidInput`, removing nothing, for a clone outside the session's
    /// capture folder and its folders on other volumes, and with the removal's other errors.
    pub fn remove_shadow_clone(&self, shadow: &Shadow) -> io::Result<()> {
        let ShadowContent::Cloned { clone_path, .. } = &shadow.content else {
            return Ok(());
        };
        let clone_path = Path::new(clone_path.as_str());
        let is_in_a_place = clone_path.parent().is_some_and(|folder| {
            folder == self.capture_folder
                || self
                    .session_folders
                    .values()
                    .flatten()
                    .any(|known| folder == Path::new(known.folder.as_str()))
        });
        if !is_in_a_place {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "a shadow's clone lies outside the session's shadow folders",
            ));
        }
        match fs::remove_file(clone_path) {
            Ok(()) => Ok(()),
            Err(error) if is_gone(&error) => Ok(()),
            Err(error) => Err(error),
        }
    }

    // The time precision of `folder`, probed at its first clone and kept; the coarsest where the
    // probe fails.
    fn time_precision_of(&mut self, folder: &Path) -> Duration {
        *self
            .time_precisions
            .entry(folder.to_path_buf())
            .or_insert_with(|| {
                probe_time_precision(folder).unwrap_or_else(|error| {
                    tracing::warn!(
                        folder = %folder.display(),
                        error = &error as &(dyn Error + 'static),
                        "the time precision of a shadow folder did not read; the coarsest is taken"
                    );
                    COARSEST_TIME_PRECISION
                })
            })
    }
}

/// `<owner>/captures/large`, the folder of `owner_folder`'s clones on its own volume, made or not.
pub fn large_folder(owner_folder: &Path) -> PathBuf {
    owner_folder.join(CAPTURES_SEGMENT).join(LARGE_SEGMENT)
}

/// Whether the file whose facts read `now`, `None` when it is gone or did not read, changed since
/// `shadow` was taken. A shadow with no facts, a gone file and any differing fact are changes, and
/// so is a modified or changed time within the shadow folder's time precision of the capture's
/// clock, which a write in that same tick would not move.
pub fn compare_shadow(shadow: &Shadow, now: Option<FileFacts>) -> ShadowComparison {
    let (Some(then), Some(now)) = (shadow.facts, now) else {
        return ShadowComparison::Changed;
    };
    let is_racy = |time: i128| {
        let precision = i128::try_from(shadow.time_precision.as_nanos()).unwrap_or(i128::MAX);
        shadow.taken_at.as_nanosecond().saturating_sub(time) < precision
    };
    if then != now || is_racy(then.modified) || is_racy(then.changed) {
        ShadowComparison::Changed
    } else {
        ShadowComparison::Unchanged
    }
}

/// The file-system calls a shadow's placement makes, apart so each placement can be shown with
/// answers a test chooses.
trait ShadowFiles {
    /// Opens `relative` under `checkout` through no link, as `open_regular_file` does.
    fn open(&mut self, checkout: &Path, relative: &Path) -> io::Result<RegularFileOpen>;

    /// The facts of the open `file`.
    fn facts_of(&mut self, file: &File) -> io::Result<FileFacts>;

    /// The facts of the file at `path`, a link followed.
    fn facts_at(&mut self, path: &Path) -> io::Result<FileFacts>;

    /// Clones the open `file` to the new `destination`.
    fn clone_file(&mut self, file: &File, destination: &Path) -> Result<(), CloneOpenFileError>;

    /// The volume holding the file at `path`, read from its real path.
    fn read_volume(&mut self, path: &Path) -> io::Result<Volume>;

    /// This user's own folder on `volume` outside `checkout`, as `create_volume_folder` answers.
    fn create_volume_folder(
        &mut self,
        volume: &Volume,
        checkout: &Path,
    ) -> io::Result<Option<PathBuf>>;

    /// Makes the session's `folder` in this user's folder, readable by its owner alone.
    fn create_session_folder(&mut self, folder: &Path) -> io::Result<()>;
}

/// The system's own calls.
struct NativeFiles;

impl ShadowFiles for NativeFiles {
    fn open(&mut self, checkout: &Path, relative: &Path) -> io::Result<RegularFileOpen> {
        open_regular_file(checkout, relative)
    }

    fn facts_of(&mut self, file: &File) -> io::Result<FileFacts> {
        file_facts_of(file)
    }

    fn facts_at(&mut self, path: &Path) -> io::Result<FileFacts> {
        file_facts(path)
    }

    fn clone_file(&mut self, file: &File, destination: &Path) -> Result<(), CloneOpenFileError> {
        clone_open_file(file, destination)
    }

    fn read_volume(&mut self, path: &Path) -> io::Result<Volume> {
        read_volume(&real_path(path)?)
    }

    fn create_volume_folder(
        &mut self,
        volume: &Volume,
        checkout: &Path,
    ) -> io::Result<Option<PathBuf>> {
        create_volume_folder(volume, checkout)
    }

    fn create_session_folder(&mut self, folder: &Path) -> io::Result<()> {
        create_private_folder(folder)
    }
}

/// What a placement found at the file.
#[derive(Debug, PartialEq, Eq)]
#[expect(
    clippy::large_enum_variant,
    reason = "a placement is answered once per large file and taken apart at once"
)]
enum Placement {
    /// No file.
    Gone,
    /// The file's clone, or why none was kept.
    Placed(PlacedShadow),
}

/// A placed shadow before its time precision is read.
#[derive(Debug, PartialEq, Eq)]
struct PlacedShadow {
    /// Its clone, or why none was kept.
    content: ShadowContent,
    /// The file's facts, `None` when their read failed.
    facts: Option<FileFacts>,
    /// The folder holding the clone, `None` when none was kept.
    clone_folder: Option<PathBuf>,
    /// The session's folder on another volume this placement cloned into or made.
    volume_folder: Option<VolumeFolder>,
}

// A shadow that kept no clone, for `reason`, with the facts read.
fn not_kept(reason: NotKeptReason, facts: Option<FileFacts>) -> Placement {
    Placement::Placed(PlacedShadow {
        content: ShadowContent::NotKept { reason },
        facts,
        clone_folder: None,
        volume_folder: None,
    })
}

// Clones `file` into `folder` under `shadow_id`'s name and answers the clone's path as its row
// records it; a path no row can hold fails before anything is written.
fn clone_into(
    files: &mut impl ShadowFiles,
    file: &File,
    folder: &Path,
    shadow_id: ShadowId,
) -> Result<FilesystemPath, CloneOpenFileError> {
    let destination = folder.join(shadow_id.text().as_str());
    let recorded = recorded_path(&destination).map_err(CloneOpenFileError::Failed)?;
    files.clone_file(file, &destination)?;
    Ok(recorded)
}

/// `path` as a row records it, refused with `InvalidInput` when no row can hold it, a path that is
/// not UTF-8 or past the length bound among them.
pub(crate) fn recorded_path(path: &Path) -> io::Result<FilesystemPath> {
    let text = path
        .to_str()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "a recorded path is not UTF-8"))?;
    FilesystemPath::new(text.to_owned())
        .map_err(|error| io::Error::new(ErrorKind::InvalidInput, error))
}

// Logs why a step of a shadow's take failed, which the shadow records only as failed.
fn log_failure(relative: &Path, step: &'static str, error: &(dyn Error + 'static)) {
    tracing::warn!(
        path = %relative.display(),
        step,
        error,
        "a large file's shadow kept no clone: a step failed"
    );
}

#[cfg(test)]
mod tests;
