//! Whether a watched worktree's branch has merged back into its base or the base's upstream; a
//! merge into any other branch is not read.
//!
//! - The row records the last tip seen holding commits of its own: each check that counts a commit
//!   on the branch that changes a path, merge commits not counted, and that neither the base nor
//!   its upstream holds records the tip; while it records none and the tip is contained, the newest
//!   commit, amend or pick in the branch's reflog that changed a path and that the base or its
//!   upstream holds seeds it. A branch that only caught up with its base, by a fast-forward or a
//!   merge commit, never left it or made only empty commits records none and never reads merged.
//! - The checks run on the recorded tip, never on a later tip that discarded its work: it has
//!   merged when the base or its upstream holds it, or, where neither does, when nothing on it is
//!   left unapplied there: each of its commits' patches found on that side, or all of its changes
//!   as one squashed patch. The patch test runs once per combination of the recorded tip, the
//!   base's and the upstream's.
//! - A merged branch reads reopened once a check counts such commits of its own past its recorded
//!   tip.
//! - A base that names no local or remote-tracking branch, and a recorded tip the repository no
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

// Records the last tip of the tree's branch seen holding commits of its own.
const RECORD_OWN_COMMIT_TIP_SQL: &str =
    "UPDATE worktrees SET own_commit_tip = @tip, updated_at = @now WHERE id = @worktree_id";

// The prefix of every remote-tracking branch's full ref name.
const REMOTE_REF_PREFIX: &str = "refs/remotes/";

// The reflog subjects git writes for a commit made on the branch: a new one, an amended one and a
// picked one.
const OWN_COMMIT_REFLOG_PREFIXES: [&[u8]; 3] = [b"commit:", b"commit (amend):", b"cherry-pick:"];

// `merge-base`'s exit when the two commits share no history.
const NO_MERGE_BASE_EXIT_CODE: i32 = 1;

// `rev-parse --verify --quiet`'s exit when the repository holds no such commit.
const NOT_HELD_EXIT_CODE: i32 = 1;

