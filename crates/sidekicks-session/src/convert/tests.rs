use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::params;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::session::convert::{
    SessionConversionSkippedFileListRequest, SessionConversionSkippedFileListResponse,
    SessionConvertRequest, SessionConvertResponse, SessionConvertSkipReason,
    SessionConvertSkippedFile,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::{os_text_stable_bytes, real_path};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::test_registry::test_driver_services;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_workspace::event_emitter::WorkspaceEventEmitter;
use sidekicks_workspace::execution_root::test_fixture::{
    ExecutionRootFixture, MOUNT_ID, SESSION_ID,
};
use sidekicks_workspace::git::process::test_git_runner;
use sidekicks_workspace::git::process::test_repository::make_test_repository;
use sidekicks_workspace::git::process::write_link;
use sidekicks_workspace::project::list_feed::ProjectListFeed;
use sidekicks_workspace::project::records::ProjectRecords;
use sidekicks_workspace::project::service::{ProjectService, ProjectServiceDeps};
use sidekicks_workspace::project::test_doubles::Unreached;
use sidekicks_workspace::repo::mount::service::RepoMountService;
use sidekicks_workspace::repo::root_resolver::RepoRootResolver;

use super::{SessionConversion, SessionConversionDeps, SessionConversionError};
use crate::changes::SessionChanges;
use crate::directory::run_activity::ProjectSessionActivityReader;
use crate::plan_holds::NoPlanHolds;
use crate::questions::schema::schema_parts;

const MANAGED_MOUNT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4ec0";
const FIRST_KEY: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4ec1";
const SECOND_KEY: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4ec2";

/// The conversion over the execution roots' fixture: its session is a chat whose managed
/// workspace is `workspace`, and its attached mount is the repository `app`.
struct Fixture {
    roots: ExecutionRootFixture,
    conversion: SessionConversion,
    workspace: PathBuf,
    // Where links point and what no copy may reach.
    outside: PathBuf,
    // Each link a test writes takes a scratch repository of its own.
    link_count: usize,
}

impl Fixture {
    async fn new() -> Self {
        let roots = ExecutionRootFixture::with(schema_parts(), test_git_runner()).await;
        let scratch = real_path(roots.scratch.path()).expect("the scratch folder resolves");
        let workspace = scratch.join("workspace");
        let outside = scratch.join("outside");
        fs::create_dir(&workspace).expect("the chat's workspace is made");
        fs::create_dir(&outside).expect("the outside folder is made");
        roots
            .rows
            .execute(
                "UPDATE repo_mounts SET metadata = json_set(metadata, '$.commonDir', ?1) \
                 WHERE id = ?2",
                params![roots.repository.join(".git").to_string_lossy(), MOUNT_ID],
            )
            .expect("the mount records its anchor");
        roots
            .rows
            .execute(
                "INSERT INTO repo_mounts (id, machine_id, local_path, canonical_root, origin, \
                 managed_session_id, attached_at, updated_at) VALUES (?1, 'machine', ?2, ?2, \
                 'managed', ?3, '2026-10-14T09:30:00.000Z', '2026-10-14T09:30:00.000Z')",
                params![MANAGED_MOUNT_ID, workspace.to_string_lossy(), SESSION_ID],
            )
            .expect("the chat's managed mount is stored");

        let git = test_git_runner();
        let mounts = Arc::new(RepoMountService::new(
            Arc::clone(&roots.log.writer),
            Arc::clone(&roots.reads),
            Arc::new(WorkspaceEventEmitter::new(Arc::clone(&roots.log.service))),
            RepoRootResolver::new(git.clone()),
            MachineId::new("machine".to_owned()).expect("the id is short"),
        ));
        let changes = Arc::new(SessionChanges::new(
            Arc::clone(&roots.reads),
            Arc::clone(&roots.log.service),
            Arc::new(ProviderRegistry::register_from(
                &[],
                &test_driver_services(),
            )),
        ));
        let records = Arc::new(ProjectRecords::new(
            Arc::clone(&roots.reads),
            Arc::new(ProjectSessionActivityReader::new(&NoPlanHolds)),
        ));
        let projects = Arc::new(ProjectService::new(ProjectServiceDeps {
            writer: Arc::clone(&roots.log.writer),
            records: Arc::clone(&records),
            mounts: Arc::clone(&mounts),
            sessions: Arc::clone(&changes) as _,
            git,
            settings: Arc::new(Unreached),
            driver_set_names: Vec::new(),
            worktrees_folder: scratch.join("worktrees"),
            list_feed: Arc::new(ProjectListFeed::new(records, &roots.log.followers)),
        }));
        let conversion = SessionConversion::new(SessionConversionDeps {
            reads: Arc::clone(&roots.reads),
            writer: Arc::clone(&roots.log.writer),
            appender: SessionEventAppender::new(
                Arc::clone(&roots.log.service),
                SESSION_EVENT_VERSION.clone(),
            ),
            changes,
            mounts,
            projects,
            workspaces: Arc::clone(&roots.workspaces),
        });
        Self {
            roots,
            conversion,
            workspace,
            outside,
            link_count: 0,
        }
    }

    async fn convert(
        &self,
        folder: &Path,
        key: &str,
    ) -> Result<SessionConvertResponse, SessionConversionError> {
        self.conversion
            .convert(&SessionConvertRequest {
                session_id: session_id(),
                path: FilesystemPath::new(folder.to_string_lossy().into_owned())
                    .expect("the folder is a wire path"),
                client_idempotency_key: ClientUuid::new(key.to_owned()).expect("a UUID"),
            })
            .await
    }

    /// Every skipped file, page by page from the first.
    async fn read_every_skipped_file(&self) -> (Vec<SessionConvertSkippedFile>, usize) {
        let mut files = Vec::new();
        let mut pages = 0;
        let mut after_cursor = None;
        loop {
            pages += 1;
            let page = self
                .conversion
                .list_skipped_files(&SessionConversionSkippedFileListRequest {
                    session_id: session_id(),
                    after_cursor: after_cursor.take(),
                    limit: None,
                })
                .await
                .expect("a page is read");
            match page {
                SessionConversionSkippedFileListResponse::Continuing(page) => {
                    files.extend(page.files.as_slice().iter().cloned());
                    after_cursor = Some(page.next_cursor);
                }
                SessionConversionSkippedFileListResponse::Terminal(page) => {
                    assert!(
                        pages == 1 || !page.files.as_slice().is_empty(),
                        "a page said more files follow, and the next page held none",
                    );
                    files.extend(page.files.as_slice().iter().cloned());
                    return (files, pages);
                }
            }
        }
    }

    /// Writes a link at `link` in `folder` pointing at `target`.
    async fn write_link(&mut self, folder: &Path, link: &str, target: &Path) {
        self.link_count += 1;
        let scratch = real_path(self.roots.scratch.path())
            .expect("the scratch folder resolves")
            .join(format!("link-scratch-{}", self.link_count));
        write_link(
            &self.roots.git,
            &scratch,
            folder,
            link,
            &target.to_string_lossy(),
        )
        .await;
    }

    /// Records a conversion of the chat into the repository that stopped once `a.txt` was copied,
    /// that copy left in the repository.
    async fn record_stopped_conversion(&self) {
        let working_tree = RepoRootResolver::new(test_git_runner())
            .read_working_tree_root(&self.roots.repository)
            .await
            .expect("git reads the working tree")
            .expect("the repository is a working tree");
        self.roots
            .rows
            .execute(
                "INSERT INTO session_convert_requests (client_idempotency_key, session_id, \
                 repo_mount_id, working_tree) VALUES (?1, ?2, ?3, ?4)",
                params![
                    FIRST_KEY,
                    SESSION_ID,
                    MOUNT_ID,
                    working_tree.to_string_lossy()
                ],
            )
            .expect("the stopped conversion is stored");
        record_file(&self.roots.rows, "a.txt", "copied");
        write(&self.roots.repository.join("a.txt"), "chat a");
    }
}

// Records `path`'s outcome as the copy does, keyed by the path's stable bytes.
fn record_file(rows: &rusqlite::Connection, path: &str, outcome: &str) {
    rows.execute(
        "INSERT INTO session_convert_files (session_id, path_key, path, outcome) \
         VALUES (?1, ?2, ?3, ?4)",
        params![
            SESSION_ID,
            os_text_stable_bytes(OsStr::new(path)).as_ref(),
            path,
            outcome
        ],
    )
    .expect("a file's outcome is stored");
}

fn session_id() -> SessionId {
    SessionId::new(SESSION_ID).expect("the id is a UUID")
}

fn write(path: &Path, text: &str) {
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder).expect("the file's folder is made");
    }
    fs::write(path, text).expect("the file is written");
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).expect("the file is read")
}

