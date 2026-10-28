//! Reads a review note's line from the file on its side of the comparison it was left in, as that
//! file reads now in the session's working folder. A note may sit on any line the diff draws,
//! context lines included, so its line is there while that side's file still has it.
//!
//! - The uncommitted changes compare `HEAD` with the working tree; a working file counts only when
//!   git lists it, tracked or untracked and not ignored.
//! - The branch compares `HEAD`, and a pull request its head commit, with where it left its base.
//! - Each file is read through git, so a symbolic link reads as its target's name and a file git
//!   calls binary has no lines. A file too large for git's output bound reads as having none.
//! - A path that leads outside the working folder is never read, so its note reads stranded.
//!
//! The person's diff settings never shape the read: fixed prefixes, no external or
//! text-converting driver, no color, no rename pairing.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use diffy::Line;
use diffy::patch_set::{ParseOptions, PatchKind, PatchSet, PatchSetParseError};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::review_note::{ReviewNoteComparison, ReviewNoteScope, ReviewNoteSide};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::{PathRules, resolve_path, resolve_path_against};
use sidekicks_std::missing_entry::is_gone;
use sidekicks_workspace::git::process::{
    GIT_OUTPUT_MAX_BYTES, GitCall, GitError, GitRunner, background_read,
};

/// A diff marks every line, so its output can run to twice the file; a quarter of git's output
/// bound leaves room for that and the headers.
const MAX_READ_FILE_BYTES: u64 = (GIT_OUTPUT_MAX_BYTES / 4) as u64;

/// git's exit code for `rev-parse --verify --quiet` and `merge-base` finding no commit.
const NOT_FOUND_EXIT_CODE: i32 = 1;

/// git's exit code for `diff --no-index` finding a difference, the answer a read wants.
const DIFFERENCE_EXIT_CODE: i32 = 1;

/// The name git reads as no file at all, compared before it looks at the disk, on every system.
const NO_FILE_PATH: &str = "/dev/null";

/// The fixed diff flags every read runs with.
const DIFF_FLAGS: [&str; 8] = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--unified=0",
    "--src-prefix=a/",
    "--dst-prefix=b/",
];

/// The members of a note that name its line in its comparison.
#[derive(Clone, Copy, Debug)]
pub(crate) struct NoteLocation<'a> {
    /// The comparison the note was left in.
    pub(crate) comparison: &'a ReviewNoteComparison,
    /// The file.
    pub(crate) path: &'a FilesystemPath,
    /// The file's earlier path, when it was renamed; the removed side reads it.
    pub(crate) old_path: Option<&'a FilesystemPath>,
    /// The line's side.
    pub(crate) side: ReviewNoteSide,
    /// The line, or the last of several; a range's first line comes at or before it, so its last
    /// line being there means every line of it is.
    pub(crate) line: SafeInt<1>,
}

