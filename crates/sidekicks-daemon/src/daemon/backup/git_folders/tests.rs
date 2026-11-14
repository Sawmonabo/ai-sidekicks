use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use sidekicks_platforms::real_path;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::backup_mirror::{
    CopiedIndex, CopiedIndexCheck, LiveGitFolders, MirrorError, MirrorReport, MirrorRoot,
    mirror_roots,
};
use sidekicks_store::data_folder::{data_folder, session_storage_root};
use sidekicks_workspace::git::process::{GitCall, GitRunner, in_folder, test_git_runner};
use sidekicks_workspace::git::turn_snapshot::capture::{CheckoutCaptureInput, GitFloorReports};
use sidekicks_workspace::git::turn_snapshot::capture_folder::is_capture_folder;
use sidekicks_workspace::git::turn_snapshot::command_capture::CommandCaptureService;
use sidekicks_workspace::git::turn_snapshot::repack::{
    CaptureFolderSweep, CapturePacking, PackingError,
};
use sidekicks_workspace::managed::service::managed_workspaces_folder;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::BackupGitFolders;

// The test's own identity, branch and ref format, never the person's config.
const SETTINGS: [&str; 10] = [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "init.defaultBranch=main",
    "-c",
    "init.defaultRefFormat=files",
];

// The refs of the test's run in a capture folder.
const RUN_REFS: &str = "refs/sidekicks/runs/run/epoch-0";

// Runs git with `arguments` before which `location` places it, under the test's settings, and
// answers what it printed; a failure fails the test.
async fn git_with(git: &GitRunner, location: Vec<OsString>, arguments: &[&str]) -> String {
    let call = SETTINGS
        .iter()
        .map(OsString::from)
        .chain(location)
        .chain(arguments.iter().map(OsString::from));
    let output = git
        .run(None, GitCall::read(call))
        .await
        .unwrap_or_else(|failure| panic!("git {arguments:?} failed: {failure}"));
    String::from_utf8(output.stdout).expect("git prints text")
}

// Runs git in the work tree `folder`.
async fn git_in(git: &GitRunner, folder: &Path, arguments: &[&str]) -> String {
    git_with(git, in_folder(folder, &[]), arguments).await
}

// Runs git against the git folder `folder`.
async fn git_at(git: &GitRunner, folder: &Path, arguments: &[&str]) -> String {
    let mut location = OsString::from("--git-dir=");
    location.push(folder);
    git_with(git, vec![location], arguments).await
}

// A repository at `folder` with one commit on `main`.
async fn make_repository(git: &GitRunner, folder: &Path) {
    fs::create_dir_all(folder).expect("the repository's folder is made");
    git_in(git, folder, &["init", "--quiet"]).await;
    fs::write(folder.join("notes.md"), "notes\n").expect("written");
    git_in(git, folder, &["add", "notes.md"]).await;
    git_in(git, folder, &["commit", "--quiet", "-m", "first"]).await;
}

// The one capture folder of the owner whose folder is `owner`.
fn only_capture_folder(owner: &Path) -> PathBuf {
    let folders: Vec<PathBuf> = fs::read_dir(owner.join("captures"))
        .expect("the captures folder is listed")
        .map(|entry| entry.expect("the entry reads").path())
        .filter(|folder| is_capture_folder(folder))
        .collect();
    assert_eq!(folders.len(), 1, "one capture folder, got {folders:?}");
    folders.into_iter().next().expect("one folder")
}

// The mirror run over `roots` on a blocking thread, as the backup runs it.
async fn mirror_on_thread(
    mirror: &Path,
    home: &Path,
    roots: &[MirrorRoot],
    git_folders: Arc<dyn LiveGitFolders>,
    stop: &CancellationToken,
) -> Result<MirrorReport, MirrorError> {
    let (mirror, home, roots, stop) = (
        mirror.to_path_buf(),
        home.to_path_buf(),
        roots.to_vec(),
        stop.clone(),
    );
    tokio::task::spawn_blocking(move || mirror_roots(&mirror, &home, &roots, &*git_folders, &stop))
        .await
        .expect("the mirror's thread ends")
}

