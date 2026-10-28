//! The git reads behind the switcher's rows, the branch list, the working-folder watch, creation
//! and Put back: the trees git lists for a repository, each branch's distance from its upstream,
//! refs' commits and a branch's holding tree, every branch's name, the paths a tree has
//! uncommitted, the branch a folder is on, its own git folder, a linked tree's record and the
//! record a `.git` file names. Every answer but the last is git's own; the last reads the `.git`
//! file itself, so it answers even when the record it names is gone.
//!
//! Each git read runs in the background with no optional lock, so it never rewrites the index
//! under a run working in the same tree. Output stays bytes, and a path git prints is read back as
//! the path it names; a git that prints something these reads cannot parse fails with
//! [`GitError::Read`].

use std::borrow::Cow;
use std::collections::HashMap;
use std::io;
use std::num::ParseIntError;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use memchr::memmem;
use sidekicks_contracts::free_form_string::FILE_PATH_MAX_LEN;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};
use sidekicks_platforms::path_from_program_output;
use sidekicks_std::missing_entry::is_missing_entry;

use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::{
    GitCall, GitError, GitRunner, background_read, strip_carriage_return, strip_line_end,
};

/// The prefix of every local branch's full ref name.
pub(crate) const BRANCH_REF_PREFIX: &str = "refs/heads/";

/// The folder in a repository's git common folder that holds a record per linked tree.
pub(crate) const LINKED_RECORDS_FOLDER_NAME: &str = "worktrees";

const REMOTE_REF_PREFIX: &[u8] = b"refs/remotes/";
const REMOTE_HEAD_SUFFIX: &[u8] = b"/HEAD";
// The name git's own `clone` gives its remote, preferred when several remotes name a default.
const CLONE_REMOTE_NAME: &[u8] = b"origin";

// git's exit when it refuses an option it does not know, as a git older than 2.36 refuses `-z`
// on `worktree list`.
const UNKNOWN_OPTION_EXIT_CODE: i32 = 129;
// git's exit when the folder it was asked from is in no repository.
const NOT_A_REPOSITORY_EXIT_CODE: i32 = 128;
// `symbolic-ref --quiet`'s exit for a HEAD that names no branch.
const DETACHED_HEAD_EXIT_CODE: i32 = 1;

// What a `.git` file starts with when it names a record elsewhere.
const GIT_FILE_PREFIX: &[u8] = b"gitdir: ";

/// One record `git worktree list` prints for a repository.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "each flag is one fact git prints, or the read knows, of a tree"
)]
pub(crate) struct ListedWorktree {
    /// The tree's folder as git records it, not resolved.
    pub(crate) path: PathBuf,
    /// Whether git printed the path NUL-ended (`-z`), so it is exact; false from a git that refuses
    /// `-z`, whose newline-ended records split a path holding a newline.
    pub(crate) is_path_exact: bool,
    /// The branch it has checked out, or `None` while its HEAD is detached.
    pub(crate) branch_name: Option<String>,
    /// The commit its HEAD names; `None` on a branch with no commit yet, and on a bare record.
    pub(crate) head_commit: Option<String>,
    /// The repository's own checkout: git's first record, when that record has a working folder.
    pub(crate) is_main_checkout: bool,
    /// A bare repository's own record, which has no working folder.
    pub(crate) is_bare: bool,
    /// git can no longer find the folder, so it would prune the record.
    pub(crate) is_prunable: bool,
    /// Whether the record is locked against pruning and moving.
    pub(crate) is_locked: bool,
    /// The reason the lock gives, or `None` for a lock without one and an unlocked record.
    pub(crate) lock_reason: Option<String>,
}

/// One local branch with the facts the branch list and the switcher draw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BranchFigures {
    /// The branch's name, without `refs/heads/`.
    pub(crate) name: String,
    /// Commits ahead of its upstream; `None` when it has none or the upstream is gone.
    pub(crate) ahead: Option<u64>,
    /// Commits behind its upstream; `None` when it has none or the upstream is gone.
    pub(crate) behind: Option<u64>,
    /// When its newest commit was made, in seconds since the epoch.
    pub(crate) newest_commit_seconds: i64,
    /// The folder of the tree that has it checked out, or `None` when none has.
    pub(crate) checked_out_at: Option<PathBuf>,
}

