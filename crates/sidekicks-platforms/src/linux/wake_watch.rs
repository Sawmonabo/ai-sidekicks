//! The machine's wakes from sleep on Linux: logind's `PrepareForSleep` signal on the system bus,
//! sent with `true` as the machine goes to sleep and `false` once it has resumed.

use std::io;

use futures_util::StreamExt;
use zbus::Proxy;
use zbus::proxy::{Builder, CacheProperties, SignalStream};

use crate::wake_watch::WakeWatchError;

// What announces the wakes, as an error names it.
const SOURCE_NAME: &str = "logind's PrepareForSleep signal";

// logind's name, object and interface on the system bus, and the signal it sends around a sleep.
const LOGIN_SERVICE: &str = "org.freedesktop.login1";
const LOGIN_OBJECT: &str = "/org/freedesktop/login1";
const LOGIN_MANAGER_INTERFACE: &str = "org.freedesktop.login1.Manager";
const PREPARE_FOR_SLEEP_SIGNAL: &str = "PrepareForSleep";

/// The machine's wakes from sleep, heard from logind on the system bus.
pub struct WakeWatch {
    sleep_signals: SignalStream<'static>,
}

impl WakeWatch {
    /// Starts hearing the machine's wakes. Fails with [`WakeWatchError`] when the system bus cannot
    /// be reached or logind is not on it.
    pub async fn start() -> Result<Self, WakeWatchError> {
        let connection = zbus::Connection::system().await.map_err(watch_failure)?;
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
        let sleep_signals = login_manager
            .receive_signal(PREPARE_FOR_SLEEP_SIGNAL)
            .await
            .map_err(watch_failure)?;
        Ok(Self { sleep_signals })
    }

    /// Waits for the machine's next wake. Cancel-safe. Fails with [`WakeWatchError`] when the
    /// system bus closes or logind sends a signal that does not read.
    pub async fn next_wake(&mut self) -> Result<(), WakeWatchError> {
        loop {
            let signal = self.sleep_signals.next().await.ok_or_else(|| {
                watch_failure(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "the system bus closed",
                ))
            })?;
            let is_going_to_sleep: bool = signal.body().deserialize().map_err(watch_failure)?;
            if !is_going_to_sleep {
                return Ok(());
            }
        }
    }
}

fn watch_failure(failure: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> WakeWatchError {
    WakeWatchError {
        source_name: SOURCE_NAME,
        source: failure.into(),
    }
}
