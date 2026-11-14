use std::fs;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr as _;

use rstest::rstest;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::VolumeId;
use sidekicks_session::checkpoints::store::shadows::VolumeFolder;
use sidekicks_session::checkpoints::volume_folders::{VolumeFolderState, restored_clone_folder};
use sidekicks_store::backup_mirror::MirrorRoot;
use sidekicks_store::data_folder::data_folder;

use super::{volume_clone_root, workflow_capture_roots};

const SESSION: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e";

// Where a test's volume folder lies, outside the home folder.
const VOLUME_FOLDER: &str = "/Volumes/Other/.sidekicks/0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e";

// Where a run takes a root's copy from.
#[derive(Clone, Copy, Debug)]
enum ExpectedSource {
    VolumeFolder,
    Place,
    KeptAsIs,
}

fn volume_folder(volume_id: &str) -> VolumeFolder {
    VolumeFolder {
        volume_id: VolumeId::from_str(volume_id).expect("a volume id"),
        folder: FilesystemPath::new(VOLUME_FOLDER.to_owned()).expect("a folder"),
    }
}

// Each row of the table of where a run copies a clone root from: the volume folder while it is
// there, the restored copy where the volume folder is not and a restored copy is, and nowhere
// otherwise or when the read failed. Killed by an absent volume's copy emptied, by a restored copy
// passed over, and by a present volume folder passed over.
#[rstest]
#[case::present_folder(Some(VolumeFolderState::Mounted { is_present: true }), false, ExpectedSource::VolumeFolder)]
#[case::present_folder_and_restored(Some(VolumeFolderState::Mounted { is_present: true }), true, ExpectedSource::VolumeFolder)]
#[case::missing_folder_and_restored(Some(VolumeFolderState::Mounted { is_present: false }), true, ExpectedSource::Place)]
#[case::absent_volume_and_restored(Some(VolumeFolderState::Absent), true, ExpectedSource::Place)]
#[case::missing_folder(Some(VolumeFolderState::Mounted { is_present: false }), false, ExpectedSource::KeptAsIs)]
#[case::absent_volume(Some(VolumeFolderState::Absent), false, ExpectedSource::KeptAsIs)]
#[case::failed_read_and_restored(None, true, ExpectedSource::KeptAsIs)]
#[case::failed_read(None, false, ExpectedSource::KeptAsIs)]
fn a_clone_root_is_copied_from_where_its_clones_are(
    #[case] state: Option<VolumeFolderState>,
    #[case] is_restored_present: bool,
    #[case] expected: ExpectedSource,
) {
    let home = Path::new("/home/person");
    let data_folder = home.join(".sidekicks");
    let session_id = SessionId::new(SESSION).expect("a session id");
    let volume_folder = volume_folder("disk-volume");

    let root = volume_clone_root(
        home,
        &data_folder,
        &session_id,
        &volume_folder,
        state,
        is_restored_present,
    )
    .expect("the root is under the home folder");

    let place = restored_clone_folder(&data_folder, &session_id, &volume_folder.volume_id);
    let listed = MirrorRoot::under_home(root.name().to_owned(), home, &place).expect("a root");
    let expected_root = match expected {
        ExpectedSource::VolumeFolder => listed.copied_from(PathBuf::from(VOLUME_FOLDER)),
        ExpectedSource::Place => listed,
        ExpectedSource::KeptAsIs => listed.kept_as_is(),
    };
    assert_eq!(root, expected_root);
}

// A volume id holding spaces and separators, as Linux's and Windows' do, is spelled into neither
// the root's name nor its place, so the root is one plain name under the home folder that a
// restore reads back. Killed by the volume id spelled into the name or the place.
#[rstest]
#[case::linux("/dev/sdb1 / ext4")]
#[case::windows(r"\\?\Volume{0a1b2c3d-0000-0000-0000-000000000000}\")]
fn a_clone_root_is_one_plain_name_under_the_home_folder(#[case] volume_id: &str) {
    let home = Path::new("/home/person");
    let data_folder = home.join(".sidekicks");
    let session_id = SessionId::new(SESSION).expect("a session id");
    let volume_folder = volume_folder(volume_id);

    let root = volume_clone_root(
        home,
        &data_folder,
        &session_id,
        &volume_folder,
        Some(VolumeFolderState::Mounted { is_present: true }),
        false,
    )
    .expect("the root is under the home folder");

    assert!(
        root.name()
            .starts_with(&format!("restored-clones-{SESSION}-"))
    );
    assert!(!root.name().contains(['/', '\\', ' ']));
    assert!(matches!(
        Path::new(root.name())
            .components()
            .collect::<Vec<_>>()
            .as_slice(),
        [Component::Normal(_)]
    ));
    let place = root.place(home);
    assert_eq!(
        place,
        restored_clone_folder(&data_folder, &session_id, &volume_folder.volume_id)
    );
    assert!(place.starts_with(data_folder));
    let listed = serde_json::to_value(&root).expect("the root serializes");
    let read_back: MirrorRoot = serde_json::from_value(listed).expect("a restore reads the root");
    assert_eq!(read_back.place(home), place);
}

// A data folder holding a run with a capture folder, a run with only a working file, and a
// version's package gives one root, over the first run's captures folder alone. Killed by the
// workflow roots left out (no root), by a root over the run's folder or the workflows' folder (its
// place), and by a run with no captures folder given a root (two roots).
#[test]
fn the_roots_hold_each_workflow_runs_capture_folder_and_nothing_else_of_it() {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let home = scratch.path();
    let data_folder = data_folder(home);
    let workflow = data_folder.join("workflows/d");
    let capture_folder = workflow.join("runs/r1/captures").join("a".repeat(64));
    fs::create_dir_all(&capture_folder).expect("the capture folder is made");
    fs::write(capture_folder.join("HEAD"), "ref: refs/heads/main\n").expect("written");
    fs::create_dir_all(workflow.join("runs/r2")).expect("the second run's folder is made");
    fs::write(workflow.join("runs/r2/notes.md"), "working\n").expect("written");
    let step = workflow.join("versions/v/steps/s");
    fs::create_dir_all(&step).expect("the step's folder is made");
    fs::write(step.join("package.json"), "{}\n").expect("written");

    let roots = workflow_capture_roots(home, &data_folder).expect("the roots are listed");

    let expected = MirrorRoot::under_home(
        "workflow-captures-d-r1".to_owned(),
        home,
        &workflow.join("runs/r1/captures"),
    )
    .expect("a root");
    assert_eq!(roots, [expected]);
}