/// A count of commits as the wire carries it, which no repository brings near the safe integer's
/// bound.
pub(crate) fn commit_count(count: u64) -> SafeInt<0> {
    SafeInt::new(count).expect("a count of commits is a safe integer")
}

/// A tree's name as the wire carries it: its folder's last part. Fails when that part is no text
/// the wire carries (absent, blank, or past a path's length).
pub(crate) fn tree_name_of(folder: &Path) -> Result<FreeFormText<FILE_PATH_MAX_LEN>, TextError> {
    FreeFormText::new(
        folder
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    )
}

/// A ref's commit and, for a branch, the tree git lists with it checked out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RefHead {
    /// The commit the ref names.
    pub(crate) commit: String,
    /// The folder of a tree git lists with the branch checked out, or `None` when none has.
    pub(crate) checked_out_at: Option<PathBuf>,
}

/// Why the record of a linked tree could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum LinkedTreeRecordError {
    /// git's read failed, or printed something other than three folders.
    #[error(transparent)]
    Git(#[from] GitError),
    /// The tree's folder, or the top level git named, could not be resolved to compare them.
    #[error("a tree's folder could not be resolved to compare it with git's")]
    Resolve(#[source] io::Error),
}

/// Lists every record git keeps of a tree for the repository at `repository_root` of a project at
/// `place`, in git's order, a bare repository's own record included; paths are as git recorded
/// them, not resolved. Asks for NUL-ended records first and reads the newline form from a git
/// that refuses `-z`. Each call is held to `timeout` (the runner's bound when `None`). Fails as
/// [`GitRunner::run`] does, with `PathText` for a path this system
/// cannot name and `Read` for a record git printed without its folder or with a quote it never
/// writes.
#[cfg_attr(not(test), expect(dead_code, reason = "the worktree service's reads"))]
pub(crate) async fn read_listed_worktrees(
    git: &GitRunner,
    place: Option<&Place>,
    repository_root: &Path,
    timeout: Option<Duration>,
) -> Result<Vec<ListedWorktree>, GitError> {
    let listing = git
        .run(
            place,
            GitCall::read(background_read(
                repository_root,
                &["worktree", "list", "--porcelain", "-z"],
            ))
            .with_timeout(timeout),
        )
        .await;
    match listing {
        Ok(output) => parse_listed_worktrees(output.stdout.split(|byte| *byte == 0), true),
        Err(GitError::Exited {
            code: Some(UNKNOWN_OPTION_EXIT_CODE),
            ..
        }) => {
            let output = git
                .run(
                    place,
                    GitCall::read(background_read(
                        repository_root,
                        &["worktree", "list", "--porcelain"],
                    ))
                    .with_timeout(timeout),
                )
                .await?;
            parse_listed_worktrees(output_lines(&output.stdout), false)
        }
        Err(failure) => Err(failure),
    }
}

// The records of a `worktree list --porcelain` listing given as its fields: runs of fields, each
// run ended by an empty one.
fn parse_listed_worktrees<'listing>(
    fields: impl Iterator<Item = &'listing [u8]>,
    is_path_exact: bool,
) -> Result<Vec<ListedWorktree>, GitError> {
    let mut worktrees = Vec::new();
    let mut record = Vec::new();
    for field in fields {
        if !field.is_empty() {
            record.push(field);
            continue;
        }
        if !record.is_empty() {
            worktrees.push(parse_worktree_record(
                &record,
                worktrees.is_empty(),
                is_path_exact,
            )?);
            record.clear();
        }
    }
    if !record.is_empty() {
        worktrees.push(parse_worktree_record(
            &record,
            worktrees.is_empty(),
            is_path_exact,
        )?);
    }
    Ok(worktrees)
}

