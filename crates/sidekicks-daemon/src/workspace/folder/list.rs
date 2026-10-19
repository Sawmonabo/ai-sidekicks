//! The machine's folders, listed for another device's `Open folder…` (`machine.folder.list`): the
//! folder in view, the path down to it, and its folders in the order the person's language sorts
//! names, each marked when it is a git repository's own top level.
//!
//! - The listing starts at the home folder of the account the service runs as, leaves hidden
//!   folders out unless asked, and is cut only where it would overflow one message, with `more`
//!   saying the filter would narrow further.
//! - A read of the folder that fails in a way another moment can clear is tried once more; a read
//!   that still fails is refused with the system's own reason.
//! - Git is asked, one folder at a time and as many at once as the machine has processors, whether
//!   a folder is a repository's top level; git's files are never read. A check that runs out of
//!   time lists its folder as no repository, so one hung network folder never empties the list.
//! - macOS and Linux have no top level above their folders and no WSL distribution, so both are
//!   refused.

use std::cmp::Ordering;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fs::Metadata;
use std::io;
use std::path::{Component, Path, PathBuf};

use icu_collator::options::CollatorOptions;
use icu_collator::preferences::CollationNumericOrdering;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::page::{PAGE_MAX_BYTES, count_entries_fitting_one_frame};
use sidekicks_contracts::name_fold::fold_name;
use sidekicks_contracts::repo::folders::{
    MachineFolderListEntry, MachineFolderListFolderResponse, MachineFolderListRequest,
    MachineFolderListResponse, MachineFolderPathSegment, RepoMountRootResolutionReason,
};
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_platforms::{
    LocaleCategory, PathRules, is_hidden_entry, is_link_loop, path_from_program_output,
    resolve_path, system_locale,
};

use crate::git::process::{GitCall, GitError, GitRunner, background_read, strip_line_end};
use crate::missing_entry::is_missing_entry;
use crate::processor_bound::map_with_processor_bound;
use crate::read_retry::{is_retryable_read_failure, read_with_one_retry};
use crate::settle_all::SettleFailures;
use crate::workspace::folder::canonical_path::canonical_folder_path;
use crate::workspace::repo::errors::RepoRefusal;
use crate::workspace::repo::root_resolver::{
    ROOT_RESOLUTION_GIT_TIMEOUT, refusal_of_filesystem_failure,
};

