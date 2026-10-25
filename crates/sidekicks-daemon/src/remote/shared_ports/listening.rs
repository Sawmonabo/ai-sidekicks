//! What listens on the shared ports: the reading Preview's dev-server discovery answers for each
//! one, and the follow the shared ports hold it through while anyone reads their list.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;

use sidekicks_contracts::wire::integer::Port;
use sidekicks_contracts::wire::text::NonEmptyText;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// A listener on a shared port: the address it is bound to and the framework discovery named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PortListening {
    /// The address the listener is bound to.
    pub(crate) bound_address: IpAddr,
    /// The framework discovery named, `None` where it named none.
    pub(crate) framework: Option<NonEmptyText>,
}

/// Every listed port's listener, by port; a port with none has no entry.
pub(crate) type PortListeningReadings = HashMap<Port, PortListening>;

/// Where a source sends each whole set of readings.
pub(crate) type PortListeningSink = Arc<dyn Fn(PortListeningReadings) + Send + Sync>;

/// The machine's listening read over the shared ports, which Preview's dev-server discovery
/// answers from its one probe loop.
pub(crate) trait SharedPortListeningSource: Send + Sync {
    /// Follows the listeners on the ports `listed` holds, the list changing as ports are shared
    /// and removed: sends `sink` every listed port's reading once it has them and again whenever
    /// one changes, until `stop` is canceled. Readings it holds already go to `sink` inside this
    /// call, so a first reader's first list is right whenever the source has read. For a port
    /// with several listeners it reports one that
    /// [`is_reached_by_loopback_connect`](super::loopback::is_reached_by_loopback_connect) accepts,
    /// where there is one. At most one follow is live: a new one starts only once the last one's
    /// `stop` is canceled, so a source may replace its follow. It reads nothing while `listed` is
    /// empty, and nothing at all when `stop` is canceled already, as a reader that left at once
    /// leaves it.
    fn follow(
        &self,
        listed: watch::Receiver<Vec<Port>>,
        sink: PortListeningSink,
        stop: CancellationToken,
    );
}