// One record's fields read into a tree. git prints the folder as it stands in either form, so it
// is never unquoted; it C-quotes only a newline-ended record's lock reason.
fn parse_worktree_record(
    fields: &[&[u8]],
    is_first: bool,
    is_path_exact: bool,
) -> Result<ListedWorktree, GitError> {
    let lock_reason_of = |value: &[u8]| -> Result<Vec<u8>, GitError> {
        if is_path_exact {
            return Ok(value.to_vec());
        }
        unquote_git_text(value)
            .map(Cow::into_owned)
            .ok_or_else(|| malformed("git quoted a value with an escape it never writes"))
    };
    let mut path = None;
    let mut branch_name = None;
    let mut head_commit = None;
    let mut is_bare = false;
    let mut is_prunable = false;
    let mut is_locked = false;
    let mut lock_reason = None;
    for field in fields {
        let (label, value) = match field.iter().position(|byte| *byte == b' ') {
            Some(space) => (&field[..space], Some(&field[space + 1..])),
            None => (*field, None),
        };
        match label {
            b"worktree" => {
                let value = value
                    .ok_or_else(|| malformed("git listed a tree with an empty folder field"))?;
                path = Some(path_from_program_output(value.to_vec()).map_err(GitError::PathText)?);
            }
            // An unborn branch prints the all-zero name.
            b"HEAD" => {
                head_commit = value
                    .filter(|commit| !commit.iter().all(|byte| *byte == b'0'))
                    .map(|commit| String::from_utf8_lossy(commit).into_owned());
            }
            b"branch" => {
                branch_name = value.map(|reference| {
                    let name = reference
                        .strip_prefix(BRANCH_REF_PREFIX.as_bytes())
                        .unwrap_or(reference);
                    String::from_utf8_lossy(name).into_owned()
                });
            }
            b"bare" => is_bare = true,
            b"prunable" => is_prunable = true,
            b"locked" => {
                is_locked = true;
                lock_reason = value
                    .map(lock_reason_of)
                    .transpose()?
                    .map(|reason| String::from_utf8_lossy(&reason).into_owned());
            }
            // `detached`, and any field a newer git adds.
            _ => {}
        }
    }
    let path = path.ok_or_else(|| malformed("git listed a tree without its folder"))?;
    Ok(ListedWorktree {
        path,
        is_path_exact,
        branch_name,
        head_commit,
        is_main_checkout: is_first && !is_bare,
        is_bare,
        is_prunable,
        is_locked,
        lock_reason,
    })
}

// A value git printed C-quoted where it needed quoting (`"a\"b\303\251"` reads `a"bé`): a
// backslash escape for a quote, a backslash and the control characters, three octal digits for
// any other byte, each one byte of the name. A value not wrapped in quotes is git's as it stands.
// `None` for an escape git never writes.
fn unquote_git_text(value: &[u8]) -> Option<Cow<'_, [u8]>> {
    let Some(mut rest) = value
        .strip_prefix(b"\"")
        .and_then(|inner| inner.strip_suffix(b"\""))
    else {
        return Some(Cow::Borrowed(value));
    };
    let mut bytes = Vec::with_capacity(rest.len());
    while let Some((&byte, after)) = rest.split_first() {
        rest = after;
        if byte != b'\\' {
            bytes.push(byte);
            continue;
        }
        let (&escape, after) = rest.split_first()?;
        rest = after;
        let unescaped = match escape {
            b'a' => 0x07,
            b'b' => 0x08,
            b't' => b'\t',
            b'n' => b'\n',
            b'v' => 0x0b,
            b'f' => 0x0c,
            b'r' => b'\r',
            b'"' => b'"',
            b'\\' => b'\\',
            // A byte's three octal digits, the first at most 3 since a byte ends at 0o377.
            b'0'..=b'3' => {
                let (&[middle, last], after) = rest.split_first_chunk::<2>()?;
                let octal_digits = b'0'..=b'7';
                if !octal_digits.contains(&middle) || !octal_digits.contains(&last) {
                    return None;
                }
                rest = after;
                (escape - b'0') * 64 + (middle - b'0') * 8 + (last - b'0')
            }
            _ => return None,
        };
        bytes.push(unescaped);
    }
    Some(Cow::Owned(bytes))
}