// The files in the copied git folder `copy` that git reads as a ref: `HEAD`, `packed-refs`, and
// each file under `refs/` whose name does not start with `.`.
fn refs_git_reads(copy: &Path) -> Vec<PathBuf> {
    fn walk(folder: &Path, found: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(folder) else {
            return;
        };
        for entry in entries {
            let path = entry.expect("the entry reads").path();
            if path.is_dir() {
                walk(&path, found);
            } else if !path
                .file_name()
                .is_some_and(|name| name.as_encoded_bytes().starts_with(b"."))
            {
                found.push(path);
            }
        }
    }
    let mut found: Vec<PathBuf> = ["HEAD", "packed-refs"]
        .into_iter()
        .map(|name| copy.join(name))
        .filter(|path| path.exists())
        .collect();
    walk(&copy.join("refs"), &mut found);
    found
}

// The real git folders, the run's stop fired as the copy asks for a hold.
struct StopAtHold {
    inner: BackupGitFolders,
    stop: CancellationToken,
}

impl LiveGitFolders for StopAtHold {
    fn hold(
        &self,
        git_folder: &Path,
        stop: &CancellationToken,
    ) -> Result<Option<Box<dyn Send + '_>>, MirrorError> {
        self.stop.cancel();
        self.inner.hold(git_folder, stop)
    }

    fn check_copied_indexes(
        &self,
        git_folder: &Path,
        copy_objects: &Path,
        indexes: &[CopiedIndex],
        stop: &CancellationToken,
    ) -> Result<CopiedIndexCheck, MirrorError> {
        self.inner
            .check_copied_indexes(git_folder, copy_objects, indexes, stop)
    }
}

// A hold that runs `on_release` before it lets the held lock go.
struct ReleaseAfter<'held> {
    on_release: Option<Box<dyn FnOnce() + Send + 'held>>,
    _held: Option<Box<dyn Send + 'held>>,
}

impl Drop for ReleaseAfter<'_> {
    fn drop(&mut self) {
        if let Some(on_release) = self.on_release.take() {
            on_release();
        }
    }
}

// The real git folders with a sweep pass of the capture folder started once the copy holds it;
// as the hold drops, a second capture and its ref are written and the pass must not have ended.
struct SweepDuringCopy {
    inner: BackupGitFolders,
    packing: Arc<CapturePacking>,
    git: GitRunner,
    captures: Arc<CommandCaptureService>,
    repository: PathBuf,
    owner: PathBuf,
    common: PathBuf,
    folder: PathBuf,
    sweep: Mutex<Option<JoinHandle<Result<CaptureFolderSweep, PackingError>>>>,
    is_swept: Arc<AtomicBool>,
}

impl LiveGitFolders for SweepDuringCopy {
    fn hold(
        &self,
        git_folder: &Path,
        stop: &CancellationToken,
    ) -> Result<Option<Box<dyn Send + '_>>, MirrorError> {
        let held = self.inner.hold(git_folder, stop)?;
        let runtime = Handle::current();
        let folder_lock = self.packing.folder_lock();
        // Read before the pass starts, so only the copy's own hold can hold the lock.
        assert!(
            folder_lock.try_acquire(self.folder.clone()).is_err(),
            "the copy holds the capture folder's lock"
        );
        let handles = folder_lock.queue_handle_count(self.folder.clone());
        let packing = Arc::clone(&self.packing);
        let (owner, common, is_swept) = (
            self.owner.clone(),
            self.common.clone(),
            Arc::clone(&self.is_swept),
        );
        let mut sweep = runtime.spawn(async move {
            let swept = packing
                .sweep_capture_folder(None, &owner, &common, None, &[], &[], SystemTime::now())
                .await;
            is_swept.store(true, Ordering::SeqCst);
            swept
        });
        runtime.block_on(async {
            tokio::select! {
                swept = &mut sweep => panic!("the sweep pass ran inside the copy's hold: {swept:?}"),
                () = folder_lock.wait_for_queue_past(self.folder.clone(), handles) => {}
            }
        });
        *lock(&self.sweep) = Some(sweep);
        let on_release = move || {
            runtime.block_on(async {
                let input = CheckoutCaptureInput {
                    owner_folder: self.owner.clone(),
                    execution_root: self.repository.clone(),
                    checkout_root: self.repository.clone(),
                    captured_at: jiff::Timestamp::now(),
                };
                let second = self
                    .captures
                    .capture_before(None, &input)
                    .await
                    .expect("the second capture is taken");
                let turn = format!("{RUN_REFS}/turn-2");
                git_at(
                    &self.git,
                    &self.folder,
                    &["update-ref", &turn, second.objects.commit().as_str()],
                )
                .await;
            });
            assert!(
                !self.is_swept.load(Ordering::SeqCst),
                "the sweep pass ended before the copy let its hold go"
            );
        };
        Ok(Some(Box::new(ReleaseAfter {
            on_release: Some(Box::new(on_release)),
            _held: held,
        })))
    }

    fn check_copied_indexes(
        &self,
        git_folder: &Path,
        copy_objects: &Path,
        indexes: &[CopiedIndex],
        stop: &CancellationToken,
    ) -> Result<CopiedIndexCheck, MirrorError> {
        self.inner
            .check_copied_indexes(git_folder, copy_objects, indexes, stop)
    }
}

