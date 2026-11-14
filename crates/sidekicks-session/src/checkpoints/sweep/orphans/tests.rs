use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rusqlite::params;
use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::SnapshotId;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::{VolumeId, file_facts, read_volume, real_path};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use sidekicks_store::data_folder::session_storage_folder;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::statement::{DATABASE_NOW_SQL, WriteStatement};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::checkpoints::command_windows::test_fixture::{Fixture, utf8};
use crate::checkpoints::copies::{COPIES_LOCK, copies_folder};
use crate::checkpoints::schema::{CheckpointVersionContent, CheckpointVersionLeg, CopyMode};
use crate::checkpoints::shadows::large_folder;
use crate::checkpoints::store::shadows::{
    Shadow, ShadowContent, ShadowId, VolumeFolder, insert_current_shadow_statement,
    insert_volume_folder_statement,
};
use crate::checkpoints::store::{
    Checkpoint, CheckpointVersion, insert_checkpoint_statement, insert_version_statement,
};
use crate::checkpoints::sweep::tests::sweep_over;
use crate::checkpoints::sweep::{CheckpointSweep, CheckpointSweepCounts};
use crate::checkpoints::volume_folders::restored_clone_folder;

// Twice the age past which a file no row names is an orphan.
const TWO_HOURS: Duration = Duration::from_hours(2);

// Far past one session's walk, which a walk that waited on a keeper would pass.
const HELD_WALK_BOUND: Duration = Duration::from_secs(10);

// One orphans walk with the sweep's clock at `now`.
async fn walk_at(
    sweep: &CheckpointSweep,
    clock: &TestWallClock,
    now: SystemTime,
) -> CheckpointSweepCounts {
    clock.set_now(now);
    let mut counts = CheckpointSweepCounts::default();
    sweep
        .walk_orphans(
            &CancellationToken::new(),
            &ProcessorMeter::default(),
            &mut counts,
        )
        .await
        .expect("the walk reads");
    counts
}

// A copy's name: 64 lowercase hex digits of `digit`.
fn copy_name(digit: char) -> String {
    digit.to_string().repeat(64)
}

// The edit version of the fixture's checkpoint that names the copy `name`.
fn copy_version(fixture: &Fixture, name: &str) -> WriteStatement {
    let checkout = real_path(&fixture.checkout).expect("the checkout's real path reads");
    insert_version_statement(
        &fixture.checkpoint_id,
        &CheckpointVersion {
            path: fixture.recorded(&format!("{name}.txt")),
            leg: CheckpointVersionLeg::Edit,
            content: CheckpointVersionContent::Copy {
                hash: Sha256Hex::new(name.to_owned()).expect("a copy's hash"),
                mode: CopyMode::Permissions(0o644),
            },
            parent_real_path: FilesystemPath::new(utf8(&checkout).to_owned())
                .expect("a recorded folder"),
            window_id: None,
            tool_call_id: None,
        },
    )
}

// A shadow of the fixture's session whose clone, written into `folder`, a row of `relative` names.
fn cloned_shadow(
    fixture: &Fixture,
    folder: &Path,
    relative: &str,
    volume_id: Option<VolumeId>,
) -> (Shadow, PathBuf) {
    let shadow_id = ShadowId::mint();
    let clone = folder.join(shadow_id.text().as_str());
    fs::write(&clone, "clone").expect("a clone is written");
    let shadow = Shadow {
        shadow_id,
        session_id: fixture.session_id,
        path: fixture.recorded(relative),
        content: ShadowContent::Cloned {
            clone_path: FilesystemPath::new(utf8(&clone).to_owned()).expect("a clone path"),
            volume_id,
        },
        facts: Some(file_facts(&clone).expect("the clone's facts are read")),
        taken_at: jiff::Timestamp::now(),
        time_precision: Duration::from_secs(1),
    };
    (shadow, clone)
}

// A file in `folder` named as an unnamed clone.
fn unnamed_clone(folder: &Path) -> PathBuf {
    let clone = folder.join(ShadowId::mint().text().as_str());
    fs::write(&clone, "orphan").expect("an orphan is written");
    clone
}

