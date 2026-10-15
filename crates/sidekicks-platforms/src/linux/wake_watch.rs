//! The machine's wakes from sleep on Linux. On the machine itself, logind's `PrepareForSleep`
//! signal on the system bus, sent with `true` as the machine goes to sleep and `false` once it has
//! resumed. Inside a WSL distribution logind never sends it, since Windows pauses the distribution
//! rather than suspending it, so there the wakes are Windows' own resumes, which the service's
//! Windows half reports over its channel to the daemon. Wakes that come while no one waits count as
//! one.

use std::io;
use std::sync::Arc;

use futures_util::stream::Fuse;
use futures_util::{FutureExt, StreamExt};
use tokio::sync::Notify;
use zbus::Proxy;
use zbus::fdo::DBusProxy;
use zbus::names::BusName;
use zbus::proxy::{Builder, CacheProperties, SignalStream};

use super::folder_place;
use crate::folder_place::FolderPlace;
use crate::wake_watch::WakeWatchError;

// What announces the wakes, as an error names it.
const SOURCE_NAME: &str = "logind's PrepareForSleep signal";

// logind's name, object and interface on the system bus, and the signal it sends around a sleep.
const LOGIN_SERVICE: &str = "org.freedesktop.login1";
const LOGIN_OBJECT: &str = "/org/freedesktop/login1";
const LOGIN_MANAGER_INTERFACE: &str = "org.freedesktop.login1.Manager";
const PREPARE_FOR_SLEEP_SIGNAL: &str = "PrepareForSleep";

/// The machine's wakes from sleep, heard from logind on the system bus or, inside a WSL
/// distribution, from the resumes Windows reports.
pub struct WakeWatch {
    wake_source: WakeSource,
}

// Where the wakes come from.
enum WakeSource {
    // Fused, so once the bus closes every later read sees it closed too.
    Logind(Fuse<SignalStream<'static>>),
    WindowsResumes(Arc<Notify>),
}

impl WakeWatch {
    /// Starts hearing the machine's wakes. Fails with [`WakeWatchError`] when the place the service
    /// runs in cannot be read, or, outside WSL, when the system bus cannot be reached or logind does
    /// not answer on it.
    pub async fn start() -> Result<Self, WakeWatchError> {
        let place = folder_place().map_err(watch_failure)?;
        let wake_source = match place {
            FolderPlace::Wsl { .. } => WakeSource::WindowsResumes(Arc::new(Notify::new())),
            FolderPlace::OwnDisk | FolderPlace::Windows => {
                WakeSource::Logind(logind_sleep_signals().await?.fuse())
            }
        };
        Ok(Self { wake_source })
    }

    /// Waits for the machine's next wake; wakes that came while no one waited count as one.
    /// Cancel-safe. Fails with [`WakeWatchError`] when the system bus closes, after which no wake
    /// is heard; a logind signal that does not read is logged and skipped.
    pub async fn next_wake(&mut self) -> Result<(), WakeWatchError> {
        match &mut self.wake_source {
            WakeSource::Logind(sleep_signals) => {
                // Read until a signal says the machine has resumed.
                while next_sleep_signal(sleep_signals).await? != Some(false) {}
                // Signals already queued are read now, so a run of wakes counts as one; a bus closed
                // meanwhile is seen at the next wait.
                while let Some(Some(_)) = sleep_signals.next().now_or_never() {}
                Ok(())
            }
            WakeSource::WindowsResumes(resumes) => {
                resumes.notified().await;
                Ok(())
            }
        }
    }

    /// What tells each resume the service's Windows half reports to this watch; `None` outside
    /// WSL, where logind tells them.
    #[expect(
        dead_code,
        reason = "the Windows half's power report on a WSL computer"
    )]
    pub(crate) fn windows_resume_sender(&self) -> Option<impl Fn() + Send + Sync + 'static> {
        match &self.wake_source {
            WakeSource::Logind(_) => None,
            WakeSource::WindowsResumes(resumes) => {
                let resumes = Arc::clone(resumes);
                Some(move || resumes.notify_one())
            }
        }
    }
}

// Connects to the system bus, checks logind answers there, and listens for its sleep signal.
async fn logind_sleep_signals() -> Result<SignalStream<'static>, WakeWatchError> {
    let connection = zbus::Connection::system().await.map_err(watch_failure)?;
    let bus = DBusProxy::new(&connection).await.map_err(watch_failure)?;
    let login_service = BusName::try_from(LOGIN_SERVICE).map_err(watch_failure)?;
    if !bus
        .name_has_owner(login_service)
        .await
        .map_err(watch_failure)?
    {
        return Err(watch_failure(io::Error::new(
            io::ErrorKind::NotFound,
            "logind is not on the system bus",
        )));
    }
    let login_manager: Proxy<'static> = Builder::new(&connection)
        .destination(LOGIN_SERVICE)
        .map_err(watch_failure)?
        .path(LOGIN_OBJECT)
        .map_err(watch_failure)?
        .interface(LOGIN_MANAGER_INTERFACE)
        .map_err(watch_failure)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(watch_failure)?;
    login_manager
        .receive_signal(PREPARE_FOR_SLEEP_SIGNAL)
        .await
        .map_err(watch_failure)
}

// Reads logind's next sleep signal: whether the machine is going to sleep, or `None` for a signal
// that does not read, which is logged.
async fn next_sleep_signal(
    sleep_signals: &mut Fuse<SignalStream<'static>>,
) -> Result<Option<bool>, WakeWatchError> {
    let signal = sleep_signals.next().await.ok_or_else(bus_closed)?;
    match signal.body().deserialize::<bool>() {
        Ok(is_going_to_sleep) => Ok(Some(is_going_to_sleep)),
        Err(failure) => {
            tracing::warn!(
                error = &failure as &(dyn std::error::Error + 'static),
                "A sleep signal from logind does not read"
            );
            Ok(None)
        }
    }
}

fn bus_closed() -> WakeWatchError {
    watch_failure(io::Error::new(
        io::ErrorKind::UnexpectedEof,
        "the system bus closed",
    ))
}

fn watch_failure(failure: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> WakeWatchError {
    WakeWatchError {
        source_name: SOURCE_NAME,
        source: failure.into(),
    }
}
