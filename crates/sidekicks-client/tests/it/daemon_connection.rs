//! Opening a daemon connection over a real local socket: the token is read at each connect and
//! once more when the daemon refuses it, and a run folder that is not this account's alone is
//! refused before the client writes a byte.

use std::path::Path;
use std::time::Duration;

use interprocess::local_socket::tokio::{Listener, Stream};
use interprocess::local_socket::traits::tokio::Listener as _;
use interprocess::local_socket::{GenericFilePath, ListenerOptions, ToFsName as _};
use sidekicks_client::daemon_connection::{DaemonConnection, DaemonEndpoint};
use sidekicks_client::error::ClientError;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_platforms::DaemonRunFolder;
use tokio::io::AsyncReadExt as _;

use crate::helpers::ScriptedDaemon;

/// How long a test waits for the client before it counts as stuck.
const PATIENCE: Duration = Duration::from_secs(10);

fn run_folder(folder_path: &Path, socket_folder: &Path) -> DaemonRunFolder {
    DaemonRunFolder {
        folder_path: folder_path.to_path_buf(),
        socket_path: socket_folder.join("daemon.sock"),
        token_path: socket_folder.join("token"),
    }
}

fn listen(run_folder: &DaemonRunFolder) -> Listener {
    let name = run_folder
        .socket_path
        .as_path()
        .to_fs_name::<GenericFilePath>()
        .expect("a socket path in a temporary folder");
    ListenerOptions::new()
        .name(name)
        .create_tokio()
        .expect("the test binds its socket")
}

async fn accept(listener: &Listener) -> ScriptedDaemon<Stream> {
    let stream = tokio::time::timeout(PATIENCE, listener.accept())
        .await
        .expect("the client connects")
        .expect("the connection is accepted");
    ScriptedDaemon::new(stream)
}

/// Reads `connection.initialize`, checks the token it presents and answers its id.
async fn read_initialize(daemon: &mut ScriptedDaemon<Stream>, token: &str) -> serde_json::Value {
    let request = daemon.next_message().await;
    assert_eq!(request["params"]["sessionToken"], token);
    request["id"].clone()
}

#[tokio::test]
async fn a_refused_token_is_read_again_and_retried_once_only_when_the_file_changed() {
    let folder = tempfile::tempdir().expect("a temporary folder");
    let private = folder.path().join("run");
    sidekicks_platforms::create_private_folder(&private).expect("the run folder is made private");
    let run_folder = run_folder(&private, &private);
    let listener = listen(&run_folder);
    std::fs::write(&run_folder.token_path, "first-token").expect("the token is written");

    let connecting = tokio::spawn(DaemonConnection::connect(DaemonEndpoint::new(
        run_folder.clone(),
    )));
    let mut first = accept(&listener).await;
    let id = read_initialize(&mut first, "first-token").await;
    // The daemon restarted and wrote a new token after the client read the old one.
    std::fs::write(&run_folder.token_path, "second-token").expect("the token is rewritten");
    first.refuse(&id, RefusalCode::AuthTokenInvalid).await;
    let mut second = accept(&listener).await;
    second.answer_initialize_with_token("second-token").await;
    let connection = tokio::time::timeout(PATIENCE, connecting)
        .await
        .expect("the connect ends")
        .expect("the connect task runs")
        .expect("the second token opens the link");
    assert!(connection.initialize_response().compatible);

    let connecting = tokio::spawn(DaemonConnection::connect(DaemonEndpoint::new(
        run_folder.clone(),
    )));
    let mut third = accept(&listener).await;
    let id = read_initialize(&mut third, "second-token").await;
    third.refuse(&id, RefusalCode::AuthTokenInvalid).await;
    let refused = tokio::time::timeout(PATIENCE, connecting)
        .await
        .expect("an unchanged token is not retried")
        .expect("the connect task runs");
    assert!(
        matches!(&refused, Err(ClientError::Remote(remote)) if remote.data.as_ref().is_some_and(
            |data| data.refusal == RefusalCode::AuthTokenInvalid.as_str()
        )),
        "{:?}",
        refused.err()
    );
}

#[tokio::test]
async fn a_run_folder_that_is_not_a_private_folder_is_refused_before_any_byte_is_written() {
    let folder = tempfile::tempdir().expect("a temporary folder");
    // A file where the folder should be is no folder this account keeps to itself.
    let not_a_folder = folder.path().join("not-a-folder");
    std::fs::write(&not_a_folder, "").expect("the file is written");
    let run_folder = run_folder(&not_a_folder, folder.path());
    let listener = listen(&run_folder);
    std::fs::write(&run_folder.token_path, "a-token").expect("the token is written");

    let connecting = tokio::spawn(DaemonConnection::connect(DaemonEndpoint::new(run_folder)));
    let mut stream = tokio::time::timeout(PATIENCE, listener.accept())
        .await
        .expect("the client connects")
        .expect("the connection is accepted");
    let mut received = Vec::new();
    tokio::time::timeout(PATIENCE, stream.read_to_end(&mut received))
        .await
        .expect("the client closes the connection")
        .expect("the connection reads");
    assert!(
        received.is_empty(),
        "the client wrote {} bytes",
        received.len()
    );
    let refused = connecting.await.expect("the connect task runs");
    assert!(
        matches!(refused, Err(ClientError::RunFolder(_))),
        "{:?}",
        refused.err()
    );
}
