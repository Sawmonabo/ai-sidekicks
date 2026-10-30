//! The run of a command that calls the daemon: a current-thread runtime of its own, built only
//! for that command so `--help` and `--version` start none, a connection to this machine's daemon,
//! and the person's Ctrl-C turned into a cancel of what the command waits on.

use anyhow::Context as _;
use sidekicks_client::daemon_connection::{DaemonConnection, DaemonEndpoint};
use sidekicks_client::error::ClientError;
use sidekicks_platforms::{CtrlCListener, ctrl_c};
use tokio_util::sync::CancellationToken;

/// Runs `body` connected to this machine's daemon, with a token the person's first Ctrl-C
/// cancels, so each call the body makes through `call_until` settles as canceled. A Ctrl-C while
/// the connection opens, or a second one while the body waits on its cancel's answer, ends the
/// command as a canceled call. Fails as the connect or the body does, and `ClientError::Canceled`
/// after such a Ctrl-C.
pub(crate) fn run_connected<T>(
    body: impl AsyncFnOnce(&DaemonConnection, &CancellationToken) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    run_listening_for_ctrl_c(async |ctrl_c| {
        let endpoint = DaemonEndpoint::this_machine()
            .context("could not find where the background service listens")?;
        let connection = tokio::select! {
            connected = DaemonConnection::connect(endpoint) => connected?,
            _ = ctrl_c.recv() => return Err(ClientError::Canceled.into()),
        };
        let cancel = CancellationToken::new();
        let outcome = tokio::select! {
            outcome = body(&connection, &cancel) => outcome,
            () = cancel_on_ctrl_c(ctrl_c, &cancel) => Err(ClientError::Canceled.into()),
        };
        connection.close().await;
        outcome
    })
}

/// Runs `body` on the command's own runtime with the person's Ctrl-C taken first, so a Ctrl-C
/// from then on reaches `body` through the listener instead of ending the process. Fails as the
/// runtime's start, the listener or `body` does.
pub(crate) fn run_listening_for_ctrl_c<T>(
    body: impl AsyncFnOnce(&mut CtrlCListener) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("could not start the command's runtime")?;
    runtime.block_on(async {
        let mut ctrl_c = ctrl_c().context("could not listen for Ctrl-C")?;
        body(&mut ctrl_c).await
    })
}

/// Cancels `cancel` at the first Ctrl-C and answers at the second, so a command whose daemon is
/// slow to answer the cancel still ends when the person presses Ctrl-C again.
async fn cancel_on_ctrl_c(ctrl_c: &mut CtrlCListener, cancel: &CancellationToken) {
    // The listener answers `None` only once the runtime shuts down, which it cannot while the
    // command runs on it.
    ctrl_c.recv().await;
    cancel.cancel();
    ctrl_c.recv().await;
}
