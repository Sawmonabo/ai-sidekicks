//! The crash report pass over dumps a crashing child leaves, and over what failed writes left.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use rstest::rstest;
use sidekicks_contracts::machine::settings::MachineSettingsChange;
use tokio_util::sync::CancellationToken;

use super::{
    CrashReportDeps, REPORT_KEY_FILE_NAME, REPORT_KEY_LENGTH, build_crash_reports, make_key,
    read_crash_reports,
};
use crate::daemon::crash::monitor::{
    CRASH_DUMPS_FOLDER_NAME, DUMP_EXTENSION, DUMP_IN_PROGRESS_SUFFIX, PANIC_RECORD_SUFFIX,
    attach_crash_handler, connect_crash_monitor, crash_monitor_socket_path, serve_crash_monitor,
};
use crate::daemon::machine::settings::file::MachineSettingsFile;
use crate::daemon::panic_hook::{install_panic_hook, send_panics_to_monitor};
use crate::daemon::scheduler::budget::ProcessorMeter;
use crate::daemon::service_log::CRASH_REPORTS_FOLDER_NAME;

// The child's crash, its monitor's socket and its data folder, passed to the child.
const CHILD_CRASH: &str = "SIDEKICKS_TEST_CRASH";
const CHILD_SOCKET: &str = "SIDEKICKS_TEST_CRASH_SOCKET";
const CHILD_DATA_FOLDER: &str = "SIDEKICKS_TEST_CRASH_DATA_FOLDER";

// A secret the child holds in memory, so its dump carries it, and the session id, folder and
// credentials its panic names.
const PLANTED_TOKEN: &str = "planted-secret-held-in-the-crashing-stack";
const SESSION_ID: &str = "0199f3a1-7c2e-7b44-9a51-3f0e6d2c8b17";
const PRIVATE_FOLDER: &str = "/Users/someone/private project/src";
const PLANTED_API_KEY: &str = "sk-plantedkey0123456789";
const PLANTED_BEARER_TOKEN: &str = "x.y.z";

// Runs as the crashing child: connects to the monitor, attaches the crash handler and crashes
// as asked, a panic through the service's own hook or a bad read.
#[expect(
    unsafe_code,
    reason = "the child reads a bad address to crash on purpose"
)]
fn crash_as_the_child(crash: &str) -> ! {
    let socket = PathBuf::from(std::env::var_os(CHILD_SOCKET).expect("the socket is passed"));
    let data_folder =
        PathBuf::from(std::env::var_os(CHILD_DATA_FOLDER).expect("the folder is passed"));
    // On the crashing thread's stack, which the dump holds.
    let mut held = [0_u8; PLANTED_TOKEN.len()];
    held.copy_from_slice(PLANTED_TOKEN.as_bytes());
    std::hint::black_box(&mut held);
    let client = Arc::new(connect_crash_monitor(&socket).expect("the monitor answers"));
    let _handler = attach_crash_handler(Arc::clone(&client)).expect("the handler attaches");
    if crash == "panic" {
        install_panic_hook(&data_folder, None);
        send_panics_to_monitor(client);
        panic!(
            "session {SESSION_ID} failed reading {PRIVATE_FOLDER}/main.rs:12:5 with key \
             {PLANTED_API_KEY} and Authorization: Bearer {PLANTED_BEARER_TOKEN} ({})",
            std::hint::black_box(&held).len()
        );
    }
    // SAFETY: none holds; the read of a bad address crashes the child, which is the point.
    let crashed = unsafe { std::ptr::without_provenance::<u64>(8).read_volatile() };
    unreachable!(
        "the bad read crashed the child before it read {crashed} past {}",
        std::hint::black_box(&held).len()
    );
}

// Serves a monitor and runs this test's binary as a child that crashes as `crash`, then waits
// for the monitor to write its dump.
fn crash_a_child(crash: &str, data_folder: &Path) {
    // A folder per child: the in-process monitor's port name lives as long as this process.
    let run_folder = data_folder.join(crash);
    fs::create_dir_all(&run_folder).expect("the run folder is made");
    let socket = crash_monitor_socket_path(&run_folder, std::process::id());
    let dumps = data_folder.join(CRASH_DUMPS_FOLDER_NAME);
    let monitor_socket = socket.clone();
    let monitor = std::thread::spawn(move || serve_crash_monitor(&monitor_socket, &dumps));
    let test_path = module_path!()
        .split_once("::")
        .map(|(_crate, path)| path)
        .expect("the module path names its crate");
    let status = Command::new(std::env::current_exe().expect("the test knows its binary"))
        .args([
            "--exact",
            &format!("{test_path}::crashes_become_stripped_reports_and_none_while_off"),
            "--nocapture",
        ])
        .env(CHILD_CRASH, crash)
        .env(CHILD_SOCKET, &socket)
        .env(CHILD_DATA_FOLDER, data_folder)
        .status()
        .expect("the child runs");
    assert!(!status.success(), "the child crashed");
    monitor
        .join()
        .expect("the monitor's thread ends")
        .expect("the monitor served its child");
}

