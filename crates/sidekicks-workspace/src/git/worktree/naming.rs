//! How a worktree is named: its branch from the machine's or the project's branch-name pattern,
//! and its flat folder `<worktrees>/<project slug>/<session-short-id>-<tail>/`. The creator names
//! the tree it makes and the create form's suggestion through the one plan built here, so the form
//! never shows a name or a path the daemon would not make. Git's refusal of a taken branch name is
//! read here too, for every caller that makes a branch, and the folder shape a name plan makes is
//! checked here for every caller that deletes a tree by its stored folder.
//!
//! Every tail is shaped to `a-z 0-9 . _ -` before it is cut, so its bytes and its characters
//! count alike.

use std::error::Error;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::settings::{BRANCH_NAME_TITLE_PLACEHOLDER, BranchNamePattern};
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};
use sidekicks_contracts::worktree::lifecycle::NewWorktreeSuggestion;

use crate::git::branch_name_pattern::{
    BranchNamePatternValues, GIT_FATAL_PREFIX, fill_branch_name_pattern, last_fatal_line,
    strip_lock_clause,
};
use crate::git::worktree::errors::{WorktreeCreateFailureReason, WorktreeRefusal};

const WORKTREES_FOLDER_NAME: &str = "worktrees";

/// The folder in each project's worktrees folder that holds its kept worktrees. A slug never
/// starts with a dot, so it cannot be a project's folder.
#[expect(dead_code, reason = "the kept worktrees' store and their put-back")]
pub(crate) const REMOVED_WORKTREES_FOLDER_NAME: &str = ".removed";

const SHORT_ID_LENGTH: usize = 8;

// The longest tail in bytes, its collision suffix included: the file system's 255-byte name limit
// (APFS, ext4), less the folder's `<8hex>-` prefix.
const TAIL_MAX_BYTES: usize = 255 - (SHORT_ID_LENGTH + 1);

/// The most code points a name derived from a session's words holds: the session's fallback name
/// from its first message, and a worktree tail cut from its title, which is shaped to ASCII first.
pub const DERIVED_NAME_MAX_CODE_POINTS: usize = 40;

/// The daemon's worktrees folder in the data folder inside `home_folder`, holding one folder per
/// project.
pub fn worktrees_folder(home_folder: &Path) -> PathBuf {
    home_folder
        .join(DAEMON_DATA_FOLDER_NAME)
        .join(WORKTREES_FOLDER_NAME)
}

/// The last 8 hex characters of an id, hyphens stripped and lowercased: a v7 id's random tail.
#[cfg_attr(not(test), expect(dead_code, reason = "worktree creation and status"))]
pub(crate) fn short_id_of(identifier: &str) -> String {
    let hex: Vec<char> = identifier
        .chars()
        .filter(|character| *character != '-')
        .collect();
    hex[hex.len().saturating_sub(SHORT_ID_LENGTH)..]
        .iter()
        .collect::<String>()
        .to_lowercase()
}

/// Git's taken-branch line in a failed branch creation's `stderr`, printed under `LC_ALL=C`: its
/// last `fatal: ` line whole when it says a branch of that name exists, or that one exists the new
/// branch would hold or sit inside, with or without the files backend's lock clause. `None` for any
/// other failure.
#[cfg_attr(not(test), expect(dead_code, reason = "worktree creation"))]
pub(crate) fn read_taken_branch_line(stderr: &str) -> Option<&str> {
    let line = last_fatal_line(stderr)?;
    let words = strip_lock_clause(line.strip_prefix(GIT_FATAL_PREFIX)?);
    let is_named_branch = words
        .strip_prefix("a branch named '")
        .is_some_and(|rest| rest.ends_with("' already exists"));
    let is_nested_branch = words.strip_prefix("'refs/heads/").is_some_and(|rest| {
        rest.split_once("' exists; cannot create 'refs/heads/")
            .is_some_and(|(_held, created)| created.ends_with('\''))
    });
    (is_named_branch || is_nested_branch).then_some(line)
}