/// Why a folder listing failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum FolderListError {
    /// The request was refused: the top level, a WSL distribution, a path naming no complete
    /// location, or a folder that cannot be read, with the system's reason.
    #[error(transparent)]
    Refused(#[from] RepoRefusal),
    /// A link in the folder could not be followed for a reason other than leading nowhere,
    /// looping or lacking access.
    #[error("a link in the folder could not be followed")]
    LinkRead(#[source] io::Error),
    /// The folder in view has a path the wire cannot carry.
    #[error("the folder's path is longer than the wire carries")]
    PathNotSendable(#[source] TextError),
    /// git could not check one or more folders: it could not start, was ended, or printed what
    /// cannot be read.
    #[error(transparent)]
    RepositoryCheck(#[from] SettleFailures<RepositoryCheckError>),
}

/// Why one folder's repository check failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RepositoryCheckError {
    /// git could not answer: it could not start, was ended, or printed what cannot be read.
    #[error("git could not check whether a folder is a repository")]
    Git(#[from] GitError),
    /// The folder or the top level git printed could not be resolved for the comparison.
    #[error("a folder could not be resolved to compare it with git's top level")]
    Resolve(#[from] io::Error),
}

// Why the folder's read failed: the folder itself, which the person is told about, or a link in it
// that could not be followed, which is the daemon's failure.
#[derive(Debug)]
enum FolderReadFailure {
    Folder(io::Error),
    Link(io::Error),
}

/// Lists the machine's folders for another device's folder chooser.
pub(crate) struct FolderListService {
    home_folder: PathBuf,
    git: GitRunner,
}

impl FolderListService {
    /// The listing starting at `home_folder`, the home folder of the account the service runs as,
    /// asking `git` which folders are repositories.
    pub(crate) fn new(home_folder: PathBuf, git: GitRunner) -> Self {
        Self { home_folder, git }
    }

    /// The folder `request` names (the home folder when it names none) and its folders matching
    /// its filter, folded for case, in name order. Fails with [`FolderListError::Refused`]:
    /// `machine.folder.topLevel.notOffered` for the top level, `repoMount.distributionNotFound`
    /// for a WSL place, and `repoMount.rootResolutionFailed` with `notAbsolute` for a path naming
    /// no complete location or with `pathNotFound` or `notReadable` and the system's reason for a
    /// folder that cannot be read after one retry; and with the other variants when a link cannot
    /// be followed or git cannot check a folder.
    pub(crate) async fn list(
        &self,
        request: MachineFolderListRequest,
    ) -> Result<MachineFolderListResponse, FolderListError> {
        let request = match request {
            MachineFolderListRequest::Top(_) => return Err(RepoRefusal::TopLevelNotOffered.into()),
            MachineFolderListRequest::Folder(request) => request,
        };
        // This daemon reaches no WSL distribution, so none of that name is here to list.
        if let Some(place) = request.place {
            return Err(RepoRefusal::DistributionNotFound {
                distro: place.distro,
            }
            .into());
        }
        let folder = self.folder_in_view(request.path.as_ref())?;
        let filter = request
            .filter
            .as_ref()
            .map(|filter| fold_name(filter.as_str()))
            .filter(|filter| !filter.is_empty());
        let is_hidden_shown = request.show_hidden == Some(true);

        let mut names = read_with_one_retry(
            || read_folder_names_off_workers(folder.clone(), is_hidden_shown, filter.clone()),
            |failure| match failure {
                FolderReadFailure::Folder(error) => is_retryable_read_failure(error),
                FolderReadFailure::Link(_) => false,
            },
        )
        .await
        .map_err(|failure| match failure {
            FolderReadFailure::Folder(error) => {
                FolderListError::Refused(refusal_of_filesystem_failure(&error))
            }
            FolderReadFailure::Link(error) => FolderListError::LinkRead(error),
        })?;
        sort_folder_names(&mut names, &folder_name_collator());

        let candidates: Vec<(PathBuf, MachineFolderListEntry)> = names
            .iter()
            .filter_map(|name| entry_of(&folder, name))
            .collect();
        // Cut to one message before git is asked, so no folder past the cut costs a git call.
        let fitted = count_entries_fitting_one_frame(
            &candidates
                .iter()
                .map(|(_, entry)| entry)
                .collect::<Vec<_>>(),
            candidates.len(),
            PAGE_MAX_BYTES,
        )
        .expect("a folder entry of paths and a flag serializes to JSON");
        let more = fitted < candidates.len();
        let entries = map_with_processor_bound(
            candidates.into_iter().take(fitted),
            "checking which folders are repositories",
            |(path, entry)| self.mark_repository(path, entry),
        )
        .await?;

        Ok(MachineFolderListResponse::Folder(
            MachineFolderListFolderResponse {
                top: None,
                place: None,
                path: wire_path(folder.as_os_str()).map_err(FolderListError::PathNotSendable)?,
                segments: segments_of(&folder)?,
                entries,
                more,
            },
        ))
    }

    // The folder the request names, `.` and `..` folded as typed and no link followed, so the
    // folder in view keeps the address the person walked; the home folder when it names none. A
    // relative path, `~` or a Windows root with no drive would be completed from the daemon's own
    // state, so it is refused, and the home folder is held to the same rule.
    fn folder_in_view(&self, requested: Option<&FilesystemPath>) -> Result<PathBuf, RepoRefusal> {
        let not_absolute = || RepoRefusal::RootResolutionFailed {
            reason: RepoMountRootResolutionReason::NotAbsolute,
            detail: None,
        };
        let Some(requested) = requested else {
            return if PathRules::NATIVE.names_complete_location(&self.home_folder.to_string_lossy())
            {
                Ok(self.home_folder.clone())
            } else {
                Err(not_absolute())
            };
        };
        if !PathRules::NATIVE.names_complete_location(requested.as_str()) {
            return Err(not_absolute());
        }
        resolve_path(requested.as_str())
            .map(PathBuf::from)
            .map_err(|error| refusal_of_filesystem_failure(&error))
    }

    // `entry` with git's answer for the folder at `path`.
    async fn mark_repository(
        &self,
        path: PathBuf,
        mut entry: MachineFolderListEntry,
    ) -> Result<MachineFolderListEntry, RepositoryCheckError> {
        entry.is_repository = self.is_repository(&path).await?;
        Ok(entry)
    }

    // A repository's own top level, as git reports it; a folder inside one, or in none, is not.
    async fn is_repository(&self, folder: &Path) -> Result<bool, RepositoryCheckError> {
        let call = GitCall::read(background_read(folder, &["rev-parse", "--show-toplevel"]))
            .with_timeout(Some(ROOT_RESOLUTION_GIT_TIMEOUT));
        let output = match self.git.run(None, call).await {
            Ok(output) => output,
            // git answered with a refusal: no repository, a bare one, a folder it cannot read.
            Err(GitError::Exited { code: Some(_), .. }) => return Ok(false),
            Err(timed_out @ GitError::TimedOut { .. }) => {
                tracing::warn!(
                    error = &timed_out as &(dyn Error + 'static),
                    folder = %folder.display(),
                    "a folder's repository check got no answer in time; it lists as no repository"
                );
                return Ok(false);
            }
            Err(
                failure @ (GitError::Exited { code: None, .. }
                | GitError::WslPlace { .. }
                | GitError::NotFound
                | GitError::Start(_)
                | GitError::OutputTooLarge { .. }
                | GitError::Read(_)
                | GitError::PathText(_)),
            ) => return Err(failure.into()),
        };
        let top_level =
            path_from_program_output(strip_line_end(output.stdout)).map_err(GitError::PathText)?;
        // Both resolved and in the system's comparable form, since git prints the top level with
        // each link resolved, and with forward slashes on Windows.
        Ok(canonical_folder_path(&top_level).await? == canonical_folder_path(folder).await?)
    }
}

// The names of `folder`'s folders, off the async workers.
async fn read_folder_names_off_workers(
    folder: PathBuf,
    is_hidden_shown: bool,
    filter: Option<String>,
) -> Result<Vec<OsString>, FolderReadFailure> {
    tokio::task::spawn_blocking(move || {
        read_folder_names(&folder, is_hidden_shown, filter.as_deref())
    })
    .await
    .map_err(|error| FolderReadFailure::Folder(io::Error::other(error)))?
}

// The names of `folder`'s folders and links to folders, hidden ones only when `is_hidden_shown`,
// and only those whose folded name holds `filter`.
fn read_folder_names(
    folder: &Path,
    is_hidden_shown: bool,
    filter: Option<&str>,
) -> Result<Vec<OsString>, FolderReadFailure> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(folder).map_err(FolderReadFailure::Folder)? {
        let entry = entry.map_err(FolderReadFailure::Folder)?;
        let name = entry.file_name();
        // The entry's own facts, no link followed, so a link's hidden mark is its own.
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            // Gone since the listing named it.
            Err(error) if is_missing_entry(&error) => continue,
            Err(error) => return Err(FolderReadFailure::Folder(error)),
        };
        if !is_hidden_shown && is_hidden_entry(&name, &metadata) {
            continue;
        }
        if let Some(filter) = filter
            && !fold_name(&name.to_string_lossy()).contains(filter)
        {
            continue;
        }
        if is_folder(&entry.path(), &metadata).map_err(FolderReadFailure::Link)? {
            names.push(name);
        }
    }
    Ok(names)
}

// A folder, or a link to one; a link that leads nowhere, loops or cannot be followed for want of
// access is no folder, never the listing's failure.
fn is_folder(path: &Path, metadata: &Metadata) -> io::Result<bool> {
    if metadata.is_dir() {
        return Ok(true);
    }
    if !metadata.is_symlink() {
        return Ok(false);
    }
    match std::fs::metadata(path) {
        Ok(target) => Ok(target.is_dir()),
        Err(error)
            if is_missing_entry(&error)
                || is_link_loop(&error)
                || error.kind() == io::ErrorKind::PermissionDenied =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

// The collator of the person's language with numbers ordered by value, read once per listing.
fn folder_name_collator() -> CollatorBorrowed<'static> {
    // No locale is the POSIX locale, which orders by the root collation.
    numeric_collator(
        system_locale(LocaleCategory::Messages)
            .map_or_else(CollatorPreferences::default, CollatorPreferences::from),
    )
}

// The collator `preferences` name with numbers ordered by value, so `build-9` comes before
// `build-10`; the root collation, which every language's order tailors, where the compiled data
// cannot build one for them.
fn numeric_collator(mut preferences: CollatorPreferences) -> CollatorBorrowed<'static> {
    preferences.numeric_ordering = Some(CollationNumericOrdering::True);
    Collator::try_new(preferences, CollatorOptions::default()).unwrap_or_else(|error| {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "the language's collation could not be built; folders list in the root order"
        );
        let mut root = CollatorPreferences::default();
        root.numeric_ordering = Some(CollationNumericOrdering::True);
        Collator::try_new(root, CollatorOptions::default())
            .expect("the root collation is in the compiled data")
    })
}

// `names` in `collator`'s order, names it ranks equal (`build-01` and `build-1` under numeric
// order) by their bytes, so the order is total; bytes that are not UTF-8 compare as U+FFFD.
fn sort_folder_names(names: &mut [OsString], collator: &CollatorBorrowed<'_>) {
    names.sort_by(|left, right| folder_name_order(collator, left, right));
}

fn folder_name_order(collator: &CollatorBorrowed<'_>, left: &OsStr, right: &OsStr) -> Ordering {
    let (left, right) = (left.as_encoded_bytes(), right.as_encoded_bytes());
    collator
        .compare_utf8(left, right)
        .then_with(|| left.cmp(right))
}

// The entry of `folder`'s folder `name`, with its path kept as bytes for git; `None`, logged, for
// a path longer than the wire carries, which no program opens by that path either.
fn entry_of(folder: &Path, name: &OsStr) -> Option<(PathBuf, MachineFolderListEntry)> {
    let path = folder.join(name);
    match (wire_path(name), wire_path(path.as_os_str())) {
        (Ok(wire_name), Ok(wire_folder)) => Some((
            path,
            MachineFolderListEntry {
                name: wire_name,
                path: wire_folder,
                is_repository: false,
            },
        )),
        (Err(error), _) | (_, Err(error)) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a folder whose path the wire cannot carry is left out of a listing"
            );
            None
        }
    }
}

