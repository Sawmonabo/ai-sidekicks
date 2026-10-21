//! The machine's folders, listed for another device's `Open folder…` (`machine.folder.list`): the
//! folder in view, the path down to it, and its folders in the order the person's language sorts
//! names, each marked when it is a git repository's own top level.
//!
//! - The listing starts at the home folder of the account the service runs as, leaves hidden
//!   folders out unless asked, and is cut only where it would overflow one message, with `more`
//!   saying the filter would narrow further.
//! - A read of the folder that fails in a way another moment can clear is tried once more; a read
//!   that still fails is refused with the system's own reason.
//! - Every file read is held to the bounded read's ceiling, off tokio's workers: the folder's own
//!   read past it is refused `notReadable`, an entry's read past it leaves that entry out, and a
//!   repository check whose resolve passes it lists its folder as no repository, each logged, so
//!   one hung network folder inside the one in view never holds or empties the list.
//! - Git is asked, one folder at a time and as many at once as the machine has processors, whether
//!   a folder is a repository's top level; git's files are never read. A check that runs out of
//!   time lists its folder as no repository.
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
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::{PAGE_MAX_BYTES, count_entries_fitting_one_frame};
use sidekicks_contracts::name_fold::fold_name;
use sidekicks_contracts::repo::folders::{
    MachineFolderListEntry, MachineFolderListFolderResponse, MachineFolderListRequest,
    MachineFolderListResponse, MachineFolderPathSegment, RepoMountRootResolutionReason,
};
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_platforms::{
    LocaleCategory, PathRules, is_hidden_entry, path_from_program_output, resolve_path,
    system_locale,
};

use crate::file::bounded_read::read_within_ceiling;
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

/// Lists the machine's folders for another device's folder chooser.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the folder list method's handler")
)]
pub(crate) struct FolderListService {
    home_folder: PathBuf,
    git: GitRunner,
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the folder list method's handler")
)]
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
    /// folder that cannot be read after one retry or in time; and with the other variants when
    /// the path cannot be sent or git cannot check a folder.
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

        let refused =
            |error: &io::Error| FolderListError::Refused(refusal_of_filesystem_failure(error));
        let candidate_names = read_with_one_retry(
            || {
                let filter = filter.clone();
                read_within_ceiling(&folder, move |folder| {
                    read_candidate_names(folder, filter.as_deref())
                })
            },
            is_retryable_read_failure,
        )
        .await
        .map_err(|error| refused(&error))?;
        let mut names: Vec<OsString> =
            map_with_processor_bound(candidate_names, "reading the entries of a folder", |name| {
                read_folder_entry(&folder, name, is_hidden_shown)
            })
            .await
            .map_err(|failures| match failures {
                SettleFailures::One(error) => refused(&error),
                SettleFailures::Many { failures, .. } => refused(&failures[0]),
            })?
            .into_iter()
            .flatten()
            .collect();
        sort_folder_names(&mut names, &folder_name_collator());

        let candidates: Vec<(PathBuf, MachineFolderListEntry)> = names
            .iter()
            .filter_map(|name| entry_of(&folder, name))
            .collect();
        // Cut to one message before git is asked, so no folder past the cut costs a git call.
        let fitted = count_entries_fitting_one_frame(
            &candidates,
            candidates.len(),
            PAGE_MAX_BYTES,
            |(_, entry)| json_utf8_byte_length(entry),
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
                | GitError::PathText(_)
                | GitError::NotStartable),
            ) => return Err(failure.into()),
        };
        let top_level =
            path_from_program_output(strip_line_end(output.stdout)).map_err(GitError::PathText)?;
        // Both resolved and in the system's comparable form, since git prints the top level with
        // each link resolved, and with forward slashes on Windows.
        let keys = async {
            Ok::<_, io::Error>(
                canonical_folder_path(&top_level).await? == canonical_folder_path(folder).await?,
            )
        };
        match keys.await {
            Ok(is_top_level) => Ok(is_top_level),
            Err(timed_out) if timed_out.kind() == io::ErrorKind::TimedOut => {
                tracing::warn!(
                    error = &timed_out as &(dyn Error + 'static),
                    folder = %folder.display(),
                    "a folder's repository check could not resolve it in time; it lists as no \
                     repository"
                );
                Ok(false)
            }
            Err(error) => Err(error.into()),
        }
    }
}

// The names in `folder` that may be folders, its folders and its links, by the type the listing
// gives without reading each entry, and only those whose folded name holds `filter`.
fn read_candidate_names(folder: &Path, filter: Option<&str>) -> io::Result<Vec<OsString>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(folder)? {
        let entry = entry?;
        let name = entry.file_name();
        if let Some(filter) = filter
            && !fold_name(&name.to_string_lossy()).contains(filter)
        {
            continue;
        }
        let entry_type = match entry.file_type() {
            Ok(entry_type) => entry_type,
            // Gone since the listing named it.
            Err(error) if is_missing_entry(&error) => continue,
            Err(error) => return Err(error),
        };
        if entry_type.is_dir() || entry_type.is_symlink() {
            names.push(name);
        }
    }
    Ok(names)
}