// A tail shaped as typed: lowercased, every character outside `a-z 0-9 . _ -` turned into a
// hyphen, and any leading `.`, `_` or `-` dropped, so it is empty or starts with a letter or digit.
fn shape_typed_tail(typed: &str) -> String {
    let shaped: String = typed
        .to_lowercase()
        .chars()
        .map(|character| match character {
            'a'..='z' | '0'..='9' | '.' | '_' | '-' => character,
            _ => '-',
        })
        .collect();
    shaped.trim_start_matches(['.', '_', '-']).to_owned()
}

// Trailing `-`, `.` and `.lock`, which git refuses at a name's end, trimmed until none is left.
fn trim_tail_end(tail: &str) -> &str {
    let mut trimmed = tail;
    loop {
        let next = trimmed.trim_end_matches(['-', '.']);
        let next = next.strip_suffix(".lock").unwrap_or(next);
        if next.len() == trimmed.len() {
            return trimmed;
        }
        trimmed = next;
    }
}

// Cut at the last hyphen within `max_len`; a single word longer than that is cut at `max_len`.
fn cut_at_word_break(tail: &str, max_len: usize) -> &str {
    if tail.len() <= max_len {
        return tail;
    }
    let clipped = &tail[..tail.floor_char_boundary(max_len)];
    if tail[clipped.len()..].starts_with('-') {
        return clipped;
    }
    match clipped.rfind('-') {
        Some(last_break) if last_break > 0 => &clipped[..last_break],
        Some(_) | None => clipped,
    }
}

// A tail with its collision suffix, the tail cut first so both fit the folder name's bound.
fn with_suffix(tail: &str, suffix: &str) -> String {
    let tail_max_len = TAIL_MAX_BYTES - suffix.len();
    if tail.len() <= tail_max_len {
        return format!("{tail}{suffix}");
    }
    format!(
        "{}{suffix}",
        trim_tail_end(cut_at_word_break(tail, tail_max_len))
    )
}

// Runs of `-` and of `.` each folded into one.
fn collapse_repeats(tail: &str) -> String {
    let mut collapsed = String::with_capacity(tail.len());
    for character in tail.chars() {
        let is_repeat = matches!(character, '-' | '.') && collapsed.ends_with(character);
        if !is_repeat {
            collapsed.push(character);
        }
    }
    collapsed
}

/// The tail a session's title words suggest, as the naming sources read them: shaped as typed,
/// repeated `-` and `.` collapsed, a trailing `-`, `.` or `.lock` trimmed, and cut at a word break
/// within [`DERIVED_NAME_MAX_CODE_POINTS`]. Empty when no usable words remain.
#[cfg_attr(not(test), expect(dead_code, reason = "worktree creation and status"))]
pub(crate) fn suggest_tail_for(title_words: &str) -> String {
    let collapsed = collapse_repeats(&shape_typed_tail(title_words));
    trim_tail_end(cut_at_word_break(
        trim_tail_end(&collapsed),
        DERIVED_NAME_MAX_CODE_POINTS,
    ))
    .to_owned()
}

/// The tail a run's tree takes when no title gives one: `run-<run-short-id>`. Fails with
/// `worktree.createFailed` (`BranchNameUnderivable`) when there is no run either.
#[cfg_attr(not(test), expect(dead_code, reason = "worktree creation"))]
pub(crate) fn derive_run_tail(
    title_tail: &str,
    run_id: Option<&str>,
) -> Result<String, WorktreeRefusal> {
    if !title_tail.is_empty() {
        return Ok(title_tail.to_owned());
    }
    match run_id.filter(|run_id| !run_id.is_empty()) {
        Some(run_id) => Ok(format!("run-{}", short_id_of(run_id))),
        None => Err(WorktreeRefusal::CreateFailed {
            reason: WorktreeCreateFailureReason::BranchNameUnderivable,
            source: None,
        }),
    }
}

