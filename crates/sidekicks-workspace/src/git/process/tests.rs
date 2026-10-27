use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sidekicks_platforms::PathRules;
use sidekicks_std::file::atomic_write::write_file_atomically;

use super::{
    GitCall, GitError, GitLimits, GitRunner, git_environment, in_folder, strip_line_end,
    test_git_runner,
};

// The person's git with `limits`.
fn test_runner(limits: GitLimits) -> GitRunner {
    GitRunner {
        limits,
        ..test_git_runner()
    }
}

// A new repository in a temporary folder, with one commit of the empty tree: the temporary
// folder, the repository's folder, the empty tree's id and the commit's.
async fn repository_with_a_commit(git: &GitRunner) -> (tempfile::TempDir, PathBuf, String, String) {
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let repository = root.path().join("repository");
    git.run(
        None,
        GitCall::write([OsString::from("init"), repository.clone().into()]),
    )
    .await
    .expect("the repository is made");
    let tree = git
        .run(None, GitCall::read(in_folder(&repository, &["write-tree"])))
        .await
        .expect("the empty tree is written");
    let tree = String::from_utf8(strip_line_end(tree.stdout)).expect("an id is ASCII");
    let commit = git
        .run(
            None,
            committing(&repository, &tree).with_input(b"first\n".to_vec()),
        )
        .await
        .expect("the commit is written");
    let commit = String::from_utf8(strip_line_end(commit.stdout)).expect("an id is ASCII");
    (root, repository, tree, commit)
}

