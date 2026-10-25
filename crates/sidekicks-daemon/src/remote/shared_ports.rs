//! The ports this machine shares with the person's other devices: the list, kept in the database
//! and in memory, each port's close signal, the readers of the list, and the loopback connect that
//! checks the list before it dials.
//!
//! A change to the list runs one at a time under the change lock, in one order: the table is
//! written, memory follows, a removed port's signal fires, then every reader gets the new list. A
//! failed write so changes nothing, and no reader sees a list the table does not hold. Memory and
//! the readers sit under a second lock no holder keeps across an await, so a connect answers from
//! memory at once, even while a change waits on its write.

use std::sync::{Arc, Mutex, Weak};

use jiff::{SignedDuration, Timestamp};
use sidekicks_contracts::preview::port::{PreviewPortShareListFrame, PreviewSharedPort};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::Port;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::{DatabaseWriter, WriteError};
use crate::ipc::stream::latest_value::LatestValueOutlet;
use crate::mutex_lock::lock;
use crate::remote::shared_ports::listening::{
    PortListeningReadings, PortListeningSink, SharedPortListeningSource,
};
use crate::remote::shared_ports::loopback::{
    SharedPortConnectError, SharedPortConnection, connect_loopback, is_reached_by_loopback_connect,
};
use crate::remote::shared_ports::store::{
    SharedPortsReadError, delete_every_shared_port, delete_shared_port, insert_shared_port,
    read_shared_ports,
};

pub(crate) mod listening;
pub(crate) mod loopback;
pub(crate) mod methods;
pub(crate) mod schema;
pub(crate) mod store;

/// Why a port could not be shared.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SharedPortAddError {
    /// The port is shared already; nothing changed.
    #[error("port {} is already shared", port.get())]
    AlreadyShared {
        /// The port.
        port: Port,
    },
    /// The row was not stored, so nothing changed.
    #[error(transparent)]
    Write(#[from] WriteError),
}

/// The shared-ports list with its close signals and readers; see the module doc.
pub(crate) struct SharedPorts {
    writer: Arc<DatabaseWriter>,
    listening_source: Arc<dyn SharedPortListeningSource>,
    /// Runs add, remove and clear one at a time, held across each one's write.
    changes: tokio::sync::Mutex<()>,
    /// The list in memory and its readers; never held across an await.
    list: Mutex<SharedPortList>,
}

/// One shared port in memory.
struct SharedPort {
    port: Port,
    added_at: WireInstant,
    /// Fired when the port stops being shared; every open connection on it holds a child.
    closed: CancellationToken,
}

struct SharedPortList {
    /// The shared ports, in the order they were added.
    ports: Vec<SharedPort>,
    /// What the listening source last read, cleared while nobody reads the list.
    listening: PortListeningReadings,
    /// The listed ports the listening source follows.
    listed: watch::Sender<Vec<Port>>,
    /// Each reader's outlet, by the id its detach removes it with.
    readers: Vec<(u64, LatestValueOutlet<PreviewPortShareListFrame>)>,
    next_reader_id: u64,
    /// Stops the listening source's follow, held while any reader reads the list.
    listening_follow: Option<CancellationToken>,
}

impl SharedPortList {
    fn position(&self, port: Port) -> Option<usize> {
        self.ports.iter().position(|shared| shared.port == port)
    }

    fn frame(&self) -> PreviewPortShareListFrame {
        let ports = self
            .ports
            .iter()
            .map(|shared| {
                let listener = self
                    .listening
                    .get(&shared.port)
                    .filter(|listener| is_reached_by_loopback_connect(listener.bound_address));
                PreviewSharedPort {
                    port: shared.port,
                    framework: listener.and_then(|listener| listener.framework.clone()),
                    listening: listener.is_some(),
                    added_at: shared.added_at.clone(),
                }
            })
            .collect();
        PreviewPortShareListFrame { ports }
    }

    // Tells the listening source and every reader of a change to the list.
    fn announce_list(&self) {
        self.listed
            .send_replace(self.ports.iter().map(|shared| shared.port).collect());
        self.announce_frame();
    }

    fn announce_frame(&self) {
        let frame = self.frame();
        for (_, reader) in &self.readers {
            reader.send(frame.clone());
        }
    }
}