/// Reads every local branch of the repository at `repository_root` with its upstream distance,
/// newest commit and holding tree. Fails as [`GitRunner::run`] does, with `PathText` for a holding
/// tree this system cannot name and `Read` for a record git printed that does not parse.
pub(crate) async fn read_branch_figures(
    git: &GitRunner,
    place: Option<&Place>,
    repository_root: &Path,
) -> Result<Vec<BranchFigures>, GitError> {
    // Each record's fields end in NUL and the record in a NUL and git's newline, so a folder name
    // holding a newline cannot split a record.
    let output = git
        .run(
            place,
            GitCall::read(background_read(
                repository_root,
                &[
                    "for-each-ref",
                    "--format=%(refname)%00%(upstream)%00%(upstream:track,nobracket)%00\
                     %(committerdate:unix)%00%(worktreepath)%00",
                    BRANCH_REF_PREFIX,
                ],
            )),
        )
        .await?;
    ref_records(&output.stdout)
        .map(|record| {
            let mut fields = record.split(|byte| *byte == 0);
            let mut field = || fields.next().unwrap_or_default();
            let (ref_name, upstream, track, committed_at, checked_out_at) =
                (field(), field(), field(), field(), field());
            let distance = if upstream.is_empty() {
                None
            } else {
                parse_upstream_track(track)?
            };
            Ok(BranchFigures {
                name: String::from_utf8_lossy(
                    ref_name
                        .strip_prefix(BRANCH_REF_PREFIX.as_bytes())
                        .unwrap_or(ref_name),
                )
                .into_owned(),
                ahead: distance.map(|(ahead, _)| ahead),
                behind: distance.map(|(_, behind)| behind),
                newest_commit_seconds: parse_number(committed_at)?,
                checked_out_at: optional_path(checked_out_at)?,
            })
        })
        .collect()
}

// `upstream:track,nobracket` prints `ahead 2, behind 1`, either half alone, nothing when the two
// are level, or `gone` when the upstream branch no longer exists (`None`).
fn parse_upstream_track(track: &[u8]) -> Result<Option<(u64, u64)>, GitError> {
    if track == b"gone" {
        return Ok(None);
    }
    let (mut ahead, mut behind) = (0, 0);
    for part in memmem::find_iter(track, b", ")
        .chain([track.len()])
        .scan(0, |start, end| {
            let part = &track[*start..end];
            *start = end + 2;
            Some(part)
        })
        .filter(|part| !part.is_empty())
    {
        if let Some(count) = part.strip_prefix(b"ahead ") {
            ahead = parse_number(count)?;
        } else if let Some(count) = part.strip_prefix(b"behind ") {
            behind = parse_number(count)?;
        } else {
            return Err(malformed(
                "git printed an upstream distance it never writes",
            ));
        }
    }
    Ok(Some((ahead, behind)))
}

/// Reads, in one git call, the commit and holding tree of each of `ref_names` (full names) that
/// exists in the repository at `repository_folder`, by full name; a ref that does not exist has
/// no entry. Fails as [`GitRunner::run`] does, with `PathText` for a holding tree this system
/// cannot name.
#[expect(dead_code, reason = "the worktree service's reads")]
pub(crate) async fn read_ref_heads(
    git: &GitRunner,
    place: Option<&Place>,
    repository_folder: &Path,
    ref_names: &[&str],
) -> Result<HashMap<String, RefHead>, GitError> {
    let mut arguments = vec![
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(worktreepath)%00",
    ];
    arguments.extend_from_slice(ref_names);
    let output = git
        .run(
            place,
            GitCall::read(background_read(repository_folder, &arguments)),
        )
        .await?;
    let mut heads = HashMap::new();
    for record in ref_records(&output.stdout) {
        let mut fields = record.split(|byte| *byte == 0);
        let mut field = || fields.next().unwrap_or_default();
        let (ref_name, commit, checked_out_at) = (field(), field(), field());
        // A pattern also matches the refs below it, so only the names asked for are kept.
        let Some(asked) = ref_names.iter().find(|asked| asked.as_bytes() == ref_name) else {
            continue;
        };
        heads.insert(
            (*asked).to_owned(),
            RefHead {
                commit: String::from_utf8_lossy(commit).into_owned(),
                checked_out_at: optional_path(checked_out_at)?,
            },
        );
    }
    Ok(heads)
}