/// A project's naming facts: its slug, fixed at attach, and its own branch pattern if set.
#[derive(Clone, Debug)]
pub struct WorktreeProjectNaming {
    /// The project's slug, its worktrees folder's name.
    pub slug: String,
    /// The project's own pattern; `None` follows the machine's.
    pub branch_pattern: Option<BranchNamePattern>,
}

/// Why a naming source could not answer; the implementation's own failure is kept as the cause.
#[derive(Debug, thiserror::Error)]
#[error("the worktree's naming facts could not be read")]
pub struct WorktreeNamingError(#[source] pub Box<dyn Error + Send + Sync>);

/// Where the naming reads what other owners keep: the project record, the machine's settings and
/// the session's title.
pub trait WorktreeNamingSources: Send + Sync {
    /// The naming facts of the project the attached mount `repo_mount_id` serves. Fails when the
    /// mount serves none or the read fails.
    fn read_project_naming<'a>(
        &'a self,
        repo_mount_id: &'a RepoMountId,
    ) -> BoxFuture<'a, Result<WorktreeProjectNaming, WorktreeNamingError>>;

    /// The machine's `Branch names` pattern. Fails when the settings cannot be read.
    fn read_machine_branch_pattern(
        &self,
    ) -> BoxFuture<'_, Result<BranchNamePattern, WorktreeNamingError>>;

    /// The words `session_id`'s title gives: its name, else the first words of its first message,
    /// else those of `fallback_message`, which stands in for a first message not yet recorded on
    /// the session; empty when none gives any. Fails when the session is unknown or the read fails.
    fn read_session_title_words<'a>(
        &'a self,
        session_id: &'a SessionId,
        fallback_message: Option<&'a str>,
    ) -> BoxFuture<'a, Result<String, WorktreeNamingError>>;
}

/// One candidate name: the whole branch, the tree's folder, and the tail both were made from.
#[cfg_attr(not(test), expect(dead_code, reason = "worktree creation and status"))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorktreeName {
    /// The branch.
    pub(crate) branch_name: String,
    /// The tree's folder.
    pub(crate) folder_path: PathBuf,
    /// The tail, empty for a supplied name the pattern did not make.
    pub(crate) tail: String,
}

/// What every plan for one session's tree on one project shares.
#[cfg_attr(not(test), expect(dead_code, reason = "worktree creation and status"))]
#[derive(Clone, Debug)]
pub(crate) struct WorktreeNameBase {
    /// The project's or the machine's pattern.
    pub(crate) pattern: BranchNamePattern,
    /// The session's short id.
    pub(crate) session_short_id: String,
    /// The project's worktrees folder.
    pub(crate) project_folder: PathBuf,
}

// Where a plan's branch name comes from.
#[cfg_attr(not(test), expect(dead_code, reason = "worktree creation and status"))]
#[derive(Clone, Debug)]
enum PlannedBranch {
    // A tail the pattern fills in.
    Tail(String),
    // A whole name a caller supplied that the pattern did not make, kept as spelled.
    Supplied(String),
}

/// The names one tree can take, in collision order: ordinal 1 is the name itself, and ordinal `n`
/// puts `-n` on the tail, so the branch and the folder stay in step. A tail too long to take its
/// suffix within the folder name's bound is cut first.
#[cfg_attr(not(test), expect(dead_code, reason = "worktree creation and status"))]
#[derive(Clone, Debug)]
pub(crate) struct WorktreeNamePlan {
    base: WorktreeNameBase,
    branch: PlannedBranch,
    folder_tail: String,
}

#[cfg_attr(not(test), expect(dead_code, reason = "worktree creation and status"))]
impl WorktreeNamePlan {
    /// The plan for a tail the pattern fills in.
    pub(crate) fn for_tail(base: WorktreeNameBase, tail: String) -> Self {
        Self {
            base,
            folder_tail: tail.clone(),
            branch: PlannedBranch::Tail(tail),
        }
    }