// `commit-tree` of `tree` with a fixed identity and no signing, whatever the person's config.
fn committing(repository: &Path, tree: &str) -> GitCall {
    let mut arguments = vec![OsString::from("-c"), "commit.gpgSign=false".into()];
    arguments.extend(in_folder(repository, &["commit-tree", tree, "-F", "-"]));
    GitCall::write(arguments)
        .with_environment("GIT_AUTHOR_NAME", "Test")
        .with_environment("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .with_environment("GIT_COMMITTER_NAME", "Test")
        .with_environment("GIT_COMMITTER_EMAIL", "test@example.invalid")
}

// An `update-ref` of a new branch through a `reference-transaction` hook whose body is
// `hook`, from a hooks folder the call names over the person's config.
async fn update_ref_through_hook(
    git: &GitRunner,
    root: &Path,
    repository: &Path,
    commit: &str,
    hook: &str,
) -> Result<(), GitError> {
    let hooks = root.join("hooks");
    tokio::fs::create_dir_all(&hooks)
        .await
        .expect("the hooks folder is made");
    write_file_atomically(
        &hooks.join("reference-transaction"),
        format!("#!/bin/sh\n{hook}\n"),
        0o755,
    )
    .await
    .expect("the hook is written");
    let mut arguments = vec![
        OsString::from("-c"),
        OsString::from(format!("core.hooksPath={}", hooks.display())),
    ];
    arguments.extend(in_folder(
        repository,
        &["update-ref", "refs/heads/hooked", commit],
    ));
    git.run(None, GitCall::write(arguments)).await.map(drop)
}

// Fails when the `\r` a macOS or Linux folder's name ends with is read as part of the line end,
// which names another folder, or when a Windows line end keeps its `\r`.
#[test]
fn strip_line_end_keeps_a_carriage_return_only_where_a_name_may_hold_one() {
    let printed = b"/repos/cr-name\r\n".to_vec();

    let stripped = strip_line_end(printed);

    let expected: &[u8] = if PathRules::NATIVE.has_carriage_return_line_ends() {
        b"/repos/cr-name"
    } else {
        b"/repos/cr-name\r"
    };
    assert_eq!(stripped, expected);
}

// Fails when a redirecting variable spelled in another case survives, when the locale is not
// pinned, or when the pinned value overrides the call's own.
#[test]
fn git_environment_strips_redirects_and_lets_the_call_set_last() {
    let variables = [
        ("Git_Dir", "/elsewhere/.git"),
        ("GIT_SHALLOW_FILE", "/elsewhere/shallow"),
        ("GIT_INDEX_FILE", "/elsewhere/index"),
        ("LANG", "fr_FR.UTF-8"),
        ("HOME", "/home/person"),
    ]
    .map(|(name, value)| (OsString::from(name), OsString::from(value)));
    let overrides = vec![(
        OsString::from("GIT_INDEX_FILE"),
        OsString::from("/scratch/index"),
    )];

    let mut command = tokio::process::Command::new("git");
    command
        .env_clear()
        .envs(git_environment(variables, overrides));
    let environment: Vec<(String, Option<String>)> = command
        .as_std()
        .get_envs()
        .map(|(name, value)| {
            let text = |text: &std::ffi::OsStr| text.to_string_lossy().into_owned();
            (text(name), value.map(text))
        })
        .collect();

    let value_of = |wanted: &str| {
        environment
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(wanted))
            .and_then(|(_, value)| value.clone())
    };
    assert_eq!(value_of("GIT_DIR"), None);
    assert_eq!(value_of("GIT_SHALLOW_FILE"), None);
    assert_eq!(
        value_of("GIT_INDEX_FILE").as_deref(),
        Some("/scratch/index")
    );
    assert_eq!(value_of("LANG").as_deref(), Some("C"));
    assert_eq!(value_of("LC_ALL").as_deref(), Some("C"));
    assert_eq!(value_of("GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
    assert_eq!(value_of("HOME").as_deref(), Some("/home/person"));
}

// Fails when a call given no input leaves git's standard input open, where `-F -` waits until
// the timeout.
#[tokio::test]
async fn commit_tree_given_no_input_returns() {
    let git = test_runner(GitLimits {
        timeout: Duration::from_secs(30),
        output_bytes: 1024,
    });
    let (_root, repository, tree, _commit) = repository_with_a_commit(&git).await;

    let commit = git.run(None, committing(&repository, &tree)).await;

    assert!(commit.expect("the commit is written").stdout.len() > tree.len());
}

// Fails when output past the bound is cut and returned rather than failing the call.
#[tokio::test]
async fn output_past_the_bound_fails_the_call() {
    let git = test_runner(GitLimits {
        timeout: Duration::from_secs(30),
        output_bytes: 4,
    });

    let version = git.run(None, GitCall::read(["version"])).await;

    assert!(matches!(
        version,
        Err(GitError::OutputTooLarge { bound: 4 })
    ));
}

// Fails when a read runs a hook or the file-watch helper program the repository's own config
// names, a live index read among them, or when a write does not run the repository's hooks.
#[tokio::test]
async fn a_read_runs_no_hook_or_file_watch_helper_and_a_write_runs_the_hooks() {
    let git = test_git_runner();
    let (root, repository, _tree, commit) = repository_with_a_commit(&git).await;
    let ran = |name: &str| root.path().join(name);
    tokio::fs::write(repository.join("tracked.txt"), "tracked\n")
        .await
        .expect("the file is written");
    git.run(
        None,
        GitCall::write(in_folder(&repository, &["add", "tracked.txt"])),
    )
    .await
    .expect("the file is staged");
    let hooks = root.path().join("hooks");
    let helper = root.path().join("file-watch-helper");
    tokio::fs::create_dir_all(&hooks)
        .await
        .expect("the hooks folder is made");
    // The helper fails, so git reads the tree itself.
    for (script, marker, end) in [
        (hooks.join("post-index-change"), "index-hook-ran", ""),
        (hooks.join("reference-transaction"), "ref-hook-ran", ""),
        (helper.clone(), "helper-ran", "exit 1"),
    ] {
        let body = format!("#!/bin/sh\ntouch '{}'\n{end}\n", ran(marker).display());
        write_file_atomically(&script, body, 0o755)
            .await
            .expect("the script is written");
    }
    for (name, value) in [("core.hooksPath", &hooks), ("core.fsmonitor", &helper)] {
        let mut arguments = in_folder(&repository, &["config", name]);
        arguments.push(value.into());
        git.run(None, GitCall::write(arguments))
            .await
            .expect("the repository's config is written");
    }

    for read in [
        GitCall::read(in_folder(&repository, &["status", "--porcelain"])),
        GitCall::live_index_read(&repository, &["status", "--porcelain"]),
        GitCall::read(in_folder(&repository, &["read-tree", &commit])),
    ] {
        git.run(None, read).await.expect("the read runs");
    }
    let ran_after_reads = [ran("index-hook-ran").exists(), ran("helper-ran").exists()];
    git.run(
        None,
        GitCall::write(in_folder(
            &repository,
            &["update-ref", "refs/heads/hooked", &commit],
        )),
    )
    .await
    .expect("the ref is written");

    assert_eq!(ran_after_reads, [false, false]);
    assert!(
        ran("ref-hook-ran").exists(),
        "the write ran the repository's hook"
    );
}

// Fails when the timeout ends git alone, which leaves its sleeping hook to finish its work.
#[tokio::test]
async fn a_timeout_ends_the_hook_git_started() {
    let git = test_runner(GitLimits {
        timeout: Duration::from_secs(30),
        output_bytes: 1024,
    });
    let (root, repository, _tree, commit) = repository_with_a_commit(&git).await;
    let started = root.path().join("started");
    let finished = root.path().join("finished");
    let impatient = GitRunner {
        limits: GitLimits {
            timeout: Duration::from_millis(1_500),
            output_bytes: 1024,
        },
        ..git
    };

    let update = update_ref_through_hook(
        &impatient,
        root.path(),
        &repository,
        &commit,
        &format!(
            "touch '{}'\nsleep 3\ntouch '{}'",
            started.display(),
            finished.display()
        ),
    )
    .await;
    tokio::time::sleep(Duration::from_secs(4)).await;

    assert!(matches!(update, Err(GitError::TimedOut { .. })));
    assert!(started.exists(), "the hook ran");
    assert!(!finished.exists(), "the hook outlived the timeout");
}

// Fails when the output read waits for the end of git's output, which a process a hook left
// behind holds open long after git's exit.
#[tokio::test]
async fn the_call_returns_at_git_exit_while_a_hook_child_holds_its_output() {
    let git = test_runner(GitLimits {
        timeout: Duration::from_secs(60),
        output_bytes: 1024,
    });
    let (root, repository, _tree, commit) = repository_with_a_commit(&git).await;
    let sleeper_pid_file = root.path().join("sleeper.pid");
    let started_at = Instant::now();

    let update = update_ref_through_hook(
        &git,
        root.path(),
        &repository,
        &commit,
        &format!("sleep 30 &\necho $! > '{}'", sleeper_pid_file.display()),
    )
    .await;
    let elapsed = started_at.elapsed();
    // The sleeper is the test's own child's child, ended here so it outlives nothing.
    let sleeper_pid = std::fs::read_to_string(&sleeper_pid_file).expect("the hook wrote its pid");
    let ended = std::process::Command::new("kill")
        .arg(sleeper_pid.trim())
        .status()
        .expect("kill runs");

    update.expect("the update succeeds");
    assert!(elapsed < Duration::from_secs(10));
    assert!(ended.success(), "the sleeper was still running");
}

// Fails when a git a signal ended reports only that it had no code, which hides what ended it.
#[tokio::test]
async fn a_git_a_signal_ended_names_the_signal() {
    let git = test_git_runner();
    let (root, repository, _tree, commit) = repository_with_a_commit(&git).await;

    // The hook ends its own parent, the git this test started.
    let update =
        update_ref_through_hook(&git, root.path(), &repository, &commit, "kill -KILL $PPID").await;

    let Err(failure @ GitError::Exited { .. }) = update else {
        panic!("a killed git is an exit failure: {update:?}");
    };
    assert!(
        matches!(
            &failure,
            GitError::Exited { code: None, signal_number: Some(9), signal_name: Some(name), .. }
                if name == "SIGKILL"
        ),
        "the failure names the signal: {failure:?}"
    );
    assert_eq!(failure.to_string(), "git ended by signal 9 (SIGKILL)");
}
