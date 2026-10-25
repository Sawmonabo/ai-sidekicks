//! Whether this machine runs on AC power on Linux: UPower's `OnBattery` property on the system bus,
//! read once as the watch starts and then followed through UPower's `PropertiesChanged` signal,
//! never polled. A system bus or UPower that cannot be reached reads as not on AC power.

use std::error::Error;
use std::io;
use std::sync::Arc;

use futures_util::{Stream, StreamExt};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use zbus::Proxy;
use zbus::fdo::DBusProxy;
use zbus::names::BusName;
use zbus::proxy::{Builder, CacheProperties};

// UPower's name, object and interface on the system bus, and its property that tells the battery.
const UPOWER_SERVICE: &str = "org.freedesktop.UPower";
const UPOWER_OBJECT: &str = "/org/freedesktop/UPower";
const UPOWER_INTERFACE: &str = "org.freedesktop.UPower";
const ON_BATTERY_PROPERTY: &str = "OnBattery";

/// Whether this machine runs on AC power, read from UPower once at start and followed through its
/// property changes; a system bus or UPower that cannot be reached reads as not on AC.
pub struct PowerSourceWatch {
    // Kept, so receivers stay open while the watch lives.
    on_ac: Arc<watch::Sender<bool>>,
    // The task that reads UPower and publishes each reading, ended with the watch.
    follow: JoinHandle<()>,
}

impl PowerSourceWatch {
    /// Starts hearing the power source on the running Tokio runtime, and panics outside one. Never
    /// fails: the reading is not on AC until UPower's first answer, and stays so when the system
    /// bus or UPower cannot be reached, which is logged once.
    pub fn start() -> Self {
        let on_ac = Arc::new(watch::Sender::new(false));
        let follow = tokio::spawn(follow_power_source(Arc::clone(&on_ac)));
        Self { on_ac, follow }
    }

    /// A receiver of whether this machine runs on AC power, holding the newest reading and told of
    /// each change.
    pub fn receiver(&self) -> watch::Receiver<bool> {
        self.on_ac.subscribe()
    }
}

impl Drop for PowerSourceWatch {
    fn drop(&mut self) {
        self.follow.abort();
    }
}

// Reads UPower's `OnBattery` and publishes each reading until the watch drops.
async fn follow_power_source(on_ac: Arc<watch::Sender<bool>>) {
    match on_battery_readings().await {
        Ok(readings) => publish_readings(readings, &on_ac).await,
        Err(error) => tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "upower cannot be reached, so this machine reads as not on ac power"
        ),
    }
}

// Connects to the system bus, checks UPower answers there, and streams its `OnBattery` property:
// the value read at the start first, then each value its `PropertiesChanged` signal carries.
async fn on_battery_readings() -> zbus::Result<impl Stream<Item = zbus::Result<bool>>> {
    let connection = zbus::Connection::system().await?;
    let bus = DBusProxy::new(&connection).await?;
    if !bus
        .name_has_owner(BusName::try_from(UPOWER_SERVICE)?)
        .await?
    {
        return Err(zbus::Error::InputOutput(Arc::new(io::Error::new(
            io::ErrorKind::NotFound,
            "upower is not on the system bus",
        ))));
    }
    let upower: Proxy<'static> = Builder::new(&connection)
        .destination(UPOWER_SERVICE)?
        .path(UPOWER_OBJECT)?
        .interface(UPOWER_INTERFACE)?
        .cache_properties(CacheProperties::Yes)
        .build()
        .await?;
    Ok(upower
        .receive_property_changed::<bool>(ON_BATTERY_PROPERTY)
        .await
        .then(|changed| async move { changed.get().await }))
}

// Publishes whether each reading of `OnBattery` means AC power, only when that changed; a reading
// that fails publishes not on AC and logs once until a reading succeeds again.
async fn publish_readings<E: Error + 'static>(
    readings: impl Stream<Item = Result<bool, E>>,
    on_ac: &watch::Sender<bool>,
) {
    let mut readings = std::pin::pin!(readings);
    let mut is_failure_logged = false;
    while let Some(reading) = readings.next().await {
        let is_on_ac = match reading {
            Ok(is_on_battery) => {
                is_failure_logged = false;
                !is_on_battery
            }
            Err(error) => {
                if !is_failure_logged {
                    is_failure_logged = true;
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "upower's battery reading does not read, so this machine reads as not on \
                         ac power"
                    );
                }
                false
            }
        };
        on_ac.send_if_modified(|current| {
            let is_changed = *current != is_on_ac;
            *current = is_on_ac;
            is_changed
        });
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use futures_util::stream;
    use rstest::rstest;
    use tokio::sync::watch;

    use super::publish_readings;

    // Each reading after the first is followed, and a reading that fails reads as not on AC. Killed
    // by the loop ending after its first reading (`while let` made `if let`), by the `!` dropped
    // from `!is_on_battery`, and by the failure arm publishing `true`.
    #[rstest]
    #[case::on_battery_then_on_ac(vec![Ok(true), Ok(false)], true)]
    #[case::on_ac_then_on_battery(vec![Ok(false), Ok(true)], false)]
    #[case::on_ac_then_a_failed_reading(vec![Ok(false), Err(io::Error::other("no reply"))], false)]
    #[tokio::test]
    async fn the_watch_publishes_the_newest_reading(
        #[case] readings: Vec<io::Result<bool>>,
        #[case] is_on_ac: bool,
    ) {
        let on_ac = watch::Sender::new(!is_on_ac);

        publish_readings(stream::iter(readings), &on_ac).await;

        assert_eq!(*on_ac.borrow(), is_on_ac);
    }
}
