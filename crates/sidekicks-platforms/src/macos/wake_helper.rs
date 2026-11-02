//! The macOS wake helper as the service reaches it: a booking or cancel sent on the helper's
//! socket, the helper's install and removal behind one administrator prompt, and its status read
//! from the system's login items beside its property list. The root program's bookings are
//! `program`, which the helper's own build includes by path beside its own run.

mod install;
pub(crate) mod program;
mod status;

use std::path::Path;
use std::time::{Duration, SystemTime};

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::UnixStream;

use crate::spawner::Spawner;
use crate::{WakeHelperError, WakeHelperStatus, WakeReply, WakeRequest};

/// The socket launchd holds for the helper and starts it on, directly in `/var/run`, which no user
/// but root and the system's own daemons can write: the system empties that folder at each start,
/// so a folder of the helper's own there would be gone before launchd binds. The console user's
/// service connects to it.
pub const WAKE_HELPER_SOCKET_PATH: &str = "/var/run/sidekicks-wake-helper.sock";

// How long one exchange with the helper may take, as long as the helper gives a connection.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(5);

// The longest reply line read: `failed 0x` and eight digits, or the longest refusal, with room to
// spare.
const MOST_REPLY_BYTES: u64 = 64;

/// The macOS wake helper, which this system supplies.
#[derive(Clone, Copy, Debug)]
pub struct WakeHelper(());

/// The wake helper this system supplies, which macOS always does.
pub fn wake_helper() -> Option<WakeHelper> {
    Some(WakeHelper(()))
}

impl WakeHelper {
    /// Books a wake one minute before `asked_at`, in whole seconds since 1970, and answers the
    /// helper's reply: a refusal or a failed power-event call is a reply, not an error. Fails
    /// with [`WakeHelperError::Unreachable`] when the socket cannot be reached or the exchange
    /// takes over five seconds, and with [`WakeHelperError::UnknownReply`] on a line the helper
    /// never writes.
    pub async fn book(&self, asked_at: SystemTime) -> Result<WakeReply, WakeHelperError> {
        exchange(WakeRequest::Book(program::seconds_since_1970(asked_at))).await
    }

    /// Cancels the wake booked for `asked_at`, the time [`Self::book`] was given, and answers the
    /// helper's reply. Fails as [`Self::book`] fails.
    pub async fn cancel(&self, asked_at: SystemTime) -> Result<WakeReply, WakeHelperError> {
        exchange(WakeRequest::Cancel(program::seconds_since_1970(asked_at))).await
    }

    /// Installs `helper_program` as the helper and starts it, behind one administrator prompt, in
    /// place of any helper installed before. Fails with [`WakeHelperError::Canceled`] when the
    /// person cancels the prompt, and otherwise with the step's cause and macOS's own message.
    pub async fn install(
        &self,
        spawner: &Spawner,
        helper_program: &Path,
    ) -> Result<(), WakeHelperError> {
        install::install(spawner, helper_program).await
    }

    /// Stops the helper and removes its program, its property list and its socket, behind one
    /// administrator prompt; a helper already gone is removed. Fails as [`Self::install`] fails.
    pub async fn uninstall(&self, spawner: &Spawner) -> Result<(), WakeHelperError> {
        install::uninstall(spawner).await
    }

    /// Whether the helper is installed, turned off in the login items, or missing. Blocks on the
    /// system's answer. Fails with [`WakeHelperError::File`] when the property list's folder
    /// cannot be read, and with [`WakeHelperError::UnknownStatus`] on a status this build does
    /// not know.
    pub fn status(&self) -> Result<WakeHelperStatus, WakeHelperError> {
        status::read_status()
    }
}

// Sends `request` on the helper's socket and reads its one reply line.
async fn exchange(request: WakeRequest) -> Result<WakeReply, WakeHelperError> {
    let reply = tokio::time::timeout(EXCHANGE_TIMEOUT, async {
        let mut stream = UnixStream::connect(WAKE_HELPER_SOCKET_PATH).await?;
        stream.write_all(format!("{request}\n").as_bytes()).await?;
        let mut reply = String::new();
        stream
            .take(MOST_REPLY_BYTES)
            .read_to_string(&mut reply)
            .await?;
        Ok(reply)
    })
    .await
    .map_err(|elapsed| WakeHelperError::Unreachable(elapsed.into()))?
    .map_err(WakeHelperError::Unreachable)?;
    reply
        .parse()
        .map_err(|_unknown| WakeHelperError::UnknownReply {
            line: reply.trim().to_owned(),
        })
}