impl SharedPorts {
    /// The list as the table keeps it, each port with a fresh close signal; `listening_source`
    /// says what listens on each port while anyone reads the list. Fails with
    /// [`SharedPortsReadError`] when the table cannot be read.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start opens the shared ports once its database is open"
        )
    )]
    pub(crate) async fn open(
        reads: &DatabaseReadPool,
        writer: Arc<DatabaseWriter>,
        listening_source: Arc<dyn SharedPortListeningSource>,
    ) -> Result<Arc<Self>, SharedPortsReadError> {
        let ports: Vec<SharedPort> = read_shared_ports(reads)
            .await?
            .into_iter()
            .map(|stored| SharedPort {
                port: stored.port,
                added_at: stored.added_at,
                closed: CancellationToken::new(),
            })
            .collect();
        let listed = watch::Sender::new(ports.iter().map(|shared| shared.port).collect());
        Ok(Arc::new(Self {
            writer,
            listening_source,
            changes: tokio::sync::Mutex::new(()),
            list: Mutex::new(SharedPortList {
                ports,
                listening: PortListeningReadings::new(),
                listed,
                readers: Vec::new(),
                next_reader_id: 0,
                listening_follow: None,
            }),
        }))
    }

    /// Shares `port` and answers when it was shared: strictly later than every port already on
    /// the list, so the list's order is the order added even when the clock steps back. Fails with
    /// [`SharedPortAddError::AlreadyShared`] for a listed port, and with
    /// [`SharedPortAddError::Write`] when the row was not stored; either way nothing changes.
    pub(crate) async fn add(&self, port: Port) -> Result<WireInstant, SharedPortAddError> {
        let _change = self.changes.lock().await;
        let newest = {
            let list = lock(&self.list);
            if list.position(port).is_some() {
                return Err(SharedPortAddError::AlreadyShared { port });
            }
            list.ports
                .last()
                .and_then(|shared| shared.added_at.timestamp())
        };
        let added_at = added_after(newest);
        insert_shared_port(&self.writer, port, &added_at).await?;
        let mut list = lock(&self.list);
        list.ports.push(SharedPort {
            port,
            added_at: added_at.clone(),
            closed: CancellationToken::new(),
        });
        list.announce_list();
        Ok(added_at)
    }

    /// Stops sharing `port` and closes every connection open on it; a port that is not shared
    /// changes nothing. Fails with [`WriteError`] when the row was not removed, with the port
    /// still shared and its connections open.
    pub(crate) async fn remove(&self, port: Port) -> Result<(), WriteError> {
        let _change = self.changes.lock().await;
        if lock(&self.list).position(port).is_none() {
            return Ok(());
        }
        delete_shared_port(&self.writer, port).await?;
        let mut list = lock(&self.list);
        let index = list
            .position(port)
            .expect("only a change removes a port, and the change lock is held");
        list.ports.remove(index).closed.cancel();
        tracing::info!(
            port = port.get(),
            "the port stopped being shared and every connection on it was closed"
        );
        list.announce_list();
        Ok(())
    }

    /// Stops sharing every port and closes every connection open on them, as removing this
    /// machine does. Fails with [`WriteError`] when the rows were not removed, with nothing
    /// changed.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "applying this machine's removal stops every shared port"
        )
    )]
    pub(crate) async fn clear(&self) -> Result<(), WriteError> {
        let _change = self.changes.lock().await;
        if lock(&self.list).ports.is_empty() {
            return Ok(());
        }
        delete_every_shared_port(&self.writer).await?;
        let mut list = lock(&self.list);
        for shared in list.ports.drain(..) {
            shared.closed.cancel();
        }
        tracing::info!("every shared port stopped being shared and its connections were closed");
        list.announce_list();
        Ok(())
    }

    /// Opens a connection to `port`'s server on this machine's loopback, when the port is shared;
    /// its close signal fires when the port stops being shared, a stop that lands during the dial
    /// included. Fails with [`SharedPortConnectError::NotShared`] for an unlisted port, which is
    /// never dialed, and as the loopback connect does.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the port tunnel and the browser address's forward open their loopback \
                      connection here"
        )
    )]
    pub(crate) async fn connect(
        &self,
        port: Port,
    ) -> Result<SharedPortConnection, SharedPortConnectError> {
        let closed = {
            let list = lock(&self.list);
            let Some(index) = list.position(port) else {
                tracing::info!(
                    port = port.get(),
                    "a connection to a port that is not shared was refused"
                );
                return Err(SharedPortConnectError::NotShared { port });
            };
            list.ports[index].closed.child_token()
        };
        connect_loopback(port, closed).await
    }

    /// Sends the list as it stands through `outlet`, then every later list, until the answered
    /// detach runs. The first reader starts following what listens on the ports, and the last
    /// one's detach stops it.
    pub(crate) fn follow(
        self: &Arc<Self>,
        outlet: LatestValueOutlet<PreviewPortShareListFrame>,
    ) -> impl FnOnce() + Send + use<> {
        let (id, listening_follow) = {
            let mut list = lock(&self.list);
            let listening_follow = if list.listening_follow.is_none() {
                // Readings from a follow that stopped are stale.
                list.listening.clear();
                let stop = CancellationToken::new();
                list.listening_follow = Some(stop.clone());
                Some((list.listed.subscribe(), stop))
            } else {
                None
            };
            outlet.send(list.frame());
            let id = list.next_reader_id;
            list.next_reader_id += 1;
            list.readers.push((id, outlet));
            (id, listening_follow)
        };
        // Outside the lock, so a source that reads at once can hand its readings straight in.
        if let Some((listed, stop)) = listening_follow {
            let sink = self.listening_sink(stop.clone());
            self.listening_source.follow(listed, sink, stop);
        }
        let shared_ports: Weak<Self> = Arc::downgrade(self);
        move || {
            if let Some(shared_ports) = shared_ports.upgrade() {
                let mut list = lock(&shared_ports.list);
                list.readers.retain(|(reader_id, _)| *reader_id != id);
                if list.readers.is_empty()
                    && let Some(stop) = list.listening_follow.take()
                {
                    stop.cancel();
                }
            }
        }
    }

    // Takes the readings of the follow `stop` ends, none once it ended.
    fn listening_sink(self: &Arc<Self>, stop: CancellationToken) -> PortListeningSink {
        let shared_ports: Weak<Self> = Arc::downgrade(self);
        Arc::new(move |readings: PortListeningReadings| {
            if let Some(shared_ports) = shared_ports.upgrade() {
                let mut list = lock(&shared_ports.list);
                if !stop.is_cancelled() && list.listening != readings {
                    list.listening = readings;
                    list.announce_frame();
                }
            }
        })
    }
}

// The later of now and a millisecond past `newest`, the newest instant on the list.
fn added_after(newest: Option<Timestamp>) -> WireInstant {
    let now = Timestamp::now();
    let after_newest =
        newest.and_then(|newest| newest.checked_add(SignedDuration::from_millis(1)).ok());
    WireInstant::from_timestamp(after_newest.map_or(now, |after_newest| after_newest.max(now)))
        .expect("the clock reads after year 0000")
}
