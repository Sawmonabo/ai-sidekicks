use std::sync::Arc;
use std::time::Duration;

use interprocess::local_socket::traits::tokio::Listener as _;
use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, CAN_LINK_A_SOCKET, ProcessRecord, bind_socket_listener,
    pin_child_process, read_socket_link, replace_socket_link, short_socket_folder,
};
use tokio::time::Instant;

use super::stand_in::{
    CRASH_WAIT, StandInServices, account_home, cut_short_planned_restart, home_record_file,
    is_running, mark_kept_records_draining, send_signal, services_on, stand_in_services,
    this_daemon, wait_for_end_and_record_removal, wait_until_gone,
};
use crate::driver::PROVIDER_REGISTRATIONS;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::service::home::CodexHomeKind;
use crate::driver::codex::service::record::{LastingServiceRecord, LastingServiceRecordFile};
use crate::driver::codex::service::registry::home_socket_path;
use crate::driver::codex::service::supervisor::test_service::{
    HANG_UP_IGNORED_NAME, ProgramPerHome, STOP_IGNORED_NAME, StandInReplies,
    answer_as_codex_service,
};
use crate::driver::daemon_stop::{DaemonStopIntent, daemon_stop_deadline};
use crate::runtime_binding::test_store::test_provider_account_id;

// The start bound of the daemon whose join of a stopped former service must run out: shorter than
// the product's, and long enough that the launch after it, which the same bound holds, answers
// within it on a loaded machine.
const JOIN_START_BOUND: Duration = Duration::from_secs(10);

// The bound of the daemon's stop of a service that ignores its stop.
const STOP_BOUND: Duration = Duration::from_millis(300);

// How long past the stop's deadline the service may take to be reaped once killed.
const KILL_MARGIN: Duration = Duration::from_secs(1);

// Fails when a daemon restarted in the middle of a planned restart retires both services, which
// ends every terminal session inside them, joins the one the home's link does not name, or leaves
// the other running unended rather than draining it to its end and removing its record.
#[tokio::test(flavor = "multi_thread")]
async fn a_restart_cut_short_joins_the_socket_link_holder_and_drains_the_other() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = stand_in_services(|program| Arc::new(program));
    let startup_timeout = services.dependencies.startup_timeout;
    let (first_process, second_process, _first_socket) = cut_short_planned_restart(&services).await;

    let daemon = this_daemon(&services);
    let joined = daemon
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let started = joined.ensure_started(startup_timeout).await;
    let joined_process = joined.process_id();
    let is_first_drained =
        wait_for_end_and_record_removal(first_process, &services, startup_timeout).await;
    let is_second_running = is_running(second_process);
    daemon
        .shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;

    assert!(started.is_ok(), "{started:?}");
    assert_eq!(joined_process, Some(second_process));
    assert!(
        is_first_drained,
        "the service the link left did not end by itself"
    );
    assert!(is_second_running);
}

// Fails when a daemon restarted after the home's link holder died joins the first through the
// home's path, which no longer reaches it and so stops it, launches over it, or leaves the link
// off it.
#[tokio::test(flavor = "multi_thread")]
async fn a_restart_cut_short_whose_socket_link_holder_died_points_the_link_back_and_joins() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = stand_in_services(|program| Arc::new(program));
    let startup_timeout = services.dependencies.startup_timeout;
    let (first_process, second_process, first_socket) = cut_short_planned_restart(&services).await;
    let is_second_killed = send_signal(second_process, "-KILL");
    let is_second_gone = wait_until_gone(second_process).await;

    let daemon = this_daemon(&services);
    let joined = daemon
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let started = joined.ensure_started(startup_timeout).await;
    let joined_process = joined.process_id();
    let is_first_running = is_running(first_process);
    let link =
        read_socket_link(&home_socket_path(&services.home.codex_home)).expect("the link reads");
    daemon
        .shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;

    assert!(is_second_killed && is_second_gone);
    assert!(started.is_ok(), "{started:?}");
    assert_eq!(joined_process, Some(first_process));
    assert!(is_first_running, "the service the start joined was stopped");
    assert!(first_socket.is_some());
    assert_eq!(link, first_socket);
}