// A copy stopped at its capture folder's hold leaves no ref git reads; a sweep pass of that folder
// started while the copy holds it waits until the copy lets go, and the refs the copy placed name
// only objects it holds or the repository supplies, a capture written as the hold drops never
// among them. Killed by no hold (the lock is free under the copy's hold), by the refs copied once
// the hold drops (`turn-2` is copied without its objects), and by the refs placed before the
// objects or staged under a name git reads (the stopped copy leaves a ref).
#[tokio::test(flavor = "multi_thread")]
async fn a_capture_folders_copy_holds_its_lock_and_every_object_its_copied_refs_name() {
    let git = test_git_runner();
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let root = real_path(scratch.path()).expect("the scratch folder resolves");
    let home = root.join("home");
    let repository = root.join("repository");
    make_repository(&git, &repository).await;
    let sessions = session_storage_root(&data_folder(&home));
    let owner = sessions.join("session");
    let captures = Arc::new(CommandCaptureService::new(
        git.clone(),
        Arc::new(KeyedLock::new()),
        Arc::new(GitFloorReports::default()),
    ));
    let input = CheckoutCaptureInput {
        owner_folder: owner.clone(),
        execution_root: repository.clone(),
        checkout_root: repository.clone(),
        captured_at: jiff::Timestamp::now(),
    };
    let first = captures
        .capture_before(None, &input)
        .await
        .expect("the capture is taken");
    let folder = only_capture_folder(&owner);
    let turn = format!("{RUN_REFS}/turn-1");
    git_at(
        &git,
        &folder,
        &["update-ref", &turn, first.objects.commit().as_str()],
    )
    .await;
    let packing = Arc::new(CapturePacking::new(
        git.clone(),
        Arc::new(GitFloorReports::default()),
    ));
    let backup_folders =
        || BackupGitFolders::new(Arc::clone(&packing), git.clone(), Handle::current());
    let mirror = root.join("mirror");
    let roots = [MirrorRoot::under_home("sessions".to_owned(), &home, &sessions).expect("a root")];
    let copy = mirror
        .join("sessions/session/captures")
        .join(folder.file_name().expect("a capture folder is named"));

    let stopped = CancellationToken::new();
    let stopping = Arc::new(StopAtHold {
        inner: backup_folders(),
        stop: stopped.clone(),
    });
    let stopped_run = mirror_on_thread(&mirror, &home, &roots, stopping, &stopped).await;
    let left_refs = refs_git_reads(&copy);
    let sweeping = Arc::new(SweepDuringCopy {
        inner: backup_folders(),
        packing: Arc::clone(&packing),
        git: git.clone(),
        captures: Arc::clone(&captures),
        repository: repository.clone(),
        owner: owner.clone(),
        common: first.common_folder.clone(),
        folder: folder.clone(),
        sweep: Mutex::new(None),
        is_swept: Arc::new(AtomicBool::new(false)),
    });
    let report = mirror_on_thread(
        &mirror,
        &home,
        &roots,
        Arc::clone(&sweeping) as Arc<dyn LiveGitFolders>,
        &CancellationToken::new(),
    )
    .await
    .expect("the second run copies");
    let sweep = lock(&sweeping.sweep)
        .take()
        .expect("the sweep pass started");
    let swept = sweep.await.expect("the sweep pass's task ends");

    assert!(
        matches!(stopped_run, Err(MirrorError::Stopped)),
        "got {stopped_run:?}"
    );
    assert_eq!(left_refs, Vec::<PathBuf>::new());
    assert_eq!(report.skipped_folders, Vec::<PathBuf>::new());
    assert!(swept.is_ok(), "got {swept:?}");
    let copied_refs = git_at(&git, &copy, &["for-each-ref", "--format=%(refname)"]).await;
    assert!(copied_refs.contains("/turn-1\n"), "got {copied_refs}");
    assert!(!copied_refs.contains("/turn-2"), "got {copied_refs}");
    let alternates = copy.join("objects/info/alternates");
    fs::create_dir_all(alternates.parent().expect("a file has a folder")).expect("made");
    fs::write(
        &alternates,
        format!("{}\n", first.common_folder.join("objects").display()),
    )
    .expect("the repository's objects are attached");
    git_at(&git, &copy, &["rev-list", "--objects", "--all"]).await;
}