/// Whether the repository at `repository_folder` has a local branch named `branch`. Fails as
/// [`read_ref_heads`] does.
#[expect(dead_code, reason = "the worktree service's reads")]
pub(crate) async fn has_branch(
    git: &GitRunner,
    place: Option<&Place>,
    repository_folder: &Path,
    branch: &str,
) -> Result<bool, GitError> {
    let ref_name = format!("{BRANCH_REF_PREFIX}{branch}");
    Ok(
        read_ref_heads(git, place, repository_folder, &[ref_name.as_str()])
            .await?
            .contains_key(&ref_name),
    )
}

/// Every local branch's name in the repository at `repository_folder`, in git's order, each read
/// as UTF-8 with any other byte replaced. Fails as [`GitRunner::run`] does.
#[expect(dead_code, reason = "worktree creation")]
pub(crate) async fn read_branch_names(
    git: &GitRunner,
    place: Option<&Place>,
    repository_folder: &Path,
) -> Result<Vec<String>, GitError> {
    let output = git
        .run(
            place,
            GitCall::read(background_read(
                repository_folder,
                &[
                    "for-each-ref",
                    "--format=%(refname:lstrip=2)",
                    BRANCH_REF_PREFIX,
                ],
            )),
        )
        .await?;
    Ok(output
        .stdout
        .split(|byte| *byte == b'\n')
        .map(strip_carriage_return)
        .filter(|name| !name.is_empty())
        .map(|name| String::from_utf8_lossy(name).into_owned())
        .collect())
}

/// Names the default branch of the repository at `repository_root`: the branch a remote's HEAD
/// names, the clone's own remote first; `None` when no remote names one. Fails as
/// [`GitRunner::run`] does.
pub(crate) async fn read_remote_default_branch(
    git: &GitRunner,
    place: Option<&Place>,
    repository_root: &Path,
) -> Result<Option<String>, GitError> {
    let output = git
        .run(
            place,
            GitCall::read(background_read(
                repository_root,
                &[
                    "for-each-ref",
                    "--format=%(refname)%00%(symref)",
                    "refs/remotes/",
                ],
            )),
        )
        .await?;
    let mut defaults = Vec::new();
    for line in output_lines(&output.stdout) {
        let mut fields = line.splitn(2, |byte| *byte == 0);
        let (Some(ref_name), Some(target)) = (fields.next(), fields.next()) else {
            continue;
        };
        let Some(remote) = ref_name
            .strip_prefix(REMOTE_REF_PREFIX)
            .and_then(|name| name.strip_suffix(REMOTE_HEAD_SUFFIX))
        else {
            continue;
        };
        // The HEAD names a branch of its own remote: `refs/remotes/<remote>/<branch>`.
        let remote_prefix = &ref_name[..ref_name.len() - b"HEAD".len()];
        let Some(branch) = target
            .strip_prefix(remote_prefix)
            .filter(|branch| !branch.is_empty())
        else {
            continue;
        };
        defaults.push((remote, branch));
    }
    Ok(defaults
        .iter()
        .find(|(remote, _)| *remote == CLONE_REMOTE_NAME)
        .or(defaults.first())
        .map(|(_, branch)| String::from_utf8_lossy(branch).into_owned()))
}

/// Lists the paths `git status` reports in `folder`, relative to it: changed, staged, unmerged and
/// untracked files, each untracked file named on its own, a rename by its new path alone; ignored
/// files are not listed. Fails as [`GitRunner::run`] does, with `PathText` for a path this system
/// cannot name and `Read` for an entry git printed that does not parse.
pub(crate) async fn read_uncommitted_paths(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
) -> Result<Vec<PathBuf>, GitError> {
    let output = git
        .run(
            place,
            GitCall::live_index_read(
                folder,
                &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
            ),
        )
        .await?;
    let mut paths = Vec::new();
    let mut fields = output.stdout.split(|byte| *byte == 0);
    while let Some(field) = fields.next() {
        // `1` ordinary, `2` renamed or copied (its original path follows in the next field),
        // `u` unmerged, `?` untracked; the path is the last of a fixed count of space-separated
        // parts, so a path holding a space stays whole.
        let path = match field.first() {
            Some(b'1') => last_part(field, 9)?,
            Some(b'2') => {
                fields.next();
                last_part(field, 10)?
            }
            Some(b'u') => last_part(field, 11)?,
            Some(b'?') => field
                .get(2..)
                .ok_or_else(|| malformed("git listed an untracked file without its path"))?,
            Some(_) | None => continue,
        };
        paths.push(path_from_program_output(path.to_vec()).map_err(GitError::PathText)?);
    }
    Ok(paths)
}

