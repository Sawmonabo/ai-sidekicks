//! The copy kept before an agent's edit tool writes a file: the file as it stood, copied into the
//! session's copies folder and recorded under the session's newest checkpoint, once per path in
//! that checkpoint. A copy that fails is recorded as failed, named by the edit's tool call, so the
//! hook that holds the edit is answered either way.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::SnapshotId;
use sidekicks_provider::port::edit_checkpoint::{EditCheckpoint, EditCheckpointRequest};
use sidekicks_std::file::real_location::resolve_real_location;
use sidekicks_store::data_folder::session_storage_folder;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::writer::DatabaseWriter;
use tokio::task::JoinError;

use crate::checkpoints::copies::{COPIES_LOCK, CopyStore, FileCopyError, FileCopyOutcome};
use crate::checkpoints::schema::{
    CheckpointVersionContent, CheckpointVersionLeg, CopyMode, NotKeptReason,
};
use crate::checkpoints::shadows::recorded_path;
use crate::checkpoints::store::{
    CheckpointVersion, holds_path, insert_version_statement, newest_checkpoint,
};

/// The statements an edit's copy prepares on a pooled connection: the session's newest checkpoint
/// and the probe of whether it already holds the path.
pub const EDIT_CHECKPOINTS_STATEMENT_CAPACITY: usize = 2;