// The path from its root down, each step pressable, the last the folder itself. A Windows drive or
// share and the root after it are one step.
fn segments_of(
    folder: &Path,
) -> Result<BoundedVec<MachineFolderPathSegment, 1, { usize::MAX }>, FolderListError> {
    let mut walked = PathBuf::new();
    let mut segments = Vec::new();
    for component in folder.components() {
        walked.push(component);
        let name = match component {
            Component::Prefix(_) => continue,
            Component::RootDir => walked.as_os_str(),
            Component::CurDir | Component::ParentDir | Component::Normal(_) => {
                component.as_os_str()
            }
        };
        segments.push(MachineFolderPathSegment::Folder {
            name: wire_path(name).map_err(FolderListError::PathNotSendable)?,
            path: wire_path(walked.as_os_str()).map_err(FolderListError::PathNotSendable)?,
        });
    }
    Ok(BoundedVec::new(segments).expect("a complete location's root is its first segment"))
}

// A path as the wire carries it: its text, each sequence that is not UTF-8 one U+FFFD.
fn wire_path(path: &OsStr) -> Result<FilesystemPath, TextError> {
    FilesystemPath::new(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use icu_collator::CollatorPreferences;
    use rstest::rstest;
    use sidekicks_platforms::path_from_program_output;

    use super::{numeric_collator, sort_folder_names};

    // A name from its bytes, `None` where the system holds no name of them (Windows' names are
    // UTF-16, so bytes that are not UTF-8 name nothing there).
    fn name_of(bytes: &[u8]) -> Option<OsString> {
        path_from_program_output(bytes.to_vec())
            .ok()
            .map(std::path::PathBuf::into_os_string)
    }

    // Catches numbers ordered as text, case over letters, a tie left open or a misplaced name.
    #[rstest]
    #[case::numbers_by_their_value(
        vec![b"build-10".as_slice(), b"build-9".as_slice()],
        vec![b"build-9".as_slice(), b"build-10".as_slice()]
    )]
    #[case::letters_without_case(
        vec![b"Zebra".as_slice(), b"apple".as_slice()],
        vec![b"apple".as_slice(), b"Zebra".as_slice()]
    )]
    #[case::equal_numbers_by_their_bytes(
        vec![b"build-1".as_slice(), b"build-01".as_slice()],
        vec![b"build-01".as_slice(), b"build-1".as_slice()]
    )]
    #[case::a_name_that_is_not_utf8(
        vec![b"c".as_slice(), b"b\xffd".as_slice(), b"a".as_slice()],
        vec![b"a".as_slice(), b"b\xffd".as_slice(), b"c".as_slice()]
    )]
    fn folder_names_list_in_the_order_people_read_them(
        #[case] given: Vec<&[u8]>,
        #[case] expected: Vec<&[u8]>,
    ) {
        let (Some(mut names), Some(expected)) = (
            given.into_iter().map(name_of).collect::<Option<Vec<_>>>(),
            expected
                .into_iter()
                .map(name_of)
                .collect::<Option<Vec<_>>>(),
        ) else {
            // The system holds no such name, so no folder can carry it.
            return;
        };
        sort_folder_names(
            &mut names,
            &numeric_collator(CollatorPreferences::default()),
        );
        assert_eq!(names, expected);
    }
}
