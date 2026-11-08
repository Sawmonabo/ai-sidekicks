//! Whether a watched worktree's branch has merged back into its base or the base's upstream; a
//! merge into any other branch is not read.
//!
//! - The row records the branch's newest commit of its own: each check that finds a commit on the
//!   branch that changes a path, merge commits not counted, and that neither the base nor its
//!   upstream holds records the newest such commit; while it records none and the tip is
//!   contained, the newest commit, amend or pick in the branch's reflog that changed a path and
//!   that the base or its upstream holds seeds it. A branch that only caught up with its base, by a
//!   fast-forward or a merge commit, never left it or made only empty commits records none and
//!   never reads merged.
//! - The checks run on the recorded commit, never on a later tip that discarded its work: it has
//!   merged when the base or its upstream holds it, or, where neither does, when nothing on it is
//!   left unapplied there: each of its commits' patches found on that side, or all of its changes
//!   as one squashed patch. The patch test runs once per combination of the commit it tests, the
//!   base's tip and the upstream's.
//! - A merged branch reads reopened once a check finds such a commit of its own past its recorded
//!   one.
//! - A base that names no local or remote-tracking branch, and a recorded commit the repository no
//!   longer holds, read as not merged, each logged once.

use std::collections::HashSet;
use std::path::Path;

use sidekicks_contracts::place::Place;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::WriteError;

use super::WorkingFolderWatcherDeps;
use super::tree_state::StandingTree;
use crate::git::process::{GitCall, GitError, GitRunner, background_read, strip_line_end};
use crate::git::worktree::reads::{
    BRANCH_REF_PREFIX, UpstreamDistanceRead, malformed, parse_number, read_ref_heads,
};

// Records the newest commit of its own the tree's branch was seen holding.
const RECORD_NEWEST_OWN_COMMIT_SQL: &str =
    "UPDATE worktrees SET newest_own_commit = @commit, updated_at = @now WHERE id = @worktree_id";

// The prefix of every remote-tracking branch's full ref name.
const REMOTE_REF_PREFIX: &str = "refs/remotes/";

// The reflog subjects git writes for a commit made on the branch: a new one, an amended one and a
// picked one.
const OWN_COMMIT_REFLOG_PREFIXES: [&[u8]; 3] = [b"commit:", b"commit (amend):", b"cherry-pick:"];

// `merge-base`'s exit when the two commits share no history.
const NO_MERGE_BASE_EXIT_CODE: i32 = 1;

// `rev-parse --verify --quiet`'s exit when the repository holds no such commit.
const NOT_HELD_EXIT_CODE: i32 = 1;

/// What a folder's merged checks keep between changes: the last patch test's tips and verdict,
/// the full ref name of the base's upstream, read with the base, and each base already logged as
/// naming no branch and each recorded commit as gone.
#[derive(Default)]
pub(super) struct MergedCheck {
    last_patch_test: Option<(BranchTips, bool)>,
    upstream_ref: Option<String>,
    unresolved_bases: HashSet<String>,
    missing_commits: HashSet<String>,
}

// The commits a check reads: the branch's tip, and the targets it merges back into: the base's,
// then the upstream's where it holds commits the base lacks, or the upstream's alone where it holds
// the base, since then it holds all the base holds. The patch test's tip is the recorded one.
#[derive(Clone, Debug, PartialEq, Eq)]
struct BranchTips {
    tip: String,
    targets: Vec<String>,
}