// Fails when a daemon restarted while a service no record names answers through the home's link,
// Codex's managed daemon in use, points the link at a former service's socket or joins that
// service, rather than joining the listener through the folder's path with no process of its own
// and draining the former service.
#[tokio::test(flavor = "multi_thread")]
async fn a_restart_joins_an_unrecorded_service_on_the_link_and_drains_the_recorded_one() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = stand_in_services(|program| Arc::new(program));
    let startup_timeout = services.dependencies.startup_timeout;
    let (first_process, second_process, _first_socket) = cut_short_planned_restart(&services).await;
    let is_second_killed = send_signal(second_process, "-KILL");
    let is_second_gone = wait_until_gone(second_process).await;
    let home_socket = home_socket_path(&services.home.codex_home);
    let unrecorded_socket = services.home.codex_home.join("unrecorded.sock");
    let unrecorded =
        bind_socket_listener(&unrecorded_socket).expect("the unrecorded listener listens");
    let answering = tokio::spawn(async move {
        while let Ok(stream) = unrecorded.accept().await {
            tokio::spawn(answer_as_codex_service(
                stream,
                StandInReplies::default(),
                |_request| {},
            ));
        }
    });
    replace_socket_link(&home_socket, &unrecorded_socket).expect("the link names the listener");

    let daemon = this_daemon(&services);
    let joined = daemon
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let started = joined.ensure_started(startup_timeout).await;
    let joined_process = joined.process_id();
    let is_first_drained =
        wait_for_end_and_record_removal(first_process, &services, startup_timeout).await;
    let link = read_socket_link(&home_socket).expect("the link reads");
    daemon
        .shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;
    answering.abort();

    assert!(is_second_killed && is_second_gone);
    assert!(started.is_ok(), "{started:?}");
    assert_eq!(
        joined_process, None,
        "the start took a process of its own for the listener"
    );
    assert!(is_first_drained, "the recorded service was not drained");
    assert_eq!(link.as_deref(), Some(unrecorded_socket.as_path()));
}

// Fails when a join the former service fails, here one stopped so it never answers, hands its
// process back to nothing, which leaves it running in its record, joined again and failed by
// every later start, so the folder's service never starts.
#[tokio::test(flavor = "multi_thread")]
async fn a_former_service_that_never_answers_its_join_is_stopped_and_the_next_start_launches() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let mut services = stand_in_services(|program| Arc::new(program));
    let (first_process, second_process, _first_socket) = cut_short_planned_restart(&services).await;
    // The join fails only once its start bound runs out, so the test's daemon takes a short one.
    Arc::get_mut(&mut services.dependencies)
        .expect("no daemon holds the test's dependencies yet")
        .startup_timeout = JOIN_START_BOUND;
    let startup_timeout = services.dependencies.startup_timeout;
    let is_second_killed = send_signal(second_process, "-KILL");
    let is_second_gone = wait_until_gone(second_process).await;
    let is_first_stopped = send_signal(first_process, "-STOP");

    let daemon = this_daemon(&services);
    let service = daemon
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let joined = service.ensure_started(startup_timeout * 3).await;
    let is_first_retired =
        wait_for_end_and_record_removal(first_process, &services, CRASH_WAIT).await;
    // The wait spans the failed start's teardown and the launch, each bounded by the start bound.
    let launched = service.ensure_started(startup_timeout * 3).await;
    let launched_process = service.process_id();
    daemon
        .shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;
    if !is_first_retired {
        send_signal(first_process, "-CONT");
        send_signal(first_process, "-KILL");
    }

    assert!(is_second_killed && is_second_gone && is_first_stopped);
    assert!(
        joined.is_err(),
        "the join of a service that never answers succeeded"
    );
    assert!(
        is_first_retired,
        "the service whose join failed was left running in its record"
    );
    assert!(launched.is_ok(), "{launched:?}");
    assert!(
        launched_process
            .is_some_and(|process| process != first_process && process != second_process),
        "the next start did not launch a service of its own"
    );
}

// Fails when the home's link is pointed back at a draining service, which joins the folder's
// terminals to one about to disconnect them, rather than launching beside it.
#[tokio::test(flavor = "multi_thread")]
async fn a_draining_service_is_never_where_the_link_is_pointed_back() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = stand_in_services(|program| Arc::new(program));
    let startup_timeout = services.dependencies.startup_timeout;
    let (first_process, second_process, _first_socket) = cut_short_planned_restart(&services).await;
    let is_second_killed = send_signal(second_process, "-KILL");
    let is_second_gone = wait_until_gone(second_process).await;
    let marked = mark_kept_records_draining(&services);

    let daemon = this_daemon(&services);
    let launched = daemon
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let started = launched.ensure_started(startup_timeout).await;
    let launched_process = launched.process_id();
    let link =
        read_socket_link(&home_socket_path(&services.home.codex_home)).expect("the link reads");
    let launched_socket = launched.physical_socket();
    let is_first_still_running = is_running(first_process);
    daemon
        .shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;
    send_signal(first_process, "-KILL");

    assert!(is_second_killed && is_second_gone);
    assert_eq!(marked, 2);
    assert!(
        is_first_still_running,
        "the marked record's service was asked to drain again"
    );
    assert!(started.is_ok(), "{started:?}");
    assert!(
        launched_process
            .is_some_and(|process| process != first_process && process != second_process),
        "the start joined the draining service"
    );
    assert!(launched_socket.is_some());
    assert_eq!(link, launched_socket);
}

