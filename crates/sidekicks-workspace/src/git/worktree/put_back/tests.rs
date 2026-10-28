//! The put-back's tests: a tree comes back whole, at a free name, with its LFS objects, its
//! linking files as the repository writes them and its record named as git names it.

use std::fs;
use std::path::{Path, PathBuf};

use rstest::rstest;

use super::record::sanitize_record_name;
use crate::git::worktree::removed_store::test_fixture::KeptCopyFixture;

// Kills skipping the pack, copying only the index, a walk that skips ignored files, and a
// `worktree unlock` or `prune` anywhere.
#[tokio::test]
async fn a_locked_tree_comes_back_whole_after_its_repository_is_collected() {
    let fixture = KeptCopyFixture::new().await;
    let tree = fixture.add_tree("feature", "feature").await;
    let folder = fixture.tree_at("feature");
    fs::write(folder.join(".gitignore"), ".env\n").expect("the ignore rules are written");
    fixture.git(&folder, &["add", ".gitignore"]).await;
    fixture.commit(&folder, "ignore the environment").await;
    fixture
        .git(&folder, &["sparse-checkout", "set", "--no-cone", "/*"])
        .await;
    fixture
        .git(&folder, &["config", "--worktree", "sidekicks.kept", "yes"])
        .await;
    fs::write(folder.join("staged.txt"), "staged only\n").expect("the staged file is written");
    fixture.git(&folder, &["add", "staged.txt"]).await;
    fs::write(folder.join(".env"), "SECRET=1\n").expect("the ignored file is written");
    fixture
        .git(
            &fixture.repository,
            &[
                "worktree",
                "lock",
                "--reason",
                "on a stick",
                &folder.to_string_lossy(),
            ],
        )
        .await;
    let head = fixture.git(&folder, &["rev-parse", "HEAD"]).await;
    let record = PathBuf::from(
        fixture
            .git(&folder, &["rev-parse", "--absolute-git-dir"])
            .await,
    );
    let sparse_rules =
        fs::read(record.join("info").join("sparse-checkout")).expect("the sparse rules are read");
    let lock = fs::read(record.join("locked")).expect("the lock is read");
    // A second tree whose folder is gone keeps its record throughout.
    fixture.add_tree("other", "other").await;
    fs::remove_dir_all(fixture.tree_at("other")).expect("the second tree's folder is removed");

    let removed_worktree_id = fixture.discard(&tree).await;
    fixture
        .git(&fixture.repository, &["gc", "--quiet", "--prune=now"])
        .await;
    let (restored, branch, is_new_branch) = fixture.restore(removed_worktree_id).await;

    assert_eq!(
        (restored.as_path(), branch.as_str(), is_new_branch),
        (folder.as_path(), "feature", false)
    );
    assert_eq!(
        fixture.git(&folder, &["show", ":staged.txt"]).await,
        "staged only"
    );
    assert!(
        fixture
            .git(&folder, &["status", "--porcelain", "--ignored"])
            .await
            .lines()
            .any(|line| line == "!! .env")
    );
    assert_eq!(fixture.git(&folder, &["rev-parse", "HEAD"]).await, head);
    assert_eq!(
        fixture.git(&folder, &["symbolic-ref", "HEAD"]).await,
        "refs/heads/feature"
    );
    let restored_record = PathBuf::from(
        fixture
            .git(&folder, &["rev-parse", "--absolute-git-dir"])
            .await,
    );
    assert_eq!(
        fs::read(restored_record.join("info").join("sparse-checkout"))
            .expect("the restored sparse rules are read"),
        sparse_rules
    );
    assert_eq!(
        fixture
            .git(
                &folder,
                &["config", "--worktree", "--get", "sidekicks.kept"]
            )
            .await,
        "yes"
    );
    assert_eq!(
        fs::read(restored_record.join("locked")).expect("the restored lock is read"),
        lock
    );
    assert!(
        fixture
            .common_folder()
            .join("worktrees")
            .join("other")
            .is_dir()
    );
}

// Kills numbering the folder and the branch apart, and taking the own branch after it moved.
#[rstest]
#[case::the_own_folder_free(&[], &[], "fix", "fix-restored")]
#[case::both_restored_names_taken(
    &["fix", "fix-restored"],
    &["fix-restored"],
    "fix-restored-2",
    "fix-restored-2"
)]
#[case::the_restored_folder_taken(
    &["fix", "fix-restored"],
    &[],
    "fix-restored-2",
    "fix-restored-2"
)]
#[tokio::test]
async fn a_moved_branch_puts_back_on_a_new_branch_numbered_with_its_folder(
    #[case] taken_folders: &[&str],
    #[case] taken_branches: &[&str],
    #[case] expected_folder: &str,
    #[case] expected_branch: &str,
) {
    let fixture = KeptCopyFixture::new().await;
    let tree = fixture.add_tree("fix", "fix").await;
    let folder = fixture.tree_at("fix");
    fixture.commit(&folder, "work").await;
    let recorded = fixture.git(&folder, &["rev-parse", "HEAD"]).await;
    let removed_worktree_id = fixture.discard(&tree).await;
    fixture
        .git(&fixture.repository, &["branch", "--force", "fix", "main"])
        .await;
    for taken_folder in taken_folders {
        fs::create_dir_all(fixture.tree_at(taken_folder)).expect("a taken folder is made");
    }
    for taken_branch in taken_branches {
        fixture
            .git(&fixture.repository, &["branch", taken_branch, "main"])
            .await;
    }

    let (restored, branch, is_new_branch) = fixture.restore(removed_worktree_id).await;

    assert_eq!(
        (restored, branch.as_str(), is_new_branch),
        (fixture.tree_at(expected_folder), expected_branch, true)
    );
    assert_eq!(
        fixture
            .git(&fixture.repository, &["rev-parse", expected_branch])
            .await,
        recorded
    );
}