    /// The plan for a whole branch name a caller supplied: the tail is what the pattern's fixed
    /// parts leave of it, and a name the pattern did not make keeps its spelling while its folder
    /// takes the name shaped as typed.
    pub(crate) fn for_branch_name(base: WorktreeNameBase, branch_name: &str) -> Self {
        let (before, after) = split_pattern(&base.pattern, &base.session_short_id);
        let middle = (branch_name.len() > before.len() + after.len())
            .then(|| branch_name.strip_prefix(before.as_str()))
            .flatten()
            .and_then(|rest| rest.strip_suffix(after.as_str()));
        if let Some(middle) = middle
            && shape_typed_tail(middle) == middle
        {
            return Self::for_tail(base, middle.to_owned());
        }
        Self {
            base,
            folder_tail: shape_typed_tail(branch_name),
            branch: PlannedBranch::Supplied(branch_name.to_owned()),
        }
    }

    /// The name at `ordinal`, 1 for the name itself.
    pub(crate) fn name_at(&self, ordinal: u32) -> WorktreeName {
        let suffix = if ordinal == 1 {
            String::new()
        } else {
            format!("-{ordinal}")
        };
        let folder_path = self.base.project_folder.join(format!(
            "{}-{}",
            self.base.session_short_id,
            with_suffix(&self.folder_tail, &suffix)
        ));
        match &self.branch {
            PlannedBranch::Supplied(branch_name) => WorktreeName {
                branch_name: format!("{branch_name}{suffix}"),
                folder_path,
                tail: String::new(),
            },
            PlannedBranch::Tail(tail) => {
                let tail = with_suffix(tail, &suffix);
                WorktreeName {
                    branch_name: fill_branch_name_pattern(
                        self.base.pattern.as_str(),
                        BranchNamePatternValues {
                            title: &tail,
                            session: &self.base.session_short_id,
                        },
                    ),
                    folder_path,
                    tail,
                }
            }
        }
    }

    /// The create form's parts: the branch's fixed part before the tail, the tail at `ordinal`,
    /// and the folder up to that tail. A typed branch name the pattern did not make, or a session
    /// with no title words, has no tail, so the suggestion carries none. Fails with the text
    /// check's refusal when the folder is not a path the wire takes.
    pub(crate) fn describe_at(&self, ordinal: u32) -> Result<NewWorktreeSuggestion, TextError> {
        let (fixed_part, _after) = split_pattern(&self.base.pattern, &self.base.session_short_id);
        let folder_before = self
            .base
            .project_folder
            .join(format!("{}-", self.base.session_short_id));
        // The plan's own tail is read before any suffix, which would make an empty one `-2`.
        let suggested_tail = match &self.branch {
            PlannedBranch::Tail(tail) if !tail.is_empty() => {
                Some(FreeFormText::new(self.name_at(ordinal).tail)?)
            }
            PlannedBranch::Tail(_) | PlannedBranch::Supplied(_) => None,
        };
        Ok(NewWorktreeSuggestion {
            fixed_part,
            suggested_tail,
            folder_before: FilesystemPath::new(folder_before.to_string_lossy().into_owned())?,
        })
    }
}

// The pattern's text before and after `{title}`, each with `{session}` filled in.
#[cfg_attr(not(test), expect(dead_code, reason = "worktree creation and status"))]
fn split_pattern(pattern: &BranchNamePattern, session_short_id: &str) -> (String, String) {
    let (before, after) = pattern
        .as_str()
        .split_once(BRANCH_NAME_TITLE_PLACEHOLDER)
        .expect("a saved branch-name pattern holds {title} once");
    let fill = |part: &str| {
        fill_branch_name_pattern(
            part,
            BranchNamePatternValues {
                title: "",
                session: session_short_id,
            },
        )
    };
    (fill(before), fill(after))
}