// The real git folders with `on_hold` run before each hold a copy asks for, given the count of
// holds asked so far, this one included.
struct ActOnHold {
    inner: BackupGitFolders,
    on_hold: Box<dyn Fn(usize) + Send + Sync>,
    holds: AtomicUsize,
}

impl ActOnHold {
    // The real git folders over a packing of their own, `on_hold` run on the mirror's thread.
    fn new(git: &GitRunner, on_hold: impl Fn(usize) + Send + Sync + 'static) -> Arc<Self> {
        let packing = Arc::new(CapturePacking::new(
            git.clone(),
            Arc::new(GitFloorReports::default()),
        ));
        Arc::new(Self {
            inner: BackupGitFolders::new(packing, git.clone(), Handle::current()),
            on_hold: Box::new(on_hold),
            holds: AtomicUsize::new(0),
        })
    }
}

impl LiveGitFolders for ActOnHold {
    fn hold(
        &self,
        git_folder: &Path,
        stop: &CancellationToken,
    ) -> Result<Option<Box<dyn Send + '_>>, MirrorError> {
        (self.on_hold)(self.holds.fetch_add(1, Ordering::SeqCst) + 1);
        self.inner.hold(git_folder, stop)
    }

    fn check_copied_indexes(
        &self,
        git_folder: &Path,
        copy_objects: &Path,
        indexes: &[CopiedIndex],
        stop: &CancellationToken,
    ) -> Result<CopiedIndexCheck, MirrorError> {
        self.inner
            .check_copied_indexes(git_folder, copy_objects, indexes, stop)
    }
}

// The objects the index of the work tree `folder` names, one per entry.
async fn index_objects(git: &GitRunner, folder: &Path) -> Vec<String> {
    git_in(git, folder, &["ls-files", "--stage"])
        .await
        .lines()
        .map(|entry| {
            entry
                .split(' ')
                .nth(1)
                .expect("an entry names its object")
                .to_owned()
        })
        .collect()
}