// The last of `part_count` space-separated parts of a status entry, the path.
fn last_part(entry: &[u8], part_count: usize) -> Result<&[u8], GitError> {
    entry
        .splitn(part_count, |byte| *byte == b' ')
        .nth(part_count - 1)
        .ok_or_else(|| malformed("git listed a status entry with fewer parts than its kind has"))
}

/// The branch `folder` has checked out, or `None` while its HEAD is detached or names no branch.
/// Fails as [`GitRunner::run`] does.
pub(crate) async fn read_current_branch(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
) -> Result<Option<String>, GitError> {
    // The full name, since `--short` prints `heads/<name>` for a branch a tag shares a name with.
    let output = git
        .run(
            place,
            GitCall::read(background_read(
                folder,
                &["symbolic-ref", "--quiet", "HEAD"],
            )),
        )
        .await;
    let ref_name = match output {
        Ok(output) => strip_line_end(output.stdout),
        // `--quiet` makes a detached HEAD exit 1 with nothing printed.
        Err(GitError::Exited {
            code: Some(DETACHED_HEAD_EXIT_CODE),
            ..
        }) => return Ok(None),
        Err(failure) => return Err(failure),
    };
    Ok(ref_name
        .strip_prefix(BRANCH_REF_PREFIX.as_bytes())
        .map(|name| String::from_utf8_lossy(name).into_owned()))
}

/// The folder that holds `folder`'s own HEAD and index: the checkout's git folder, or for a linked
/// tree its record inside the repository's. Fails as [`GitRunner::run`] does, with `PathText` for
/// a path this system cannot name and `Read` for an answer that names no folder.
pub(crate) async fn read_tree_git_folder(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
) -> Result<PathBuf, GitError> {
    let output = git
        .run(
            place,
            GitCall::read(background_read(
                folder,
                &["rev-parse", "--path-format=absolute", "--git-path", "HEAD"],
            )),
        )
        .await?;
    let head =
        path_from_program_output(strip_line_end(output.stdout)).map_err(GitError::PathText)?;
    head.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| malformed("git named a HEAD file outside any folder"))
}

/// The git common folder that holds `record_folder`, a linked tree's `<common>/worktrees/<name>`;
/// `None` for a path too short to be one.
#[cfg_attr(not(test), expect(dead_code, reason = "the worktree service's reads"))]
pub(crate) fn common_folder_of_record(record_folder: &Path) -> Option<&Path> {
    record_folder.parent().and_then(Path::parent)
}

/// The record git keeps of the linked tree at `tree_folder`, `<common folder>/worktrees/<name>`,
/// as git names it from inside the tree; `None` when git answers that the folder is in no
/// repository, when the folder is not a working tree's top level (its `.git` is gone and git
/// answered for a tree around it), or when its git folder is not a linked tree's record (a main
/// checkout's own `.git`), so a caller removing the record can never reach anything else. Fails
/// with git's failure, a `Read` failure when git prints other than three folders, or the
/// resolve's failure when a folder cannot be compared.
#[cfg_attr(not(test), expect(dead_code, reason = "the worktree service's reads"))]
pub(crate) async fn read_linked_tree_record(
    git: &GitRunner,
    place: Option<&Place>,
    tree_folder: &Path,
) -> Result<Option<PathBuf>, LinkedTreeRecordError> {
    let output = git
        .run(
            place,
            GitCall::read(background_read(
                tree_folder,
                &[
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-dir",
                    "--git-common-dir",
                    "--show-toplevel",
                ],
            )),
        )
        .await;
    let output = match output {
        Ok(output) => output,
        Err(failure) if failure.exit_code() == Some(NOT_A_REPOSITORY_EXIT_CODE) => {
            return Ok(None);
        }
        Err(failure) => return Err(failure.into()),
    };
    // A folder holding a newline adds a line, so the answer fails rather than misreads.
    let mut lines: Vec<&[u8]> = output_lines(&output.stdout).collect();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let [record_folder, common_folder, top_level] = lines[..] else {
        return Err(malformed("git rev-parse printed something other than three folders").into());
    };
    let path_of =
        |folder: &[u8]| path_from_program_output(folder.to_vec()).map_err(GitError::PathText);
    let (record_folder, common_folder, top_level) = (
        path_of(record_folder)?,
        path_of(common_folder)?,
        path_of(top_level)?,
    );
    let top_level_key = canonical_folder_path(&top_level)
        .await
        .map_err(LinkedTreeRecordError::Resolve)?;
    let tree_key = canonical_folder_path(tree_folder)
        .await
        .map_err(LinkedTreeRecordError::Resolve)?;
    if top_level_key != tree_key {
        return Ok(None);
    }
    let is_linked_record =
        record_folder.parent() == Some(common_folder.join(LINKED_RECORDS_FOLDER_NAME).as_path());
    Ok(is_linked_record.then_some(record_folder))
}