/// Whether `folder` is `<worktrees_folder>/<project slug>/<name>`, the only shape a name plan
/// makes: a stored path comes from the database, and a recursive removal must not reach a
/// project's kept copies under [`REMOVED_WORKTREES_FOLDER_NAME`], another project's folder or
/// anything outside the worktrees folder.
pub(crate) fn is_named_worktree_folder(worktrees_folder: &Path, folder: &Path) -> bool {
    let Ok(inside) = folder.strip_prefix(worktrees_folder) else {
        return false;
    };
    let parts: Vec<Component<'_>> = inside.components().collect();
    parts.len() == 2
        && parts.iter().all(|part| match part {
            Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
            Component::Prefix(_)
            | Component::RootDir
            | Component::CurDir
            | Component::ParentDir => false,
        })
}

/// Builds name plans from the project's and the machine's patterns.
#[expect(dead_code, reason = "worktree creation and status")]
#[derive(Clone)]
pub(crate) struct WorktreeNaming {
    worktrees_folder: PathBuf,
    sources: Arc<dyn WorktreeNamingSources>,
}

#[expect(dead_code, reason = "worktree creation and status")]
impl WorktreeNaming {
    /// Naming under the daemon's `worktrees_folder`, reading what other owners keep from `sources`.
    pub(crate) fn new(worktrees_folder: PathBuf, sources: Arc<dyn WorktreeNamingSources>) -> Self {
        Self {
            worktrees_folder,
            sources,
        }
    }

    /// The daemon's worktrees folder, holding one folder per project.
    pub(crate) fn worktrees_folder(&self) -> &Path {
        &self.worktrees_folder
    }

    /// The folder the project of `repo_mount_id` keeps its worktrees in, and its kept ones under
    /// [`REMOVED_WORKTREES_FOLDER_NAME`]. Fails when the project's naming cannot be read.
    pub(crate) async fn project_folder_of(
        &self,
        repo_mount_id: &RepoMountId,
    ) -> Result<PathBuf, WorktreeNamingError> {
        let project = self.sources.read_project_naming(repo_mount_id).await?;
        Ok(self.worktrees_folder.join(project.slug))
    }

