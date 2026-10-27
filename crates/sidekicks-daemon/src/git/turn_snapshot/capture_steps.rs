//! The git steps of one turn-snapshot capture: resolve the base, seed and partition the scratch
//! index, record embedded repositories, commit the tree and write its ref. The service orders them
//! and turns a failure into the failed step.
//!
//! - A duplicate capture whose worktree changed leaves an unreferenced tree and commit for gc.
//! - Host git config, measured on git 2.50.1: `core.ignorecase` and `core.precomposeUnicode` state
//!   the file system and `core.fileMode` matches porcelain `add -A`, so they stay unpinned (a stale
//!   `false` loses an exec bit). Inert on these steps: `core.eol`, `core.symlinks`,
//!   `core.untrackedCache`, `core.excludesFile`, `core.checkRoundtripEncoding`, and the stat family
//!   (a bare `read-tree` seed has no stat data; the sparse seed copies the live index, which does).
//!   Residual with no closed pin set: `filter.<name>.smudge|clean|required`.
//! - No pin restores skip-worktree bits on a `read-tree <base>` seed
//!   (`-c core.sparseCheckout=false` and `--no-sparse-checkout` lose out-of-cone paths alike), so a
//!   sparse root seeds from a copy of the live index.

use std::borrow::Cow;
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use jiff::Timestamp;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_platforms::{create_new_file, path_from_program_output};
use tokio::task::JoinError;

use crate::git::process::{GitCall, GitError, GitRunner, in_folder, strip_line_end};
use crate::git::turn_snapshot::capture::{
    CORE_SPARSE_CHECKOUT_KEY, GITLINK_TREE_MODE, ObjectFormat,
    SKIPPED_EMBEDDED_REPOSITORIES_TRAILER, SNAPSHOT_COMMIT_MESSAGE, SNAPSHOT_IDENTITY_EMAIL,
    SNAPSHOT_IDENTITY_NAME, SPARSE_BOUNDARY_PATHS_TRAILER, SPARSE_SEED_INDEX_LOCK_ATTEMPTS,
    SPARSE_SEED_INDEX_LOCK_RETRY_DELAY, SparseListingPartition, UnrecognizedObjectFormat,
    join_nul_terminated_listing, split_nul_terminated_listing_bytes, to_raw_git_date,
};
use crate::git::turn_snapshot::refs::USE_REPLACE_REFS_PIN;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::missing_entry::MissingEntry;

const INDEX_COPY_OPERATION: &str = "copying the live index to the scratch index";