// A panic and a bad read in a child each leave one report of module file names and offsets;
// the panic's report names its file and not its folder, holds the session id only as its
// keyed hash and holds neither credential its message named, nor does either of the panic's
// raw records, the hook's and the one the monitor writes beside the dump;
// no report holds the secret the child's dump does; each dump is deleted once built. While
// `Keep crash reports` is off, no report is built and every dump, report and panic record
// goes. Killed by a path kept whole or cut at a space, by an unkeyed or raw id, by the
// credential scrub dropped from the report or either raw record, by a dump left behind, by the
// monitor not writing, by the switch not read, and by the raw record kept while it is off.
#[tokio::test]
async fn crashes_become_stripped_reports_and_none_while_off() {
    if let Ok(crash) = std::env::var(CHILD_CRASH) {
        crash_as_the_child(&crash);
    }
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let data_folder = scratch.path().join("data");
    fs::create_dir_all(&data_folder).expect("the data folder is made");
    crash_a_child("panic", &data_folder);
    crash_a_child("bad-read", &data_folder);
    let dumps = data_folder.join(CRASH_DUMPS_FOLDER_NAME);
    let dump_bytes: Vec<u8> = fs::read_dir(&dumps)
        .expect("the dumps list")
        .flat_map(|entry| fs::read(entry.expect("an entry").path()).unwrap_or_default())
        .collect();
    assert!(
        dump_bytes
            .windows(PLANTED_TOKEN.len())
            .any(|window| window == PLANTED_TOKEN.as_bytes()),
        "a dump holds the planted secret"
    );
    let monitor_records: Vec<String> = fs::read_dir(&dumps)
        .expect("the dumps list")
        .map(|entry| entry.expect("an entry").path())
        .filter(|path| path.to_string_lossy().ends_with(PANIC_RECORD_SUFFIX))
        .map(|path| fs::read_to_string(path).expect("the monitor's record reads"))
        .collect();
    assert_eq!(
        monitor_records.len(),
        1,
        "the monitor wrote the panic's record"
    );
    assert!(
        monitor_records[0].contains(SESSION_ID),
        "the monitor's record is the unstripped one"
    );
    assert!(!monitor_records[0].contains(PLANTED_API_KEY));
    assert!(!monitor_records[0].contains(PLANTED_BEARER_TOKEN));
    let settings = Arc::new(MachineSettingsFile::new(
        data_folder.join("machine-settings.json"),
    ));
    let deps = CrashReportDeps {
        data_folder: data_folder.clone(),
        settings: Arc::clone(&settings),
        app_version: "0.1.0".to_owned(),
        service_version: "0.1.0".to_owned(),
    };
    let stop = CancellationToken::new();
    let meter = ProcessorMeter::default();

    let pass = build_crash_reports(&deps, &stop, &meter)
        .await
        .expect("the pass runs");

    assert_eq!((pass.built, pass.failed), (2, 0));
    assert!(pass.dump_bytes > 0);
    assert_eq!(fs::read_dir(&dumps).expect("the dumps list").count(), 0);
    let reports = read_crash_reports(&data_folder).expect("the reports read");
    assert_eq!(reports.len(), 2);
    let report_text = serde_json::to_string(&reports).expect("the reports serialize");
    assert!(!report_text.contains(PLANTED_TOKEN));
    assert!(!report_text.contains("/Users/someone"));
    assert!(!report_text.contains("project"));
    assert!(!report_text.contains(SESSION_ID));
    assert!(!report_text.contains(PLANTED_API_KEY));
    assert!(!report_text.contains(PLANTED_BEARER_TOKEN));
    let raw_records = panic_records(&data_folder);
    assert_eq!(raw_records.len(), 1, "the panic's hook wrote its record");
    let raw_record = fs::read_to_string(&raw_records[0]).expect("the record reads");
    assert!(
        raw_record.contains(SESSION_ID),
        "the raw record is the unstripped one"
    );
    assert!(!raw_record.contains(PLANTED_API_KEY));
    assert!(!raw_record.contains(PLANTED_BEARER_TOKEN));
    for report in &reports {
        assert!(!report.stack.as_ref().is_empty(), "each report has a stack");
    }
    let panic = reports
        .iter()
        .find_map(|report| report.panic.as_ref())
        .expect("the panic's report carries it");
    let key = fs::read(data_folder.join(REPORT_KEY_FILE_NAME)).expect("the key reads");
    let key: [u8; 32] = key.try_into().expect("the key is 32 bytes");
    let hashed = blake3::keyed_hash(&key, SESSION_ID.as_bytes()).to_hex();
    assert!(
        panic
            .message
            .as_ref()
            .contains(&format!("id-{}", &hashed[..32]))
    );
    assert!(panic.message.as_ref().contains("main.rs:12:5"));
    assert!(panic.location.as_ref().starts_with("tests.rs:"));
    assert_eq!(
        reports
            .iter()
            .filter(|report| report.panic.is_some())
            .count(),
        1
    );

    settings
        .update(MachineSettingsChange::KeepCrashReports(false))
        .await
        .expect("the switch is turned off");
    fs::write(dumps.join("late.dmp"), b"a dump").expect("written");
    let pass = build_crash_reports(&deps, &stop, &meter)
        .await
        .expect("the pass runs");

    assert_eq!((pass.built, pass.failed), (0, 0));
    assert!(!dumps.join("late.dmp").exists());
    assert_eq!(panic_records(&data_folder), Vec::<PathBuf>::new());
    assert_eq!(
        read_crash_reports(&data_folder).expect("the reports read"),
        Vec::new()
    );
}