// Fails when a daemon restarted while every service a former one left still drains joins one of
// them, points the home's link at one, or waits for their ends rather than launching beside them
// at once, here services stopped mid-drain that never end by themselves.
#[tokio::test(flavor = "multi_thread")]
async fn a_restart_finding_every_service_draining_launches_beside_them_at_once() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = stand_in_services(|program| Arc::new(program));
    let startup_timeout = services.dependencies.startup_timeout;
    let (first_process, second_process, _first_socket) = cut_short_planned_restart(&services).await;
    let marked = mark_kept_records_draining(&services);
    let are_former_stopped =
        send_signal(first_process, "-STOP") && send_signal(second_process, "-STOP");

    let daemon = this_daemon(&services);
    let launched = daemon
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    let started = launched.ensure_started(startup_timeout).await;
    let launched_process = launched.process_id();
    let link =
        read_socket_link(&home_socket_path(&services.home.codex_home)).expect("the link reads");
    let launched_socket = launched.physical_socket();
    daemon
        .shutdown(DaemonStopIntent::Stop, daemon_stop_deadline())
        .await;
    send_signal(first_process, "-KILL");
    send_signal(second_process, "-KILL");

    assert_eq!(marked, 2);
    assert!(are_former_stopped);
    assert!(started.is_ok(), "{started:?}");
    assert!(
        launched_process
            .is_some_and(|process| process != first_process && process != second_process),
        "the start joined a draining service"
    );
    assert!(launched_socket.is_some());
    assert_eq!(link, launched_socket);
}

// Fails when the daemon's stop leaves a drain under way waiting, which holds the stop of the
// service it drains until its running replies finish, here a service that ignores the hang-up and
// so never ends by itself.
#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_stop_returns_without_waiting_on_a_drain_under_way() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = stand_in_services(|mut program| {
        program
            .environment
            .push((HANG_UP_IGNORED_NAME.to_owned(), "1".to_owned()));
        Arc::new(program)
    });
    let startup_timeout = services.dependencies.startup_timeout;
    let registry = Arc::new(this_daemon(&services));
    let first = registry
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    first
        .ensure_started(startup_timeout)
        .await
        .expect("the first service starts");
    registry.replace(&first).await.expect("the second starts");
    let first_process = first.process_id().expect("the first runs a process");
    let retiring = {
        let registry = Arc::clone(&registry);
        let first = Arc::clone(&first);
        tokio::spawn(async move { registry.retire(&first).await })
    };
    let record_file = home_record_file(&services);
    // The drain marks the record once its ask was delivered and announces nothing, so the test
    // reads the record until it is marked.
    let is_drain_asked = tokio::time::timeout(CRASH_WAIT, async {
        while !record_file
            .lock()
            .and_then(|locked| locked.read())
            .expect("the record reads")
            .is_some_and(|record| record.is_draining)
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .is_ok();

    let stopped = tokio::time::timeout(
        CRASH_WAIT,
        registry.shutdown(DaemonStopIntent::Stop, daemon_stop_deadline()),
    )
    .await;
    let retired = tokio::time::timeout(CRASH_WAIT, retiring).await;
    let is_first_running = is_running(first_process);
    send_signal(first_process, "-KILL");

    assert!(is_drain_asked);
    assert!(stopped.is_ok(), "the daemon's stop waited on a drain");
    assert!(
        retired.is_ok(),
        "the retire waited on a drain the stop called off"
    );
    assert!(
        is_first_running,
        "the drained service was ended rather than left to drain"
    );
}

// Fails when the daemon's stop leaves its own service, which ignores the stop it is asked, running
// past the stop's deadline. Killed by the stop keeping its own grace under the daemon's stop: the
// kill then comes 2 s after the ask, past the deadline and its margin.
#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_stop_kills_a_service_that_ignores_its_stop_at_the_deadline() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let records_folder = folder.path().to_owned();
    let home = account_home(folder.path(), CodexHomeKind::CapabilityRead);
    let services = services_on(home, folder, move |mut program| {
        program
            .environment
            .push((STOP_IGNORED_NAME.to_owned(), "1".to_owned()));
        Arc::new(ProgramPerHome {
            program,
            records_folder,
        })
    });
    // The capability read's service is the daemon's own child.
    let service = this_daemon(&services)
        .capability_read_service()
        .await
        .expect("the read's folder is made");
    service
        .ensure_started(services.dependencies.startup_timeout)
        .await
        .expect("the read's service starts");
    let process_id = service
        .process_id()
        .expect("the read's service runs a process of its own");

    let deadline = Instant::now() + STOP_BOUND;
    service.shutdown(DaemonStopIntent::Stop, deadline).await;
    let returned_at = Instant::now();
    // The service ignores its stop, so only the kill ends it.
    let is_killed = tokio::time::timeout_at(deadline + KILL_MARGIN, wait_until_gone(process_id))
        .await
        .unwrap_or(false);

    assert!(
        returned_at <= deadline + KILL_MARGIN,
        "the stop returned {:?} past its deadline",
        returned_at - deadline
    );
    assert!(is_killed, "the service outlived the stop's deadline");
}