/// The record a `.git` file at `git_file` names, read as git reads it: the file must start with
/// `gitdir: `, only line ends are trimmed from its end, and a relative record is joined onto the
/// file's folder with its `..` and separators kept, as git joins it before resolving it, since
/// folding them as text would lose a name's bytes that are not UTF-8; a caller resolves it before
/// comparing it. `None` for a missing `.git`, a checkout's own `.git` folder, or a file that names
/// none. Fails with the read's error, or on Windows with `InvalidData` for a record that is not
/// UTF-8.
#[expect(dead_code, reason = "the worktree service's reads")]
pub(crate) async fn read_record_named_by(git_file: &Path) -> io::Result<Option<PathBuf>> {
    // A folder is checked first, since reading one fails differently from system to system.
    let contents = match tokio::fs::metadata(git_file).await {
        Ok(metadata) if metadata.is_dir() => return Ok(None),
        Ok(_) => tokio::fs::read(git_file).await,
        Err(failure) => Err(failure),
    };
    let contents = match contents {
        Ok(contents) => contents,
        Err(failure) if is_missing_entry(&failure) => return Ok(None),
        Err(failure) => return Err(failure),
    };
    let Some(mut named) = contents.strip_prefix(GIT_FILE_PREFIX) else {
        return Ok(None);
    };
    while let Some(trimmed) = named
        .strip_suffix(b"\n")
        .or_else(|| named.strip_suffix(b"\r"))
    {
        named = trimmed;
    }
    if named.is_empty() {
        return Ok(None);
    }
    let named = path_from_program_output(named.to_vec())?;
    Ok(Some(match git_file.parent() {
        Some(folder) => folder.join(named),
        None => named,
    }))
}

// The records of a `for-each-ref` listing whose format ends each record's last field with a NUL:
// a record ends at a NUL and git's newline, which no field holds.
fn ref_records(listing: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut start = 0;
    memmem::find_iter(listing, b"\0\n").map(move |end| {
        let record = &listing[start..end];
        start = end + 2;
        record
    })
}

// The lines of git's output, each without its `\n`, and without the `\r` before it where the
// running system ends lines with `\r\n`.
fn output_lines(output: &[u8]) -> impl Iterator<Item = &[u8]> {
    output
        .split(|byte| *byte == b'\n')
        .map(strip_carriage_return)
}

// A path git printed in a field, `None` for an empty field.
fn optional_path(field: &[u8]) -> Result<Option<PathBuf>, GitError> {
    if field.is_empty() {
        return Ok(None);
    }
    path_from_program_output(field.to_vec())
        .map(Some)
        .map_err(GitError::PathText)
}

// A number git printed in decimal; bytes that are not UTF-8 fail the parse.
fn parse_number<Number: FromStr<Err = ParseIntError>>(digits: &[u8]) -> Result<Number, GitError> {
    String::from_utf8_lossy(digits)
        .parse()
        .map_err(|error| GitError::Read(io::Error::new(io::ErrorKind::InvalidData, error)))
}

// git printed something these reads cannot parse.
fn malformed(what: &'static str) -> GitError {
    GitError::Read(io::Error::new(io::ErrorKind::InvalidData, what))
}

#[cfg(test)]
mod tests;