/// Why whether a branch merged back could not be read.
#[derive(Debug, thiserror::Error)]
pub(super) enum MergedReadError {
    /// A git read failed.
    #[error("a worktree's branch or its base could not be read")]
    Git(#[from] GitError),
    /// The row's record of the branch's own commits could not be written.
    #[error("that a worktree's branch held commits of its own could not be recorded")]
    Write(#[from] WriteError),
}

impl MergedCheck {
    /// Whether `tree`'s branch, checked out at `folder`, has merged back into its base, recording
    /// on its row the newest commit of its own seen on it. Fails as git or the write does.
    pub(super) async fn has_merged_back(
        &mut self,
        deps: &WorkingFolderWatcherDeps,
        place: Option<&Place>,
        folder: &Path,
        tree: &StandingTree,
    ) -> Result<bool, MergedReadError> {
        let git = &deps.git;
        let branch_ref = format!("{BRANCH_REF_PREFIX}{}", tree.row.branch_name.as_str());
        let Some(mut tips) = self
            .read_tips(git, place, folder, &branch_ref, &tree.base)
            .await?
        else {
            return Ok(false);
        };
        if let Some(newest) =
            newest_own_commit_past(git, place, folder, &tips.tip, &tips.targets).await?
        {
            // The tip holds work the base and its upstream lack, so neither contains it.
            if tree.newest_own_commit.as_deref() != Some(newest.as_str()) {
                record_newest_own_commit(deps, tree, &newest).await?;
            }
        } else {
            let recorded = if let Some(recorded) = &tree.newest_own_commit {
                recorded.clone()
            } else {
                if count_past(git, place, folder, &tips.tip, &tips.targets).await? > 0 {
                    return Ok(false);
                }
                let Some(seed) =
                    newest_own_commit_on(git, place, folder, &branch_ref, &tips).await?
                else {
                    return Ok(false);
                };
                record_newest_own_commit(deps, tree, &seed).await?;
                seed
            };
            match count_past(git, place, folder, &recorded, &tips.targets).await {
                Ok(0) => return Ok(true),
                Ok(_) => {}
                Err(error) => {
                    if is_commit_held(git, place, folder, &recorded).await? {
                        return Err(error.into());
                    }
                    if self.missing_commits.insert(recorded) {
                        tracing::warn!(
                            "a worktree's recorded branch commit is gone from its repository, so \
                             its branch is not read as merged back"
                        );
                    }
                    return Ok(false);
                }
            }
            tips.tip = recorded;
        }
        if let Some((last_tips, verdict)) = &self.last_patch_test
            && *last_tips == tips
        {
            return Ok(*verdict);
        }
        let verdict = is_applied(git, place, folder, &tips).await?;
        self.last_patch_test = Some((tips, verdict));
        Ok(verdict)
    }

    /// The newest commit of its own on `tree`'s merged branch, checked out at `folder`, past the
    /// recorded one that neither the base nor its upstream holds, which the row then records;
    /// `None` while it holds none. Fails as git does.
    pub(super) async fn reopened_commit(
        &mut self,
        git: &GitRunner,
        place: Option<&Place>,
        folder: &Path,
        tree: &StandingTree,
    ) -> Result<Option<String>, GitError> {
        let branch_ref = format!("{BRANCH_REF_PREFIX}{}", tree.row.branch_name.as_str());
        let Some(tips) = self
            .read_tips(git, place, folder, &branch_ref, &tree.base)
            .await?
        else {
            return Ok(None);
        };
        let mut past = tips.targets.clone();
        past.extend(tree.newest_own_commit.iter().cloned());
        match newest_own_commit_past(git, place, folder, &tips.tip, &past).await {
            Ok(newest) => Ok(newest),
            // A recorded commit the repository no longer holds bounds nothing.
            Err(error) => match &tree.newest_own_commit {
                Some(recorded) if !is_commit_held(git, place, folder, recorded).await? => {
                    newest_own_commit_past(git, place, folder, &tips.tip, &tips.targets).await
                }
                _ => Err(error),
            },
        }
    }

    // The branch's tip and its targets, the base's upstream taken only where it holds commits the
    // base lacks; `None` when the branch is gone or the base names no branch. The upstream's tip is
    // read with the base under the name the last check saw, and apart only when that name changed.
    async fn read_tips(
        &mut self,
        git: &GitRunner,
        place: Option<&Place>,
        folder: &Path,
        branch_ref: &str,
        base: &str,
    ) -> Result<Option<BranchTips>, GitError> {
        // A base is stored as given: a local branch's short name first, then a full ref name, then
        // a remote-tracking branch's short name.
        let mut base_refs = vec![
            format!("{BRANCH_REF_PREFIX}{base}"),
            base.to_owned(),
            format!("{REMOTE_REF_PREFIX}{base}"),
        ];
        base_refs.dedup();
        let mut names = vec![branch_ref];
        names.extend(base_refs.iter().map(String::as_str));
        if let Some(upstream) = &self.upstream_ref
            && !names.contains(&upstream.as_str())
        {
            names.push(upstream.as_str());
        }
        let mut heads =
            read_ref_heads(git, place, folder, &names, UpstreamDistanceRead::Counted).await?;
        let Some(tip) = heads.remove(branch_ref).map(|head| head.commit) else {
            return Ok(None);
        };
        let Some(base_head) = base_refs.iter().find_map(|name| heads.remove(name)) else {
            if self.unresolved_bases.insert(base.to_owned()) {
                tracing::warn!(
                    "a worktree's base names no branch, so its branch is not read as merged back"
                );
            }
            return Ok(None);
        };
        let mut targets = vec![base_head.commit];
        if let (Some(upstream), Some((only_base, only_upstream))) =
            (&base_head.upstream, base_head.upstream_distance)
            && only_upstream > 0
        {
            let head = if self.upstream_ref.as_ref() == Some(upstream) {
                heads.remove(upstream)
            } else {
                read_ref_heads(
                    git,
                    place,
                    folder,
                    &[upstream.as_str()],
                    UpstreamDistanceRead::Skipped,
                )
                .await?
                .remove(upstream)
            };
            if let Some(head) = head {
                if only_base == 0 {
                    targets.clear();
                }
                targets.push(head.commit);
            }
        }
        self.upstream_ref = base_head.upstream;
        Ok(Some(BranchTips { tip, targets }))
    }
}

// The commits `commit` holds that none of the commits `past` holds; none exactly when one of them
// holds `commit`.
async fn count_past(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    commit: &str,
    past: &[String],
) -> Result<u64, GitError> {
    let excluded: Vec<String> = past.iter().map(|target| format!("^{target}")).collect();
    let mut arguments = vec!["rev-list", "--count", commit];
    arguments.extend(excluded.iter().map(String::as_str));
    arguments.push("--");
    parse_number(&strip_line_end(read(git, place, folder, &arguments).await?))
}

// The newest commit `commit` holds that changes a path, merge commits left out, and that none of
// the commits `past` holds; `None` when there is none.
async fn newest_own_commit_past(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    commit: &str,
    past: &[String],
) -> Result<Option<String>, GitError> {
    let excluded: Vec<String> = past.iter().map(|target| format!("^{target}")).collect();
    let mut arguments = vec!["rev-list", "--max-count=1", "--no-merges", commit];
    arguments.extend(excluded.iter().map(String::as_str));
    // The tree's root as a path keeps only the commits that change one.
    arguments.extend(["--", "."]);
    let newest = strip_line_end(read(git, place, folder, &arguments).await?);
    Ok((!newest.is_empty()).then(|| String::from_utf8_lossy(&newest).into_owned()))
}

// The newest commit, amend or pick in the branch's reflog that changed a path and that the base or
// its upstream holds; `None` when none did. It is read only while the branch's tip is contained,
// so a commit the branch still holds is held there too.
async fn newest_own_commit_on(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    branch_ref: &str,
    tips: &BranchTips,
) -> Result<Option<String>, GitError> {
    let reflog = read(
        git,
        place,
        folder,
        &[
            "log",
            "--walk-reflogs",
            "--format=%H%x00%gs",
            branch_ref,
            "--",
        ],
    )
    .await?;
    let mut made: Vec<&[u8]> = Vec::new();
    for entry in reflog.split(|byte| *byte == b'\n') {
        let Some(end) = entry.iter().position(|byte| *byte == 0) else {
            continue;
        };
        let (commit, subject) = (&entry[..end], &entry[end + 1..]);
        if OWN_COMMIT_REFLOG_PREFIXES
            .iter()
            .any(|prefix| subject.starts_with(prefix))
            && !made.contains(&commit)
        {
            made.push(commit);
        }
    }
    if made.is_empty() {
        return Ok(None);
    }
    // Those that changed a path, newest first.
    let changed = read_with_input(
        git,
        place,
        folder,
        &["rev-list", "--no-walk=unsorted", "--stdin", "--", "."],
        lines_of(made.iter().copied()),
    )
    .await?;
    let changed: Vec<&[u8]> = changed
        .split(|byte| *byte == b'\n')
        .filter(|commit| !commit.is_empty())
        .collect();
    if changed.is_empty() {
        return Ok(None);
    }
    // A walk from them that stops at the base and its upstream lists every one neither holds.
    let excluded: Vec<Vec<u8>> = tips
        .targets
        .iter()
        .map(|target| format!("^{target}").into_bytes())
        .collect();
    let walk = lines_of(
        changed
            .iter()
            .copied()
            .chain(excluded.iter().map(Vec::as_slice)),
    );
    let outside = read_with_input(git, place, folder, &["rev-list", "--stdin"], walk).await?;
    let outside: HashSet<&[u8]> = outside.split(|byte| *byte == b'\n').collect();
    Ok(changed
        .iter()
        .find(|commit| !outside.contains(*commit))
        .map(|commit| String::from_utf8_lossy(commit).into_owned()))
}

// `lines`, each ended by a newline, as git's standard input takes revisions.
fn lines_of<'line>(lines: impl Iterator<Item = &'line [u8]>) -> Vec<u8> {
    let mut input = Vec::new();
    for line in lines {
        input.extend_from_slice(line);
        input.push(b'\n');
    }
    input
}

// Whether the repository holds `commit`.
async fn is_commit_held(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    commit: &str,
) -> Result<bool, GitError> {
    let object = format!("{commit}^{{commit}}");
    match read(
        git,
        place,
        folder,
        &["rev-parse", "--verify", "--quiet", &object],
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(error) if error.exit_code() == Some(NOT_HELD_EXIT_CODE) => Ok(false),
        Err(error) => Err(error),
    }
}

// Whether the base or its upstream holds every change the branch makes: each commit's patch, else
// the branch's whole change as one squashed patch. One patch-id call reads every target's patches,
// each headed by a label in place of its commit that names its target and its side.
async fn is_applied(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    tips: &BranchTips,
) -> Result<bool, GitError> {
    let mut input = Vec::new();
    let mut labels: Vec<(usize, PatchSide)> = Vec::new();
    let mut tested = 0;
    for target in &tips.targets {
        let Some(patches) = read_patches_on(git, place, folder, target, &tips.tip).await? else {
            continue;
        };
        let mut label = |input: &mut Vec<u8>, side| {
            input.extend_from_slice(COMMIT_HEADER);
            input.extend_from_slice(format!("{:0>1$x}\n", labels.len(), tips.tip.len()).as_bytes());
            labels.push((tested, side));
        };
        label(&mut input, PatchSide::Squash);
        input.extend(patches.squash);
        for line in patches.log.split(|byte| *byte == b'\n') {
            match line.strip_prefix(COMMIT_HEADER).map(<[u8]>::first) {
                Some(Some(b'<')) => label(&mut input, PatchSide::Target),
                Some(Some(b'>')) => label(&mut input, PatchSide::Branch),
                Some(_) => return Err(malformed("git printed a log header it never writes")),
                None => {
                    input.extend_from_slice(line);
                    input.push(b'\n');
                }
            }
        }
        tested += 1;
    }
    if tested == 0 {
        return Ok(false);
    }
    let ids = read_with_input(git, place, folder, &["patch-id", "--stable"], input).await?;
    let mut found: Vec<PatchIds> = (0..tested).map(|_| PatchIds::default()).collect();
    for line in ids
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let Some(space) = line.iter().position(|byte| *byte == b' ') else {
            return Err(malformed("git printed a patch id it never writes"));
        };
        let (patch, label) = (&line[..space], &line[space + 1..]);
        let Some(&(target, side)) = std::str::from_utf8(label)
            .ok()
            .and_then(|label| usize::from_str_radix(label, 16).ok())
            .and_then(|index| labels.get(index))
        else {
            return Err(malformed(
                "git printed a patch id for a patch it was never given",
            ));
        };
        let target_ids = &mut found[target];
        match side {
            PatchSide::Squash => target_ids.squash = Some(patch),
            PatchSide::Branch => target_ids.branch.push(patch),
            PatchSide::Target => {
                target_ids.target.insert(patch);
            }
        }
    }
    Ok(found.iter().any(|ids| {
        ids.branch.iter().all(|patch| ids.target.contains(patch))
            || ids.squash.is_some_and(|patch| ids.target.contains(patch))
    }))
}

