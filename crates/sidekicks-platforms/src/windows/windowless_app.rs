//! The app's windowless start on Windows, which starts nothing yet: the app's program is not found
//! from its registration yet.

use std::io::{self, ErrorKind};

use crate::spawner::Spawner;
use crate::windowless_app::WindowlessLaunch;

/// Starts nothing: Windows does not find the app's program yet. Always fails with `Unsupported`,
/// which means no app was started.
pub async fn launch_app_windowless(_spawner: &Spawner) -> io::Result<WindowlessLaunch> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows does not find the app's program to start with no window yet",
    ))
}
