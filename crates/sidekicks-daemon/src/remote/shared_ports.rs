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
use sidekicks_ipc::stream::latest_value::{LatestValueOutlet, LatestValueOutlets};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

pub(crate) mod listening;
pub(crate) mod loopback;
pub(crate) mod methods;
pub mod schema;
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
    /// What the listening source last read, cleared when a new follow starts.
    listening: PortListeningReadings,
    /// The listed ports the listening source follows.
    listed: watch::Sender<Vec<Port>>,
    /// Each reader's outlet.
    readers: LatestValueOutlets<PreviewPortShareListFrame>,
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
        self.readers.send(&self.frame());
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
                readers: LatestValueOutlets::default(),
                listening_follow: None,
            }),
        }))
    }

    /// Shares `port` and answers when it was shared: strictly later than every port already on
    /// the list, so the list's order is the order added even when the clock steps back. Fails with
    /// [`SharedPortAddError::AlreadyShared`] for a listed port, and with
    /// [`SharedPortAddError::Write`] when the row was not stored; either way nothing changes. The
    /// call runs to its answer: a caller never drops its future, which would leave memory behind
    /// the table.
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
    /// still shared and its connections open. The call runs to its answer: a caller never drops
    /// its future, which would leave memory behind the table.
    pub(crate) async fn remove(&self, port: Port) -> Result<(), WriteError> {
        let _change = self.changes.lock().await;
        if lock(&self.list).position(port).is_none() {
            return Ok(());
        }
        delete_shared_port(&self.writer, port).await?;
        {
            let mut list = lock(&self.list);
            let index = list
                .position(port)
                .expect("only a change removes a port, and the change lock is held");
            list.ports.remove(index).closed.cancel();
            list.announce_list();
        }
        tracing::info!(
            port = port.get(),
            "the port stopped being shared and every connection on it was closed"
        );
        Ok(())
    }

    /// Stops sharing every port and closes every connection open on them, as removing this
    /// machine does. Fails with [`WriteError`] when the rows were not removed, with nothing
    /// changed. The call runs to its answer: a caller never drops its future, which would leave
    /// memory behind the table.
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
        {
            let mut list = lock(&self.list);
            for shared in list.ports.drain(..) {
                shared.closed.cancel();
            }
            list.announce_list();
        }
        tracing::info!("every shared port stopped being shared and its connections were closed");
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
            reason = "the port tunnel and the web address's forward open their loopback \
                      connection here"
        )
    )]
    pub(crate) async fn connect(
        &self,
        port: Port,
    ) -> Result<SharedPortConnection, SharedPortConnectError> {
        let closed = {
            let list = lock(&self.list);
            list.position(port)
                .map(|index| list.ports[index].closed.child_token())
        };
        let Some(closed) = closed else {
            tracing::info!(
                port = port.get(),
                "a connection to a port that is not shared was refused"
            );
            return Err(SharedPortConnectError::NotShared { port });
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
            (list.readers.attach(outlet), listening_follow)
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
                list.readers.detach(id);
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
                if stop.is_cancelled() {
                    return;
                }
                let before = list.frame();
                list.listening = readings;
                // A changed reading the frame does not show, such as one at an address the
                // connect does not reach, sends nothing.
                if list.frame() != before {
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

#[cfg(test)]
mod tests {
    use std::io;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use jiff::{SignedDuration, Timestamp};
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::preview::port::{PreviewPortShareListFrame, PreviewSharedPort};
    use sidekicks_contracts::wire::integer::Port;
    use sidekicks_contracts::wire::text::NonEmptyText;
    use tokio::sync::watch;
    use tokio_util::sync::CancellationToken;

    use super::listening::{
        PortListening, PortListeningReadings, PortListeningSink, SharedPortListeningSource,
    };
    use super::loopback::SharedPortConnectError;
    use super::methods::port_not_shared;
    use super::store::SHARED_PORTS_STATEMENT_CAPACITY;
    use super::{SharedPortAddError, SharedPorts, added_after};
    use crate::remote::shared_ports::schema::schema_parts;
    use sidekicks_ipc::domain_error::refusal_fields;
    use sidekicks_ipc::stream::feed::{CreditGate, Feed};
    use sidekicks_ipc::stream::latest_value::LatestValueFeed;
    use sidekicks_std::mutex_lock::lock;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    const WAIT: Duration = Duration::from_secs(10);

    // How long a reader waits to be sure no list was sent.
    const QUIET: Duration = Duration::from_millis(200);

    /// A listening source that reads nothing itself, so every port reads as not listening until a
    /// test sends readings through a follow it kept.
    #[derive(Default)]
    struct KeptFollows {
        /// Each follow's sink, in the order the follows started.
        follows: Mutex<Vec<PortListeningSink>>,
    }

    impl KeptFollows {
        fn follow_sink(&self, index: usize) -> PortListeningSink {
            Arc::clone(&lock(&self.follows)[index])
        }
    }

    impl SharedPortListeningSource for KeptFollows {
        fn follow(
            &self,
            _listed: watch::Receiver<Vec<Port>>,
            sink: PortListeningSink,
            _stop: CancellationToken,
        ) {
            lock(&self.follows).push(sink);
        }
    }

    async fn open_writer(database: &TestDatabase) -> Arc<DatabaseWriter> {
        Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        )
    }

    async fn open_shared_ports(
        database: &TestDatabase,
        writer: Arc<DatabaseWriter>,
    ) -> Arc<SharedPorts> {
        open_shared_ports_reading(database, writer, Arc::new(KeptFollows::default())).await
    }

    async fn open_shared_ports_reading(
        database: &TestDatabase,
        writer: Arc<DatabaseWriter>,
        listening_source: Arc<KeptFollows>,
    ) -> Arc<SharedPorts> {
        let reads = DatabaseReadPool::new(database.path(), SHARED_PORTS_STATEMENT_CAPACITY);
        SharedPorts::open(&reads, writer, listening_source)
            .await
            .expect("the shared ports read")
    }

    async fn follow_list(
        shared_ports: &Arc<SharedPorts>,
    ) -> impl Feed<Emission = PreviewPortShareListFrame> + use<> {
        let shared_ports = Arc::clone(shared_ports);
        LatestValueFeed::open(|outlet| async move { Ok(shared_ports.follow(outlet)) })
            .await
            .expect("the list is followed")
    }

    // The ports of the next list `feed` reads.
    async fn next_ports(
        feed: &mut impl Feed<Emission = PreviewPortShareListFrame>,
        gate: &CreditGate,
    ) -> Vec<PreviewSharedPort> {
        tokio::time::timeout(WAIT, feed.next(gate))
            .await
            .expect("a list comes")
            .expect("the list reads")
            .expect("the stream goes on")
            .ports
    }

    fn port(number: u16) -> Port {
        Port::new(number).expect("the test names a port number")
    }

    // A listener on an ephemeral port of `address`, which nothing dials unless the test does.
    fn listener_on(address: SocketAddr) -> (TcpListener, Port) {
        let listener = TcpListener::bind(address).expect("the test binds a loopback listener");
        listener
            .set_nonblocking(true)
            .expect("the listener stops blocking");
        let bound = listener.local_addr().expect("the listener has an address");
        (listener, port(bound.port()))
    }

    // Killed by the membership check removed from `connect` (the dial reaches the listener), and by
    // memory taking a port before its write commits (the failed add's port would read shared).
    #[rstest]
    #[case::never_added(false)]
    #[case::added_while_the_writer_had_ended(true)]
    #[tokio::test]
    async fn an_unlisted_port_is_never_dialed(#[case] is_add_attempted: bool) {
        let database = TestDatabase::new(schema_parts());
        let writer = open_writer(&database).await;
        let shared_ports = open_shared_ports(&database, Arc::clone(&writer)).await;
        let (listener, listened_port) = listener_on((Ipv4Addr::LOCALHOST, 0).into());
        if is_add_attempted {
            writer.end(Arc::new(io::Error::other("the test ended the writer")));
            let added = shared_ports.add(listened_port).await;
            assert!(matches!(added, Err(SharedPortAddError::Write(_))));
        }

        let Err(SharedPortConnectError::NotShared { port: refused_port }) =
            shared_ports.connect(listened_port).await
        else {
            panic!("an unlisted port is refused");
        };
        let refusal = port_not_shared(refused_port);
        assert_eq!(refusal.code, RefusalCode::PreviewPortNotShared);
        assert_eq!(
            refusal.detail,
            Some(refusal_fields(json!({ "port": listened_port.get() })))
        );
        let accepted = listener.accept();
        assert!(
            matches!(&accepted, Err(error) if error.kind() == io::ErrorKind::WouldBlock),
            "nothing reached the listener: {accepted:?}"
        );
    }

    // A failed `[::1]` bind fails the IPv6 case: every machine the tests run on keeps `::1` on its
    // loopback. Killed by a dial of one family only, and by giving up after the first family fails.
    #[rstest]
    #[case::ipv4_only(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))]
    #[case::ipv6_only(SocketAddr::from((Ipv6Addr::LOCALHOST, 0)))]
    #[tokio::test]
    async fn a_shared_port_is_reached_on_either_loopback_family(#[case] address: SocketAddr) {
        let database = TestDatabase::new(schema_parts());
        let shared_ports = open_shared_ports(&database, open_writer(&database).await).await;
        let (listener, listened_port) = listener_on(address);
        shared_ports
            .add(listened_port)
            .await
            .expect("the port is shared");

        let connection = shared_ports
            .connect(listened_port)
            .await
            .expect("the shared port's server is reached");
        let (stream, _closed) = connection.into_parts();
        assert_eq!(
            stream.peer_addr().expect("the stream has a peer"),
            listener.local_addr().expect("the listener has an address")
        );
        assert!(stream.nodelay().expect("the stream's no-delay reads"));
    }

    // Killed by a remove or a clear that skips the cancel, and by a re-add that keeps the removed
    // port's signal (its new connection would be born closed).
    #[tokio::test]
    async fn stop_sharing_closes_every_connection_open_on_the_port() {
        let database = TestDatabase::new(schema_parts());
        let shared_ports = open_shared_ports(&database, open_writer(&database).await).await;
        let (_first_listener, first_port) = listener_on((Ipv4Addr::LOCALHOST, 0).into());
        let (_second_listener, second_port) = listener_on((Ipv4Addr::LOCALHOST, 0).into());
        let connect = async |port: Port| {
            let connection = shared_ports
                .connect(port)
                .await
                .expect("the shared port's server is reached");
            connection.into_parts()
        };
        shared_ports
            .add(first_port)
            .await
            .expect("the port is shared");
        let (_first_stream, first_closed) = connect(first_port).await;
        let (_second_stream, second_closed) = connect(first_port).await;

        shared_ports
            .remove(first_port)
            .await
            .expect("the port stops being shared");
        for closed in [&first_closed, &second_closed] {
            tokio::time::timeout(WAIT, closed.cancelled())
                .await
                .expect("each connection on the removed port is closed");
        }

        shared_ports
            .add(first_port)
            .await
            .expect("the port is shared again");
        shared_ports
            .add(second_port)
            .await
            .expect("a second port is shared");
        let (_readded_stream, readded_closed) = connect(first_port).await;
        let (_other_stream, other_closed) = connect(second_port).await;
        assert!(
            !readded_closed.is_cancelled(),
            "a re-added port has a fresh signal"
        );

        shared_ports
            .clear()
            .await
            .expect("every port stops being shared");
        assert!(readded_closed.is_cancelled());
        assert!(other_closed.is_cancelled());
        assert!(matches!(
            shared_ports.connect(second_port).await,
            Err(SharedPortConnectError::NotShared { .. })
        ));
    }

    // Killed by an add whose insert is dropped (the reopened list is empty), by a list read in port
    // order (the ports are added high first), and by a list sent for a refused, unchanged or failed
    // call, an announce placed before the write among them.
    #[tokio::test]
    async fn the_list_keeps_the_order_added_across_a_restart_and_announces_only_changes() {
        let database = TestDatabase::new(schema_parts());
        let (first, second, never_added) = (port(5174), port(5173), port(3000));
        let writer = open_writer(&database).await;
        let shared_ports = open_shared_ports(&database, Arc::clone(&writer)).await;
        let gate = CreditGate::with_credit(1);
        let mut feed = follow_list(&shared_ports).await;
        assert_eq!(next_ports(&mut feed, &gate).await, Vec::new());

        let first_added_at = shared_ports.add(first).await.expect("the port is shared");
        let after_first = next_ports(&mut feed, &gate).await;
        assert_eq!(after_first.len(), 1);
        assert_eq!(after_first[0].port, first);
        assert_eq!(after_first[0].added_at, first_added_at);
        let second_added_at = shared_ports.add(second).await.expect("the port is shared");
        let after_second = next_ports(&mut feed, &gate).await;

        let Err(SharedPortAddError::AlreadyShared { port: refused }) =
            shared_ports.add(first).await
        else {
            panic!("a port shared already is refused");
        };
        assert_eq!(refused, first);
        shared_ports
            .remove(never_added)
            .await
            .expect("removing a port that is not shared answers the same");
        writer.end(Arc::new(io::Error::other("the test ended the writer")));
        assert!(matches!(
            shared_ports.add(never_added).await,
            Err(SharedPortAddError::Write(_))
        ));
        assert!(
            tokio::time::timeout(QUIET, feed.next(&gate)).await.is_err(),
            "no list is sent for a call that changed nothing"
        );
        drop(feed);
        drop(shared_ports);
        drop(writer);

        let reopened = open_shared_ports(&database, open_writer(&database).await).await;
        let reopened_list = next_ports(&mut follow_list(&reopened).await, &gate).await;
        assert_eq!(reopened_list, after_second);
        assert_eq!(
            reopened_list
                .iter()
                .map(|shared| (shared.port, shared.added_at.clone()))
                .collect::<Vec<_>>(),
            vec![(first, first_added_at), (second, second_added_at)]
        );
    }

    // Killed by `frame` keeping a listener the loopback connect does not reach, its filter deleted
    // or swapped for `IpAddr::is_loopback` (the `127.0.0.2` port would read listening), by a filter
    // that refuses `[::1]` or `0.0.0.0` (the `[::1]` or `0.0.0.0` port would read nothing), by a sink
    // that takes a stopped follow's readings (the late reading would reach the next reader), and by
    // a new follow that keeps the last one's readings (its first list would read listening).
    #[tokio::test]
    async fn only_a_listener_the_loopback_connect_reaches_reads_listening() {
        let database = TestDatabase::new(schema_parts());
        let listening_source = Arc::new(KeptFollows::default());
        let shared_ports = open_shared_ports_reading(
            &database,
            open_writer(&database).await,
            Arc::clone(&listening_source),
        )
        .await;
        let (reached, reached_v6, reached_any, unreached) =
            (port(5173), port(5174), port(5175), port(5176));
        for shared in [reached, reached_v6, reached_any, unreached] {
            shared_ports.add(shared).await.expect("the port is shared");
        }
        let listener = |address: IpAddr, framework: &str| PortListening {
            bound_address: address,
            framework: Some(
                NonEmptyText::new(framework.to_owned()).expect("the test names a framework"),
            ),
        };
        let readings = PortListeningReadings::from([
            (reached, listener(Ipv4Addr::LOCALHOST.into(), "vite")),
            (reached_v6, listener(Ipv6Addr::LOCALHOST.into(), "vite")),
            (reached_any, listener(Ipv4Addr::UNSPECIFIED.into(), "next")),
            (
                unreached,
                listener(Ipv4Addr::new(127, 0, 0, 2).into(), "next"),
            ),
        ]);
        let listening_of = |ports: Vec<PreviewSharedPort>| {
            ports
                .into_iter()
                .map(|shared| {
                    let framework = shared.framework.map(NonEmptyText::into_string);
                    (shared.port, shared.listening, framework)
                })
                .collect::<Vec<_>>()
        };
        let nothing_read = vec![
            (reached, false, None),
            (reached_v6, false, None),
            (reached_any, false, None),
            (unreached, false, None),
        ];
        let gate = CreditGate::with_credit(1);

        let mut feed = follow_list(&shared_ports).await;
        assert_eq!(
            listening_of(next_ports(&mut feed, &gate).await),
            nothing_read
        );
        let first_follow = listening_source.follow_sink(0);
        first_follow(readings.clone());
        assert_eq!(
            listening_of(next_ports(&mut feed, &gate).await),
            vec![
                (reached, true, Some("vite".to_owned())),
                (reached_v6, true, Some("vite".to_owned())),
                (reached_any, true, Some("next".to_owned())),
                (unreached, false, None)
            ]
        );

        drop(feed);
        let mut next_feed = follow_list(&shared_ports).await;
        assert_eq!(
            listening_of(next_ports(&mut next_feed, &gate).await),
            nothing_read
        );
        first_follow(readings);
        assert!(
            tokio::time::timeout(QUIET, next_feed.next(&gate))
                .await
                .is_err(),
            "a stopped follow's reading is not announced"
        );
    }

    // Killed by an `added_after` that reads only the clock, so a port added after the clock stepped
    // back would sort before the ports already on the list.
    #[test]
    fn a_port_is_added_a_millisecond_after_a_newest_instant_ahead_of_the_clock() {
        let newest = Timestamp::now()
            .checked_add(SignedDuration::from_hours(1))
            .expect("an hour from now is a timestamp");
        assert_eq!(
            added_after(Some(newest)).unix_millisecond(),
            Some(newest.as_millisecond() + 1)
        );
    }
}
