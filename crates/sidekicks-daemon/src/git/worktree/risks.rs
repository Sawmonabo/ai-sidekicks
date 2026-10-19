//! What removing a tree would lose, read from git in the tree: its uncommitted entries, its
//! ignored entries (an `.env`, say), and the commits no remote-tracking branch reaches.

use std::num::ParseIntError;
use std::path::Path;

use sha2::{Digest as _, Sha256};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::worktree::lifecycle::WorktreeRemovalRisks;

use crate::git::process::{GitCall, GitError, GitRunner, background_read};

// The status code porcelain v1 gives an ignored entry.
const IGNORED_STATUS: &str = "!!";

/// Why a tree's risks could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RemovalRiskReadError {
    /// A git read failed.
    #[error("reading what removing the tree would lose failed")]
    Git(#[from] GitError),
    /// `rev-list --count` printed no count.
    #[error("git printed {printed:?} where a count of unpushed commits belongs")]
    UnpushedCommitCount {
        /// What it printed, trimmed.
        printed: String,
        /// Why it is no count.
        #[source]
        source: ParseIntError,
    },
}

/// The tree's risks as git reads them now, with the sessions standing in it. Uncommitted entries
/// are counted file by file, each untracked file on its own; ignored entries are counted as the
/// ignore rules match them, a wholly ignored folder once, so the read stays bounded on a tree with
/// a large ignored folder. Both reads take no optional lock, so they never rewrite the tree's index
/// under a run working there, and run one after another; the status read keeps git's built-in
/// file-watch daemon where the repository turns it on. Fails with the first git read's failure.
#[expect(
    dead_code,
    reason = "worktree removal reads what it would lose through it"
)]
pub(crate) async fn read_removal_risks(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    occupying_session_ids: Vec<SessionId>,
) -> Result<WorktreeRemovalRisks, RemovalRiskReadError> {
    let entries = read_status_entries(git, place, folder).await?;
    let unpushed_commit_count = read_unpushed_commit_count(git, place, folder).await?;
    Ok(risks_of(
        &entries,
        unpushed_commit_count,
        occupying_session_ids,
    ))
}

/// What the risk read shows in a tree, and a digest of every entry and commit behind it.
#[expect(
    dead_code,
    reason = "worktree removal reads what it would lose through it"
)]
#[derive(Clone, Debug)]
pub(crate) struct RemovalRiskReading {
    /// What removing the tree would lose.
    pub(crate) risks: WorktreeRemovalRisks,
    /// Equal for two reads that show the same uncommitted and ignored entries, the same `HEAD` and
    /// the same count of unpushed commits; a change inside a file git already lists leaves it
    /// equal. SHA-256 in lowercase hex.
    pub(crate) digest: String,
}

/// The risk read with its digest, for a tree no session stands in. Fails with the first git read's
/// failure, a tree whose `HEAD` names no commit among them.
#[expect(
    dead_code,
    reason = "worktree removal reads what it would lose through it"
)]
pub(crate) async fn read_removal_risk_reading(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
) -> Result<RemovalRiskReading, RemovalRiskReadError> {
    let mut entries = read_status_entries(git, place, folder).await?;
    let unpushed_commit_count = read_unpushed_commit_count(git, place, folder).await?;
    let head = git
        .run(
            place,
            GitCall::read(background_read(folder, &["rev-parse", "--verify", "HEAD"])),
        )
        .await?;
    // Hashed in JavaScript's sort order, by UTF-16 units.
    entries.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let mut digest = Sha256::new();
    for entry in &entries {
        digest.update(entry.as_bytes());
        digest.update(b"\0");
    }
    digest.update(String::from_utf8_lossy(&head.stdout).trim().as_bytes());
    digest.update(b"\0");
    digest.update(unpushed_commit_count.get().to_string().as_bytes());
    Ok(RemovalRiskReading {
        risks: risks_of(&entries, unpushed_commit_count, Vec::new()),
        digest: base16ct::lower::encode_string(&digest.finalize()),
    })
}

/// Whether a plain removal would lose anything: uncommitted, ignored or unpushed work.
#[expect(
    dead_code,
    reason = "worktree removal reads what it would lose through it"
)]
pub(crate) fn has_something_to_lose(risks: &WorktreeRemovalRisks) -> bool {
    risks.uncommitted_file_count.get() > 0
        || risks.ignored_file_count.get() > 0
        || risks.unpushed_commit_count.get() > 0
}

// Each porcelain entry with its status code, a rename's or copy's source path joined to it after
// a NUL. Only counted and hashed, never handed back to git, so a path is read as text.
async fn read_status_entries(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
) -> Result<Vec<String>, GitError> {
    let status = git
        .run(
            place,
            GitCall::live_index_read(
                folder,
                &[
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--ignored=matching",
                    "--untracked-files=all",
                ],
            ),
        )
        .await?;
    let listing = String::from_utf8_lossy(&status.stdout);
    let mut fields = listing.split('\0');
    let mut entries = Vec::new();
    while let Some(entry) = fields.next() {
        if entry.is_empty() {
            continue;
        }
        // A rename or a copy names its source in the next field.
        if is_rename_or_copy(entry) {
            entries.push(format!("{entry}\0{}", fields.next().unwrap_or_default()));
        } else {
            entries.push(entry.to_owned());
        }
    }
    Ok(entries)
}

// Whether a porcelain v1 entry's two-letter status names a rename or a copy on either side.
fn is_rename_or_copy(entry: &str) -> bool {
    entry
        .bytes()
        .take(2)
        .any(|status| status == b'R' || status == b'C')
}

// The commits `HEAD` reaches that no remote-tracking branch does.
async fn read_unpushed_commit_count(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
) -> Result<SafeInt<0>, RemovalRiskReadError> {
    let unpushed = git
        .run(
            place,
            GitCall::read(background_read(
                folder,
                &["rev-list", "--count", "HEAD", "--not", "--remotes"],
            )),
        )
        .await?;
    let printed = String::from_utf8_lossy(&unpushed.stdout).trim().to_owned();
    let count = printed
        .parse()
        .map_err(|source| RemovalRiskReadError::UnpushedCommitCount {
            printed: printed.clone(),
            source,
        })?;
    Ok(SafeInt::new(count).expect("no repository holds 2^53 commits"))
}

fn risks_of(
    entries: &[String],
    unpushed_commit_count: SafeInt<0>,
    occupying_session_ids: Vec<SessionId>,
) -> WorktreeRemovalRisks {
    let ignored_file_count = entries
        .iter()
        .filter(|entry| entry.starts_with(IGNORED_STATUS))
        .count();
    WorktreeRemovalRisks {
        uncommitted_file_count: file_count(entries.len() - ignored_file_count),
        ignored_file_count: file_count(ignored_file_count),
        unpushed_commit_count,
        occupying_session_ids,
    }
}

fn file_count(count: usize) -> SafeInt<0> {
    u64::try_from(count)
        .ok()
        .and_then(SafeInt::new)
        .expect("a listing within git's output bound holds far fewer than 2^53 entries")
}