/// Why the checkpoint an edit falls under could not be read; that edit is not recorded.
#[derive(Debug, thiserror::Error)]
enum EditCheckpointReadError {
    /// The read pool did not run the read.
    #[error("the read pool did not run the edit's read")]
    Pool(#[from] DatabaseReadError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("the session's newest checkpoint or its versions of the path could not be read")]
    Read(#[from] rusqlite::Error),
}

/// Why an edit's copy, or the real path of its folder, could not be kept; the edit is recorded as
/// failed.
#[derive(Debug, thiserror::Error)]
enum EditCopyError {
    /// The session's copies folder could not be made.
    #[error("the session's copies folder could not be made")]
    Folder(#[source] io::Error),
    /// The file could not be copied.
    #[error(transparent)]
    Copy(#[from] FileCopyError),
    /// The copy's task did not finish.
    #[error("the edit's copy did not finish")]
    Unfinished(#[source] JoinError),
    /// The real path of the file's folder could not be read, or no row can hold it.
    #[error("the real path of the edited file's folder could not be read")]
    ParentRealPath(#[source] io::Error),
}

/// The edit leg's checkpoint service: it keeps a copy of each file an agent's edit tool is about
/// to write, in each session's storage folder under the daemon's data folder.
pub struct EditCheckpoints {
    /// The pool the newest checkpoint and the probe are read through.
    reads: Arc<DatabaseReadPool>,
    /// The writer each version is recorded through.
    writer: Arc<DatabaseWriter>,
    /// The daemon's data folder, which holds each session's storage folder.
    data_folder: PathBuf,
}

impl EditCheckpoints {
    /// The service reading checkpoints through `reads`, recording versions through `writer`, and
    /// keeping copies in each session's storage folder under `data_folder`.
    pub fn new(
        reads: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
        data_folder: PathBuf,
    ) -> Self {
        Self {
            reads,
            writer,
            data_folder,
        }
    }

    // Records what stands at the request's path under the session's newest checkpoint, unless the
    // checkpoint already holds the path; every failure is logged, and none reaches the caller.
    async fn keep(&self, request: EditCheckpointRequest) {
        let EditCheckpointRequest {
            session_id,
            path,
            tool_call_id,
        } = request;
        let tool_call = tool_call_id.as_ref().map(ToolCallId::as_str);
        // A relative path would be opened against the daemon's own folder, and an undo would
        // remove it there.
        let Some(edited) = EditedPath::of(&path) else {
            tracing::warn!(
                %session_id,
                tool_call_id = tool_call,
                path = %path.display(),
                "an edit's path is not absolute or no row can hold it, so the edit was not recorded"
            );
            return;
        };
        let checkpoint_id = match self.checkpoint_without(session_id, &edited.recorded).await {
            Ok(Some(checkpoint_id)) => checkpoint_id,
            Ok(None) => return,
            Err(error) => {
                tracing::error!(
                    %session_id,
                    tool_call_id = tool_call,
                    path = %path.display(),
                    error = &error as &(dyn Error + 'static),
                    "an edit's checkpoint could not be read, so the edit was not recorded"
                );
                return;
            }
        };
        // Held until the version naming the copy is written, so the orphans walk keeps the copy.
        let copies_hold = COPIES_LOCK.read(session_id).await;
        let owner_folder = session_storage_folder(&self.data_folder, &session_id);
        let copied_path = path.clone();
        let copied = tokio::task::spawn_blocking(move || -> Result<_, EditCopyError> {
            let copies = CopyStore::open(&owner_folder).map_err(EditCopyError::Folder)?;
            Ok(copies.keep_file_copy(&copied_path)?)
        })
        .await
        .unwrap_or_else(|unfinished| Err(EditCopyError::Unfinished(unfinished)));
        let content = match copied {
            Ok(FileCopyOutcome::Copied { hash, mode }) => Ok(CheckpointVersionContent::Copy {
                hash,
                mode: CopyMode::Permissions(mode),
            }),
            Ok(FileCopyOutcome::Gone) => Ok(CheckpointVersionContent::Created),
            Ok(FileCopyOutcome::Link) => {
                tracing::debug!(
                    %session_id,
                    tool_call_id = tool_call,
                    path = %path.display(),
                    "an edit's path is a link, which the tool does not write through, so the edit \
                     records nothing"
                );
                return;
            }
            Ok(FileCopyOutcome::SpecialFile) => Ok(CheckpointVersionContent::NotKept {
                reason: NotKeptReason::NotARegularFile,
            }),
            Err(error) => Err(error),
        };
        let parent_real_path = parent_real_path(edited.parent).await;
        for error in [content.as_ref().err(), parent_real_path.as_ref().err()]
            .into_iter()
            .flatten()
        {
            tracing::warn!(
                %session_id,
                tool_call_id = tool_call,
                path = %path.display(),
                error = error as &(dyn Error + 'static),
                "an edit's file could not be kept, so the edit is recorded as failed"
            );
        }
        let (content, parent_real_path) = match (content, parent_real_path) {
            (Ok(content), Ok(parent_real_path)) => (content, parent_real_path),
            (_, parent_real_path) => (
                CheckpointVersionContent::NotKept {
                    reason: NotKeptReason::Failed,
                },
                parent_real_path.unwrap_or(edited.recorded_parent),
            ),
        };
        let version = CheckpointVersion {
            path: edited.recorded,
            leg: CheckpointVersionLeg::Edit,
            content,
            parent_real_path,
            window_id: None,
            tool_call_id: tool_call_id.clone(),
        };
        let written = self
            .writer
            .write(vec![insert_version_statement(&checkpoint_id, &version)])
            .await;
        drop(copies_hold);
        if let Err(error) = written {
            tracing::error!(
                %session_id,
                tool_call_id = tool_call,
                path = %path.display(),
                error = &error as &(dyn Error + 'static),
                "an edit's version could not be written, so the edit was not recorded"
            );
        }
    }

    // The session's newest checkpoint where it does not hold `path` yet; `None` where it does, or
    // where the session has none, which is logged.
    async fn checkpoint_without(
        &self,
        session_id: SessionId,
        path: &FilesystemPath,
    ) -> Result<Option<SnapshotId>, EditCheckpointReadError> {
        let probed = path.clone();
        let newest = self
            .reads
            .read(ReadLength::Short, move |reader| {
                let Some(newest) = newest_checkpoint(reader, session_id)? else {
                    return Ok::<_, EditCheckpointReadError>(None);
                };
                let checkpoint_id = newest.checkpoint.checkpoint_id;
                let is_held = holds_path(reader, &checkpoint_id, &probed)?;
                Ok(Some((checkpoint_id, is_held)))
            })
            .await?;
        match newest {
            Some((checkpoint_id, false)) => Ok(Some(checkpoint_id)),
            Some((_, true)) => Ok(None),
            // An edit runs only inside a turn a prompt started, whose start wrote a checkpoint.
            None => {
                tracing::warn!(
                    %session_id,
                    "an edit ran in a session with no checkpoint, so it was not recorded"
                );
                Ok(None)
            }
        }
    }
}

impl EditCheckpoint for EditCheckpoints {
    fn keep_before_edit(&self, request: EditCheckpointRequest) -> BoxFuture<'_, ()> {
        Box::pin(self.keep(request))
    }
}

/// An edited path that is absolute with a file name, and that a row can hold.
struct EditedPath<'path> {
    /// The path as its row records it.
    recorded: FilesystemPath,
    /// Its lexical parent.
    parent: &'path Path,
    /// Its lexical parent as a row records it, where the parent's real path is not named.
    recorded_parent: FilesystemPath,
}

impl<'path> EditedPath<'path> {
    // `None` where `path` is not absolute, has no file name, or no row can hold it.
    fn of(path: &'path Path) -> Option<Self> {
        if !path.is_absolute() || path.file_name().is_none() {
            return None;
        }
        let parent = path.parent()?;
        Some(Self {
            recorded: recorded_path(path).ok()?,
            parent,
            recorded_parent: recorded_path(parent).ok()?,
        })
    }
}

// The real path of the edited file's folder, a missing folder the edit makes resolved through its
// nearest existing one with the missing names kept, so an undo can tell a moved folder from one
// the edit made.
async fn parent_real_path(parent: &Path) -> Result<FilesystemPath, EditCopyError> {
    resolve_real_location(parent)
        .await
        .and_then(|real| recorded_path(&real))
        .map_err(EditCopyError::ParentRealPath)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use rstest::rstest;
    use rusqlite::Connection;
    use sidekicks_contracts::provider::tool_call::ToolCallId;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_platforms::{is_superuser, make_folder_link, make_unreadable, real_path};
    use sidekicks_provider::port::edit_checkpoint::{EditCheckpoint as _, EditCheckpointRequest};
    use sidekicks_store::data_folder::session_storage_folder;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use tempfile::TempDir;

    use super::{EDIT_CHECKPOINTS_STATEMENT_CAPACITY, EditCheckpoints};
    use crate::checkpoints::copies::CopyStore;
    use crate::checkpoints::copies::tests::{
        abc_hash, make_link_to_folder, write_read_only_source,
    };
    use crate::checkpoints::schema::{
        CheckpointVersionContent, CheckpointVersionLeg, CopyMode, NotKeptReason,
    };
    use crate::checkpoints::shadows::recorded_path;
    use crate::checkpoints::store::tests::Fixture;
    use crate::checkpoints::store::{CheckpointVersion, FailedEdit, failed_edits, versions_after};

    /// A checkpoint database, the service over it, and the data folder its copies go in.
    struct Edits {
        fixture: Fixture,
        service: EditCheckpoints,
        data_folder: TempDir,
    }

    impl Edits {
        async fn new() -> Self {
            let fixture = Fixture::new().await;
            let data_folder = tempfile::tempdir().expect("a data folder");
            let reads = Arc::new(DatabaseReadPool::new(
                fixture.database.path(),
                EDIT_CHECKPOINTS_STATEMENT_CAPACITY,
            ));
            let service = EditCheckpoints::new(
                reads,
                Arc::clone(&fixture.writer),
                data_folder.path().to_path_buf(),
            );
            Self {
                fixture,
                service,
                data_folder,
            }
        }

        /// Keeps `path` before an edit by the test's tool call.
        async fn keep(&self, path: &Path) {
            self.service
                .keep_before_edit(EditCheckpointRequest {
                    session_id: self.fixture.session_id,
                    path: path.to_path_buf(),
                    tool_call_id: Some(tool_call()),
                })
                .await;
        }

        /// Per path, the version an undo of the whole session puts back.
        fn versions(&self) -> Vec<CheckpointVersion> {
            versions_after(&self.reader(), self.fixture.session_id, SafeInt::ZERO)
                .expect("the versions read")
                .into_iter()
                .map(|stored| stored.version)
                .collect()
        }

        fn reader(&self) -> Connection {
            self.fixture.database.reader()
        }

        /// The session's storage folder, which the copies folder is made in.
        fn storage_folder(&self) -> PathBuf {
            session_storage_folder(self.data_folder.path(), &self.fixture.session_id)
        }
    }

    fn tool_call() -> ToolCallId {
        ToolCallId::new("toolu_edit".to_owned()).expect("a test tool call id")
    }

    /// The edit's version of `path` by the test's tool call.
    fn edit_version(
        path: &Path,
        content: CheckpointVersionContent,
        parent_real_path: &Path,
    ) -> CheckpointVersion {
        CheckpointVersion {
            path: recorded_path(path).expect("a test path"),
            leg: CheckpointVersionLeg::Edit,
            content,
            parent_real_path: recorded_path(parent_real_path).expect("a test path"),
            window_id: None,
            tool_call_id: Some(tool_call()),
        }
    }

    /// A folder reached through a link, and the real path of the folder it links to.
    struct LinkedFolder {
        scratch: TempDir,
        link: PathBuf,
        target_real: PathBuf,
    }

    fn linked_folder() -> LinkedFolder {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let target = scratch.path().join("target");
        fs::create_dir(&target).expect("the target is made");
        let link = scratch.path().join("reached");
        make_folder_link(&target, &link).expect("the link is made");
        let target_real = real_path(&target).expect("the target resolves");
        LinkedFolder {
            scratch,
            link,
            target_real,
        }
    }

    /// The path a case edits, and the content and parent real path its version records, `None`
    /// where it records none.
    struct Placed {
        path: PathBuf,
        expected: Option<(CheckpointVersionContent, PathBuf)>,
    }

    fn a_read_only_file(folder: &LinkedFolder) -> Placed {
        let path = folder.link.join("file");
        let mode = write_read_only_source(&path);
        let content = CheckpointVersionContent::Copy {
            hash: abc_hash(),
            mode: CopyMode::Permissions(mode),
        };
        Placed {
            path,
            expected: Some((content, folder.target_real.clone())),
        }
    }

    fn a_missing_file(folder: &LinkedFolder) -> Placed {
        Placed {
            path: folder.link.join("file"),
            expected: Some((
                CheckpointVersionContent::Created,
                folder.target_real.clone(),
            )),
        }
    }

    fn a_missing_file_in_a_missing_folder(folder: &LinkedFolder) -> Placed {
        Placed {
            path: folder.link.join("missing").join("file"),
            expected: Some((
                CheckpointVersionContent::Created,
                folder.target_real.join("missing"),
            )),
        }
    }

    fn a_folder_link(folder: &LinkedFolder) -> Placed {
        let path = folder.link.join("link");
        make_link_to_folder(folder.scratch.path(), &path);
        Placed {
            path,
            expected: None,
        }
    }

    fn a_folder(folder: &LinkedFolder) -> Placed {
        let path = folder.link.join("folder");
        fs::create_dir(&path).expect("the folder is made");
        let content = CheckpointVersionContent::NotKept {
            reason: NotKeptReason::NotARegularFile,
        };
        Placed {
            path,
            expected: Some((content, folder.target_real.clone())),
        }
    }

    // Kills each outcome's arm swapped, a link recorded, a not-found folder read as failed,
    // `Executable` recorded or the bits fixed, and the parent recorded as written, through the
    // link.
    #[rstest]
    #[case::a_read_only_file(a_read_only_file)]
    #[case::a_missing_file(a_missing_file)]
    #[case::a_missing_file_in_a_missing_folder(a_missing_file_in_a_missing_folder)]
    #[case::a_folder_link(a_folder_link)]
    #[case::a_folder(a_folder)]
    #[tokio::test]
    async fn an_edit_is_recorded_by_what_stood_at_its_path(
        #[case] place: fn(&LinkedFolder) -> Placed,
    ) {
        let edits = Edits::new().await;
        edits.fixture.record(0, &[]).await;
        let folder = linked_folder();
        let placed = place(&folder);

        edits.keep(&placed.path).await;

        let expected: Vec<CheckpointVersion> = placed
            .expected
            .iter()
            .map(|(content, parent)| edit_version(&placed.path, content.clone(), parent))
            .collect();
        assert_eq!(edits.versions(), expected);
        if let Some((CheckpointVersionContent::Copy { hash, .. }, _)) = &placed.expected {
            let copies = CopyStore::open(&edits.storage_folder()).expect("the copies open");
            assert_eq!(
                fs::read(copies.copy_path(hash)).expect("the copy reads"),
                b"abc"
            );
        }
    }

    // Kills a failed copy read as created or left with no row, and the tool call dropped.
    #[tokio::test]
    async fn an_edit_whose_copy_fails_is_recorded_failed_by_its_tool_call() {
        if is_superuser() {
            return;
        }
        let edits = Edits::new().await;
        edits.fixture.record(0, &[]).await;
        let folder = tempfile::tempdir().expect("a folder");
        let path = folder.path().join("file");
        fs::write(&path, b"abc").expect("the file is written");
        let _unreadable = make_unreadable(&path).expect("the file is made unreadable");

        edits.keep(&path).await;

        let folder_real = real_path(folder.path()).expect("the folder resolves");
        let failed = CheckpointVersionContent::NotKept {
            reason: NotKeptReason::Failed,
        };
        assert_eq!(
            edits.versions(),
            vec![edit_version(&path, failed, &folder_real)]
        );
        assert_eq!(
            failed_edits(&edits.reader(), edits.fixture.session_id, SafeInt::ZERO)
                .expect("the failed edits read"),
            vec![FailedEdit {
                path: recorded_path(&path).expect("a test path"),
                tool_call_id: tool_call(),
            }]
        );
    }

    // Kills the probe removed: the second edit would write a second row.
    #[tokio::test]
    async fn an_edit_of_a_path_the_checkpoint_already_holds_copies_nothing() {
        let edits = Edits::new().await;
        edits.fixture.record(0, &[]).await;
        let folder = tempfile::tempdir().expect("a folder");
        let path = folder.path().join("file");
        fs::write(&path, b"abc").expect("the file is written");

        edits.keep(&path).await;
        fs::write(&path, b"def").expect("the file is rewritten");
        edits.keep(&path).await;

        let row_count: i64 = edits
            .reader()
            .query_row("SELECT COUNT(*) FROM checkpoint_versions", [], |row| {
                row.get(0)
            })
            .expect("the versions count");
        assert_eq!(row_count, 1);
        let versions = edits.versions();
        let [version] = versions.as_slice() else {
            panic!("one version: {versions:?}");
        };
        let CheckpointVersionContent::Copy { hash, .. } = &version.content else {
            panic!("a copy: {version:?}");
        };
        let copies = CopyStore::open(&edits.storage_folder()).expect("the copies open");
        assert_eq!(
            fs::read(copies.copy_path(hash)).expect("the copy reads"),
            b"abc"
        );
    }

    fn an_existing_file(folder: &Path) -> PathBuf {
        let path = folder.join("file");
        fs::write(&path, b"abc").expect("the file is written");
        path
    }

    fn a_relative_path(_folder: &Path) -> PathBuf {
        PathBuf::from("file")
    }

    // Kills a row written against a missing checkpoint, the copies folder made before the read,
    // and a relative path recorded: past the guard, it reaches the copy and writes `created`.
    #[rstest]
    #[case::a_session_with_no_checkpoint(false, an_existing_file)]
    #[case::a_relative_path(true, a_relative_path)]
    #[tokio::test]
    async fn an_edit_that_cannot_be_recorded_writes_nothing(
        #[case] is_checkpointed: bool,
        #[case] edited: fn(&Path) -> PathBuf,
    ) {
        let edits = Edits::new().await;
        if is_checkpointed {
            edits.fixture.record(0, &[]).await;
        }
        let folder = tempfile::tempdir().expect("a folder");
        let path = edited(folder.path());

        edits.keep(&path).await;

        assert_eq!(edits.versions(), Vec::new());
        assert!(
            !edits
                .storage_folder()
                .try_exists()
                .expect("the storage folder is looked for"),
            "no copies folder is made"
        );
    }
}
