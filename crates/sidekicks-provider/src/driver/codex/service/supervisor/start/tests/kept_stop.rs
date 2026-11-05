//! The stop of the lasting services the records keep: the erase's, and the daemon's, which leaves
//! a live service's record, a launch's and a join's under way among them, to its supervisor.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use interprocess::local_socket::traits::tokio::Listener as _;
use sidekicks_platforms::{
    CAN_LINK_A_SOCKET, CAN_SIGNAL_A_STOP, LeftoverSweep, POSIX_SHELL, ProcessRecord,
    create_file_atomically, pin_child_process, read_socket_link, replace_socket_link,
    shell_line_command,
};
use tokio::io::AsyncReadExt as _;
use tokio::time::{Instant, timeout};
use tokio_util::sync::CancellationToken;

use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::process::repin_lasting_codex_service;
use crate::driver::codex::service::record::{LastingServiceRecord, LastingServiceRecordFile};
use crate::driver::codex::service::supervisor::own_record::socket_record_file;
use crate::driver::codex::service::supervisor::start::kept_records::{
    KeptServicesStop, lock_record, stop_kept_services,
};
use crate::driver::codex::service::supervisor::start::terminal::join_former_service;
use crate::driver::codex::service::supervisor::start::{
    compose_launch, launch_lasting_service, name_lasting_log_file,
};
use crate::driver::codex::service::supervisor::test_service::{
    STAND_IN_CODEX, TestCodexProgram, UnheardEvents, bind_test_listener,
    test_codex_service_dependencies, write_failing_codex,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};

// Fails when the erase's end of a recorded service that is gone leaves the home's link naming the
// socket the service really listened on, so a plain `codex` meets a link to a dead socket.
#[tokio::test]
async fn an_erase_takes_the_home_link_off_a_gone_service_s_socket() {
    if !CAN_LINK_A_SOCKET {
        return;
    }
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let home_socket = folder.path().join("home.sock");
    let physical_socket = folder.path().join("own.sock");
    replace_socket_link(&home_socket, &physical_socket).expect("the home's link is made");
    // This test's own process with another start mark, as a record whose process ended reads.
    let own = pin_child_process(std::process::id())
        .expect("this process pins")
        .record()
        .expect("the record reads")
        .expect("this process runs");
    let mut gone = serde_json::to_value(own).expect("a process record writes as JSON");
    gone["start"] = (gone["start"].as_u64().expect("the start mark is a number") + 1).into();
    let gone: ProcessRecord = serde_json::from_value(gone).expect("the changed record reads");
    LastingServiceRecordFile::of_socket(folder.path(), folder.path(), &physical_socket)
        .expect("the record file is named")
        .lock()
        .expect("the records lock")
        .write(&LastingServiceRecord {
            physical_socket: Some(physical_socket.clone()),
            ..LastingServiceRecord::launched(gone, home_socket.clone())
        })
        .expect("the record is written");

    let failures = stop_kept_services(folder.path().to_owned(), KeptServicesStop::Erase, &[]).await;

    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(
        read_socket_link(&home_socket).expect("the link reads"),
        None
    );
}

// Killed by the daemon's stop giving a kept service its full grace in place of what is left of the
// stop: the top cap returns at the deadline, but a service ignoring its stop then runs on past it.
#[tokio::test]
async fn a_daemon_stop_ends_a_kept_service_that_ignores_its_stop_by_the_deadline() {
    if !CAN_SIGNAL_A_STOP {
        return;
    }
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let (mut child, _record_file) = recorded_stand_in(
        folder.path(),
        "trap '' TERM; echo; exec sleep 60",
        "codex.sock",
    )
    .await;
    let deadline = Instant::now() + Duration::from_millis(300);

    let stopped = timeout(
        Duration::from_millis(1300),
        stop_kept_services(
            folder.path().to_owned(),
            KeptServicesStop::DaemonStop { deadline },
            &[],
        ),
    )
    .await;
    let ended = timeout(Duration::from_secs(1), child.wait()).await;

    assert!(stopped.is_ok(), "the stop ran past its deadline");
    let status = ended
        .expect("the stand-in still runs a second after the stop")
        .expect("the stand-in's end reads");
    assert!(status.code().is_none(), "{status:?}");
}

