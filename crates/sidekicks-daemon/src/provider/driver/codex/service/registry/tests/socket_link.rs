use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::json;
use sidekicks_platforms::{
    CAN_LINK_A_SOCKET, ExistingSocket, bind_socket_listener, read_socket_link, replace_socket_link,
};

use super::OneHome;
use super::stand_in::{
    CRASH_WAIT, FirstResolveOnly, another_daemon, is_running, send_signal, stand_in_services,
    this_daemon,
};
use crate::provider::driver::codex::service::home::CodexServiceKind;
use crate::provider::driver::codex::service::registry::{CodexServiceRegistry, home_socket_path};
use crate::provider::driver::codex::service::supervisor::CodexServiceSocket;
use crate::provider::driver::codex::service::supervisor::test_service::{
    drop_service_connection, script_codex_service,
};
use crate::provider::driver::daemon_stop::DaemonStopIntent;

// Fails when a planned restart leaves the home's socket on the first service, when the first's
// stop clears the link the second now holds, when a crash leaves the link naming the socket its
// ended process listened on, or when the second's restart leaves the link off the restarted
// service.
#[tokio::test(flavor = "multi_thread")]
async fn the_home_socket_follows_the_service_that_holds_it() {
    if !CAN_LINK_A_SOCKET {
        return;
    }
    // The home's socket path must fit the system's bound on socket paths.
    let folder = tempfile::tempdir_in("/tmp").expect("a scratch folder is made");
    let mut services = stand_in_services(folder.path(), |program| Arc::new(program));
    let startup_timeout = services.dependencies.startup_timeout;
    let home_socket = home_socket_path(&services.home.codex_home);
    let registry = this_daemon(&services);
    let first = registry.service_for(None).await.expect("the home resolves");
    first
        .ensure_started(startup_timeout)
        .await
        .expect("the first service starts");

    let second = registry.replace(&first).await.expect("the second starts");
    let first_socket = first.physical_socket();
    let second_socket = second.physical_socket();
    let after_restart = read_socket_link(&home_socket).expect("the link reads");
    registry.retire(&first).await;
    let after_retire = read_socket_link(&home_socket).expect("the link reads");
    let is_killed = send_signal(
        second.process_id().expect("the second runs a process"),
        "-KILL",
    );
    let crash_heard = tokio::time::timeout(CRASH_WAIT, services.exits.recv()).await;
    let after_crash = read_socket_link(&home_socket).expect("the link reads");
    let recovery_heard = tokio::time::timeout(CRASH_WAIT, services.recoveries.recv()).await;
    let restarted_socket = second.physical_socket();
    let after_recovery = read_socket_link(&home_socket).expect("the link reads");
    registry.shutdown(DaemonStopIntent::Stop).await;

    assert!(second_socket.is_some());
    assert_ne!(second_socket, first_socket);
    assert_eq!(after_restart, second_socket);
    assert_eq!(after_retire, second_socket);
    assert!(is_killed);
    assert!(
        matches!(crash_heard, Ok(Some(()))),
        "the crash was not heard"
    );
    assert_ne!(
        after_crash, second_socket,
        "the link still names the ended process's socket"
    );
    assert!(
        matches!(recovery_heard, Ok(Some(()))),
        "the restart was not heard"
    );
    assert!(restarted_socket.is_some());
    assert_eq!(after_recovery, restarted_socket);
}

// Fails when a planned restart whose second service cannot start takes the home from the first,
// which leaves the home's sessions on a service that never came up.
#[tokio::test(flavor = "multi_thread")]
async fn a_second_service_that_fails_to_start_leaves_the_first_the_home_s() {
    if !CAN_LINK_A_SOCKET {
        return;
    }
    let folder = tempfile::tempdir_in("/tmp").expect("a scratch folder is made");
    let services = stand_in_services(folder.path(), |program| {
        Arc::new(FirstResolveOnly {
            program,
            calls: AtomicUsize::new(0),
        })
    });
    let home_socket = home_socket_path(&services.home.codex_home);
    let registry = this_daemon(&services);
    let first = registry.service_for(None).await.expect("the home resolves");
    first
        .ensure_started(services.dependencies.startup_timeout)
        .await
        .expect("the first service starts");

    let replaced = registry.replace(&first).await;
    let registered = registry.services();
    let link = read_socket_link(&home_socket).expect("the link reads");
    registry.shutdown(DaemonStopIntent::Stop).await;

    assert!(replaced.is_err());
    assert!(
        registered.len() == 1 && Arc::ptr_eq(&registered[0], &first),
        "the first is no longer the home's service"
    );
    assert_eq!(link, first.physical_socket());
}