// Which patch a label in the patch-id call heads.
#[derive(Clone, Copy)]
enum PatchSide {
    // The branch's whole change since it parted from the target.
    Squash,
    // A commit of the branch's that the target lacks.
    Branch,
    // A commit of the target's that the branch lacks, limited to the branch's paths.
    Target,
}

// The patch ids one target's test found, by side.
#[derive(Default)]
struct PatchIds<'id> {
    squash: Option<&'id [u8]>,
    branch: Vec<&'id [u8]>,
    target: HashSet<&'id [u8]>,
}

// What one target's patch test reads: the branch's whole change since the two parted, and one log
// of the non-merge commits either holds that the other lacks, each headed `commit <side><commit>`.
struct TargetPatches {
    squash: Vec<u8>,
    log: Vec<u8>,
}

// The patches the test of `tip` against `target` reads, writing nothing; `None` when no target
// commit can hold one of the branch's. Only the target's commits that touch a path the branch's
// commits touch can, so the log reads both sides limited to those paths: a target commit that made
// one of the branch's changes beside others holds it, and no branch commit loses a path it changes.
async fn read_patches_on(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    target: &str,
    tip: &str,
) -> Result<Option<TargetPatches>, GitError> {
    let excluded = format!("^{target}");
    let paths = read(
        git,
        place,
        folder,
        &[
            "log",
            "--no-merges",
            "--no-renames",
            "--format=",
            "--name-only",
            "-z",
            tip,
            &excluded,
            "--",
        ],
    )
    .await?;
    let mut walk = format!("{target}...{tip}\n--\n").into_bytes();
    let mut has_paths = false;
    for path in paths
        .split(|byte| *byte == 0)
        .map(|path| path.strip_prefix(b"\n").unwrap_or(path))
        .filter(|path| !path.is_empty())
    {
        // Standard input ends a path at a newline, so one holding a newline cannot be named there,
        // and the branch is not read as applied.
        if path.contains(&b'\n') {
            return Ok(None);
        }
        walk.extend_from_slice(path);
        walk.push(b'\n');
        has_paths = true;
    }
    // A branch that changes no path holds no work of its own to have applied.
    if !has_paths {
        return Ok(None);
    }
    let log_arguments = [
        &[
            "--literal-pathspecs",
            "log",
            "--no-merges",
            "--left-right",
            "--format=commit %m%H",
        ][..],
        PATCH_OPTIONS,
        &["--stdin"],
    ]
    .concat();
    let log = read_with_input(git, place, folder, &log_arguments, walk).await?;
    let target_header = [COMMIT_HEADER, b"<"].concat();
    if !log
        .split(|byte| *byte == b'\n')
        .any(|line| line.starts_with(&target_header))
    {
        return Ok(None);
    }
    let range = format!("{target}...{tip}");
    let diff = [&["diff"][..], PATCH_OPTIONS, &[range.as_str(), "--"]].concat();
    let squash = match read(git, place, folder, &diff).await {
        Ok(squash) => squash,
        Err(error) => match read(git, place, folder, &["merge-base", target, tip]).await {
            Err(no_base) if no_base.exit_code() == Some(NO_MERGE_BASE_EXIT_CODE) => Vec::new(),
            _ => return Err(error),
        },
    };
    Ok(Some(TargetPatches { squash, log }))
}

