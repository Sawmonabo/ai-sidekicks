use std::time::Duration;

use sidekicks_platforms::Spawner;
use tokio::io::AsyncReadExt as _;
use tokio::net::UnixListener;

use super::retire_former_service;
use crate::provider::driver::codex::service::process::{
    CodexProcessLaunch, repin_lasting_codex_service, start_lasting_codex_service,
};
use crate::provider::driver::codex::service::record::LastingServiceRecordFile;

/// The survivor's stand-in: this test program, which holds a connection to the test's socket open
/// while it runs, so its end closes it.
const SURVIVOR_STAND_IN: &str =
    "provider::driver::codex::service::supervisor::start::tests::a_survivor_that_waits";

/// Where the survivor connects, passed in its environment.
const SURVIVOR_SOCKET_NAME: &str = "SIDEKICKS_SURVIVOR_SOCKET";

/// How long the test waits on the survivor's start and on its end.
const SURVIVOR_WAIT: Duration = Duration::from_secs(10);

#[test]
#[ignore = "run only as the retire test's survivor"]
fn a_survivor_that_waits() {
    let socket = std::env::var(SURVIVOR_SOCKET_NAME).expect("the survivor is named its socket");
    let _connection =
        std::os::unix::net::UnixStream::connect(socket).expect("the survivor reaches the test");
    std::thread::sleep(Duration::from_secs(60));
}

// Fails when a former service whose record no longer pins it is let go without ending the tree
// it left, here a helper that outlived its root, or with its record still kept.
#[tokio::test(flavor = "multi_thread")]
async fn a_former_service_its_record_no_longer_pins_leaves_no_tree_running() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let socket = folder.path().join("survivor.sock");
    let listener = UnixListener::bind(&socket).expect("the test's socket listens");
    let program = std::env::current_exe().expect("the test program names itself");
    let launch = CodexProcessLaunch {
        program: "/bin/sh".into(),
        arguments: vec![
            "-c".to_owned(),
            format!("\"$0\" --exact {SURVIVOR_STAND_IN} --include-ignored >/dev/null 2>&1 &"),
            program.display().to_string(),
        ],
        environment: vec![(
            SURVIVOR_SOCKET_NAME.to_owned(),
            socket.display().to_string(),
        )],
        working_folder: folder.path().to_owned(),
    };
    let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
    let service = start_lasting_codex_service(&spawner, launch, &folder.path().join("codex.log"))
        .await
        .expect("the root starts");
    let (mut survivor, _address) = tokio::time::timeout(SURVIVOR_WAIT, listener.accept())
        .await
        .expect("the survivor starts in time")
        .expect("the survivor connects");
    service
        .exited()
        .expect("the root is this test's child")
        .await
        .expect("the root's exit reads");
    let record = service.record().clone();
    let record_file = LastingServiceRecordFile::of_home(folder.path(), folder.path())
        .expect("the record file is named");
    let locked = record_file.lock().expect("the record is locked");
    locked.write(&record).expect("the record is written");
    let is_pinned = repin_lasting_codex_service(record.clone())
        .expect("the record re-pins")
        .is_some();

    let retired = retire_former_service(&locked, record).await;
    let mut rest = Vec::new();
    let survivor_end = tokio::time::timeout(SURVIVOR_WAIT, survivor.read_to_end(&mut rest)).await;
    let kept = locked.read().expect("the record reads");

    assert!(!is_pinned);
    assert!(retired.is_ok());
    assert!(
        matches!(survivor_end, Ok(Ok(0))),
        "the survivor still runs: {survivor_end:?}"
    );
    assert_eq!(kept, None);
}