// Fails when the erase leaves a draining service to a drain whose record it deletes, leaves a
// record behind, only logs a failure, signals a recorded id a later process took, or when Codex's
// entry in the table ends no recorded service.
#[tokio::test(flavor = "multi_thread")]
async fn the_erase_ends_every_recorded_service_a_draining_one_too_and_answers_each_failure() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let services = stand_in_services(|program| Arc::new(program));
    let (first_process, second_process, _first_socket) = cut_short_planned_restart(&services).await;
    let home_record = home_record_file(&services);
    {
        let locked = home_record.lock().expect("the records lock");
        let mut record = locked
            .read()
            .expect("the record reads")
            .expect("the first service is recorded");
        record.is_draining = true;
        locked
            .write(&record)
            .expect("the record is marked draining");
    }
    // A record naming this test's own process with another start mark, as a record whose id a
    // later process took reads.
    let own = pin_child_process(std::process::id())
        .expect("this process pins")
        .record()
        .expect("the record reads")
        .expect("this process runs");
    let mut own = serde_json::to_value(own).expect("a process record writes as JSON");
    own["start"] = (own["start"].as_u64().expect("the start mark is a number") + 1).into();
    let reused: ProcessRecord = serde_json::from_value(own).expect("the changed record reads");
    let reused_record = recorded_file_in(&services, "reused");
    reused_record
        .lock()
        .expect("the records lock")
        .write(&LastingServiceRecord::launched(
            reused,
            home_socket_path(&services.folder.path().join("reused")),
            None,
        ))
        .expect("the record is written");
    let unreadable_record = recorded_file_in(&services, "unreadable");
    drop(
        unreadable_record
            .lock()
            .expect("the records' folder is made"),
    );
    std::fs::write(unreadable_record.path(), b"not a record").expect("the file is written");
    let stop_recorded_services = PROVIDER_REGISTRATIONS
        .iter()
        .find(|registration| registration.descriptor.id == DESCRIPTOR.id)
        .and_then(|registration| registration.stop_recorded_services)
        .expect("Codex's entry ends its recorded services");

    let stopped = stop_recorded_services(&services.dependencies.data_folder).await;
    let is_first_gone = wait_until_gone(first_process).await;
    let is_second_gone = wait_until_gone(second_process).await;
    let home_locked = home_record.lock().expect("the records lock");
    let home_left = home_locked.read().expect("the record reads");
    let others_left = home_locked.others().expect("the other records list").len();
    let reused_left = reused_record
        .lock()
        .and_then(|locked| locked.read())
        .expect("the record reads");

    assert_eq!(
        stopped.map_err(|error| error.failures.len()).err(),
        Some(1),
        "the unreadable record's failure is the one answered"
    );
    assert!(is_first_gone, "the draining service was left running");
    assert!(is_second_gone, "the recorded service was left running");
    assert_eq!(home_left, None);
    assert_eq!(others_left, 0);
    assert_eq!(reused_left, None);
}

// The record file of a service on a new Codex folder `name` under the test's folder.
fn recorded_file_in(services: &StandInServices, name: &str) -> LastingServiceRecordFile {
    let codex_home = services.folder.path().join(name);
    std::fs::create_dir_all(&codex_home).expect("the Codex folder is made");
    LastingServiceRecordFile::of_socket(
        &services.dependencies.data_folder,
        &codex_home,
        &home_socket_path(&codex_home),
    )
    .expect("the record file is named")
}
