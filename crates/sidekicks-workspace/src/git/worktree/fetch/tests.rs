use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::WallClockTimer;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;
use tokio::time::timeout;

use super::{
    BackgroundFetch, BackgroundFetchDeps, FetchCounts, FetchedRepository, read_counts_as_of,
};
use crate::git::process::{
    GitCall, GitRunner, find_git_executable, in_folder, test_git_runner,
    test_git_runner_with_environment,
};
use crate::git::worktree::schema::schema_parts;
use crate::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::tests::open_log;

const WAIT: Duration = Duration::from_secs(30);

struct Fixture {
    database: TestDatabase,
    scratch: TempDir,
    git: GitRunner,
    mount: RepoMountId,
    repository: PathBuf,
    fetch: BackgroundFetch,
}

impl Fixture {
    // A mount whose checkout is a repository on `main` with one commit and no remote.
    async fn new() -> Self {
        Self::with_git(
            test_git_runner(),
            tempfile::tempdir().expect("a scratch folder"),
        )
        .await
    }

    // `new`, its git run by `git` and its folders in `scratch`.
    async fn with_git(git: GitRunner, scratch: TempDir) -> Self {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let repository = scratch.path().join("repository");
        git_in(
            &git,
            scratch.path(),
            &["init", "--quiet", "--initial-branch=main", "repository"],
        )
        .await;
        git_in(
            &git,
            &repository,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "first",
            ],
        )
        .await;
        let mount_id = mint_uuid_v7().to_string();
        let connection = database.reader();
        for row in project_and_mount_rows(&mount_id, None) {
            connection
                .execute_batch(&row)
                .expect("the project and its mount are stored");
        }
        connection
            .execute(
                "UPDATE repo_mounts SET canonical_root = ?1 WHERE id = ?2",
                params![repository.to_string_lossy(), mount_id],
            )
            .expect("the mount points at the repository");
        let fetch = BackgroundFetch::new(BackgroundFetchDeps {
            git: git.clone(),
            writer: Arc::clone(&log.writer),
            scheduler: Arc::new(Scheduler::start(
                Arc::new(WallClockTimer::new().expect("the wall-clock timer is made")),
                None,
                tokio::sync::watch::channel(0).1,
            )),
        });
        Self {
            database,
            scratch,
            git,
            mount: RepoMountId::new(&mount_id).expect("a minted id is a mount id"),
            repository,
            fetch,
        }
    }

    fn fetched_repository(&self) -> FetchedRepository {
        FetchedRepository {
            repo_mount_id: self.mount,
            repository_root: self.repository.clone(),
            place: None,
        }
    }

    // The mount's last success and last failure.
    fn recorded(&self) -> (Option<String>, Option<String>) {
        self.database
            .reader()
            .query_row(
                "SELECT fetched_at, fetch_failed_at FROM repo_mounts WHERE id = ?1",
                [self.mount.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the mount's row reads")
    }

    fn counts_as_of(&self) -> Option<WireInstant> {
        read_counts_as_of(&self.database.reader(), &self.mount).expect("the figures' instant reads")
    }

    // Waits until `reached` holds for the fetch's counts.
    async fn wait_for(&self, reached: impl FnMut(&FetchCounts) -> bool) {
        timeout(WAIT, self.fetch.counts().wait_for(reached))
            .await
            .expect("the fetch reaches the count in time")
            .expect("the fetch is alive");
    }
}

async fn git_in(git: &GitRunner, folder: &Path, arguments: &[&str]) {
    git.run(None, GitCall::read(in_folder(folder, arguments)))
        .await
        .expect("git runs in the test repository");
}

// Kills: recording the wrong instant or column, keeping the failure past a success, writing
// `FETCH_HEAD`, and fetching a remote the person keeps out of `git fetch --all`.
#[tokio::test]
async fn a_fetch_records_its_failure_and_then_its_success_on_the_mount() {
    let fixture = Fixture::new().await;
    let remote = fixture.scratch.path().join("remote.git");
    let missing = fixture.scratch.path().join("missing.git");
    git_in(
        &fixture.git,
        fixture.scratch.path(),
        &["init", "--quiet", "--bare", "remote.git"],
    )
    .await;
    git_in(
        &fixture.git,
        &fixture.repository,
        &["push", "--quiet", &remote.to_string_lossy(), "main"],
    )
    .await;
    git_in(
        &fixture.git,
        &fixture.repository,
        &["remote", "add", "origin", &missing.to_string_lossy()],
    )
    .await;
    // Unreachable, so fetching it would fail the second fetch.
    git_in(
        &fixture.git,
        &fixture.repository,
        &["remote", "add", "mirror", &missing.to_string_lossy()],
    )
    .await;
    git_in(
        &fixture.git,
        &fixture.repository,
        &["config", "remote.mirror.skipFetchAll", "true"],
    )
    .await;

    let hold = fixture.fetch.keep_fresh(fixture.fetched_repository());
    fixture.wait_for(|counts| counts.ended == 1).await;
    let (fetched_at, failed_at) = fixture.recorded();
    assert_eq!(fetched_at, None);
    assert!(failed_at.is_some(), "the failure is recorded");
    assert_eq!(
        fixture.counts_as_of().as_ref().map(WireInstant::as_str),
        Some(PARENT_ROWS_AT),
        "with no success the figures are as of the attach"
    );

    git_in(
        &fixture.git,
        &fixture.repository,
        &["remote", "set-url", "origin", &remote.to_string_lossy()],
    )
    .await;
    // The last release ends the hold set, so the next hold fetches at once.
    drop(hold);
    let _hold = fixture.fetch.keep_fresh(fixture.fetched_repository());
    fixture.wait_for(|counts| counts.ended == 2).await;
    let (fetched_at, failed_at) = fixture.recorded();
    assert!(fetched_at.is_some(), "the success is recorded");
    assert_eq!(failed_at, None, "a success clears the failure");
    assert_eq!(fixture.counts_as_of(), None);
    assert!(
        !fixture.repository.join(".git").join("FETCH_HEAD").exists(),
        "the person's FETCH_HEAD is left alone"
    );
    let fetched_ref = fixture
        .git
        .run(
            None,
            GitCall::read(in_folder(
                &fixture.repository,
                &["rev-parse", "--verify", "refs/remotes/origin/main"],
            )),
        )
        .await;
    assert!(fetched_ref.is_ok(), "the remote's branch was fetched");
}

// Kills: recording a fetch the stop ended.
#[tokio::test]
async fn a_fetch_the_stop_ends_records_nothing() {
    let fixture = Fixture::new().await;
    git_in(
        &fixture.git,
        fixture.scratch.path(),
        &["init", "--quiet", "--bare", "remote.git"],
    )
    .await;
    let remote = fixture.scratch.path().join("remote.git");
    git_in(
        &fixture.git,
        &fixture.repository,
        &["remote", "add", "origin", &remote.to_string_lossy()],
    )
    .await;
    // The remote's side marks that the transfer began, then waits long past the stop before it
    // answers.
    let marker = fixture.scratch.path().join("transfer-began");
    let upload_pack = format!("touch '{}'; sleep 60; git-upload-pack", marker.display());
    git_in(
        &fixture.git,
        &fixture.repository,
        &["config", "remote.origin.uploadpack", &upload_pack],
    )
    .await;

    let _hold = fixture.fetch.keep_fresh(fixture.fetched_repository());
    timeout(WAIT, async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the transfer begins in time");
    timeout(WAIT, fixture.fetch.stop())
        .await
        .expect("the stop ends the fetch in time");

    assert_eq!(fixture.recorded(), (None, None));
}

// Kills the empty `GIT_ASKPASS` left out, which lets git run `SSH_ASKPASS` for a remote that asks
// for a password on every fetch.
#[tokio::test]
async fn a_fetch_asked_for_a_password_runs_no_askpass_program_and_records_its_failure() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let trace = scratch.path().join("trace.json");
    let empty_config = scratch.path().join("empty.gitconfig");
    std::fs::write(&empty_config, "").expect("an empty config is written");
    let git_program = find_git_executable(&std::env::vars().collect::<Vec<_>>())
        .expect("the tests run where git is");
    let as_text = |path: &Path| path.to_str().expect("a scratch path is text").to_owned();
    let (trace_text, config_text, askpass_text) = (
        as_text(&trace),
        as_text(&empty_config),
        as_text(&git_program),
    );
    // The person's own credential helpers stay out of it; an askpass run shows in git's trace.
    let git = test_git_runner_with_environment(&[
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_CONFIG_GLOBAL", &config_text),
        ("SSH_ASKPASS", &askpass_text),
        ("GIT_TRACE2_EVENT", &trace_text),
    ]);
    let fixture = Fixture::with_git(git, scratch).await;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a local listener binds");
    let address = listener.local_addr().expect("the listener's address reads");
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut request = [0_u8; 4096];
            if stream.read(&mut request).await.is_ok() {
                let answered = stream
                    .write_all(
                        b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"test\"\r\n\
                          Content-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
                drop(answered);
            }
        }
    });
    git_in(
        &fixture.git,
        &fixture.repository,
        &[
            "remote",
            "add",
            "origin",
            &format!("http://{address}/repository.git"),
        ],
    )
    .await;

    let _hold = fixture.fetch.keep_fresh(fixture.fetched_repository());
    fixture.wait_for(|counts| counts.ended == 1).await;

    let (fetched_at, failed_at) = fixture.recorded();
    assert_eq!(fetched_at, None);
    assert!(failed_at.is_some(), "the failure is recorded");
    let trace = std::fs::read_to_string(&trace).expect("git's trace reads");
    assert!(
        !trace
            .lines()
            .any(|event| (event.contains(r#""event":"start""#)
                || event.contains(r#""event":"child_start""#))
                && event.contains("Username for")),
        "no askpass program was run"
    );
}