// Fails when a service's redial dials the home's path, which reaches whatever service the home's
// link names by then, here a listener the test points it at, rather than the service's own process.
#[tokio::test(flavor = "multi_thread")]
async fn a_redial_reaches_the_service_s_own_socket_whatever_the_link_names() {
    if !CAN_LINK_A_SOCKET {
        return;
    }
    let folder = tempfile::tempdir_in("/tmp").expect("a scratch folder is made");
    let services = stand_in_services(folder.path(), |program| Arc::new(program));
    let startup_timeout = services.dependencies.startup_timeout;
    let home_socket = home_socket_path(&services.home.codex_home);
    let registry = this_daemon(&services);
    let service = registry.service_for(None).await.expect("the home resolves");
    service
        .ensure_started(startup_timeout)
        .await
        .expect("the service starts");
    let other_socket = services.home.codex_home.join("other.sock");
    let other = bind_socket_listener(&other_socket, ExistingSocket::Refuse)
        .expect("the other listener listens");
    let accepted = Arc::new(AtomicUsize::new(0));
    let counting = Arc::clone(&accepted);
    let accepting = tokio::spawn(async move {
        while let Ok(_stream) = other.accept().await {
            counting.fetch_add(1, Ordering::Relaxed);
        }
    });

    replace_socket_link(&home_socket, &other_socket).expect("the link names the other listener");
    drop_service_connection(&service);
    let is_disconnected = tokio::time::timeout(CRASH_WAIT, async {
        while service.connection().is_ok() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    let redialed = service.ensure_started(CRASH_WAIT).await;
    let accepted_through_the_link = accepted.load(Ordering::Relaxed);
    registry.shutdown(DaemonStopIntent::Stop).await;
    accepting.abort();

    assert!(is_disconnected, "the drop was not heard");
    assert!(redialed.is_ok(), "{redialed:?}");
    assert_eq!(
        accepted_through_the_link, 0,
        "the redial dialed the home's link"
    );
}

// Fails when a crash restart of the home's service reads every record kept for the folder, which
// takes another running service the home's link names as its own process and stops it with its
// own stop, rather than joining it through the folder's socket with no process of its own.
#[tokio::test(flavor = "multi_thread")]
async fn a_crash_restart_of_the_home_s_service_never_takes_another_service_s_process() {
    if !CAN_LINK_A_SOCKET {
        return;
    }
    let folder = tempfile::tempdir_in("/tmp").expect("a scratch folder is made");
    let mut services = stand_in_services(folder.path(), |program| Arc::new(program));
    let startup_timeout = services.dependencies.startup_timeout;
    let daemon = this_daemon(&services);
    let home_service = daemon.service_for(None).await.expect("the home resolves");
    home_service
        .ensure_started(startup_timeout)
        .await
        .expect("the home's service starts");
    let home_process = home_service.process_id().expect("it runs a process");
    // Another daemon on the folder joins it and moves the home's link to a second of its own.
    let other_daemon = another_daemon(&services);
    let joined = other_daemon
        .service_for(None)
        .await
        .expect("the home resolves");
    joined
        .ensure_started(startup_timeout)
        .await
        .expect("the other daemon joins the home's service");
    let second = other_daemon
        .replace(&joined)
        .await
        .expect("the second starts");
    let second_process = second.process_id().expect("the second runs a process");
    other_daemon.shutdown(DaemonStopIntent::Restart).await;

    let is_home_killed = send_signal(home_process, "-KILL");
    let recovery_heard = tokio::time::timeout(CRASH_WAIT, services.recoveries.recv()).await;
    let recovered_process = home_service.process_id();
    daemon.shutdown(DaemonStopIntent::Stop).await;
    let is_second_running = is_running(second_process);
    send_signal(second_process, "-KILL");

    assert!(is_home_killed);
    assert!(
        matches!(recovery_heard, Ok(Some(()))),
        "the restart was not heard"
    );
    assert_eq!(recovered_process, None);
    assert!(
        is_second_running,
        "the crash restart stopped another service's process as its own"
    );
}

// Fails when a planned restart's swap takes the folder from a service the switch-off is stopping,
// which moves the home's link and hands new terminals a second service while reach goes off, or
// when the switch-off lets go of the folder's service only after its wait.
#[tokio::test(flavor = "multi_thread")]
async fn a_planned_restart_during_the_switch_off_leaves_the_socket_link_and_fails() {
    if !CAN_LINK_A_SOCKET {
        return;
    }
    let folder = tempfile::tempdir_in("/tmp").expect("a scratch folder is made");
    let services = stand_in_services(folder.path(), |program| Arc::new(program));
    let home_socket = home_socket_path(&services.home.codex_home);
    std::fs::create_dir_all(home_socket.parent().expect("the link has a folder"))
        .expect("the link's folder is made");
    let first_socket = services.home.codex_home.join("first.sock");
    replace_socket_link(&home_socket, &first_socket).expect("the link names the first");
    let (first, mut script) = script_codex_service(
        services.home.clone(),
        CodexServiceSocket {
            path: home_socket.clone(),
            home_socket: home_socket.clone(),
        },
        CodexServiceKind::Terminal,
        Arc::clone(&services.dependencies),
    );
    let registry = Arc::new(CodexServiceRegistry::new(
        Arc::new(OneHome(services.home.clone())),
        Arc::clone(&services.dependencies),
    ));
    registry
        .lock()
        .by_home
        .insert(services.home.codex_home.clone(), Arc::clone(&first));
    let inside = json!({"data": ["terminal-thread-1"]});

    let stopping = {
        let registry = Arc::clone(&registry);
        tokio::spawn(async move { registry.stop_terminal_service().await })
    };
    for _read in 0..2 {
        let loaded = script.next_sent().await;
        assert_eq!(loaded["method"], "thread/loaded/list", "{loaded}");
        script.answer(&loaded, &inside);
    }
    let registered_while_waiting = registry.services();
    let replaced = registry.replace(&first).await;
    let link = read_socket_link(&home_socket).expect("the link reads");
    script.send(&json!({"jsonrpc": "2.0", "method": "thread/closed",
        "params": {"threadId": "terminal-thread-1"}}));
    let last = script.next_sent().await;
    script.answer(&last, &json!({"data": []}));
    let stopped = stopping.await.expect("the stop ends");
    registry.shutdown(DaemonStopIntent::Stop).await;

    assert!(
        registered_while_waiting.is_empty(),
        "the switch-off left the service the folder's while it waited"
    );
    assert!(replaced.is_err());
    assert_eq!(link, Some(first_socket));
    assert!(stopped.is_ok());
}
