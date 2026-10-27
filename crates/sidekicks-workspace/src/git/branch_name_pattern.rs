//! The check a branch-name pattern passes before it is saved, for the machine's `Branch names` and
//! a project's own pattern alike: git's own branch-name rule over the name the pattern fills in,
//! then whether that name clashes with a branch in each repository the pattern applies to.
//! The rule is read as `check-ref-format` over the ref the branch would be, which opens no
//! repository, so the daemon's own folder never decides; `--branch` would read that folder's
//! repository and fail in a broken one with the code of a refused name.

use std::error::Error;
use std::path::PathBuf;

use sidekicks_contracts::machine::settings::{
    BRANCH_NAME_TITLE_PLACEHOLDER, BranchNamePattern, ProjectBranchPatternRefusedDetails,
};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::project::{ProjectId, ProjectState};
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::git::process::{GitCall, GitError, GitRunner, in_folder};

/// The placeholder a branch-name pattern may hold for the session's short id.
pub(crate) const BRANCH_NAME_SESSION_PLACEHOLDER: &str = "{session}";

/// What a branch-name pattern's placeholders are filled with.
#[derive(Clone, Copy, Debug)]
pub(crate) struct BranchNamePatternValues<'a> {
    /// The tail derived from the session's title.
    pub(crate) title: &'a str,
    /// The session's short id, the last 8 hex characters of its id.
    pub(crate) session: &'a str,
}

/// The branch name `pattern` makes: `{title}` and every `{session}` replaced by their values.
pub(crate) fn fill_branch_name_pattern(
    pattern: &str,
    values: BranchNamePatternValues<'_>,
) -> String {
    pattern
        .replace(BRANCH_NAME_TITLE_PLACEHOLDER, values.title)
        .replace(BRANCH_NAME_SESSION_PLACEHOLDER, values.session)
}

// What a pattern is filled with at save, before any session exists: a short id's shape (8 hex
// characters) and a tail's (lowercase letters), so git judges the parts the person typed.
const SAMPLE_PATTERN_VALUES: BranchNamePatternValues<'static> = BranchNamePatternValues {
    title: "title",
    session: "0123abcd",
};

// Git's exit code for a ref name its format rule refuses.
const GIT_FORMAT_REFUSED_EXIT_CODE: i32 = 1;

// Git's exit code for a fatal failure: a folder that is gone or holds no repository, and a ref
// transaction it could not prepare.
const GIT_REFUSED_EXIT_CODE: i32 = 128;

// The prefixes git writes before a failed transaction's own words.
const GIT_FATAL_PREFIX: &str = "fatal: ";
const GIT_PREPARE_PREFIX: &str = "prepare: ";

// The start of the clause the files backend writes before a ref refusal's own words.
const GIT_LOCK_CLAUSE_PREFIX: &str = "cannot lock ref '";

/// An attached project as the clash check reads it: where its repository is, where it runs, and
/// whether it keeps a pattern of its own.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the machine settings and project pattern saves check a pattern through it"
    )
)]
#[derive(Clone, Debug)]
pub(crate) struct BranchPatternProject {
    /// The project, named by the refusal a clash in its repository raises.
    pub(crate) id: ProjectId,
    /// Its repository's folder, in its place's own form.
    pub(crate) folder: PathBuf,
    /// Where the folder is: `None` on macOS and Linux.
    pub(crate) place: Option<Place>,
    /// Its life; a project still cloning has no repository to check.
    pub(crate) state: ProjectState,
    /// Whether it keeps a pattern of its own, which the machine's pattern does not reach.
    pub(crate) has_own_pattern: bool,
}

/// Why the machine's `pattern` cannot be saved, or `None` when it can: git's branch-name rule over
/// the filled name, then a clash with a branch in each of `projects` that keeps no pattern of its
/// own, one git transaction per project in order, the first clash refused naming its project. The
/// caller runs it only when the change carries a pattern. `{session}` is filled with a sample id,
/// so a clash on a real session's id, and one in a project attached after the save, are refused
/// by git when the worktree is made. Fails as [`find_project_branch_pattern_refusal`] does.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the machine settings and project pattern saves check a pattern through it"
    )
)]
pub(crate) async fn find_machine_branch_pattern_refusal(
    git: &GitRunner,
    pattern: &BranchNamePattern,
    projects: &[BranchPatternProject],
) -> Result<Option<ProjectBranchPatternRefusedDetails>, GitError> {
    find_branch_pattern_refusal(
        git,
        pattern,
        projects.iter().filter(|project| !project.has_own_pattern),
    )
    .await
}