    /// The base every plan for a tree of `session_id` on the project of `repo_mount_id` starts
    /// from. Fails when the project's naming or the machine's pattern cannot be read.
    pub(crate) async fn base_for(
        &self,
        repo_mount_id: &RepoMountId,
        session_id: &SessionId,
    ) -> Result<WorktreeNameBase, WorktreeNamingError> {
        let project = self.sources.read_project_naming(repo_mount_id).await?;
        let pattern = match project.branch_pattern {
            Some(pattern) => pattern,
            None => self.sources.read_machine_branch_pattern().await?,
        };
        Ok(WorktreeNameBase {
            pattern,
            session_short_id: short_id_of(session_id.text().as_str()),
            project_folder: self.worktrees_folder.join(project.slug),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use rstest::rstest;
    use sidekicks_contracts::machine::settings::{BranchNamePattern, BranchNamePatternChange};
    use sidekicks_contracts::wire::text::FreeFormText;

    use super::{
        WorktreeNameBase, WorktreeNamePlan, derive_run_tail, read_taken_branch_line,
        suggest_tail_for,
    };

    // Kills the 246-byte cut on a derived tail, the collapse or the trailing trim left out, the
    // run fallback taken while a word remains, and a tail derived with neither words nor a run.
    #[rstest]
    #[case::spaces("fix the login redirect", "fix-the-login-redirect")]
    #[case::shaped("Fix: Login_Redirect!!", "fix-login_redirect")]
    #[case::leading_marks("--.hidden title", "hidden-title")]
    #[case::repeats("a -- b .. c", "a-b-.-c")]
    #[case::trailing_lock("release notes.lock", "release-notes")]
    #[case::trailing_marks("what now?.", "what-now")]
    #[case::cut_near_forty(
        "one two three four five six seven eight nine ten",
        "one-two-three-four-five-six-seven-eight"
    )]
    #[case::break_at_forty(
        "abcdefghij abcdefghij abcdefghij abcdefg xyz",
        "abcdefghij-abcdefghij-abcdefghij-abcdefg"
    )]
    #[case::one_long_word(
        "abcdefghijabcdefghijabcdefghijabcdefghijabcdefghij",
        "abcdefghijabcdefghijabcdefghijabcdefghij"
    )]
    #[case::no_words("?!", "")]
    fn a_title_derives_its_tail(#[case] title: &str, #[case] expected: &str) {
        assert_eq!(suggest_tail_for(title), expected);
        let run_tail = derive_run_tail(expected, Some("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e"))
            .expect("a run gives a tail");
        let fallback = if expected.is_empty() {
            "run-7b8c9d0e"
        } else {
            expected
        };
        assert_eq!(run_tail, fallback);
        assert_eq!(
            derive_run_tail(expected, None).is_err(),
            expected.is_empty()
        );
    }

    // Kills the reftable or packed-ref line left unread, the lock clause required, and any
    // `fatal:` line taken as a taken branch.
    #[rstest]
    #[case::named(
        "Preparing worktree\nfatal: a branch named 'a' already exists\n",
        Some("fatal: a branch named 'a' already exists")
    )]
    #[case::files_loose(
        "fatal: cannot lock ref 'refs/heads/a/b': 'refs/heads/a' exists; cannot create \
         'refs/heads/a/b'\n",
        Some(
            "fatal: cannot lock ref 'refs/heads/a/b': 'refs/heads/a' exists; cannot create \
             'refs/heads/a/b'"
        )
    )]
    #[case::files_packed_or_reftable(
        "fatal: 'refs/heads/a' exists; cannot create 'refs/heads/a/b'\n",
        Some("fatal: 'refs/heads/a' exists; cannot create 'refs/heads/a/b'")
    )]
    #[case::unrelated("fatal: 'x y' is not a valid branch name\n", None)]
    #[case::no_fatal_line("error: something else\n", None)]
    fn a_taken_branch_line_is_read_as_git_prints_it(
        #[case] stderr: &str,
        #[case] expected: Option<&str>,
    ) {
        assert_eq!(read_taken_branch_line(stderr), expected);
    }

    // Kills a typed branch name the pattern did not make, or an untitled session's empty tail,
    // described with an empty tail, which the wire refuses; the empty tail read after its suffix
    // (`-2`); and a tail the pattern fills in left out of the suggestion.
    #[test]
    fn a_typed_branch_name_outside_the_pattern_suggests_no_tail() {
        let base = WorktreeNameBase {
            pattern: BranchNamePattern::new(
                BranchNamePatternChange::new("sidekicks/{session}/{title}".to_owned())
                    .expect("a bounded pattern"),
            )
            .expect("a pattern holding {title}"),
            session_short_id: "7b8c9d0e".to_owned(),
            project_folder: PathBuf::from("/worktrees/project"),
        };

        let typed = WorktreeNamePlan::for_branch_name(base.clone(), "release/next")
            .describe_at(1)
            .expect("a typed name is described");
        assert_eq!(typed.suggested_tail, None);
        assert_eq!(typed.fixed_part, "sidekicks/7b8c9d0e/");

        let untitled = WorktreeNamePlan::for_tail(base.clone(), suggest_tail_for(""));
        for ordinal in [1, 2] {
            let described = untitled
                .describe_at(ordinal)
                .expect("an untitled session is described");
            assert_eq!(described.suggested_tail, None);
        }

        let made = WorktreeNamePlan::for_branch_name(base, "sidekicks/7b8c9d0e/fix-login")
            .describe_at(2)
            .expect("a pattern-made name is described");
        assert_eq!(
            made.suggested_tail.as_ref().map(FreeFormText::as_str),
            Some("fix-login-2")
        );
    }
}