fn counts(copied: u64, skipped: u64) -> SessionConvertResponse {
    SessionConvertResponse {
        copied_count: SafeInt::new(copied).expect("a count"),
        skipped_count: SafeInt::new(skipped).expect("a count"),
    }
}

fn skipped(path: &str, reason: SessionConvertSkipReason) -> SessionConvertSkippedFile {
    SessionConvertSkippedFile {
        path: FilesystemPath::new(path.to_owned()).expect("a wire path"),
        reason,
    }
}

fn copy_name() -> String {
    format!(".ai-sidekicks-copy-{SESSION_ID}")
}

// Kills a rename in place of the publish that never replaces: the repository's own `a.txt` would
// take the chat's bytes.
#[tokio::test]
async fn a_convert_copies_the_chats_files_and_leaves_the_repositorys_own_untouched() {
    let fixture = Fixture::new().await;
    write(&fixture.workspace.join("a.txt"), "chat a");
    write(&fixture.workspace.join("nested/b.txt"), "chat b");
    write(
        &fixture.workspace.join(".git/config"),
        "the chat's own history",
    );
    write(&fixture.roots.repository.join("a.txt"), "repository a");

    let converted = fixture
        .convert(&fixture.roots.repository, FIRST_KEY)
        .await
        .expect("the chat converts");

    assert_eq!(converted, counts(1, 1));
    assert_eq!(
        read(&fixture.roots.repository.join("a.txt")),
        "repository a"
    );
    assert_eq!(
        read(&fixture.roots.repository.join("nested/b.txt")),
        "chat b"
    );
    let converted_events = fixture.roots.count(&format!(
        "SELECT count(*) FROM session_events WHERE session_id = '{SESSION_ID}' \
         AND type = 'session.converted'"
    ));
    assert_eq!(
        converted_events, 1,
        "the session kept its id and became a project"
    );
    assert_eq!(
        fixture.read_every_skipped_file().await.0,
        vec![skipped(
            "a.txt",
            SessionConvertSkipReason::RepositoryHasFile
        )]
    );
    // The same key answers the conversion again, copying nothing.
    assert_eq!(
        fixture
            .convert(&fixture.roots.repository, FIRST_KEY)
            .await
            .expect("the repeat answers"),
        counts(1, 1)
    );
}