/// Why `pattern` cannot be saved for `project`, or `None` when it can: the project's own pattern,
/// or the machine's when the project's is cleared, checked by git's branch-name rule and against
/// the branches of the project's repository alone. The caller runs it only when the change carries
/// a pattern or clears one. `{session}` is filled with a sample id, so a clash on a real session's
/// id is refused by git when the worktree is made. A project still cloning, one with no commit and
/// one whose folder is gone or holds no repository are not checked for a clash, the last logged.
/// Fails when git could not run, a WSL 2 place among the reasons, which is never read as a refusal.
#[expect(
    dead_code,
    reason = "the machine settings and project pattern saves check a pattern through it"
)]
pub(crate) async fn find_project_branch_pattern_refusal(
    git: &GitRunner,
    pattern: &BranchNamePattern,
    project: &BranchPatternProject,
) -> Result<Option<ProjectBranchPatternRefusedDetails>, GitError> {
    find_branch_pattern_refusal(git, pattern, std::iter::once(project)).await
}

// Git's branch-name rule over the filled sample name, then a clash in each project in turn.
async fn find_branch_pattern_refusal<'a>(
    git: &GitRunner,
    pattern: &BranchNamePattern,
    projects: impl Iterator<Item = &'a BranchPatternProject>,
) -> Result<Option<ProjectBranchPatternRefusedDetails>, GitError> {
    let branch_name = fill_branch_name_pattern(pattern.as_str(), SAMPLE_PATTERN_VALUES);
    if !is_branch_name(git, &branch_name).await? {
        return Ok(Some(ProjectBranchPatternRefusedDetails::NotABranchName {}));
    }
    for project in projects {
        if let Some(git_message) = find_branch_clash(git, project, &branch_name).await? {
            return Ok(Some(
                ProjectBranchPatternRefusedDetails::ClashesWithBranch {
                    git_message,
                    project_id: project.id,
                },
            ));
        }
    }
    Ok(None)
}

// Whether git's own rule takes `branch_name` as a branch's name: the format check over the ref
// the branch would be, which opens no repository.
async fn is_branch_name(git: &GitRunner, branch_name: &str) -> Result<bool, GitError> {
    // A leading `-` would reach git as an option rather than a name.
    if branch_name.starts_with('-') {
        return Ok(false);
    }
    match git
        .run(
            None,
            GitCall::read([
                "check-ref-format".to_owned(),
                format!("refs/heads/{branch_name}"),
            ]),
        )
        .await
    {
        Ok(_) => Ok(true),
        Err(refusal) if refusal.exit_code() == Some(GIT_FORMAT_REFUSED_EXIT_CODE) => Ok(false),
        Err(failure) => Err(failure),
    }
}