// The header line that starts each patch patch-id reads, and each commit's in the log, which
// writes `<` or `>` after it for a commit of the target's or the branch's.
const COMMIT_HEADER: &[u8] = b"commit ";

// The diff options both sides' patches are written with, so equal changes give equal patch ids
// whatever the repository sets for diffs.
const PATCH_OPTIONS: &[&str] = &[
    "--patch",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
];

// The standard output of a background read of `arguments` in `folder`.
async fn read(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    arguments: &[&str],
) -> Result<Vec<u8>, GitError> {
    Ok(git
        .run(place, GitCall::read(background_read(folder, arguments)))
        .await?
        .stdout)
}

// The standard output of a background read of `arguments` in `folder`, fed `input`.
async fn read_with_input(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    arguments: &[&str],
    input: Vec<u8>,
) -> Result<Vec<u8>, GitError> {
    Ok(git
        .run(
            place,
            GitCall::read(background_read(folder, arguments)).with_input(input),
        )
        .await?
        .stdout)
}

/// Records `commit` on the row of the worktree `worktree_id` as the newest commit of its own seen
/// on its branch.
pub(super) fn newest_own_commit_statement(
    worktree_id: &WorktreeId,
    commit: &str,
    now: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: RECORD_NEWEST_OWN_COMMIT_SQL.into(),
        bindings: StatementBindings::Named(vec![
            text_binding("@commit", commit),
            text_binding("@worktree_id", worktree_id.text().as_str()),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count: None,
    }
}

async fn record_newest_own_commit(
    deps: &WorkingFolderWatcherDeps,
    tree: &StandingTree,
    commit: &str,
) -> Result<(), WriteError> {
    deps.writer
        .write(vec![newest_own_commit_statement(
            &tree.row.id,
            commit,
            &WireInstant::now(),
        )])
        .await?;
    Ok(())
}