// What a failed write of the monitor left, a partial dump and a panic record whose dump is not
// there, and a key's temporary file a process ended mid-write left, are deleted by a pass
// whether reports are kept or not; a partial dump a monitor holds locked, and the panic record
// written beside it, stay. A leftover that cannot be removed, a folder in a partial dump's
// place, is answered beside the pass, which still deletes the finished dump. Killed by a pass
// that reads only finished dumps, by a key's temporary file kept, by a sweep left out of
// either branch, by a held dump or its record taken for a leftover, and by a removal failure
// that stops the pass or goes unanswered.
#[rstest]
#[case::reports_kept(true)]
#[case::reports_off(false)]
#[tokio::test]
async fn a_pass_deletes_what_a_failed_dump_left(#[case] is_kept: bool) {
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let data_folder = scratch.path().to_path_buf();
    let dumps = data_folder.join(CRASH_DUMPS_FOLDER_NAME);
    fs::create_dir_all(&dumps).expect("the dumps folder is made");
    let partial =
        |stem: &str| dumps.join(format!("{stem}.{DUMP_EXTENSION}{DUMP_IN_PROGRESS_SUFFIX}"));
    let record = |stem: &str| dumps.join(format!("{stem}{PANIC_RECORD_SUFFIX}"));
    fs::write(partial("left"), b"part of a dump").expect("written");
    fs::write(record("orphan"), b"{}").expect("written");
    let held = fs::File::create(partial("held")).expect("the held dump is made");
    held.lock()
        .expect("the test holds the dump as a writing monitor does");
    fs::write(record("held"), b"{}").expect("written");
    fs::create_dir_all(partial("stuck").join("inside")).expect("the stuck folder is made");
    fs::write(dumps.join(format!("late.{DUMP_EXTENSION}")), b"a dump").expect("written");
    let key_leftover = data_folder.join(format!("{REPORT_KEY_FILE_NAME}.a1b2c3.tmp"));
    fs::write(&key_leftover, b"part of a key").expect("written");
    let settings = Arc::new(MachineSettingsFile::new(
        data_folder.join("machine-settings.json"),
    ));
    settings
        .update(MachineSettingsChange::KeepCrashReports(is_kept))
        .await
        .expect("the switch is set");
    let deps = CrashReportDeps {
        data_folder,
        settings,
        app_version: "0.1.0".to_owned(),
        service_version: "0.1.0".to_owned(),
    };

    let pass = build_crash_reports(&deps, &CancellationToken::new(), &ProcessorMeter::default())
        .await
        .expect("the pass runs");

    let mut left: Vec<_> = fs::read_dir(&dumps)
        .expect("the dumps list")
        .map(|entry| entry.expect("an entry").path())
        .collect();
    left.sort();
    let mut kept = [partial("held"), record("held"), partial("stuck")];
    kept.sort();
    assert_eq!(left, kept);
    assert!(!key_leftover.exists());
    let failures = pass
        .leftover_failures
        .expect("the stuck folder's removal is answered");
    assert!(
        failures.cleanup_failures().is_empty(),
        "one removal failed, not {failures}"
    );
    drop(held);
}

// A key another pass made first stands, and the pass answers it in place of its own, leaving
// no temporary file. Killed by replacing a key that stands, and by answering the pass's own.
#[test]
fn a_key_another_pass_made_first_stands() {
    let data_folder = tempfile::tempdir().expect("the test makes a temporary folder");
    let key_path = data_folder.path().join(REPORT_KEY_FILE_NAME);
    let standing = [1; REPORT_KEY_LENGTH];
    fs::write(&key_path, standing).expect("the standing key is written");

    let made = make_key(data_folder.path(), [2; REPORT_KEY_LENGTH]).expect("the key reads");

    assert_eq!(made, standing);
    let names: Vec<_> = fs::read_dir(data_folder.path())
        .expect("the data folder lists")
        .map(|entry| entry.expect("an entry").file_name())
        .collect();
    assert_eq!(names, [REPORT_KEY_FILE_NAME]);
    assert_eq!(fs::read(&key_path).expect("the key reads"), standing);
}

// The panic records the hook wrote into the crash reports folder.
fn panic_records(data_folder: &Path) -> Vec<PathBuf> {
    let folder = data_folder.join(CRASH_REPORTS_FOLDER_NAME);
    fs::read_dir(folder)
        .expect("the reports folder lists")
        .map(|entry| entry.expect("an entry").path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "txt"))
        .collect()
}