// Kills putting an LFS object back into the default store when the repository names another.
#[tokio::test]
async fn an_lfs_object_goes_back_to_the_store_the_repository_names() {
    let fixture = KeptCopyFixture::new().await;
    fixture
        .git(
            &fixture.repository,
            &["config", "lfs.storage", "../lfs-store"],
        )
        .await;
    let tree = fixture.add_tree("assets", "assets").await;
    let folder = fixture.tree_at("assets");
    let lfs_object_id = "ab".repeat(32);
    let object_folder = Path::new("objects").join("ab").join("ab");
    let store_object = fixture
        .common_folder()
        .join("../lfs-store")
        .join(&object_folder)
        .join(&lfs_object_id);
    fs::create_dir_all(store_object.parent().expect("an object has a folder"))
        .expect("the store's folder is made");
    fs::write(&store_object, "large file body").expect("the object is written");
    fs::write(
        folder.join("asset.bin"),
        format!(
            "version https://git-lfs.github.com/spec/v1\noid sha256:{lfs_object_id}\nsize 15\n"
        ),
    )
    .expect("the pointer is written");
    fixture.git(&folder, &["add", "asset.bin"]).await;
    let removed_worktree_id = fixture.discard(&tree).await;
    // As `git lfs prune` would once no tree's index names it.
    fs::remove_file(&store_object).expect("the store's object is pruned");

    fixture.restore(removed_worktree_id).await;

    assert_eq!(
        fs::read_to_string(&store_object).expect("the object is back in the named store"),
        "large file body"
    );
    assert!(
        !fixture
            .common_folder()
            .join("lfs")
            .join(&object_folder)
            .join(&lfs_object_id)
            .exists()
    );
}

// Kills absolute linking files under `worktree.useRelativePaths`, and relative ones written
// before the repository is set to read them.
#[tokio::test]
async fn relative_linking_files_are_written_when_the_repository_asks() {
    let fixture = KeptCopyFixture::new().await;
    let tree = fixture.add_tree("relative", "relative").await;
    let removed_worktree_id = fixture.discard(&tree).await;
    fixture
        .git(
            &fixture.repository,
            &["config", "worktree.useRelativePaths", "true"],
        )
        .await;

    let (restored, _, _) = fixture.restore(removed_worktree_id).await;

    let git_file = fs::read_to_string(restored.join(".git")).expect("the tree's .git is read");
    let named_record = git_file
        .strip_prefix("gitdir: ")
        .expect("the .git file names a record")
        .trim_end();
    assert!(Path::new(named_record).is_relative());
    let record = fixture.common_folder().join("worktrees").join("relative");
    let gitdir = fs::read_to_string(record.join("gitdir")).expect("the record's gitdir is read");
    assert!(Path::new(gitdir.trim_end()).is_relative());
    assert_eq!(
        fixture
            .git(
                &fixture.repository,
                &["config", "--get", "extensions.relativeWorktrees"]
            )
            .await,
        "true"
    );
    fixture.git(&restored, &["status", "--porcelain"]).await;
    let listed = format!("worktree {}", restored.display());
    assert!(
        fixture
            .git(&fixture.repository, &["worktree", "list", "--porcelain"])
            .await
            .lines()
            .any(|line| line == listed)
    );
}

// Kills a record name that differs from the one git's own sanitizer gives the folder's name.
#[rstest]
#[case::a_double_dot_and_a_lock_suffix("a..b.lock", "a.b")]
#[case::the_brace_of_an_at_brace("x@{y", "x@-y")]
#[case::a_star("star*name", "star-name")]
#[case::a_leading_dot(".hidden", "-hidden")]
#[case::a_trailing_dot("trailing.", "trailing.")]
#[case::each_refused_character("sp ace:q?[b\\c^d~", "sp-ace-q--b-c-d-")]
#[case::a_repeated_lock_suffix("x.lock.lock", "x")]
fn a_record_is_named_as_git_names_it(#[case] folder_name: &str, #[case] record_name: &str) {
    assert_eq!(sanitize_record_name(folder_name), record_name);
}

// Kills a record named from the folder's name as written, which git refuses as a ref component.
#[tokio::test]
async fn a_tree_whose_folder_ends_in_lock_is_put_back_where_git_reads_it() {
    let fixture = KeptCopyFixture::new().await;
    let tree = fixture.add_tree("fix.lock", "fix-lock").await;
    let head = fixture
        .git(&fixture.tree_at("fix.lock"), &["rev-parse", "HEAD"])
        .await;
    let removed_worktree_id = fixture.discard(&tree).await;

    let (restored, _, _) = fixture.restore(removed_worktree_id).await;

    assert_eq!(
        PathBuf::from(
            fixture
                .git(&restored, &["rev-parse", "--absolute-git-dir"])
                .await
        ),
        fixture.common_folder().join("worktrees").join("fix")
    );
    assert_eq!(
        fixture
            .git(&fixture.repository, &["rev-parse", "worktrees/fix/HEAD"])
            .await,
        head
    );
}