// Kills: a named file removed (a named copy or clone goes), the age ignored (the first walk removes
// one), a place not walked (its unnamed file stays), the temporary kept, and a too-young orphan not
// marked (the second walk, which this session's activity does not bring, keeps every orphan).
#[tokio::test]
async fn a_walk_removes_what_no_row_names_an_hour_on_and_keeps_the_rest() {
    let fixture = Fixture::with_repository(&[]).await;
    let owner = session_storage_folder(&fixture.data_folder, &fixture.session_id);
    let volume_root = tempfile::tempdir().expect("the test makes its folder");
    let volume_root = real_path(volume_root.path()).expect("the folder resolves");
    let volume_id = read_volume(&volume_root)
        .expect("the folder's volume reads")
        .id;
    let volume_folder = volume_root.join(fixture.session_id.text().as_str());
    let copies = copies_folder(&owner);
    let large = large_folder(&owner);
    let restored = restored_clone_folder(&fixture.data_folder, &fixture.session_id, &volume_id);
    for folder in [&copies, &large, &volume_folder, &restored] {
        fs::create_dir_all(folder).expect("the folder is made");
    }
    let [named_copy, unnamed_copy, temporary] = [
        copy_name('a'),
        copy_name('b'),
        ".0123456789abcdef.copying".to_owned(),
    ]
    .map(|name| {
        let copy = copies.join(name);
        fs::write(&copy, "copy").expect("a copy is written");
        copy
    });
    let (large_shadow, named_large) = cloned_shadow(&fixture, &large, "large.bin", None);
    let (volume_shadow, named_on_volume) = cloned_shadow(
        &fixture,
        &volume_folder,
        "volume.bin",
        Some(volume_id.clone()),
    );
    let named_restored = restored.join(volume_shadow.shadow_id.text().as_str());
    fs::write(&named_restored, "restored").expect("a restored clone is written");
    let orphans = [
        unnamed_copy,
        temporary,
        unnamed_clone(&large),
        unnamed_clone(&volume_folder),
        unnamed_clone(&restored),
    ];
    let named = [named_copy, named_large, named_on_volume, named_restored];
    fixture
        .log
        .writer
        .write(vec![
            copy_version(&fixture, &copy_name('a')),
            insert_volume_folder_statement(
                fixture.session_id,
                &VolumeFolder {
                    volume_id,
                    folder: FilesystemPath::new(utf8(&volume_folder).to_owned())
                        .expect("a recorded folder"),
                },
            ),
            insert_current_shadow_statement(&large_shadow),
            insert_current_shadow_statement(&volume_shadow),
        ])
        .await
        .expect("the rows are written");
    let (sweep, clock) = sweep_over(&fixture);

    let now = walk_at(&sweep, &clock, SystemTime::now()).await;

    assert_eq!(now.entries_removed, 0);
    for file in orphans.iter().chain(&named) {
        assert!(file.exists(), "{} stays within the hour", file.display());
    }
    assert!(
        lock(&sweep.orphan_walks.memory)
            .walk_again
            .contains(&fixture.session_id),
        "a session with a young orphan is walked again"
    );

    let later = walk_at(&sweep, &clock, SystemTime::now() + TWO_HOURS).await;

    for orphan in &orphans {
        assert!(!orphan.exists(), "{} goes an hour on", orphan.display());
    }
    for file in &named {
        assert!(file.exists(), "{} a row names stays", file.display());
    }
    assert_eq!(
        (later.sessions_walked, later.entries_removed),
        (1, 5),
        "the five orphans go"
    );
}

// Kills: the walk waiting behind a keeper of the session's copies lock, which queues every edit
// behind it, and the walk removing a copy while a keeper holds that lock, before its row is
// written; the session is walked again instead.
#[tokio::test]
async fn a_walk_leaves_a_session_a_keeper_holds_for_its_next_walk() {
    let fixture = Fixture::with_repository(&[]).await;
    let copies = copies_folder(&session_storage_folder(
        &fixture.data_folder,
        &fixture.session_id,
    ));
    fs::create_dir_all(&copies).expect("the copies folder is made");
    let copy = copies.join(copy_name('c'));
    fs::write(&copy, "copy").expect("the copy is written");
    let (sweep, clock) = sweep_over(&fixture);
    clock.set_now(SystemTime::now() + TWO_HOURS);
    let session_id = fixture.session_id;
    let keeper = COPIES_LOCK.read(session_id).await;
    let mut counts = CheckpointSweepCounts::default();
    let (stop, meter) = (CancellationToken::new(), ProcessorMeter::default());

    let walked = timeout(
        HELD_WALK_BOUND,
        sweep.walk_orphans(&stop, &meter, &mut counts),
    )
    .await
    .expect("the walk waits for no keeper");
    drop(keeper);

    walked.expect("the walk reads");
    assert!(copy.exists(), "the copy a keeper may name stays");
    assert_eq!(counts.sessions_walked, 1);
    assert!(
        lock(&sweep.orphan_walks.memory)
            .walk_again
            .contains(&session_id),
        "the held session is walked again"
    );
}

// Kills: every session walked each time (the second walk takes three), and the sessions active
// since the walk before not taken (the second walk takes only the marked one).
#[tokio::test]
async fn a_later_walk_takes_the_sessions_active_since_and_those_marked() {
    let fixture = Fixture::with_repository(&[]).await;
    let reader = fixture.database.reader();
    let [idle, active] = [(); 2].map(|()| SessionId::try_from(mint_uuid_v7()).expect("a session"));
    for session_id in [idle, active] {
        insert_session_row(&reader, session_id.text().as_str(), None, None);
        fixture
            .log
            .writer
            .write(vec![insert_checkpoint_statement(&Checkpoint {
                checkpoint_id: SnapshotId::new(mint_uuid_v7().to_string()).expect("a snapshot"),
                session_id,
                message_sequence: SafeInt::ZERO,
                run_id: RunId::try_from(mint_uuid_v7()).expect("a run id"),
                turn_number: SafeInt::new(1).expect("a turn number"),
                turn: EpochPosition {
                    epoch: SourceEpoch(SafeInt::ZERO),
                    position: SourcePosition(SafeInt::ZERO),
                },
            })])
            .await
            .expect("the checkpoint is written");
    }
    // The fixture's session is marked by a copy too young to go.
    let copies = copies_folder(&session_storage_folder(
        &fixture.data_folder,
        &fixture.session_id,
    ));
    fs::create_dir_all(&copies).expect("the copies folder is made");
    fs::write(copies.join(copy_name('d')), "young").expect("the copy is written");
    let (sweep, clock) = sweep_over(&fixture);
    let first = walk_at(&sweep, &clock, SystemTime::now()).await;
    reader
        .execute(
            &format!("UPDATE sessions SET last_activity_at = {DATABASE_NOW_SQL} WHERE id = ?1"),
            params![active.text().as_str()],
        )
        .expect("the session's activity is set");

    let second = walk_at(&sweep, &clock, SystemTime::now()).await;

    assert_eq!((first.sessions_walked, second.sessions_walked), (3, 2));
}