// A live repository whose ref moves and whose object is pruned between the copy's first read and
// its objects' copy is read again and copied whole; one whose refs move at every hold keeps its
// last copy after three rounds and is named skipped; an index entry unstaged and pruned the same
// way is read again, so the copy's index names only objects it holds; and an entry naming a blob
// the repository itself never had is copied as it is. Killed by no second read (the copy's
// `topic` names a commit it lacks), by a fourth round (four holds), by a placing after the third
// unstable round (the second run's copy changes), by no index check (the copy's index names a blob
// it lacks), and by an object the live folder also lacks and still names counted moved (the
// workspace is named skipped).
#[tokio::test(flavor = "multi_thread")]
async fn a_live_repository_copy_reads_its_refs_again_when_they_move_during_it() {
    let git = test_git_runner();
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let root = real_path(scratch.path()).expect("the scratch folder resolves");
    let home = root.join("home");
    let workspaces = managed_workspaces_folder(&home);
    let workspace = workspaces.join("chat");
    make_repository(&git, &workspace).await;
    git_in(&git, &workspace, &["checkout", "--quiet", "-b", "topic"]).await;
    fs::write(workspace.join("topic.md"), "topic\n").expect("written");
    git_in(&git, &workspace, &["add", "topic.md"]).await;
    git_in(&git, &workspace, &["commit", "--quiet", "-m", "topic"]).await;
    git_in(&git, &workspace, &["checkout", "--quiet", "main"]).await;
    let mirror = root.join("mirror");
    let roots =
        [MirrorRoot::under_home("workspaces".to_owned(), &home, &workspaces).expect("a root")];
    let copy = mirror.join("workspaces/chat");
    let runtime = Handle::current();
    let run_git = {
        let (git, workspace, runtime) = (git.clone(), workspace.clone(), runtime.clone());
        move |arguments: &[&str]| {
            runtime.block_on(git_in(&git, &workspace, arguments));
        }
    };

    let prune_topic = run_git.clone();
    let moved_once = ActOnHold::new(&git, move |hold| {
        if hold == 1 {
            prune_topic(&["branch", "--force", "topic", "main"]);
            prune_topic(&["reflog", "expire", "--expire=now", "--all"]);
            prune_topic(&["prune", "--expire=now"]);
        }
    });
    let first = mirror_on_thread(
        &mirror,
        &home,
        &roots,
        moved_once,
        &CancellationToken::new(),
    )
    .await
    .expect("the first run copies");
    git_in(&git, &copy, &["rev-list", "--quiet", "--objects", "--all"]).await;
    let copied_topic = git_in(&git, &copy, &["rev-parse", "topic"]).await;
    let main = git_in(&git, &workspace, &["rev-parse", "main"]).await;
    let refs = ["for-each-ref", "--format=%(refname) %(objectname)"];
    let first_refs = git_in(&git, &copy, &refs).await;

    let move_ref = run_git.clone();
    let always_moving = ActOnHold::new(&git, move |hold| {
        move_ref(&["update-ref", &format!("refs/heads/moved-{hold}"), "main"]);
    });
    let moving = mirror_on_thread(
        &mirror,
        &home,
        &roots,
        Arc::clone(&always_moving) as Arc<dyn LiveGitFolders>,
        &CancellationToken::new(),
    )
    .await
    .expect("the second run copies");
    let unstable_refs = git_in(&git, &copy, &refs).await;

    fs::write(workspace.join("staged.md"), "staged, never committed\n").expect("written");
    git_in(&git, &workspace, &["add", "staged.md"]).await;
    let staged_blob = git_in(&git, &workspace, &["rev-parse", ":staged.md"]).await;
    let unstage = run_git.clone();
    let unstaged_once = ActOnHold::new(&git, move |hold| {
        if hold == 1 {
            unstage(&["rm", "--quiet", "--cached", "staged.md"]);
            unstage(&["prune", "--expire=now"]);
        }
    });
    let unstaged = mirror_on_thread(
        &mirror,
        &home,
        &roots,
        unstaged_once,
        &CancellationToken::new(),
    )
    .await
    .expect("the third run copies");
    let unstaged_index = index_objects(&git, &copy).await;
    let mut absent_from_copy = Vec::new();
    for object in &unstaged_index {
        let call = SETTINGS
            .iter()
            .map(OsString::from)
            .chain(in_folder(&copy, &["cat-file", "-e", object]));
        if git.run(None, GitCall::read(call)).await.is_err() {
            absent_from_copy.push(object.clone());
        }
    }

    let never_written = git
        .run(
            None,
            GitCall::read(in_folder(&workspace, &["hash-object", "--stdin"]))
                .with_input(b"never written\n".to_vec()),
        )
        .await
        .expect("the blob's id is read");
    let ghost = String::from_utf8(never_written.stdout)
        .expect("an id is text")
        .trim()
        .to_owned();
    let entry = format!("100644,{ghost},ghost.md");
    git_in(
        &git,
        &workspace,
        &["update-index", "--add", "--cacheinfo", &entry],
    )
    .await;
    let ghost_run = mirror_on_thread(
        &mirror,
        &home,
        &roots,
        ActOnHold::new(&git, |_| {}),
        &CancellationToken::new(),
    )
    .await
    .expect("the fourth run copies");
    let ghost_index = index_objects(&git, &copy).await;

    assert!(first.skipped_folders.is_empty(), "got {first:?}");
    assert_eq!(copied_topic, main);
    assert_eq!(always_moving.holds.load(Ordering::SeqCst), 3);
    assert_eq!(moving.skipped_folders, [workspace.join(".git")]);
    assert_eq!(unstable_refs, first_refs);
    assert!(unstaged.skipped_folders.is_empty(), "got {unstaged:?}");
    assert!(
        !unstaged_index.contains(&staged_blob.trim().to_owned()),
        "the copy's index still names the unstaged blob"
    );
    assert_eq!(absent_from_copy, Vec::<String>::new());
    assert!(ghost_run.skipped_folders.is_empty(), "got {ghost_run:?}");
    assert!(ghost_index.contains(&ghost), "got {ghost_index:?}");
}