// Git's line for a clash of `branch_name` with a branch in `project`'s repository, or `None`
// when there is none or the repository cannot be checked: a transaction creating the branch at
// `HEAD` is prepared, which takes the ref's locks as a real creation would, then aborted, which
// releases them and writes nothing. It runs as a read, so no `reference-transaction` hook sees it.
async fn find_branch_clash(
    git: &GitRunner,
    project: &BranchPatternProject,
    branch_name: &str,
) -> Result<Option<NonEmptyText>, GitError> {
    match project.state {
        ProjectState::Cloning => return Ok(None),
        ProjectState::Active | ProjectState::Archived => {}
    }
    let place = project.place.as_ref();
    // With no commit there is no branch to clash with, and the transaction would fail on `HEAD`.
    match git
        .run(
            place,
            GitCall::read(in_folder(
                &project.folder,
                &["rev-parse", "--verify", "--quiet", "HEAD"],
            )),
        )
        .await
    {
        Ok(_) => {}
        Err(missing) if missing.exit_code() == Some(GIT_REFUSED_EXIT_CODE) => {
            tracing::warn!(
                error = &missing as &(dyn Error + 'static),
                project_id = %project.id,
                "a project's folder is gone or holds no repository, so its branches were not \
                 checked against a branch-name pattern"
            );
            return Ok(None);
        }
        Err(no_commit) if no_commit.exit_code().is_some() => return Ok(None),
        Err(failure) => return Err(failure),
    }
    let reference = format!("refs/heads/{branch_name}");
    let transaction = format!("start\ncreate {reference} HEAD\nprepare\nabort\n");
    let Err(failure) = git
        .run(
            place,
            GitCall::read(in_folder(&project.folder, &["update-ref", "--stdin"]))
                .with_input(transaction.into_bytes()),
        )
        .await
    else {
        return Ok(None);
    };
    // A failure that is no refused preparation is git's fault, never read as a clash.
    if let GitError::Exited {
        code: Some(GIT_REFUSED_EXIT_CODE),
        stderr,
        ..
    } = &failure
        && let Some(git_message) =
            strip_clash_message(stderr).and_then(|line| NonEmptyText::new(line.to_owned()))
    {
        return Ok(Some(git_message));
    }
    Err(failure)
}

// Git's words for a refused preparation: its last `fatal: ` line without that prefix, then without
// `prepare: `, then without any `cannot lock ref` clause. `None` when no line is a refused
// preparation.
fn strip_clash_message(stderr: &str) -> Option<&str> {
    let words = last_fatal_line(stderr)?
        .strip_prefix(GIT_FATAL_PREFIX)?
        .strip_prefix(GIT_PREPARE_PREFIX)?;
    Some(strip_lock_clause(words))
}

/// Git's last `fatal: ` line in `stderr`, whole and with its line end trimmed; `None` when git
/// wrote none.
pub(crate) fn last_fatal_line(stderr: &str) -> Option<&str> {
    stderr
        .lines()
        .rev()
        .find(|line| line.starts_with(GIT_FATAL_PREFIX))
        .map(str::trim_end)
}

/// The words of git's refusal of a ref without the files backend's leading
/// `cannot lock ref '<ref>': ` clause, which reftable leaves out, and which the files backend
/// leaves out too when the clashing ref is packed; `words` as given when it has no such clause. A
/// ref name holds no `:`, so the clause ends at the first `': `.
pub(crate) fn strip_lock_clause(words: &str) -> &str {
    words
        .strip_prefix(GIT_LOCK_CLAUSE_PREFIX)
        .and_then(|rest| rest.split_once("': "))
        .map_or(words, |(_reference, after)| after)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::Path;

    use rstest::rstest;
    use sidekicks_contracts::machine::settings::{
        BranchNamePattern, BranchNamePatternChange, ProjectBranchPatternRefusedDetails,
    };
    use sidekicks_contracts::project::{ProjectId, ProjectState};
    use sidekicks_contracts::wire::text::NonEmptyText;

    use super::{BranchPatternProject, find_machine_branch_pattern_refusal, strip_clash_message};
    use crate::git::process::{GitCall, GitRunner, strip_line_end, test_git_runner};
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    // Fails when a clash line, with or without the files backend's lock clause, keeps git's
    // prefixes or loses its own words.
    #[rstest]
    #[case::files_holder(
        "fatal: prepare: cannot lock ref 'refs/heads/a/b': 'refs/heads/a' exists; cannot create \
         'refs/heads/a/b'\n",
        "'refs/heads/a' exists; cannot create 'refs/heads/a/b'"
    )]
    #[case::files_same(
        "fatal: prepare: cannot lock ref 'refs/heads/a': reference already exists\n",
        "reference already exists"
    )]
    #[case::files_inside(
        "fatal: prepare: cannot lock ref 'refs/heads/c': 'refs/heads/c/d' exists; cannot create \
         'refs/heads/c'\n",
        "'refs/heads/c/d' exists; cannot create 'refs/heads/c'"
    )]
    #[case::reftable_holder(
        "fatal: prepare: 'refs/heads/a' exists; cannot create 'refs/heads/a/b'\n",
        "'refs/heads/a' exists; cannot create 'refs/heads/a/b'"
    )]
    #[case::reftable_same(
        "fatal: prepare: cannot lock ref 'refs/heads/a': reference already exists\n",
        "reference already exists"
    )]
    #[case::reftable_inside(
        "fatal: prepare: 'refs/heads/c/d' exists; cannot create 'refs/heads/c'\n",
        "'refs/heads/c/d' exists; cannot create 'refs/heads/c'"
    )]
    fn a_clash_line_keeps_only_gits_own_words(#[case] stderr: &str, #[case] expected: &str) {
        assert_eq!(strip_clash_message(stderr), Some(expected));
    }

    // A write in `repository` that no hook of the person's config can change.
    fn write_in(hooks: &Path, repository: &Path, arguments: &[&str]) -> GitCall {
        let mut call = vec![
            OsString::from("-c"),
            OsString::from(format!("core.hooksPath={}", hooks.display())),
            OsString::from("-c"),
            OsString::from("commit.gpgSign=false"),
            OsString::from("-C"),
            repository.as_os_str().to_owned(),
        ];
        call.extend(arguments.iter().map(OsString::from));
        GitCall::write(call)
    }

    // A new files-backend repository in `root`; with `branch`, one commit on `HEAD` and on it.
    async fn repository(
        git: &GitRunner,
        root: &Path,
        branch: Option<&str>,
    ) -> BranchPatternProject {
        let hooks = root.join("hooks");
        let folder = root.join("repository");
        git.run(
            None,
            GitCall::write([
                OsString::from("-c"),
                OsString::from(format!("core.hooksPath={}", hooks.display())),
                OsString::from("init"),
                OsString::from("--ref-format=files"),
                folder.clone().into_os_string(),
            ]),
        )
        .await
        .expect("the repository is made");
        if let Some(branch) = branch {
            let tree = git
                .run(None, write_in(&hooks, &folder, &["write-tree"]))
                .await
                .expect("the empty tree is written");
            let tree = String::from_utf8(strip_line_end(tree.stdout)).expect("an id is ASCII");
            let commit = git
                .run(
                    None,
                    write_in(&hooks, &folder, &["commit-tree", &tree, "-F", "-"])
                        .with_environment("GIT_AUTHOR_NAME", "Test")
                        .with_environment("GIT_AUTHOR_EMAIL", "test@example.invalid")
                        .with_environment("GIT_COMMITTER_NAME", "Test")
                        .with_environment("GIT_COMMITTER_EMAIL", "test@example.invalid")
                        .with_input(b"first\n".to_vec()),
                )
                .await
                .expect("the commit is written");
            let commit = String::from_utf8(strip_line_end(commit.stdout)).expect("an id is ASCII");
            for reference in ["HEAD".to_owned(), format!("refs/heads/{branch}")] {
                git.run(
                    None,
                    write_in(&hooks, &folder, &["update-ref", &reference, &commit]),
                )
                .await
                .expect("the ref is written");
            }
        }
        BranchPatternProject {
            id: ProjectId::try_from(mint_uuid_v7()).expect("a minted id is a UUID"),
            folder,
            place: None,
            state: ProjectState::Active,
            has_own_pattern: false,
        }
    }

    fn pattern(text: &str) -> BranchNamePattern {
        BranchNamePattern::new(BranchNamePatternChange::new(text.to_owned()).expect("bounded"))
            .expect("the pattern holds {title} once")
    }

    // Fails when a pattern whose name would sit inside an existing branch saves, or when the
    // refusal loses git's words or the project it names.
    #[tokio::test]
    async fn a_name_inside_an_existing_branch_is_refused_naming_its_project() {
        let git = test_git_runner();
        let root = tempfile::tempdir().expect("the temporary folder is made");
        let project = repository(&git, root.path(), Some("feature")).await;

        let refusal = find_machine_branch_pattern_refusal(
            &git,
            &pattern("feature/{title}"),
            std::slice::from_ref(&project),
        )
        .await
        .expect("git runs")
        .expect("the pattern is refused");

        assert_eq!(
            refusal,
            ProjectBranchPatternRefusedDetails::ClashesWithBranch {
                git_message: NonEmptyText::new(
                    "'refs/heads/feature' exists; cannot create 'refs/heads/feature/title'"
                        .to_owned()
                )
                .expect("the line is not empty"),
                project_id: project.id,
            }
        );
    }

    // Fails when a name git's rule refuses is read as a git failure rather than the pattern's
    // refusal.
    #[tokio::test]
    async fn a_name_gits_rule_refuses_is_not_a_branch_name() {
        let git = test_git_runner();

        let refusal = find_machine_branch_pattern_refusal(&git, &pattern("feature/{title}."), &[])
            .await
            .expect("git runs");

        assert_eq!(
            refusal,
            Some(ProjectBranchPatternRefusedDetails::NotABranchName {})
        );
    }

    // Fails when a repository with no commit, which has no branch to clash with, refuses the
    // pattern on git's failure to read `HEAD`.
    #[tokio::test]
    async fn a_repository_with_no_commit_is_not_checked_for_a_clash() {
        let git = test_git_runner();
        let root = tempfile::tempdir().expect("the temporary folder is made");
        let project = repository(&git, root.path(), None).await;

        let refusal = find_machine_branch_pattern_refusal(
            &git,
            &pattern("feature/{title}"),
            std::slice::from_ref(&project),
        )
        .await
        .expect("git runs");

        assert_eq!(refusal, None);
    }
}
