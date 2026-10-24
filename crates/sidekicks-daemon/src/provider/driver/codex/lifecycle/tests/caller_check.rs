//! The caller check over the provider services the driver dials.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::{Value, json};
use sidekicks_platforms::{
    ExistingSocket, LeftoverSweep, ParentProcess, ResponsibleProcess, bind_socket_listener,
    replace_file_atomically, this_process,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::tungstenite::Message;

use super::super::CodexDriver;
use crate::ipc::caller_process::contract::CallerProcessReader;
use crate::ipc::caller_process::descent::CallerCheck;
use crate::ipc::caller_process::descent::tests::ScriptedReader;
use crate::ipc::protocol_negotiation::CallerAdmission;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::daemon_stop::DaemonStopIntent;
use crate::provider::driver::test_registry::test_driver_services;

// A service already listening on the person's Codex folder, joined through the driver's registry,
// its serving process this test's own; the daemon's caller check, over the services' one set of
// held provider services, then refuses that process. Killed by building the driver's own set of
// held services again in `CodexDriver::new`: the check, reading the daemon's set, would find no
// service held and answer that the caller needs the session token.
#[tokio::test]
async fn the_caller_check_refuses_the_process_serving_a_codex_service_the_driver_dialed() {
    // Under `/tmp`, so the socket's path fits the system's limit.
    let folder = tempfile::tempdir_in("/tmp").expect("a scratch folder is made");
    let codex_home = folder.path().join("codex-home");
    let programs = folder.path().join("bin");
    for made in [&codex_home, &programs, &folder.path().join("data")] {
        std::fs::create_dir_all(made).expect("a test folder is made");
    }
    // Found first on the search path as Codex's command; a joined service never runs it.
    replace_file_atomically(
        &programs.join("codex"),
        b"#!/bin/sh\nexit 1\n",
        0o755,
        LeftoverSweep::Unswept,
    )
    .expect("the command is written");
    let mut services = test_driver_services();
    services.data_folder = folder.path().join("data");
    services.home_folder = folder.path().join("home");
    services.base_environment = Arc::from([
        (
            DESCRIPTOR.credential_home_environment_names[0].to_owned(),
            codex_home.display().to_string(),
        ),
        ("PATH".to_owned(), programs.display().to_string()),
    ]);
    let driver = CodexDriver::new(&services);
    driver.is_terminal_reach_on.store(true, Ordering::Release);
    let service = driver
        .registry
        .service_for(None)
        .await
        .expect("the folder's service is made");
    let socket = service.socket_path().to_owned();
    std::fs::create_dir_all(socket.parent().expect("the socket has a folder"))
        .expect("the socket's folder is made");
    let listener =
        bind_socket_listener(&socket, ExistingSocket::Refuse).expect("the test service listens");
    tokio::spawn(async move {
        while let Ok(stream) = listener.accept().await {
            tokio::spawn(answer_as_idle_service(stream));
        }
    });

    service
        .ensure_started(Duration::from_secs(10))
        .await
        .expect("the driver joins the listening service");
    let check = CallerCheck::new(
        Arc::new(ScriptedReader {
            responsible: ResponsibleProcess::Itself,
            parent: ParentProcess::Root,
            is_desktop_client: false,
            was_signature_read: AtomicBool::new(false),
        }) as Arc<dyn CallerProcessReader>,
        Arc::new(HashSet::new),
        Arc::clone(&services.provider_services),
    );

    assert_eq!(
        check.admission_check()(this_process(), true)
            .await
            .expect("the check answers"),
        CallerAdmission::Refused
    );
    driver.shutdown(DaemonStopIntent::Stop).await;
}

// Answers one connection as a service the person started with no conversation loaded: its
// version, and an empty list for every other request.
async fn answer_as_idle_service(stream: impl AsyncRead + AsyncWrite + Unpin) {
    // A probe that only connects ends before the upgrade.
    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    while let Some(Ok(Message::Text(text))) = socket.next().await {
        let request: Value = serde_json::from_str(&text).expect("the daemon sends JSON");
        let result = match request["method"].as_str() {
            _ if request.get("id").is_none() => continue,
            Some("initialize") => json!({"userAgent": "ai-sidekicks-daemon/0.130.0 (test)"}),
            _ => json!({"data": []}),
        };
        let reply = json!({"id": request["id"], "result": result});
        if socket
            .send(Message::Text(reply.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    }
}