// `name` when `folder`'s entry of that name is a folder, or a link to one, that the listing shows:
// hidden ones only when `is_hidden_shown`. Its read is held to the bounded read's ceiling; an
// entry gone since the listing, or whose read gets no answer in time (logged), is left out. Fails
// with the entry's read failure.
async fn read_folder_entry(
    folder: &Path,
    name: OsString,
    is_hidden_shown: bool,
) -> io::Result<Option<OsString>> {
    let path = folder.join(&name);
    let read = read_with_one_retry(
        || {
            let name = name.clone();
            read_within_ceiling(&path, move |path| {
                // The entry's own facts, no link followed, so a link's hidden mark is its own.
                let metadata = match std::fs::symlink_metadata(path) {
                    Ok(metadata) => metadata,
                    Err(error) if is_missing_entry(&error) => return Ok(false),
                    Err(error) => return Err(error),
                };
                Ok((is_hidden_shown || !is_hidden_entry(&name, &metadata))
                    && is_folder(path, &metadata))
            })
        },
        is_retryable_read_failure,
    )
    .await;
    match read {
        Ok(is_shown) => Ok(is_shown.then_some(name)),
        Err(timed_out) if timed_out.kind() == io::ErrorKind::TimedOut => {
            tracing::warn!(
                error = &timed_out as &(dyn Error + 'static),
                entry = %path.display(),
                "a folder entry's read got no answer in time; it is left out of the listing"
            );
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

// A folder, or a link to one; a link whose target cannot be read, whatever the reason (it leads
// nowhere, loops, lacks access, or sits on a network folder that failed), is no folder, never the
// listing's failure, and any reason but leading nowhere is logged.
fn is_folder(path: &Path, metadata: &Metadata) -> bool {
    if metadata.is_dir() {
        return true;
    }
    if !metadata.is_symlink() {
        return false;
    }
    match std::fs::metadata(path) {
        Ok(target) => target.is_dir(),
        Err(error) => {
            if !is_missing_entry(&error) {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    link = %path.display(),
                    "a link's target could not be read; it lists as no folder"
                );
            }
            false
        }
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

// The entry of `folder`'s folder `name`, with its path kept as bytes for git; `None`, logged, for a
// path the wire's cap refuses, longer than macOS and Linux open whole but one Windows still opens.
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
    use std::ffi::{OsStr, OsString};

    use icu_collator::CollatorPreferences;
    use rstest::rstest;
    use sidekicks_contracts::repo::folders::{
        MachineFolderListFolderRequest, MachineFolderListRequest, MachineFolderListResponse,
    };
    use sidekicks_platforms::{path_from_program_output, real_path};

    use super::{FolderListService, numeric_collator, sort_folder_names};
    use crate::file::bounded_read::stall_reads_of;
    use crate::git::process::{GitCall, test_git_runner};

    // Which read of the held folder never answers.
    #[derive(Clone, Copy, Debug)]
    enum HeldRead {
        // Its own entry's read.
        Entry,
        // A resolve its repository check makes, after its entry's read answered.
        RepositoryCheck,
    }

    // Catches a read past the ceiling that holds the listing, keeps the held folder listed, or
    // marks it a repository without its check.
    #[rstest]
    #[case::its_entry_read(HeldRead::Entry)]
    #[case::its_repository_check(HeldRead::RepositoryCheck)]
    #[tokio::test]
    async fn a_folder_whose_read_never_answers_leaves_the_rest_of_the_listing(
        #[case] held_read: HeldRead,
    ) {
        let git = test_git_runner();
        let temporary = tempfile::tempdir().expect("the temporary folder is made");
        let folder = real_path(temporary.path()).expect("the temporary folder resolves");
        let held = folder.join("held");
        std::fs::create_dir(folder.join("plain")).expect("the plain folder is made");
        git.run(None, GitCall::read([OsStr::new("init"), held.as_os_str()]))
            .await
            .expect("the held folder is a repository");
        let passed_reads = match held_read {
            HeldRead::Entry => 0,
            HeldRead::RepositoryCheck => 1,
        };
        let _held = stall_reads_of(&held, passed_reads);

        let listing = FolderListService::new(folder, git)
            .list(MachineFolderListRequest::Folder(
                MachineFolderListFolderRequest {
                    top: None,
                    place: None,
                    path: None,
                    filter: None,
                    show_hidden: None,
                },
            ))
            .await
            .expect("the listing answers");

        let MachineFolderListResponse::Folder(listing) = listing else {
            panic!("a folder's listing answers as a folder");
        };
        let entries: Vec<(&str, bool)> = listing
            .entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.is_repository))
            .collect();
        let expected = match held_read {
            HeldRead::Entry => vec![("plain", false)],
            HeldRead::RepositoryCheck => vec![("held", false), ("plain", false)],
        };
        assert_eq!(entries, expected);
    }

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