/// Why a noted line could not be read.
#[derive(Debug, thiserror::Error)]
pub enum NotedLineError {
    /// git failed for a reason other than finding no commit or a difference.
    #[error("git could not read the noted file")]
    Git(#[from] GitError),
    /// The noted path could not be resolved against the working folder.
    #[error("the noted file's path could not be resolved against the working folder")]
    Path(#[source] io::Error),
    /// The noted file's entry in the working tree could not be read.
    #[error("the noted file's entry could not be read")]
    File(#[source] io::Error),
    /// git's diff of the noted file did not parse.
    #[error("git's diff of the noted file could not be read")]
    Patch(#[source] PatchSetParseError),
}

// Where a side's file is read from: a commit, or the working tree.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum FileSource {
    Commit(String),
    WorkingTree,
}

/// Reads notes' lines in one working folder, resolving each commit and merge base and reading
/// each file once however many notes sit on it. Made for one read of a session's notes, so a later
/// change to the folder is seen by the next reader, never by this one.
pub(crate) struct NotedLineReader {
    git: GitRunner,
    place: Option<Place>,
    folder: PathBuf,
    commits: HashMap<String, Option<String>>,
    merge_bases: HashMap<(String, String), Option<String>>,
    file_lines: HashMap<(FileSource, String), Option<Vec<String>>>,
    empty_tree: Option<String>,
}

impl NotedLineReader {
    /// A reader of notes' lines in `folder`, a project at `place`, read through `git`.
    pub(crate) fn new(git: GitRunner, place: Option<Place>, folder: PathBuf) -> Self {
        Self {
            git,
            place,
            folder,
            commits: HashMap::new(),
            merge_bases: HashMap::new(),
            file_lines: HashMap::new(),
            empty_tree: None,
        }
    }

    /// The text of `location`'s line in the file on its side of its comparison, or `None` when
    /// that file or that line is not there now, or the path leads outside the working folder.
    /// Fails with `Git` when git fails otherwise (`WslPlace` for a project in a WSL 2
    /// distribution), `Path` when the path cannot be resolved, `File` when the working file's
    /// entry cannot be read, and `Patch` when git's diff does not parse.
    pub(crate) async fn read(
        &mut self,
        location: &NoteLocation<'_>,
    ) -> Result<Option<String>, NotedLineError> {
        let Some(source) = self.source_of(location.comparison, location.side).await? else {
            return Ok(None);
        };
        let path = match location.side {
            ReviewNoteSide::Added => location.path,
            ReviewNoteSide::Removed => location.old_path.unwrap_or(location.path),
        };
        let key = (source, path.as_str().to_owned());
        if !self.file_lines.contains_key(&key) {
            let lines = self.read_lines(&key.0, &key.1).await?;
            self.file_lines.insert(key.clone(), lines);
        }
        let index = usize::try_from(location.line.get() - 1).ok();
        Ok(self
            .file_lines
            .get(&key)
            .and_then(Option::as_ref)
            .zip(index)
            .and_then(|(lines, index)| lines.get(index))
            .cloned())
    }

    // The commit or working tree a side reads its file from, or `None` when it names no commit.
    async fn source_of(
        &mut self,
        comparison: &ReviewNoteComparison,
        side: ReviewNoteSide,
    ) -> Result<Option<FileSource>, NotedLineError> {
        let (scope, base, head_commit_id) = match comparison {
            ReviewNoteComparison::Committed(committed) => (
                committed.scope,
                &committed.base,
                Some(&committed.head_commit_id),
            ),
            ReviewNoteComparison::WorkingTree(working_tree) => {
                (working_tree.scope, &working_tree.base, None)
            }
        };
        let head_revision = match scope {
            ReviewNoteScope::Changes => {
                return match side {
                    ReviewNoteSide::Added => Ok(Some(FileSource::WorkingTree)),
                    ReviewNoteSide::Removed => {
                        Ok(self.commit_of("HEAD").await?.map(FileSource::Commit))
                    }
                };
            }
            ReviewNoteScope::Branch => "HEAD",
            ReviewNoteScope::ChangeRequest => head_commit_id.map_or("HEAD", GitObjectId::as_str),
        };
        let Some(head) = self.commit_of(head_revision).await? else {
            return Ok(None);
        };
        match side {
            ReviewNoteSide::Added => Ok(Some(FileSource::Commit(head))),
            ReviewNoteSide::Removed => {
                let Some(base) = self.commit_of(base.as_str()).await? else {
                    return Ok(None);
                };
                Ok(self
                    .merge_base_of(base, head)
                    .await?
                    .map(FileSource::Commit))
            }
        }
    }

    // The lines of `path` from `source`, or `None` when it is not there or leads outside the
    // working folder.
    async fn read_lines(
        &mut self,
        source: &FileSource,
        path: &str,
    ) -> Result<Option<Vec<String>>, NotedLineError> {
        let Some(contained_path) = self.contained_path(path)? else {
            return Ok(None);
        };
        match source {
            FileSource::WorkingTree => self.read_working_lines(path, &contained_path).await,
            FileSource::Commit(commit_id) => self.read_committed_lines(commit_id, path).await,
        }
    }

    // `path` joined onto the working folder, or `None` when it leads outside it, so no note reads
    // a file elsewhere; a folder whose name is not UTF-8 holds nothing a note can name.
    fn contained_path(&self, path: &str) -> Result<Option<PathBuf>, NotedLineError> {
        let Some(folder) = self.folder.to_str() else {
            return Ok(None);
        };
        let folder = resolve_path(folder).map_err(NotedLineError::Path)?;
        let joined = resolve_path_against(&folder, path).map_err(NotedLineError::Path)?;
        let joined = PathBuf::from(joined);
        Ok(PathRules::NATIVE
            .is_within(Path::new(&folder), &joined)
            .then_some(joined))
    }

    async fn read_committed_lines(
        &mut self,
        commit_id: &str,
        path: &str,
    ) -> Result<Option<Vec<String>>, NotedLineError> {
        // `./` reads the path from the working folder, as a pathspec reads it, rather than from
        // the repository's top.
        let described = self
            .run_read(&[
                "cat-file",
                "--batch-check=%(objecttype) %(objectsize)",
                "-Z",
            ])
            .with_input(format!("{commit_id}:./{path}\0").into_bytes());
        let described = self.git.run(self.place.as_ref(), described).await?;
        // A missing path answers `<input> missing`, whose first word is never `blob`.
        let mut fields = described
            .stdout
            .split(|byte| *byte == b' ' || *byte == b'\0');
        let is_blob = fields.next() == Some(b"blob".as_slice());
        let fits = fields
            .next()
            .and_then(|size| std::str::from_utf8(size).ok())
            .and_then(|size| size.parse::<u64>().ok())
            .is_some_and(|size| size <= MAX_READ_FILE_BYTES);
        if !(is_blob && fits) {
            return Ok(None);
        }
        let empty_tree = self.empty_tree_id().await?;
        let literal_path = format!(":(literal){path}");
        let mut arguments: Vec<&str> = DIFF_FLAGS.to_vec();
        arguments.extend([empty_tree.as_str(), commit_id, "--", literal_path.as_str()]);
        let patch = self
            .git
            .run(self.place.as_ref(), self.run_read(&arguments))
            .await?;
        added_lines_of(&patch.stdout).map(Some)
    }

    async fn read_working_lines(
        &self,
        path: &str,
        contained_path: &Path,
    ) -> Result<Option<Vec<String>>, NotedLineError> {
        let literal_path = format!(":(literal){path}");
        let listed = self.run_read(&[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            &literal_path,
        ]);
        if self
            .git
            .run(self.place.as_ref(), listed)
            .await?
            .stdout
            .is_empty()
        {
            return Ok(None);
        }
        let metadata = match tokio::fs::symlink_metadata(contained_path).await {
            Ok(metadata) => metadata,
            // A listed file deleted since, or a folder on its path replaced by a file.
            Err(error) if is_gone(&error) => return Ok(None),
            Err(error) => return Err(NotedLineError::File(error)),
        };
        // A folder (a submodule's checkout) or a special file such as a pipe has no lines to read.
        let file_type = metadata.file_type();
        if !(file_type.is_file() || file_type.is_symlink()) || metadata.len() > MAX_READ_FILE_BYTES
        {
            return Ok(None);
        }
        let mut arguments: Vec<&str> = DIFF_FLAGS.to_vec();
        arguments.extend(["--no-index", "--", NO_FILE_PATH, path]);
        match self
            .git
            .run(self.place.as_ref(), self.run_read(&arguments))
            .await
        {
            // No difference from no file is an empty file.
            Ok(_) => Ok(Some(Vec::new())),
            // git exits 1 both for a difference and for a file it could not read; only the second
            // prints nothing and names its failure, then a file gone since the check has no lines.
            Err(GitError::Exited {
                code: Some(DIFFERENCE_EXIT_CODE),
                stdout,
                stderr,
                ..
            }) if stdout.is_empty() && !stderr.is_empty() => {
                let metadata_after_refusal = tokio::fs::symlink_metadata(contained_path).await;
                lines_of_refused_diff(stdout, stderr, metadata_after_refusal)
            }
            Err(GitError::Exited {
                code: Some(DIFFERENCE_EXIT_CODE),
                stdout,
                ..
            }) => added_lines_of(&stdout).map(Some),
            Err(error) => Err(error.into()),
        }
    }

    async fn commit_of(&mut self, revision: &str) -> Result<Option<String>, GitError> {
        if let Some(commit) = self.commits.get(revision) {
            return Ok(commit.clone());
        }
        let revision_commit = format!("{revision}^{{commit}}");
        let commit = self
            .read_commit_or_none(&[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                &revision_commit,
            ])
            .await?;
        self.commits.insert(revision.to_owned(), commit.clone());
        Ok(commit)
    }

    async fn merge_base_of(
        &mut self,
        base: String,
        head: String,
    ) -> Result<Option<String>, GitError> {
        let key = (base, head);
        if let Some(merge_base) = self.merge_bases.get(&key) {
            return Ok(merge_base.clone());
        }
        let merge_base = self
            .read_commit_or_none(&["merge-base", &key.0, &key.1])
            .await?;
        self.merge_bases.insert(key, merge_base.clone());
        Ok(merge_base)
    }

    // The commit id a command prints, or `None` when it exits saying it found none.
    async fn read_commit_or_none(&self, arguments: &[&str]) -> Result<Option<String>, GitError> {
        match self
            .git
            .run(self.place.as_ref(), self.run_read(arguments))
            .await
        {
            Ok(output) => Ok(Some(
                String::from_utf8_lossy(&output.stdout).trim().to_owned(),
            )),
            Err(GitError::Exited {
                code: Some(NOT_FOUND_EXIT_CODE),
                ..
            }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    // The repository's empty tree, in its own object format, to diff a committed file against.
    async fn empty_tree_id(&mut self) -> Result<String, GitError> {
        if let Some(empty_tree) = &self.empty_tree {
            return Ok(empty_tree.clone());
        }
        let hashed = self
            .run_read(&["hash-object", "-t", "tree", "--stdin"])
            .with_input(Vec::new());
        let hashed = self.git.run(self.place.as_ref(), hashed).await?;
        let empty_tree = String::from_utf8_lossy(&hashed.stdout).trim().to_owned();
        self.empty_tree = Some(empty_tree.clone());
        Ok(empty_tree)
    }

    // A read in the working folder that takes no optional lock.
    fn run_read(&self, arguments: &[&str]) -> GitCall {
        GitCall::read(background_read(&self.folder, arguments))
    }
}

// The answer to a diff that exited 1 printing nothing and naming a failure: no lines when the
// file's re-stat after it finds the file gone, else git's failure.
fn lines_of_refused_diff(
    stdout: Vec<u8>,
    stderr: String,
    metadata_after_refusal: io::Result<std::fs::Metadata>,
) -> Result<Option<Vec<String>>, NotedLineError> {
    match metadata_after_refusal {
        Err(error) if is_gone(&error) => Ok(None),
        Ok(_) | Err(_) => Err(GitError::Exited {
            code: Some(DIFFERENCE_EXIT_CODE),
            signal: None,
            stdout,
            stderr,
        }
        .into()),
    }
}

// The lines of a diff against nothing, which are every line of the file, in order, each decoded
// lossily since a note quotes text; a file git calls binary has none.
fn added_lines_of(patch_text: &[u8]) -> Result<Vec<String>, NotedLineError> {
    let mut lines = Vec::new();
    // An empty answer holds no patch, which the parser refuses.
    if patch_text.is_empty() {
        return Ok(lines);
    }
    for file_patch in PatchSet::parse_bytes(patch_text, ParseOptions::gitdiff()) {
        let file_patch = file_patch.map_err(NotedLineError::Patch)?;
        let patch = match file_patch.patch() {
            PatchKind::Text(patch) => patch,
            PatchKind::Binary(_) => continue,
        };
        for hunk in patch.hunks() {
            for line in hunk.lines() {
                match line {
                    Line::Insert(text) => lines.push(line_text_of(text)),
                    Line::Context(_) | Line::Delete(_) => {}
                }
            }
        }
    }
    Ok(lines)
}

// A diff line's text without its line end, `\r\n` included.
fn line_text_of(line: &[u8]) -> String {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    String::from_utf8_lossy(line).into_owned()
}

#[cfg(test)]
mod tests {

    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::repo::git_reads::GitObjectId;
    use sidekicks_contracts::review_note::{
        ReviewNoteComparison, ReviewNoteScope, ReviewNoteSide, WorkingTreeReviewNoteComparison,
    };
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::text::NonEmptyText;
    use sidekicks_workspace::git::process::test_repository::git_in;
    use sidekicks_workspace::git::process::{GitError, test_git_runner};

    use super::{NoteLocation, NotedLineError, NotedLineReader, lines_of_refused_diff};

    fn file_path(path: &str) -> FilesystemPath {
        FilesystemPath::new(path.to_owned()).expect("the path is a filesystem path")
    }

    // Fails when a diff git could not read is answered as a present empty file, or when a file
    // still there after it hides git's failure.
    #[rstest::rstest]
    #[case::gone(true)]
    #[case::present(false)]
    fn diff_line_reads_a_refused_diff_by_the_files_re_stat(#[case] is_file_gone: bool) {
        let folder = tempfile::tempdir().expect("the temporary folder is made");
        let metadata_after_refusal = if is_file_gone {
            std::fs::symlink_metadata(folder.path().join("gone.txt"))
        } else {
            std::fs::symlink_metadata(folder.path())
        };
        let stderr = String::from("error: Could not access 'gone.txt'\n");
        let answer = lines_of_refused_diff(Vec::new(), stderr.clone(), metadata_after_refusal);
        if is_file_gone {
            assert!(
                matches!(answer, Ok(None)),
                "a gone file has no lines: {answer:?}"
            );
        } else {
            assert!(
                matches!(
                    &answer,
                    Err(NotedLineError::Git(GitError::Exited {
                        code: Some(1),
                        signal: None,
                        stdout,
                        stderr: answered,
                    })) if stdout.is_empty() && *answered == stderr
                ),
                "a file still there keeps git's failure: {answer:?}"
            );
        }
    }

    // Fails when either side reads a file the note's path or earlier path leads to outside the
    // working folder, or when the containment check refuses a path inside it.
    #[tokio::test]
    async fn diff_line_refuses_a_path_outside_the_folder_on_both_sides() {
        let git = test_git_runner();
        // The repository holds the working folder, so `../` still names a file git can read.
        let repository = tempfile::tempdir().expect("the temporary folder is made");
        let folder = repository.path().join("folder");
        std::fs::create_dir_all(&folder).expect("the working folder is made");
        std::fs::write(repository.path().join("secret.txt"), "secret\n")
            .expect("the outside file is written");
        std::fs::write(folder.join("inside.txt"), "inside\n").expect("the inside file is written");
        git_in(&git, repository.path(), &["init"]).await;
        git_in(&git, repository.path(), &["add", "--all"]).await;
        git_in(
            &git,
            repository.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "--message=first",
            ],
        )
        .await;
        let comparison = ReviewNoteComparison::WorkingTree(WorkingTreeReviewNoteComparison {
            scope: ReviewNoteScope::Changes,
            base: NonEmptyText::new("HEAD".to_owned()).expect("the base is not empty"),
            working_tree_blob_id: GitObjectId::new("0".repeat(40))
                .expect("forty hex digits name an object"),
            request_number: None,
        });
        let inside = file_path("inside.txt");
        let outside = file_path("../secret.txt");
        let mut reader = NotedLineReader::new(git, None, folder);

        let mut read = Vec::new();
        for (side, path, old_path) in [
            (ReviewNoteSide::Added, &inside, None),
            (ReviewNoteSide::Removed, &inside, None),
            (ReviewNoteSide::Added, &outside, None),
            (ReviewNoteSide::Removed, &inside, Some(&outside)),
        ] {
            let location = NoteLocation {
                comparison: &comparison,
                path,
                old_path,
                side,
                line: SafeInt::<1>::new(1).expect("one is a line"),
            };
            read.push(reader.read(&location).await.expect("the line is read"));
        }

        assert_eq!(
            read,
            [
                Some("inside".to_owned()),
                Some("inside".to_owned()),
                None,
                None
            ]
        );
    }
}
