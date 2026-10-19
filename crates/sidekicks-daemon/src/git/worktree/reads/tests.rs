use std::ffi::OsString;
use std::path::{Path, PathBuf};

use rstest::rstest;
use sidekicks_platforms::{PathRules, real_path};

use super::{read_listed_worktrees, read_uncommitted_paths, unquote_git_text};
use crate::git::process::{GitCall, GitRunner, in_folder, strip_line_end, test_git_runner};

// Runs `arguments` in `folder` with a fixed identity and no signing or hook, whatever the
// person's config, writing `input` to git; returns what git printed, its line end removed.
async fn git_in(git: &GitRunner, folder: &Path, arguments: &[&str], input: Option<&str>) -> String {
    let settings = [
        "user.name=Test",
        "user.email=test@example.invalid",
        "commit.gpgSign=false",
    ];
    let mut call = settings
        .into_iter()
        .flat_map(|setting| [OsString::from("-c"), OsString::from(setting)])
        .collect::<Vec<_>>();
    call.extend(in_folder(folder, arguments));
    let mut call = GitCall::read(call);
    if let Some(input) = input {
        call = call.with_input(input.as_bytes().to_vec());
    }
    let output = git
        .run(None, call)
        .await
        .expect("the setup's git call succeeds");
    String::from_utf8(strip_line_end(output.stdout)).expect("the setup's git prints UTF-8")
}

// A new repository with one commit, in a temporary folder resolved through its links, as git
// records the folders it lists: the temporary folder, its resolved path and the repository's.
async fn repository_with_a_commit(git: &GitRunner) -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temporary = tempfile::tempdir().expect("the temporary folder is made");
    let root = real_path(temporary.path()).expect("the temporary folder resolves");
    git_in(git, &root, &["init", "--quiet", "repository"], None).await;
    let repository = root.join("repository");
    let first_commit = ["commit", "--quiet", "--allow-empty", "-m", "first"];
    git_in(git, &repository, &first_commit, None).await;
    (temporary, root, repository)
}

// Writes `contents` to the file `name` in `folder`.
async fn write_file(folder: &Path, name: &str, contents: &str) {
    tokio::fs::write(folder.join(name), contents)
        .await
        .expect("the file is written");
}

#[rstest]
// Fails when an escape git writes is read as another byte.
#[case::a_quote(br#""a\"b""#.as_slice(), Some(b"a\"b".as_slice()))]
#[case::a_backslash(br#""a\\b""#.as_slice(), Some(b"a\\b".as_slice()))]
#[case::a_tab(br#""a\tb""#.as_slice(), Some(b"a\tb".as_slice()))]
#[case::a_newline(br#""a\nb""#.as_slice(), Some(b"a\nb".as_slice()))]
// Fails when an octal escape is read as a character rather than one byte of a UTF-8 name.
#[case::the_octal_bytes_of_a_utf8_name(
    br#""caf\303\251""#.as_slice(),
    Some("café".as_bytes())
)]
// Fails when a value git did not quote is changed.
#[case::a_value_not_wrapped_in_quotes(
    br"plain\name".as_slice(),
    Some(br"plain\name".as_slice())
)]
// Fails when an escape git never writes is read as some byte instead of refused.
#[case::an_unknown_escape(br#""a\qb""#.as_slice(), None)]
fn unquote_git_text_reads_what_git_quoted(#[case] value: &[u8], #[case] expected: Option<&[u8]>) {
    assert_eq!(unquote_git_text(value).as_deref(), expected);
}

// Fails when a rename's original path is reported as uncommitted, when a kind is missed, or
// when a path holding a space is cut at it.
#[tokio::test]
async fn uncommitted_paths_name_each_kind_by_its_whole_path() {
    let git = test_git_runner();
    let (_temporary, _root, repository) = repository_with_a_commit(&git).await;
    write_file(&repository, "kept file.txt", "one").await;
    write_file(&repository, "old name.txt", "moved").await;
    git_in(&git, &repository, &["add", "--all"], None).await;
    git_in(
        &git,
        &repository,
        &["commit", "--quiet", "-m", "second"],
        None,
    )
    .await;
    // The person's own config may turn rename detection off.
    git_in(
        &git,
        &repository,
        &["config", "status.renames", "true"],
        None,
    )
    .await;
    write_file(&repository, "kept file.txt", "two").await;
    git_in(
        &git,
        &repository,
        &["mv", "old name.txt", "new name.txt"],
        None,
    )
    .await;
    write_file(&repository, "untracked file.txt", "new").await;
    // Three stages of one path, as a conflicted merge leaves them.
    write_file(&repository, "conflict file.txt", "side").await;
    let blob = git_in(
        &git,
        &repository,
        &["hash-object", "-w", "--stdin"],
        Some("side"),
    )
    .await;
    let stages: String = (1..=3)
        .map(|stage| format!("100644 {blob} {stage}\tconflict file.txt\n"))
        .collect();
    git_in(
        &git,
        &repository,
        &["update-index", "--index-info"],
        Some(&stages),
    )
    .await;

    let mut paths = read_uncommitted_paths(&git, None, &repository)
        .await
        .expect("the status reads");

    paths.sort();
    assert_eq!(
        paths,
        [
            "conflict file.txt",
            "kept file.txt",
            "new name.txt",
            "untracked file.txt"
        ]
        .map(PathBuf::from)
    );
}

// Fails when a linked tree's path holding a space or a newline is split or cut, or when a path
// read from NUL-ended records is not marked exact.
#[tokio::test]
async fn listed_worktrees_keep_a_path_holding_a_space_or_a_newline() {
    let git = test_git_runner();
    let (_temporary, root, repository) = repository_with_a_commit(&git).await;
    let mut linked = vec![root.join("with space")];
    // Only a system whose names may hold a line end can name this folder.
    if !PathRules::NATIVE.has_carriage_return_line_ends() {
        linked.push(root.join("with\nnewline"));
    }
    for folder in &linked {
        let folder = folder.to_str().expect("the test's folders are UTF-8");
        let add = ["worktree", "add", "--quiet", "--detach", folder];
        git_in(&git, &repository, &add, None).await;
    }

    let listed = read_listed_worktrees(&git, None, &repository, None)
        .await
        .expect("the list reads");

    assert_eq!(listed.len(), linked.len() + 1);
    assert_eq!(listed[0].path, repository);
    assert!(listed[0].is_main_checkout);
    // git lists linked trees in the order their records' folder reads, which no system fixes.
    let mut linked_paths: Vec<&Path> = listed[1..]
        .iter()
        .map(|worktree| worktree.path.as_path())
        .collect();
    linked_paths.sort();
    let mut expected: Vec<&Path> = linked.iter().map(PathBuf::as_path).collect();
    expected.sort();
    assert_eq!(linked_paths, expected);
    assert!(listed.iter().all(|worktree| worktree.is_path_exact));
    assert!(
        listed[1..]
            .iter()
            .all(|worktree| !worktree.is_main_checkout)
    );
}