// Fails when the daemon's stop of the records kept also stops a service of its own, here a former
// daemon's service a join under way publishes, which that service's supervisor stops beside it,
// or leaves a former daemon's service in the same Codex folder running. Killed by dropping the
// skip of the live records and by dropping the join's publish of its record file.
#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_stop_of_kept_records_leaves_a_live_service_s_record_to_its_supervisor() {
    if !CAN_SIGNAL_A_STOP {
        return;
    }
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let physical_socket = folder.path().join("live-physical.sock");
    // Held unanswered, so the join is under way once its dial is accepted.
    let Some(listener) = bind_test_listener(&physical_socket) else {
        return;
    };
    let (mut live, live_record) =
        recorded_stand_in(folder.path(), "echo; exec sleep 60", "live.sock").await;
    let (mut former, former_record) =
        recorded_stand_in(folder.path(), "echo; exec sleep 60", "former.sock").await;
    let read_record = |file: &LastingServiceRecordFile| {
        file.lock()
            .and_then(|locked| locked.read())
            .expect("the record reads")
    };
    let lasting = repin_lasting_codex_service(
        read_record(&live_record)
            .expect("the live stand-in is recorded")
            .process,
    )
    .expect("the process table reads")
    .expect("the live stand-in runs");
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::new(TestCodexProgram {
            program: write_failing_codex(folder.path()),
            environment: Vec::new(),
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let home_socket = folder.path().join("home.sock");
    let service = CodexService::new(
        CodexServiceHome {
            codex_home: folder.path().to_owned(),
            kind: CodexHomeKind::PersonalFolder,
        },
        CodexServiceSocket {
            path: home_socket.clone(),
            home_socket,
        },
        CodexServiceKind::Terminal,
        Arc::clone(&dependencies),
        Vec::new(),
    );
    let executable = dependencies
        .program
        .resolve(service.home())
        .await
        .expect("the test program resolves");
    let cancel = CancellationToken::new();
    let joining = tokio::spawn({
        let (service, cancel, live_record) =
            (Arc::clone(&service), cancel.clone(), live_record.clone());
        async move {
            join_former_service(
                &service,
                1,
                &cancel,
                &executable,
                lasting,
                live_record,
                physical_socket,
            )
            .await
            .map(|_started| ())
            .map_err(|failure| failure.error)
        }
    });
    let held = timeout(Duration::from_secs(10), listener.accept())
        .await
        .expect("the join dials within its wait")
        .expect("the dial is accepted");

    let failures = stop_kept_services(
        folder.path().to_owned(),
        KeptServicesStop::DaemonStop {
            deadline: Instant::now() + Duration::from_secs(5),
        },
        &[Arc::clone(&service)],
    )
    .await;
    let former_end = timeout(Duration::from_secs(5), former.wait()).await;
    let live_exit = live.try_wait().expect("the live stand-in's state reads");
    let live_kept = read_record(&live_record);
    drop((held, listener));
    cancel.cancel();
    let joined = timeout(Duration::from_secs(10), joining)
        .await
        .expect("the stood-down join ends")
        .expect("the join's task ends");

    assert!(failures.is_empty(), "{failures:?}");
    assert!(
        former_end.is_ok(),
        "the former daemon's service still runs after the stop"
    );
    assert_eq!(read_record(&former_record), None);
    assert!(
        live_exit.is_none(),
        "the kept stop ended a live service: {live_exit:?}"
    );
    assert!(
        live_kept.is_some(),
        "the kept stop removed a live service's record"
    );
    assert!(
        joined.is_err(),
        "the join answered on a socket held unanswered"
    );
}

// Fails when a launch on a socket of its own beside the home's, as a terminal service launches
// beside a draining one, publishes its record after a daemon stop began and before the stop takes
// the folder's lock, and the kept stop ends it and removes its record beside the start's own
// teardown; or when the failed launch leaves its record named the service's in place of the home
// socket's. Killed by dropping the launch's publish of its record file before it writes the
// record, by reading the live records before the folder's lock, and by dropping the failure's
// restore of the name before it.
#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_stop_leaves_a_launch_beside_under_way_to_its_supervisor() {
    if !CAN_SIGNAL_A_STOP {
        return;
    }
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let home_socket = folder.path().join("home.sock");
    let own_socket = folder.path().join("own.sock");
    // Held unanswered, so the launch is under way once its dial is accepted.
    let Some(listener) = bind_test_listener(&own_socket) else {
        return;
    };
    let program = folder.path().join("codex");
    create_file_atomically(
        &program,
        STAND_IN_CODEX.as_bytes(),
        0o755,
        LeftoverSweep::Unswept,
    )
    .expect("the stand-in is written");
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::new(TestCodexProgram {
            program,
            environment: vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())],
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let data_folder = dependencies.data_folder.clone();
    let codex_home = dependencies.personal_home.clone();
    std::fs::create_dir(&codex_home).expect("the person's folder is made");
    let service = CodexService::new(
        CodexServiceHome {
            codex_home: codex_home.clone(),
            kind: CodexHomeKind::PersonalFolder,
        },
        CodexServiceSocket {
            path: home_socket.clone(),
            home_socket: home_socket.clone(),
        },
        CodexServiceKind::Terminal,
        Arc::clone(&dependencies),
        Vec::new(),
    );
    let executable = dependencies
        .program
        .resolve(service.home())
        .await
        .expect("the test program resolves");
    let Ok(process_launch) = compose_launch(
        &service,
        &executable,
        service.launch_config_overrides(),
        &own_socket,
    )
    .await
    else {
        panic!("the launch was not composed");
    };
    let log_file = name_lasting_log_file(&service)
        .unwrap_or_else(|failure| panic!("the log is named: {:?}", failure.error));
    // The home socket's record, which a former start of the service named its own and which keeps
    // a running service, so the stop finds the folder before the launch writes its own record.
    let home_record = socket_record_file(&service).expect("the home's record file is named");
    let _home_service =
        spawn_recorded_stand_in(&home_record, &home_socket, "echo; exec sleep 60").await;
    service.set_process_record_file(Some(home_record.clone()));
    let beside_record = LastingServiceRecordFile::of_socket(&data_folder, &codex_home, &own_socket)
        .expect("the record file is named");
    // The folder's lock, held as a start holds it across its launch.
    let locked = lock_record(beside_record.clone())
        .await
        .unwrap_or_else(|failure| panic!("the record locks: {:?}", failure.error));
    let stopping = tokio::spawn({
        let (data_folder, service) = (data_folder.clone(), Arc::clone(&service));
        async move {
            stop_kept_services(
                data_folder,
                KeptServicesStop::DaemonStop {
                    deadline: Instant::now() + Duration::from_secs(10),
                },
                &[service],
            )
            .await
        }
    });
    // Lets the stop list the folder and wait on its lock before the launch publishes.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let cancel = CancellationToken::new();
    let launching = tokio::spawn({
        let (service, locked, cancel) = (Arc::clone(&service), Arc::clone(&locked), cancel.clone());
        async move {
            launch_lasting_service(
                &service,
                1,
                &cancel,
                process_launch,
                &log_file,
                &locked,
                &own_socket,
            )
            .await
        }
    });
    let held = timeout(Duration::from_secs(10), listener.accept())
        .await
        .expect("the launch dials within its wait")
        .expect("the dial is accepted");

    drop(locked);
    let failures = timeout(Duration::from_secs(10), stopping)
        .await
        .expect("the stop ends")
        .expect("the stop's task ends");
    let kept = beside_record
        .lock()
        .and_then(|locked| locked.read())
        .expect("the record reads");
    let is_running = kept.as_ref().is_some_and(|record| {
        repin_lasting_codex_service(record.process.clone())
            .expect("the process table reads")
            .is_some()
    });
    drop((held, listener));
    cancel.cancel();
    let launched = timeout(Duration::from_secs(10), launching)
        .await
        .expect("the stood-down launch ends")
        .expect("the launch's task ends");
    // The failure hands back the launched process for a teardown this test leaves undone.
    let Err(_failure) = launched else {
        panic!("the launch answered on a socket held unanswered");
    };
    let named = service.process_record_file();
    // Ends the stand-ins, which outlive this test otherwise, before any assertion can fail.
    stop_kept_services(
        data_folder,
        KeptServicesStop::DaemonStop {
            deadline: Instant::now() + Duration::from_secs(5),
        },
        &[],
    )
    .await;

    assert!(failures.is_empty(), "{failures:?}");
    assert!(
        kept.is_some(),
        "the kept stop removed a launch's record under way"
    );
    assert!(is_running, "the kept stop ended a launch under way");
    assert_eq!(
        named,
        Some(home_record),
        "a failed launch left its record named the service's"
    );
}