// Kills dropping the no-follow open: the workspace's link would be followed and its target's bytes
// copied into the repository.
#[tokio::test]
async fn no_link_is_followed_out_of_the_workspace_or_the_repository() {
    let mut fixture = Fixture::new().await;
    let secret = fixture.outside.join("secret.txt");
    write(&secret, "outside the workspace");
    let workspace = fixture.workspace.clone();
    let repository = fixture.roots.repository.clone();
    fixture.write_link(&workspace, "outside.txt", &secret).await;
    let piped = std::process::Command::new("mkfifo")
        .arg(workspace.join("pipe"))
        .status()
        .expect("mkfifo runs");
    assert!(piped.success(), "the named pipe is made");
    write(&workspace.join("linked/c.txt"), "chat c");
    write(&workspace.join("d.txt"), "chat d");
    let outside = fixture.outside.clone();
    fixture.write_link(&repository, "linked", &outside).await;
    fixture
        .write_link(&repository, "d.txt", &outside.join("d-target.txt"))
        .await;

    let converted = fixture
        .convert(&repository, FIRST_KEY)
        .await
        .expect("the chat converts");

    assert_eq!(converted, counts(0, 4));
    assert_eq!(
        fixture.read_every_skipped_file().await.0,
        vec![
            skipped("d.txt", SessionConvertSkipReason::RepositoryHasFile),
            skipped(
                "linked/c.txt",
                SessionConvertSkipReason::RepositoryPathNotAFolder
            ),
            skipped("outside.txt", SessionConvertSkipReason::Link),
            skipped("pipe", SessionConvertSkipReason::SpecialFile),
        ]
    );
    let mut reached: Vec<_> = fs::read_dir(&outside)
        .expect("the outside folder is listed")
        .map(|entry| entry.expect("an entry").file_name())
        .collect();
    reached.sort();
    assert_eq!(reached, vec!["secret.txt"], "nothing was written outside");
    assert!(
        fs::symlink_metadata(repository.join("outside.txt")).is_err(),
        "the link's target was not copied in"
    );
}