/// What a folder's merged checks keep between changes: the last patch test's tips and verdict, and
/// each base already logged as naming no branch and each recorded tip as gone.
#[derive(Default)]
pub(super) struct MergedCheck {
    last_patch_test: Option<(BranchTips, bool)>,
    unresolved_bases: HashSet<String>,
    missing_tips: HashSet<String>,
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
    /// on its row the last tip seen holding commits of its own. Fails as git or the write does.
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
        let own_commits = count_past(
            git,
            place,
            folder,
            &tips.tip,
            &tips.targets,
            Commits::OwnOnly,
        )
        .await?;
        if own_commits > 0 {
            // The tip holds work the base and its upstream lack, so neither contains it.
            if tree.own_commit_tip.as_deref() != Some(tips.tip.as_str()) {
                record_own_commit_tip(deps, tree, &tips.tip).await?;
            }
        } else {
            let recorded = if let Some(recorded) = &tree.own_commit_tip {
                recorded.clone()
            } else {
                if count_past(git, place, folder, &tips.tip, &tips.targets, Commits::All).await? > 0
                {
                    return Ok(false);
                }
                let Some(seed) =
                    newest_own_commit_on(git, place, folder, &branch_ref, &tips).await?
                else {
                    return Ok(false);
                };
                record_own_commit_tip(deps, tree, &seed).await?;
                seed
            };
            match count_past(git, place, folder, &recorded, &tips.targets, Commits::All).await {
                Ok(0) => return Ok(true),
                Ok(_) => {}
                Err(error) => {
                    if is_commit_held(git, place, folder, &recorded).await? {
                        return Err(error.into());
                    }
                    if self.missing_tips.insert(recorded) {
                        tracing::warn!(
                            "a worktree's recorded branch tip is gone from its repository, so its \
                             branch is not read as merged back"
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

    /// The tip of `tree`'s branch, merged back and checked out at `folder`, once it holds commits of
    /// its own past the recorded tip that neither the base nor its upstream holds, which the row
    /// then records; `None` while it holds none. Fails as git does.
    pub(super) async fn reopened_tip(
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
        past.extend(tree.own_commit_tip.iter().cloned());
        let count = match count_past(git, place, folder, &tips.tip, &past, Commits::OwnOnly).await {
            Ok(count) => count,
            // A recorded tip the repository no longer holds bounds nothing.
            Err(error) => match &tree.own_commit_tip {
                Some(recorded) if !is_commit_held(git, place, folder, recorded).await? => {
                    count_past(
                        git,
                        place,
                        folder,
                        &tips.tip,
                        &tips.targets,
                        Commits::OwnOnly,
                    )
                    .await?
                }
                _ => return Err(error),
            },
        };
        Ok((count > 0).then_some(tips.tip))
    }

    // The branch's tip and its targets, the base's upstream read only where it holds commits the
    // base lacks; `None` when the branch is gone or the base names no branch.
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
            && let Some(head) = read_ref_heads(
                git,
                place,
                folder,
                &[upstream.as_str()],
                UpstreamDistanceRead::Skipped,
            )
            .await?
            .remove(upstream)
        {
            if only_base == 0 {
                targets.clear();
            }
            targets.push(head.commit);
        }
        Ok(Some(BranchTips { tip, targets }))
    }
}

// Which commits a count takes.
#[derive(Clone, Copy)]
enum Commits {
    All,
    // Only those that change a path, merge commits and empty ones left out.
    OwnOnly,
}

// The commits `commit` holds that none of the commits `past` holds; with `All`, none exactly when
// one of them holds `commit`.
async fn count_past(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    commit: &str,
    past: &[String],
    commits: Commits,
) -> Result<u64, GitError> {
    let excluded: Vec<String> = past.iter().map(|target| format!("^{target}")).collect();
    let mut arguments = vec!["rev-list", "--count"];
    if matches!(commits, Commits::OwnOnly) {
        arguments.push("--no-merges");
    }
    arguments.push(commit);
    arguments.extend(excluded.iter().map(String::as_str));
    arguments.push("--");
    // The tree's root as a path keeps only the commits that change one.
    if matches!(commits, Commits::OwnOnly) {
        arguments.push(".");
    }
    parse_number(&strip_line_end(read(git, place, folder, &arguments).await?))
}

// The commit of the newest commit, amend or pick in the branch's reflog that changed a path and that
// the base or its upstream holds; `None` when none did. It is read only while the branch's tip is
// contained, so a commit the branch still holds is held there too.
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
// the branch's whole change as one squashed patch.
async fn is_applied(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    tips: &BranchTips,
) -> Result<bool, GitError> {
    for target in &tips.targets {
        if is_applied_on(git, place, folder, target, &tips.tip).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

// Whether `target` holds each change `tip` makes past it, by patch id and writing nothing: every
// non-merge commit's patch, or the whole change since the two parted as one patch. Only the
// commits on `target` that touch a path the branch's commits touch can hold one, so only they are
// read, each limited to those paths: a commit that made one of the branch's changes beside others
// holds it.
async fn is_applied_on(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    target: &str,
    tip: &str,
) -> Result<bool, GitError> {
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
    let mut walk = format!("{target}\n^{tip}\n--\n").into_bytes();
    let mut has_paths = false;
    for path in paths
        .split(|byte| *byte == 0)
        .map(|path| path.strip_prefix(b"\n").unwrap_or(path))
        .filter(|path| !path.is_empty())
    {
        // Standard input ends a path at a newline, so one holding a newline cannot be named there,
        // and the branch is not read as applied.
        if path.contains(&b'\n') {
            return Ok(false);
        }
        walk.extend_from_slice(path);
        walk.push(b'\n');
        has_paths = true;
    }
    // A branch that changes no path holds no work of its own to have applied.
    if !has_paths {
        return Ok(false);
    }
    let target_log = [
        &[
            "--literal-pathspecs",
            "log",
            "--no-merges",
            "--format=commit %H",
        ][..],
        PATCH_OPTIONS,
        &["--stdin"],
    ]
    .concat();
    let on_target = read_with_input(git, place, folder, &target_log, walk).await?;
    if on_target.is_empty() {
        return Ok(false);
    }
    // The branch's whole change first, with no commit header, so patch-id names it by the null id.
    let range = format!("{target}...{tip}");
    let diff = [&["diff"][..], PATCH_OPTIONS, &[range.as_str(), "--"]].concat();
    let mut patches = match read(git, place, folder, &diff).await {
        Ok(squash) => squash,
        Err(error) => match read(git, place, folder, &["merge-base", target, tip]).await {
            Err(no_base) if no_base.exit_code() == Some(NO_MERGE_BASE_EXIT_CODE) => Vec::new(),
            _ => return Err(error),
        },
    };
    let branch_log = [
        &["log", "--no-merges", "--format=commit %H"][..],
        PATCH_OPTIONS,
        &[tip, excluded.as_str(), "--"],
    ]
    .concat();
    let on_branch = read(git, place, folder, &branch_log).await?;
    let branch_commits: HashSet<&[u8]> = on_branch
        .split(|byte| *byte == b'\n')
        .filter_map(|line| line.strip_prefix(COMMIT_HEADER))
        .collect();
    patches.extend_from_slice(&on_branch);
    patches.extend(on_target);
    let ids = read_with_input(git, place, folder, &["patch-id", "--stable"], patches).await?;
    let (mut target_patches, mut branch_patches, mut squash) = (HashSet::new(), Vec::new(), None);
    for line in ids
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let Some(space) = line.iter().position(|byte| *byte == b' ') else {
            return Err(malformed("git printed a patch id it never writes"));
        };
        let (patch, commit) = (&line[..space], &line[space + 1..]);
        if commit.iter().all(|byte| *byte == b'0') {
            squash = Some(patch);
        } else if branch_commits.contains(commit) {
            branch_patches.push(patch);
        } else {
            target_patches.insert(patch);
        }
    }
    Ok(branch_patches
        .iter()
        .all(|patch| target_patches.contains(patch))
        || squash.is_some_and(|patch| target_patches.contains(patch)))
}

// The header line `--format=commit %H` writes before each commit's patch, which patch-id reads.
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

/// Records `tip` on the row of the worktree `worktree_id` as the last tip of its branch seen holding
/// commits of its own.
pub(super) fn own_commit_tip_statement(
    worktree_id: &WorktreeId,
    tip: &str,
    now: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: RECORD_OWN_COMMIT_TIP_SQL.into(),
        bindings: StatementBindings::Named(vec![
            text_binding("@tip", tip),
            text_binding("@worktree_id", worktree_id.text().as_str()),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count: None,
    }
}

async fn record_own_commit_tip(
    deps: &WorkingFolderWatcherDeps,
    tree: &StandingTree,
    tip: &str,
) -> Result<(), WriteError> {
    deps.writer
        .write(vec![own_commit_tip_statement(
            &tree.row.id,
            tip,
            &WireInstant::now(),
        )])
        .await?;
    Ok(())
}