// A shell stand-in running `script`, which writes one byte once it is ready, recorded as the
// lasting service on `socket_name` of the Codex folder `folder`, in `folder` as the data folder;
// ended when the answered child drops.
async fn recorded_stand_in(
    folder: &Path,
    script: &str,
    socket_name: &str,
) -> (tokio::process::Child, LastingServiceRecordFile) {
    let socket = folder.join(socket_name);
    let record_file = LastingServiceRecordFile::of_socket(folder, folder, &socket)
        .expect("the record file is named");
    let child = spawn_recorded_stand_in(&record_file, &socket, script).await;
    (child, record_file)
}

// A shell stand-in running `script`, which writes one byte once it is ready, recorded in
// `record_file` as the lasting service on `socket`.
async fn spawn_recorded_stand_in(
    record_file: &LastingServiceRecordFile,
    socket: &Path,
    script: &str,
) -> tokio::process::Child {
    let mut child = shell_line_command(Path::new(POSIX_SHELL), script)
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("the stand-in starts");
    // Its first byte says the script's set-up ran, so a stop's signal cannot race it.
    let mut ready = [0_u8];
    child
        .stdout
        .take()
        .expect("the stand-in's output is piped")
        .read_exact(&mut ready)
        .await
        .expect("the stand-in is ready");
    let process = pin_child_process(child.id().expect("the stand-in runs"))
        .expect("the stand-in pins")
        .record()
        .expect("the record reads")
        .expect("the stand-in runs");
    record_file
        .lock()
        .expect("the records lock")
        .write(&LastingServiceRecord::launched(process, socket.to_owned()))
        .expect("the record is written");
    child
}
