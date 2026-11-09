//! The stop of the lasting services the records keep: the erase's, and the daemon's, which leaves
//! a live service's record, a launch's and a join's under way among them, to its supervisor.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use sidekicks_platforms::{
    CAN_LINK_A_SOCKET, CAN_SIGNAL_A_STOP, LeftoverSweep, POSIX_SHELL, ProcessRecord,
    create_file_atomically, pin_child_process, read_socket_link, replace_socket_link,
    shell_line_command,
};
use tokio::io::AsyncReadExt as _;
use tokio::task::JoinHandle;
use tokio::time::{Instant, timeout};
use tokio_util::sync::CancellationToken;

use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::process::{CodexProcessLaunch, repin_lasting_codex_service};
use crate::driver::codex::service::record::{
    LastingServiceRecord, LastingServiceRecordFile, LockedServiceRecord,
};
use crate::driver::codex::service::supervisor::own_record::{
    retire_own_record, socket_record_file,
};
use crate::driver::codex::service::supervisor::start::kept_records::lock_record;
use crate::driver::codex::service::supervisor::start::kept_records::stop::{
    KeptServicesStop, stop_kept_services,
};
use crate::driver::codex::service::supervisor::start::take_start_lock;
use crate::driver::codex::service::supervisor::start::terminal::launch_terminal_service;
use crate::driver::codex::service::supervisor::start::{
    LaunchedLastingService, StartFailure, compose_launch, join_former_service,
    launch_lasting_service, name_lasting_log_file,
};
use crate::driver::codex::service::supervisor::test_service::{
    STAND_IN_CODEX, StandInReplies, TestCodexProgram, UnheardEvents, answer_as_codex_service,
    bind_test_listener, test_codex_service_dependencies, write_failing_codex,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
use crate::spawned_version::ResolvedProviderExecutable;

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
                CodexServiceKind::Terminal,
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

// A terminal service on `home_socket` under `folder`, set to launch beside it on a socket of its
// own, its listener bound and handed back for the test to answer, with the home socket's record
// keeping a running stand-in and named the service's, as a former start left it.
struct BesideLaunch {
    service: Arc<CodexService>,
    // Taken by the one launch the set-up is for.
    process_launch: Option<CodexProcessLaunch>,
    executable: ResolvedProviderExecutable,
    log_file: PathBuf,
    own_socket: PathBuf,
    listener: Listener,
    data_folder: PathBuf,
    home_record: LastingServiceRecordFile,
    beside_record: LastingServiceRecordFile,
    _home_service: tokio::process::Child,
}

// Sets up a launch beside the home's under `folder`; `None` where the system binds no listener.
async fn prepare_beside_launch(folder: &Path, home_socket: PathBuf) -> Option<BesideLaunch> {
    let own_socket = folder.join("own.sock");
    let listener = bind_test_listener(&own_socket)?;
    let program = folder.join("codex");
    create_file_atomically(
        &program,
        STAND_IN_CODEX.as_bytes(),
        0o755,
        LeftoverSweep::Unswept,
    )
    .expect("the stand-in is written");
    let dependencies = test_codex_service_dependencies(
        folder,
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
    // A running service in it, so a stop finds the folder before the launch writes its record.
    let home_record = socket_record_file(&service).expect("the home's record file is named");
    let home_service =
        spawn_recorded_stand_in(&home_record, &home_socket, "echo; exec sleep 60").await;
    service.set_process_record_file(Some(home_record.clone()));
    let beside_record = LastingServiceRecordFile::of_socket(&data_folder, &codex_home, &own_socket)
        .expect("the record file is named");
    Some(BesideLaunch {
        service,
        process_launch: Some(process_launch),
        executable,
        log_file,
        own_socket,
        listener,
        data_folder,
        home_record,
        beside_record,
        _home_service: home_service,
    })
}

// Launches `beside` under `locked`, stood down by `cancel`, on a task of its own.
fn spawn_beside_launch(
    beside: &mut BesideLaunch,
    locked: &Arc<LockedServiceRecord>,
    cancel: &CancellationToken,
) -> JoinHandle<Result<LaunchedLastingService, StartFailure>> {
    let (service, locked, cancel) = (
        Arc::clone(&beside.service),
        Arc::clone(locked),
        cancel.clone(),
    );
    let (log_file, own_socket) = (beside.log_file.clone(), beside.own_socket.clone());
    let process_launch = beside
        .process_launch
        .take()
        .expect("the set-up is for one launch");
    tokio::spawn(async move {
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
    })
}

// Ends every stand-in a record under `data_folder` keeps, which outlives the test otherwise.
async fn end_recorded_stand_ins(data_folder: PathBuf) {
    stop_kept_services(
        data_folder,
        KeptServicesStop::DaemonStop {
            deadline: Instant::now() + Duration::from_secs(5),
        },
        &[],
    )
    .await;
}

// Fails when a launch on a socket of its own beside the home's, as a terminal service launches
// beside a draining one, publishes its record after a daemon stop began and before the stop takes
// the folder's lock, which the start holds across its launch, and the kept stop then ends it and
// removes its record. Killed by dropping the launch's publish of its record file and by reading
// the live records before the folder's lock.
#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_stop_leaves_a_launch_beside_published_after_it_began_to_its_supervisor() {
    if !CAN_SIGNAL_A_STOP {
        return;
    }
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let Some(mut beside) =
        prepare_beside_launch(folder.path(), folder.path().join("home.sock")).await
    else {
        return;
    };
    let locked = lock_record(beside.beside_record.clone())
        .await
        .unwrap_or_else(|failure| panic!("the record locks: {:?}", failure.error));
    let stopping = tokio::spawn({
        let (data_folder, service) = (beside.data_folder.clone(), Arc::clone(&beside.service));
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
    let launching = spawn_beside_launch(&mut beside, &locked, &CancellationToken::new());
    let stream = timeout(Duration::from_secs(10), beside.listener.accept())
        .await
        .expect("the launch dials within its wait")
        .expect("the dial is accepted");
    tokio::spawn(answer_as_codex_service(
        stream,
        StandInReplies::default(),
        |_request| {},
    ));
    let launched = timeout(Duration::from_secs(10), launching)
        .await
        .expect("the launch ends")
        .expect("the launch's task ends");

    drop(locked);
    let failures = timeout(Duration::from_secs(15), stopping)
        .await
        .expect("the stop ends")
        .expect("the stop's task ends");
    let kept = beside
        .beside_record
        .lock()
        .and_then(|locked| locked.read())
        .expect("the record reads");
    let is_running = kept.as_ref().is_some_and(|record| {
        repin_lasting_codex_service(record.process.clone())
            .expect("the process table reads")
            .is_some()
    });
    let is_launched = launched.is_ok();
    drop(launched);
    end_recorded_stand_ins(beside.data_folder).await;

    assert!(
        is_launched,
        "the launch failed on a socket answered as Codex"
    );
    assert!(failures.is_empty(), "{failures:?}");
    assert!(
        kept.is_some(),
        "the kept stop removed a launch's record published under the start's hold"
    );
    assert!(
        is_running,
        "the kept stop ended a launch published under the start's hold"
    );
}

// Fails when a launch beside the home's that fails, here stood down while its dial waits, puts the
// home socket's name back before the start's teardown stopped the process it handed back, so a
// daemon stop in between ends that process beside the teardown; or when the teardown's put-back
// leaves the failed launch's record named the service's, so its retire and next start act on it.
// Killed by putting the name back where the launch returns, and by dropping the put-back.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_launch_beside_keeps_its_record_named_until_its_teardown() {
    if !CAN_SIGNAL_A_STOP {
        return;
    }
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let Some(mut beside) =
        prepare_beside_launch(folder.path(), folder.path().join("home.sock")).await
    else {
        return;
    };
    let locked = lock_record(beside.beside_record.clone())
        .await
        .unwrap_or_else(|failure| panic!("the record locks: {:?}", failure.error));
    let cancel = CancellationToken::new();
    let launching = spawn_beside_launch(&mut beside, &locked, &cancel);
    let held = timeout(Duration::from_secs(10), beside.listener.accept())
        .await
        .expect("the launch dials within its wait")
        .expect("the dial is accepted");
    drop(held);
    cancel.cancel();
    let launched = timeout(Duration::from_secs(10), launching)
        .await
        .expect("the stood-down launch ends")
        .expect("the launch's task ends");
    let Err(failure) = launched else {
        panic!("the launch answered on a socket held unanswered");
    };
    // The start lets go of the folder's lock before its teardown runs.
    drop(locked);

    let failures = stop_kept_services(
        beside.data_folder.clone(),
        KeptServicesStop::DaemonStop {
            deadline: Instant::now() + Duration::from_secs(5),
        },
        &[Arc::clone(&beside.service)],
    )
    .await;
    let kept = beside
        .beside_record
        .lock()
        .and_then(|locked| locked.read())
        .expect("the record reads");
    let is_running = kept.as_ref().is_some_and(|record| {
        repin_lasting_codex_service(record.process.clone())
            .expect("the process table reads")
            .is_some()
    });
    // The teardown's stop of the handed-back process, then its put-back of the name.
    end_recorded_stand_ins(beside.data_folder.clone()).await;
    failure
        .earlier_record_file
        .expect("a failed launch hands back the name before its own")
        .restore(&beside.service);
    let named = beside.service.process_record_file();

    assert!(failures.is_empty(), "{failures:?}");
    assert!(
        kept.is_some() && is_running,
        "the kept stop ended a failed launch's process before its teardown"
    );
    assert_eq!(
        named,
        Some(beside.home_record),
        "a failed launch left its record named the service's"
    );
}

// Fails when a start that fails after its launch succeeded, here on the move of the home's link
// onto the service launched beside, leaves the launched record named the service's once its
// teardown stopped that process, so the service's retire acts on the removed record in place of
// the home socket's. Killed by handing the failure back without the name before the launch's.
#[tokio::test(flavor = "multi_thread")]
async fn a_start_failing_after_its_launch_leaves_the_retire_to_the_home_socket_s_record() {
    if !CAN_SIGNAL_A_STOP || !CAN_LINK_A_SOCKET {
        return;
    }
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    // The home's socket in a folder that is not there, so the move of its link fails.
    let home_socket = folder.path().join("gone").join("home.sock");
    let Some(beside) = prepare_beside_launch(folder.path(), home_socket).await else {
        return;
    };
    let locked = lock_record(beside.beside_record.clone())
        .await
        .unwrap_or_else(|failure| panic!("the record locks: {:?}", failure.error));
    let start_lock = take_start_lock(&beside.service.home().codex_home, Duration::from_secs(10))
        .await
        .unwrap_or_else(|failure| panic!("Codex's start lock is taken: {:?}", failure.error));
    let cancel = CancellationToken::new();
    let (started, ()) = tokio::join!(
        launch_terminal_service(
            &beside.service,
            1,
            &cancel,
            &beside.executable,
            start_lock,
            &locked,
            &beside.own_socket,
        ),
        async {
            let stream = timeout(Duration::from_secs(10), beside.listener.accept())
                .await
                .expect("the launch dials within its wait")
                .expect("the dial is accepted");
            tokio::spawn(answer_as_codex_service(
                stream,
                StandInReplies::default(),
                |_request| {},
            ));
        },
    );
    let Err(failure) = started else {
        panic!("the start moved the home's link into a folder that is not there");
    };
    drop(locked);

    // The teardown: the launched process retired under its own record's name, then the name before
    // it put back.
    retire_own_record(&beside.service)
        .await
        .expect("the launched process is retired");
    if let Some(earlier_record_file) = failure.earlier_record_file {
        earlier_record_file.restore(&beside.service);
    }
    // The service's own retire, once nothing starts it again.
    retire_own_record(&beside.service)
        .await
        .expect("the service's record is retired");
    let read_record = |file: &LastingServiceRecordFile| {
        file.lock()
            .and_then(|locked| locked.read())
            .expect("the record reads")
    };
    let (home_kept, beside_kept) = (
        read_record(&beside.home_record),
        read_record(&beside.beside_record),
    );
    end_recorded_stand_ins(beside.data_folder).await;

    assert_eq!(beside_kept, None, "the teardown left the launched record");
    assert_eq!(
        home_kept, None,
        "the retire acted on the removed record in place of the home socket's"
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
