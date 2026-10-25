//! Whether this machine runs on AC power on Linux: UPower's `OnBattery` property on the system bus,
//! read once as the watch starts and then followed through UPower's `PropertiesChanged` signal,
//! never polled; a UPower that is installed but not running is started by the first read, as the
//! bus does for any activatable name. When UPower leaves the bus the machine reads as not on AC
//! power until it is back, and then the property is read afresh. A system bus or UPower that
//! cannot be reached reads as not on AC power.

use std::error::Error;
use std::sync::Arc;

use futures_util::{Stream, StreamExt, stream};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use zbus::Proxy;
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

// What the system bus tells about UPower: a value of `OnBattery`, or its owner leaving or arriving.
#[derive(Debug, PartialEq, Eq)]
enum Reading {
    OnBattery(bool),
    OwnerGone,
    OwnerBack,
}

// Why `publish_readings` returned.
#[derive(Debug, PartialEq, Eq)]
enum ReadingsEnd {
    // UPower is back on the bus, so its property must be read afresh.
    OwnerBack,
    // The stream ended: the bus connection is gone.
    Closed,
}

// Reads UPower's `OnBattery` and publishes each reading until the watch drops, reading the property
// afresh each time UPower comes back to the bus.
async fn follow_power_source(on_ac: Arc<watch::Sender<bool>>) {
    let connection = match zbus::Connection::system().await {
        Ok(connection) => connection,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the system bus cannot be reached, so this machine reads as not on ac power"
            );
            return;
        }
    };
    loop {
        let readings = match upower_readings(&connection).await {
            Ok(readings) => readings,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "upower cannot be reached, so this machine reads as not on ac power"
                );
                return;
            }
        };
        match publish_readings(readings, &on_ac).await {
            ReadingsEnd::OwnerBack => {}
            ReadingsEnd::Closed => return,
        }
    }
}

// Streams what the bus tells about UPower: `OnBattery` as read at the start (the read starts an
// installed UPower that is not yet running), each value its `PropertiesChanged` signal carries, and
// each change of UPower's owner on the bus.
async fn upower_readings(
    connection: &zbus::Connection,
) -> zbus::Result<impl Stream<Item = zbus::Result<Reading>> + use<>> {
    let upower: Proxy<'static> = Builder::new(connection)
        .destination(UPOWER_SERVICE)?
        .path(UPOWER_OBJECT)?
        .interface(UPOWER_INTERFACE)?
        .cache_properties(CacheProperties::Yes)
        .build()
        .await?;
    let owner_changes = upower.receive_owner_changed().await?.map(|owner| {
        Ok(match owner {
            Some(_) => Reading::OwnerBack,
            None => Reading::OwnerGone,
        })
    });
    let values = upower
        .receive_property_changed::<bool>(ON_BATTERY_PROPERTY)
        .await
        .then(|changed| async move { changed.get().await.map(Reading::OnBattery) });
    Ok(stream::select(values, owner_changes))
}

// Publishes whether each reading means AC power, only when that changed: `OnBattery` as read, an
// owner gone as not on AC, a reading that fails as not on AC with one log line until a reading
// succeeds again. Returns when UPower's owner is back, so the caller reads the property afresh, or
// when the stream ends.
async fn publish_readings<E: Error + 'static>(
    readings: impl Stream<Item = Result<Reading, E>>,
    on_ac: &watch::Sender<bool>,
) -> ReadingsEnd {
    let mut readings = std::pin::pin!(readings);
    let mut is_failure_logged = false;
    while let Some(reading) = readings.next().await {
        let is_on_ac = match reading {
            Ok(Reading::OnBattery(is_on_battery)) => {
                is_failure_logged = false;
                !is_on_battery
            }
            Ok(Reading::OwnerGone) => false,
            Ok(Reading::OwnerBack) => return ReadingsEnd::OwnerBack,
            Err(error) => {
                if !is_failure_logged {
                    is_failure_logged = true;
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "upower's battery reading failed, so this machine reads as not on ac power"
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
    ReadingsEnd::Closed
}

#[cfg(test)]
mod tests {
    use std::io;

    use futures_util::stream;
    use rstest::rstest;
    use tokio::sync::watch;

    use super::Reading::{OnBattery, OwnerBack, OwnerGone};
    use super::{ReadingsEnd, publish_readings};

    // Each reading after the first is followed, a reading that fails or an owner gone reads as not
    // on AC, and an owner back ends the stream for a fresh read. Killed by the loop ending after
    // its first reading (`while let` made `if let`), by the `!` dropped from `!is_on_battery`, by
    // the failure or owner-gone arm publishing `true`, and by the owner-back arm publishing instead
    // of returning.
    #[rstest]
    #[case::on_battery_then_on_ac(vec![Ok(OnBattery(true)), Ok(OnBattery(false))], true, ReadingsEnd::Closed)]
    #[case::on_ac_then_on_battery(vec![Ok(OnBattery(false)), Ok(OnBattery(true))], false, ReadingsEnd::Closed)]
    #[case::on_ac_then_a_failed_reading(
        vec![Ok(OnBattery(false)), Err(io::Error::other("no reply"))],
        false,
        ReadingsEnd::Closed
    )]
    #[case::on_ac_then_upower_gone(vec![Ok(OnBattery(false)), Ok(OwnerGone)], false, ReadingsEnd::Closed)]
    #[case::upower_back_ends_the_stream(
        vec![Ok(OnBattery(false)), Ok(OwnerBack), Ok(OnBattery(true))],
        true,
        ReadingsEnd::OwnerBack
    )]
    #[tokio::test]
    async fn the_watch_publishes_the_newest_reading(
        #[case] readings: Vec<io::Result<super::Reading>>,
        #[case] is_on_ac: bool,
        #[case] end: ReadingsEnd,
    ) {
        let on_ac = watch::Sender::new(!is_on_ac);

        let readings_end = publish_readings(stream::iter(readings), &on_ac).await;

        assert_eq!(*on_ac.borrow(), is_on_ac);
        assert_eq!(readings_end, end);
    }
}
