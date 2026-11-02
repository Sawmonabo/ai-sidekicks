//! The checkpoint store's tests: the version an undo puts back per path, a version kept without a
//! copy named as such, an undo's outcome saved once under its key, and a checkpoint refused for a
//! run with no row.

use rusqlite::ffi;
use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::{
    SessionRestoreFileOutcome, SessionRestoreOutcome, SessionRestoreScope,
    SessionRestoreSkipReason, SessionRestoredScope, SnapshotId,
};
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};

use super::{
    Checkpoint, CheckpointVersion, insert_checkpoint_statement, insert_restore_statement,
    insert_version_statement, read_restore, versions_after,
};
use crate::checkpoints::schema::{CheckpointVersionContent, CheckpointVersionLeg, schema_parts};
use crate::run::engine::test_fixture::insert_running_run;

/// A database on the checkpoint schema holding one running run, and the writer every write of the
/// test goes through, which holds the schema's references.
struct Fixture {
    database: TestDatabase,
    writer: DatabaseWriter,
    session_id: SessionId,
    run_id: RunId,
}

impl Fixture {
    async fn new() -> Self {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&database, session_id, run_id);
        Self {
            database,
            writer,
            session_id,
            run_id,
        }
    }

    /// A checkpoint of the fixture's run before the prompt at `message_sequence`.
    fn checkpoint(&self, message_sequence: u64) -> Checkpoint {
        Checkpoint {
            checkpoint_id: SnapshotId::new(mint_uuid_v7().to_string()).expect("a snapshot id"),
            session_id: self.session_id,
            message_sequence: sequence(message_sequence),
            run_id: self.run_id,
            turn: EpochPosition {
                epoch: SourceEpoch(SafeInt::ZERO),
                position: SourcePosition(sequence(message_sequence)),
            },
            head: None,
            tree: None,
        }
    }

    /// Writes a checkpoint before the prompt at `message_sequence` holding `versions`, in order,
    /// and returns its id.
    async fn record(&self, message_sequence: u64, versions: &[CheckpointVersion]) -> SnapshotId {
        let checkpoint = self.checkpoint(message_sequence);
        let mut statements = vec![insert_checkpoint_statement(&checkpoint)];
        statements.extend(
            versions
                .iter()
                .map(|version| insert_version_statement(&checkpoint.checkpoint_id, version)),
        );
        self.writer
            .write(statements)
            .await
            .expect("the checkpoint is written");
        checkpoint.checkpoint_id
    }
}

fn sequence(value: u64) -> SafeInt<0> {
    SafeInt::new(value).expect("a test sequence is a safe integer")
}

/// An edit's version of `path` with `content`.
fn version(path: &str, content: CheckpointVersionContent) -> CheckpointVersion {
    CheckpointVersion {
        path: FilesystemPath::new(path.to_owned()).expect("a test path"),
        leg: CheckpointVersionLeg::Edit,
        content,
        parent_real_path: FilesystemPath::new("/repo".to_owned()).expect("a test path"),
        window_id: None,
        volume_id: None,
    }
}

/// A copy whose hash is `digit` repeated.
fn copy(digit: char) -> CheckpointVersionContent {
    CheckpointVersionContent::Copy {
        hash: Sha256Hex::new(digit.to_string().repeat(64)).expect("a test hash"),
    }
}

/// The SQLite extended code a write SQLite failed at a statement carries.
fn extended_code(error: &WriteError) -> Option<i32> {
    error
        .failed_statement()
        .and_then(|(_, failure)| failure.sqlite_error())
        .map(|failure| failure.extended_code)
}

#[tokio::test]
async fn an_undo_puts_back_the_earliest_version_after_the_point() {
    let fixture = Fixture::new().await;
    fixture
        .record(2, &[version("/repo/a.txt", copy('a'))])
        .await;
    let second = fixture
        .record(6, &[version("/repo/a.txt", copy('b'))])
        .await;
    fixture
        .record(10, &[version("/repo/a.txt", copy('c'))])
        .await;
    let reader = fixture.database.reader();

    // A point inside the first prompt's turn, and a point just before the second prompt.
    for before_sequence in [3, 6] {
        let versions = versions_after(&reader, fixture.session_id, sequence(before_sequence))
            .expect("the versions read");
        assert_eq!(versions.len(), 1, "one version per path");
        assert_eq!(versions[0].checkpoint_id, second);
        assert_eq!(versions[0].version.content, copy('b'));
    }
}

#[tokio::test]
async fn a_version_kept_without_a_copy_comes_back_with_its_skip() {
    let fixture = Fixture::new().await;
    let not_kept = CheckpointVersionContent::NotKept {
        reason: SessionRestoreSkipReason::TooLarge,
    };
    fixture
        .record(
            2,
            &[
                version("/repo/big.bin", not_kept.clone()),
                version("/repo/new.txt", CheckpointVersionContent::Created),
            ],
        )
        .await;

    let versions = versions_after(&fixture.database.reader(), fixture.session_id, sequence(0))
        .expect("the versions read");
    let contents: Vec<_> = versions
        .iter()
        .map(|stored| (stored.version.path.as_str(), &stored.version.content))
        .collect();
    assert_eq!(
        contents,
        [
            ("/repo/big.bin", &not_kept),
            ("/repo/new.txt", &CheckpointVersionContent::Created),
        ]
    );
}

#[tokio::test]
async fn an_undo_outcome_is_saved_once_under_its_key() {
    let fixture = Fixture::new().await;
    let key = ClientUuid::new(mint_uuid_v7().to_string()).expect("a client key");
    let first = SessionRestoreOutcome::RestoreFinished {
        requested: SessionRestoreScope::Files,
        restored: SessionRestoredScope::Files,
        files: Some(SessionRestoreFileOutcome {
            restored_file_count: sequence(2),
            restored_line_count: sequence(14),
            skipped: Vec::new(),
        }),
        failures: None,
    };
    let second = SessionRestoreOutcome::RestoreFinished {
        requested: SessionRestoreScope::Conversation,
        restored: SessionRestoredScope::Conversation,
        files: None,
        failures: None,
    };
    fixture
        .writer
        .write(vec![insert_restore_statement(
            &key,
            fixture.session_id,
            &first,
        )])
        .await
        .expect("the first outcome is saved");

    let refusal = fixture
        .writer
        .write(vec![insert_restore_statement(
            &key,
            fixture.session_id,
            &second,
        )])
        .await
        .expect_err("a second outcome under the key is refused");
    assert_eq!(
        extended_code(&refusal),
        Some(ffi::SQLITE_CONSTRAINT_PRIMARYKEY)
    );
    assert_eq!(
        read_restore(&fixture.database.reader(), &key).expect("the outcome reads"),
        Some(first)
    );
}

#[tokio::test]
async fn a_checkpoint_of_an_unknown_run_is_refused() {
    let fixture = Fixture::new().await;
    let mut checkpoint = fixture.checkpoint(2);
    checkpoint.run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");

    let refusal = fixture
        .writer
        .write(vec![insert_checkpoint_statement(&checkpoint)])
        .await
        .expect_err("a checkpoint of a run with no row is refused");
    assert_eq!(
        extended_code(&refusal),
        Some(ffi::SQLITE_CONSTRAINT_FOREIGNKEY)
    );
}