/// Why one capture step failed; the service reports it with the step's name, and the turn ends
/// anyway.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CaptureStepError {
    /// A git call failed.
    #[error(transparent)]
    Git(#[from] GitError),
    /// git exited 0 but printed no object id, so nothing it echoed passes as one.
    #[error("git did not report an object id")]
    NotAnObjectId,
    /// git printed no index path for the checkout.
    #[error("git did not report an index path for the checkout")]
    NoIndexPath,
    /// git named an object format this code does not know.
    #[error(transparent)]
    ObjectFormat(#[from] UnrecognizedObjectFormat),
    /// The supplied checkout or git's top level could not be resolved.
    #[error("the checkout's folder could not be resolved")]
    CheckoutUnresolved(#[source] io::Error),
    /// git names another folder as the top level of the tree holding the execution root.
    #[error("the supplied checkout is not the working tree holding the execution root")]
    CheckoutMismatch,
    /// The scratch index's name could not be drawn.
    #[error("the scratch index could not be named")]
    ScratchIndexName(#[source] getrandom::Error),
    /// The folder of scratch indexes could not be made.
    #[error("the folder of scratch indexes could not be made")]
    ScratchIndexFolder(#[source] io::Error),
    /// Another git held the repository's index lock through every attempt.
    #[error("the repository's index lock stayed taken, so the scratch index was not seeded")]
    IndexLockTaken(#[source] io::Error),
    /// The repository's index lock could not be made.
    #[error("the repository's index lock could not be taken")]
    IndexLock(#[source] io::Error),
    /// The live index could not be copied, its lock released or not.
    #[error("the live index could not be copied to the scratch index")]
    IndexCopy(#[source] CleanupFailures<io::Error>),
    /// The live index was copied but its lock could not be removed.
    #[error("the repository's index lock could not be released")]
    IndexLockRelease(#[source] io::Error),
    /// The create-only ref write was refused and reading the ref back failed too.
    #[error("{}; reading the ref back failed", describe_error(refusal))]
    RefReadBack {
        /// The ref write's refusal.
        refusal: GitError,
        /// Why no recorded id could be read instead.
        #[source]
        read_back: Box<CaptureStepError>,
    },
}

/// Where a capture's git calls run: the daemon's git, the project's place and the top level of
/// the verified checkout every step runs in.
pub(crate) struct SnapshotCheckout<'checkout> {
    /// The daemon's git.
    pub(crate) git: &'checkout GitRunner,
    /// The project's place, handed to every git call.
    pub(crate) place: Option<&'checkout Place>,
    /// The checkout's top level, symlinks resolved.
    pub(crate) root: &'checkout Path,
}

impl SnapshotCheckout<'_> {
    /// Resolves `HEAD` once; the id is both the tree base and the recorded parent, so a branch
    /// moving mid-capture cannot pair an old tree with a new parent. Fails as git does, an unborn
    /// `HEAD` among them, or with `NotAnObjectId`.
    pub(crate) async fn resolve_base_commit(&self) -> Result<GitObjectId, CaptureStepError> {
        // `--verify` prints nothing on a miss; the bare form echoes `HEAD` with a non-zero exit.
        let output = self
            .git
            .run(
                self.place,
                GitCall::read(self.in_checkout(&["rev-parse", "--verify", "HEAD"])),
            )
            .await?;
        require_object_id(&output.stdout)
    }

    /// Whether the root is sparse, read from `core.sparseCheckout` alone (what git consults before
    /// skip-worktree). A rules file without the bit fails the matcher (exit 128), so the capture
    /// fails closed. Read per root, not per mode: a worktree inherits sparseness. Fails as git
    /// does.
    pub(crate) async fn detect_sparse_root(&self) -> Result<bool, CaptureStepError> {
        // `--default=false` makes an unset key a clean false; a bare `--get` exits 1 (unset) or 128
        // (unreadable), which an exit code alone cannot tell apart.
        let arguments = self.in_checkout(&[
            "config",
            "--type=bool",
            "--default=false",
            "--get",
            CORE_SPARSE_CHECKOUT_KEY,
        ]);
        let output = self.git.run(self.place, GitCall::read(arguments)).await?;
        Ok(String::from_utf8_lossy(&output.stdout).trim() == "true")
    }

    /// Copies the live index to `scratch_index` while holding git's `<index>.lock`, made
    /// exclusively and removed after, so no torn index is read and the live index is never
    /// replaced; a lock this step did not make is never removed. Contention gets a short fixed
    /// retry, then fails with `IndexLockTaken`; fails as git, the lock, the copy or the release do.
    pub(crate) async fn seed_scratch_index_from_live_index(
        &self,
        scratch_index: &Path,
    ) -> Result<(), CaptureStepError> {
        // Not `<root>/.git/index`: a linked worktree keeps its index under the main git folder.
        // Git answers relative for a main checkout and absolute for a linked one (git 2.50.1), and
        // a join onto an absolute path keeps that path.
        let output = self
            .git
            .run(
                self.place,
                GitCall::read(self.in_checkout(&["rev-parse", "--git-path", "index"])),
            )
            .await?;
        let reported = strip_line_end(output.stdout);
        if reported.is_empty() {
            return Err(CaptureStepError::NoIndexPath);
        }
        let live_index = self
            .root
            .join(path_from_program_output(reported).map_err(GitError::PathText)?);
        let mut lock_path = live_index.clone().into_os_string();
        lock_path.push(".lock");
        let lock_path = PathBuf::from(lock_path);

        let lock = take_index_lock(&lock_path).await?;
        let copied = tokio::fs::copy(&live_index, scratch_index).await;
        // Released, never committed, whatever the copy did, so a failed copy cannot strand the lock
        // and block every git command in the person's repository.
        drop(lock);
        let released = tokio::fs::remove_file(&lock_path).await.none_if_missing();
        match (copied, released) {
            (Ok(_), Ok(_)) => Ok(()),
            (Ok(_), Err(release)) => Err(CaptureStepError::IndexLockRelease(release)),
            (Err(copy), released) => Err(CaptureStepError::IndexCopy(CleanupFailures::new(
                copy,
                released.err().into_iter().collect(),
                INDEX_COPY_OPERATION,
            ))),
        }
    }

    /// Splits a `-z` listing into the in-cone staging listing and the out-of-cone entries, all the
    /// listing's own bytes, by git's live sparse rules. A matcher failure fails the step; it never
    /// degrades to staging the whole listing, which would lose out-of-cone content.
    pub(crate) async fn partition_listing_by_cone<'listing>(
        &self,
        listing: &'listing [u8],
    ) -> Result<SparseListingPartition<'listing>, CaptureStepError> {
        // The live rules' `check-rules`, not the ignore machinery: with `/*` plus `!/a/b/`,
        // `--exclude-per-directory` scores `a/b/deep.txt` includable and the cone does not (git
        // 2.50.1). `-z` echoes the input bytes verbatim whatever `core.quotePath` says. A trailing
        // slash stays, the only record that git refused to descend into an entry.
        let entries: Vec<&[u8]> = split_nul_terminated_listing_bytes(listing).collect();
        let call = GitCall::read(self.in_checkout(&["sparse-checkout", "check-rules", "-z"]))
            .with_input(join_nul_terminated_listing(&entries));
        let matcher = self.git.run(self.place, call).await?;
        let in_cone: HashSet<&[u8]> = split_nul_terminated_listing_bytes(&matcher.stdout).collect();
        let (in_cone_entries, out_of_cone_entries): (Vec<&[u8]>, Vec<&[u8]>) = entries
            .into_iter()
            .partition(|entry| in_cone.contains(entry));
        Ok(SparseListingPartition {
            in_cone_listing: Cow::Owned(join_nul_terminated_listing(in_cone_entries)),
            out_of_cone_entries,
        })
    }

    /// The out-of-cone entries the snapshot tree `tree` does not hold, compared byte for byte
    /// against the tree read back: untracked and intent-to-add paths, which `write-tree` omits
    /// (git 2.50.1). Fails as git does.
    pub(crate) async fn derive_sparse_boundary_paths<'listing>(
        &self,
        tree: &GitObjectId,
        out_of_cone_entries: &[&'listing [u8]],
    ) -> Result<Vec<&'listing [u8]>, CaptureStepError> {
        // Replace refs pinned off: a changed path set would change the trailer, an input to the id.
        let [pin_flag, pin_setting] = USE_REPLACE_REFS_PIN;
        let arguments = self.in_checkout(&[
            pin_flag,
            pin_setting,
            "ls-tree",
            "-r",
            "--name-only",
            "-z",
            tree.as_str(),
        ]);
        let tree_listing = self.git.run(self.place, GitCall::read(arguments)).await?;
        // Byte keys: decoded names would map distinct non-UTF-8 paths to one string and subtract a
        // boundary path away.
        let recorded: HashSet<&[u8]> =
            split_nul_terminated_listing_bytes(&tree_listing.stdout).collect();
        Ok(out_of_cone_entries
            .iter()
            .copied()
            .filter(|entry| !recorded.contains(entry))
            .collect())
    }

    /// Records each untracked embedded repository of `listing` (a trailing-slash entry
    /// `update-index --add` silently drops) in `scratch_index` as a gitlink, as `git add -A` does,
    /// and returns the paths of those it skipped: no commit yet, or another object format. Fails
    /// as git does on anything but git's own refusal of an embedded `HEAD`.
    pub(crate) async fn normalize_embedded_repositories<'listing>(
        &self,
        scratch_index: &Path,
        listing: &'listing [u8],
    ) -> Result<Vec<&'listing [u8]>, CaptureStepError> {
        let mut skipped = Vec::new();
        let mut superproject_format: Option<ObjectFormat> = None;
        for entry in split_nul_terminated_listing_bytes(listing) {
            let Some(embedded_path) = entry.strip_suffix(b"/") else {
                continue;
            };
            let embedded_path_text =
                path_from_program_output(embedded_path.to_vec()).map_err(GitError::PathText)?;
            let embedded_root = self.root.join(&embedded_path_text);
            let head_call = GitCall::read(in_folder(
                &embedded_root,
                &["rev-parse", "--verify", "HEAD"],
            ));
            let head = match self.git.run(self.place, head_call).await {
                Ok(head) => head,
                // git's refusal (no commits yet) is a skip; a git that never reached an exit
                // (a start failure, a timeout) fails the step, so a fault is never a skip.
                Err(refusal) if refusal.exit_code().is_some() => {
                    skipped.push(embedded_path);
                    continue;
                }
                Err(fault) => return Err(fault.into()),
            };
            // git exited 0, so an answer that is no id is a fault, not a skip.
            let embedded_head = require_object_id(&head.stdout)?;
            // Read once, and only when an embedded repository is met. A predicate, not a wider
            // catch: a SHA-1 id offered to a SHA-256 index exits 129 in `--cacheinfo` (git
            // 2.50.1), and a catch would hide other failures.
            let format = if let Some(format) = superproject_format {
                format
            } else {
                let call = GitCall::read(self.in_checkout(&["rev-parse", "--show-object-format"]));
                let output = self.git.run(self.place, call).await?;
                let format = ObjectFormat::from_show_object_format(&output.stdout)?;
                superproject_format = Some(format);
                format
            };
            if embedded_head.as_str().len() != format.object_id_hex_length() {
                skipped.push(embedded_path);
                continue;
            }
            // A direct index insert of the gitlink, as porcelain staging writes; git records it
            // although the object lives in the embedded repository's store (git 2.50.1).
            let mut cache_info =
                OsString::from(format!("{GITLINK_TREE_MODE},{},", embedded_head.as_str()));
            cache_info.push(embedded_path_text.as_os_str());
            let mut arguments = self.in_checkout(&["update-index", "--add", "--cacheinfo"]);
            arguments.push(cache_info);
            let call = GitCall::read(arguments).with_environment("GIT_INDEX_FILE", scratch_index);
            self.git.run(self.place, call).await?;
        }
        Ok(skipped)
    }

    /// Commits `tree` on `base` under the encoding pin, the snapshot identity and `turn_ended_at`
    /// as both dates, so the id depends only on project state and the turn's end. What a restore
    /// cannot re-derive rides as trailers (see [`compose_snapshot_message`]). Fails as git does,
    /// or with `NotAnObjectId`.
    pub(crate) async fn commit_snapshot_tree(
        &self,
        tree: &GitObjectId,
        base: &GitObjectId,
        skipped_embedded_repositories: &[&[u8]],
        sparse_boundary_paths: Option<&[&[u8]]>,
        turn_ended_at: Timestamp,
    ) -> Result<GitObjectId, CaptureStepError> {
        let date = to_raw_git_date(turn_ended_at);
        // `i18n.commitEncoding=utf-8` because a host setting adds an `encoding` header. The dates
        // are commit fields too, so the identity alone would leak the host's time zone into the id.
        let arguments = self.in_checkout(&[
            "-c",
            "i18n.commitEncoding=utf-8",
            "commit-tree",
            tree.as_str(),
            "-p",
            base.as_str(),
            "-F",
            "-",
        ]);
        // Over standard input, not `-m`: the sparse trailer is unbounded and an argument list is
        // not.
        let message =
            compose_snapshot_message(skipped_embedded_repositories, sparse_boundary_paths);
        let call = GitCall::write(arguments)
            .with_environment("GIT_AUTHOR_NAME", SNAPSHOT_IDENTITY_NAME)
            .with_environment("GIT_AUTHOR_EMAIL", SNAPSHOT_IDENTITY_EMAIL)
            .with_environment("GIT_AUTHOR_DATE", &date)
            .with_environment("GIT_COMMITTER_NAME", SNAPSHOT_IDENTITY_NAME)
            .with_environment("GIT_COMMITTER_EMAIL", SNAPSHOT_IDENTITY_EMAIL)
            .with_environment("GIT_COMMITTER_DATE", &date)
            .with_input(message.into_bytes());
        let output = self.git.run(self.place, call).await?;
        require_object_id(&output.stdout)
    }

    /// Writes `snapshot_ref` to `snapshot_commit` only where no ref is: `None` when this call
    /// wrote it, or the recorded id when one was already there. Fails with git's refusal when no
    /// ref is found after it, or with `RefReadBack` when the read back fails too.
    pub(crate) async fn write_create_only_ref(
        &self,
        snapshot_ref: &str,
        snapshot_commit: &GitObjectId,
    ) -> Result<Option<GitObjectId>, CaptureStepError> {
        // The empty old value makes this a compare-and-swap against absence. `--no-deref` keeps the
        // check on the built name: without it a planted dangling symref makes git write its
        // referent outside the namespace and exit 0 (git 2.50.1, 2.54.0). With it, 2.50.1 replaces
        // the symref and 2.54.0 refuses; a live referent refuses on both, and the id read back
        // through it is reported as found, not as written here.
        let arguments = self.in_checkout(&[
            "update-ref",
            "--no-deref",
            snapshot_ref,
            snapshot_commit.as_str(),
            "",
        ]);
        let Err(refusal) = self.git.run(self.place, GitCall::write(arguments)).await else {
            return Ok(None);
        };
        // The ref, not git's message, is read, and only after the swap refused, so a concurrent
        // loser reads the winner's id.
        match self.read_ref_if_present(snapshot_ref).await {
            Ok(Some(recorded)) => Ok(Some(recorded)),
            Ok(None) => Err(refusal.into()),
            Err(read_back) => Err(CaptureStepError::RefReadBack {
                refusal,
                read_back: Box::new(read_back),
            }),
        }
    }

    // The id `snapshot_ref` records, or `None` when it does not exist; `for-each-ref` exits 0 on a
    // miss, so a failure is a fault, never an absence.
    async fn read_ref_if_present(
        &self,
        snapshot_ref: &str,
    ) -> Result<Option<GitObjectId>, CaptureStepError> {
        // The pattern also matches refs below `<ref>/`, so the exact name is picked out.
        let arguments = self.in_checkout(&[
            "for-each-ref",
            "--format=%(objectname) %(refname)",
            snapshot_ref,
        ]);
        let output = self.git.run(self.place, GitCall::read(arguments)).await?;
        for line in String::from_utf8_lossy(&output.stdout).split('\n') {
            if let Some((object_id, listed_ref)) = line.split_once(' ')
                && listed_ref == snapshot_ref
            {
                return require_object_id(object_id.as_bytes()).map(Some);
            }
        }
        Ok(None)
    }

    /// The arguments of a git call in the checkout: `-C <root>` and then `arguments`.
    pub(crate) fn in_checkout(&self, arguments: &[&str]) -> Vec<OsString> {
        in_folder(self.root, arguments)
    }
}

/// git's answer as a SHA-1 or SHA-256 id, checked before it enters an argument list or a result,
/// so an echo that is not an id never passes as one. Fails with `NotAnObjectId` on anything else.
pub(crate) fn require_object_id(stdout: &[u8]) -> Result<GitObjectId, CaptureStepError> {
    GitObjectId::new(String::from_utf8_lossy(stdout).trim().to_owned())
        .ok_or(CaptureStepError::NotAnObjectId)
}

/// The snapshot commit's message: the fixed line, then the skipped embedded repositories when
/// there are any, then the sparse boundary paths whenever the root is sparse (`None` when it is
/// not), paragraphs apart and ending in a line end, without which the id differs. Both lists are
/// sorted for a stable id: the skipped paths read as UTF-8, any other byte replaced, and ordered
/// by UTF-16 units; the boundary paths ordered by their bytes and written one character per byte.
pub(crate) fn compose_snapshot_message(
    skipped_embedded_repositories: &[&[u8]],
    sparse_boundary_paths: Option<&[&[u8]]>,
) -> String {
    let mut paragraphs = vec![SNAPSHOT_COMMIT_MESSAGE.to_owned()];
    if !skipped_embedded_repositories.is_empty() {
        let mut skipped: Vec<String> = skipped_embedded_repositories
            .iter()
            .map(|path| String::from_utf8_lossy(path).into_owned())
            .collect();
        skipped.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        paragraphs.push(format!(
            "{SKIPPED_EMBEDDED_REPOSITORIES_TRAILER} {}",
            json_list(&skipped)
        ));
    }
    if let Some(boundary_paths) = sparse_boundary_paths {
        let mut sorted = boundary_paths.to_vec();
        sorted.sort_unstable();
        // One character per byte keeps distinct non-UTF-8 paths distinct through JSON.
        let boundary: Vec<String> = sorted
            .iter()
            .map(|path| path.iter().copied().map(char::from).collect())
            .collect();
        paragraphs.push(format!(
            "{SPARSE_BOUNDARY_PATHS_TRAILER} {}",
            json_list(&boundary)
        ));
    }
    let mut message = paragraphs.join("\n\n");
    message.push('\n');
    message
}

// `entries` as one JSON array; its escapes keep a line end from forging a trailer.
fn json_list(entries: &[String]) -> String {
    serde_json::to_string(entries).expect("a list of text always writes as JSON")
}

// Makes git's index lock, waiting a moment between attempts while another git holds it.
async fn take_index_lock(lock_path: &Path) -> Result<File, CaptureStepError> {
    let mut attempt = 1;
    loop {
        let path = lock_path.to_owned();
        let made = tokio::task::spawn_blocking(move || create_new_file(&path, 0o666)).await;
        match joined(made) {
            Ok(lock) => return Ok(lock),
            // Only an existing lock is contention; retrying any other failure would only delay the
            // turn's end.
            Err(taken) if taken.kind() == io::ErrorKind::AlreadyExists => {
                if attempt == SPARSE_SEED_INDEX_LOCK_ATTEMPTS {
                    return Err(CaptureStepError::IndexLockTaken(taken));
                }
                attempt += 1;
                tokio::time::sleep(SPARSE_SEED_INDEX_LOCK_RETRY_DELAY).await;
            }
            Err(failure) => return Err(CaptureStepError::IndexLock(failure)),
        }
    }
}

/// A blocking file call's answer, a blocking task that did not finish read as an I/O failure.
pub(crate) fn joined<Value>(answer: Result<io::Result<Value>, JoinError>) -> io::Result<Value> {
    answer.unwrap_or_else(|join_failure| Err(io::Error::other(join_failure)))
}

#[cfg(test)]
mod tests {
    use super::compose_snapshot_message;

    // Fails when the trailers' bytes change for a path outside the Basic Multilingual Plane, one in
    // U+E000–U+FFFF or one that is not UTF-8: the order, the escapes or the decoding, each an input
    // to every snapshot's id.
    #[test]
    fn the_trailers_keep_the_bytes_every_snapshot_id_hashes() {
        let astral = "vendor/\u{1F600}".as_bytes();
        let private_use = "vendor/\u{FF5E}".as_bytes();
        let not_utf8 = b"vendor/\xFF".as_slice();
        let paths = [not_utf8, private_use, astral];

        let message = compose_snapshot_message(&paths, Some(paths.as_slice()));

        assert!(message.ends_with("]\n") && !message.ends_with("]\n\n"));
        insta::assert_snapshot!("turn_snapshot_message_trailers", message);
    }
}
