//! The app's windowless start on macOS, through `LaunchServices`' `open`.

use std::io;
use std::process::Stdio;

use sidekicks_contracts::app_identity::APP_BUNDLE_IDENTIFIER;
use tokio::process::Command;

use crate::spawner::Spawner;
use crate::windowless_app::WindowlessLaunch;

// The program that asks LaunchServices for the app, by its full path so no `PATH` entry stands in
// for it.
const OPEN_PROGRAM: &str = "/usr/bin/open";

// The argument that starts the app with no window.
const BANNER_ARGUMENT: &str = "--banner";

/// Starts the app with no window by its bundle identifier, kept from the front, through `open`
/// started on `spawner`'s thread: `LaunchServices` starts it outside the daemon's tree, or hands
/// nothing to one already running, so no process is handed back. Fails when `open` cannot start or
/// exits with a failure, which it does when no app with that identifier is installed.
pub async fn launch_app_windowless(spawner: &Spawner) -> io::Result<WindowlessLaunch> {
    let mut command = Command::new(OPEN_PROGRAM);
    // No `-n`, so a running app is reused; no `-j`, which would leave a later windowed app hidden;
    // no `-W`, which would hold `open` for the app's whole life.
    command
        .args(["-g", "-b", APP_BUNDLE_IDENTIFIER, "--args", BANNER_ARGUMENT])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = spawner.run(move || command.spawn()).await??;
    let status = child.wait().await?;
    if !status.success() {
        return Err(io::Error::other(format!("open exited with {status}")));
    }
    Ok(WindowlessLaunch::Unwatched)
}