// Kills dropping the working-tree compare: the other folder would be attached and the copy go
// there.
#[tokio::test]
async fn a_stopped_conversion_resumes_only_into_its_own_folder_under_a_new_key() {
    let fixture = Fixture::new().await;
    fixture.record_stopped_conversion().await;
    write(&fixture.workspace.join("a.txt"), "chat a");
    write(&fixture.workspace.join("b.txt"), "chat b");
    let scratch = real_path(fixture.roots.scratch.path()).expect("the scratch folder resolves");
    let other = make_test_repository(&fixture.roots.git, &scratch, "other").await;

    let refusal = fixture
        .convert(&other, SECOND_KEY)
        .await
        .expect_err("a stopped conversion copies into its own folder only");

    let SessionConversionError::Refused(refusal) = refusal else {
        panic!("the convert is refused, not {refusal:?}");
    };
    assert_eq!(refusal.code, RefusalCode::SessionConversionRefused);
    let detail = refusal.detail.expect("the refusal names its reason");
    assert_eq!(detail["reason"], "conversionUnfinished");
    assert_eq!(detail["repoMountId"], MOUNT_ID);
    assert!(
        !other.join("b.txt").exists(),
        "nothing was copied into the other folder"
    );

    let resumed = fixture
        .convert(&fixture.roots.repository, SECOND_KEY)
        .await
        .expect("the conversion resumes");

    assert_eq!(resumed, counts(2, 0), "the copy before the stop counts");
    assert_eq!(read(&fixture.roots.repository.join("b.txt")), "chat b");
    assert_eq!(
        fixture.roots.count(&format!(
            "SELECT count(*) FROM session_convert_requests WHERE client_idempotency_key = \
             '{SECOND_KEY}'"
        )),
        1,
        "the new key took the conversion over"
    );
}

// Kills skipping the leftover removal: the copy a stop cut short would stay in the repository, and
// the resumed copy of its file could not be written beside it.
#[tokio::test]
async fn a_copy_cut_short_is_removed_at_start_and_on_resume() {
    let fixture = Fixture::new().await;
    fixture.record_stopped_conversion().await;
    write(&fixture.workspace.join("sub/b.txt"), "chat b");
    let leftover = fixture.roots.repository.join("sub").join(copy_name());
    write(&leftover, "chat");

    fixture
        .conversion
        .remove_stopped_copies()
        .await
        .expect("the stopped copies are removed");

    assert!(!leftover.exists(), "the start removed the copy cut short");
    assert!(!fixture.roots.repository.join("sub/b.txt").exists());

    write(&leftover, "chat");
    fixture
        .convert(&fixture.roots.repository, SECOND_KEY)
        .await
        .expect("the conversion resumes");

    assert!(!leftover.exists(), "the resume removed the copy cut short");
    assert_eq!(read(&fixture.roots.repository.join("sub/b.txt")), "chat b");
}

// Kills the cursor's `>` written `>=`: each page would carry the previous page's last file again.
// Kills the page's more-follows check written `>=`: a full last page would say more follows.
#[tokio::test]
async fn every_skipped_file_is_read_back_once_in_path_order_over_pages_cut_at_the_budget() {
    let fixture = Fixture::new().await;
    // Each path near the longest, so a page fills its byte budget long before its file limit.
    let paths: Vec<String> = (0..900)
        .map(|index| format!("{index:04}-{}", "x".repeat(3_900)))
        .collect();
    for (index, path) in paths.iter().enumerate() {
        let outcome = if index % 3 == 0 { "copied" } else { "link" };
        record_file(&fixture.roots.rows, path, outcome);
    }
    let expected: Vec<_> = paths
        .iter()
        .enumerate()
        .filter(|(index, _)| index % 3 != 0)
        .map(|(_, path)| skipped(path, SessionConvertSkipReason::Link))
        .collect();

    let (files, pages) = fixture.read_every_skipped_file().await;

    assert_eq!(files, expected);
    assert!(pages >= 3, "the byte budget cut the pages, {pages} read");
}
