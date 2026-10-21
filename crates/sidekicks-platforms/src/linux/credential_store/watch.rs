//! The Secret Service on the session bus, over the one connection the watch keeps: who owns its
//! name, whether its default collection is unlocked, and its signals, the bus's `NameOwnerChanged`
//! for its name and its own `CollectionChanged`, which it sends when a collection's lock state
//! changes. The signals are subscribed before the owner is asked, so no change between the two is
//! missed, and nothing polls. A bus that closes is connected again at the next read.

use std::error::Error;
use std::sync::Arc;

use futures_util::StreamExt as _;
use tokio::sync::{Mutex, watch};
use tokio_util::task::AbortOnDropHandle;
use zbus::fdo::{DBusProxy, NameOwnerChangedStream};
use zbus::message::Type;
use zbus::names::{BusName, OwnedUniqueName};
use zbus::proxy::{CacheProperties, MethodFlags};
use zbus::zvariant::{OwnedObjectPath, OwnedValue};
use zbus::{Connection, MatchRule, MessageStream, Proxy};

use crate::credential_store::{CredentialStore, CredentialStoreUnreachable};
use crate::linux::credential_store::{SECRET_SERVICE_NAME, is_session_bus_named, login_state};
use crate::linux::read_process_file;

// The Secret Service's object, its interfaces, and the signal it sends when a collection changes.
const SECRET_SERVICE_PATH: &str = "/org/freedesktop/secrets";
const SECRET_SERVICE_INTERFACE: &str = "org.freedesktop.Secret.Service";
const COLLECTION_INTERFACE: &str = "org.freedesktop.Secret.Collection";
const PROPERTIES_INTERFACE: &str = "org.freedesktop.DBus.Properties";
const COLLECTION_CHANGED_SIGNAL: &str = "CollectionChanged";

// The alias of the collection a new item goes into, its lock property, and the path `ReadAlias`
// answers for an alias that names no collection.
const DEFAULT_ALIAS: &str = "default";
const LOCKED_PROPERTY: &str = "Locked";
const NO_COLLECTION: &str = "/";

// Whether a Secret Service can be reached, as `check_reachable` answers.
type Reachability = Result<(), CredentialStoreUnreachable>;

/// The Secret Service as the watch's one session-bus connection sees it; see the module doc.
pub(crate) struct SecretServiceWatch {
    // The connection and the task hearing its signals: none with no session bus named, and
    // connected again at the next read once the task ended with the bus.
    bus: Mutex<Option<HeardBus>>,
    // Whether a Secret Service owns its name, as last heard.
    reachability: watch::Sender<Reachability>,
    // Sent at each moment the store may have become usable.
    moments: watch::Sender<()>,
}

// An open connection and the task hearing its signals, which ends when the bus closes and is
// aborted when the watch drops.
struct HeardBus {
    connection: Connection,
    hearing: AbortOnDropHandle<()>,
}

impl SecretServiceWatch {
    /// Connects to the session bus named, subscribes to the signals and asks once who owns the
    /// Secret Service's name, within [`CredentialStore::QUICK_ANSWER_LIMIT`]; a failure is kept as
    /// the reachability and the next read connects again.
    pub(crate) async fn start() -> Arc<Self> {
        let watch = Arc::new(Self {
            bus: Mutex::new(None),
            reachability: watch::Sender::new(Err(CredentialStoreUnreachable::NoSessionBus)),
            moments: watch::Sender::new(()),
        });
        if let Err(unreachable) = watch.connection().await {
            tracing::info!(
                error = &unreachable as &(dyn Error + 'static),
                "The Secret Service cannot be reached yet; the next read asks again"
            );
        }
        watch
    }

    /// A receiver that sees each moment the store may have become usable, from now on.
    pub(crate) fn moments(&self) -> watch::Receiver<()> {
        self.moments.subscribe()
    }

    /// Whether a Secret Service owns its name, as last heard; a bus that closed is connected again
    /// first. Fails with [`CredentialStoreUnreachable`] naming the condition that failed.
    pub(crate) async fn check_reachable(&self) -> Reachability {
        self.connection().await?;
        self.reachability.borrow().clone()
    }

    /// Whether the default collection exists and is unlocked, read within
    /// [`CredentialStore::QUICK_ANSWER_LIMIT`] with no question
    /// that could start a Secret Service. Fails with [`CredentialStoreUnreachable`] when no Secret
    /// Service runs or it does not answer.
    pub(crate) async fn is_unlocked(&self) -> Result<bool, CredentialStoreUnreachable> {
        let connection = self.connection().await?;
        self.reachability.borrow().clone()?;
        match tokio::time::timeout(
            CredentialStore::QUICK_ANSWER_LIMIT,
            read_is_unlocked(&connection),
        )
        .await
        .map(|read| read.map_err(zbus::fdo::Error::from))
        {
            Ok(Ok(is_unlocked)) => Ok(is_unlocked),
            Ok(Err(zbus::fdo::Error::ServiceUnknown(_) | zbus::fdo::Error::NameHasNoOwner(_))) => {
                Err(CredentialStoreUnreachable::NoSecretService)
            }
            Ok(Err(failure)) => Err(CredentialStoreUnreachable::SecretServiceFailed(Arc::new(
                failure,
            ))),
            Err(_elapsed) => Err(CredentialStoreUnreachable::NoAnswer),
        }
    }

    /// The program holding the Secret Service and this account's login state, as far as each reads
    /// within [`CredentialStore::QUICK_ANSWER_LIMIT`], for the service log.
    pub(crate) async fn description(&self) -> String {
        let holder = match self.connection().await {
            Ok(connection) => {
                match tokio::time::timeout(
                    CredentialStore::QUICK_ANSWER_LIMIT,
                    owning_program(&connection),
                )
                .await
                {
                    Ok(Ok(Some(program))) => format!("the Secret Service, held by {program}"),
                    Ok(Ok(None)) => {
                        format!("no Secret Service: nothing owns {SECRET_SERVICE_NAME}")
                    }
                    Ok(Err(failure)) => format!("the Secret Service, its holder unread: {failure}"),
                    Err(_elapsed) => format!(
                        "the Secret Service, its holder unread: no answer within {} s",
                        CredentialStore::QUICK_ANSWER_LIMIT.as_secs()
                    ),
                }
            }
            Err(unreachable) => format!("no Secret Service: {unreachable}"),
        };
        format!(
            "{holder}; this account's login state: {}",
            login_state().await
        )
    }

    // The open connection, connected now within the quick-answer limit when there is none or its
    // signals stopped, one read at a time. Fails with no session bus named, or when it does not
    // connect, the failure then kept as the reachability.
    async fn connection(&self) -> Result<Connection, CredentialStoreUnreachable> {
        if !is_session_bus_named() {
            return Err(CredentialStoreUnreachable::NoSessionBus);
        }
        let mut bus = self.bus.lock().await;
        if let Some(open) = bus.as_ref()
            && !open.hearing.is_finished()
        {
            return Ok(open.connection.clone());
        }
        *bus = None;
        let failure =
            match tokio::time::timeout(CredentialStore::QUICK_ANSWER_LIMIT, self.connect()).await {
                Ok(Ok(open)) => {
                    let connection = open.connection.clone();
                    *bus = Some(open);
                    return Ok(connection);
                }
                Ok(Err(failure)) => CredentialStoreUnreachable::SessionBusFailed(Arc::new(failure)),
                Err(_elapsed) => CredentialStoreUnreachable::NoAnswer,
            };
        self.reachability
            .send_modify(|held| *held = Err(failure.clone()));
        Err(failure)
    }

    // Connects, subscribes to both signals, then asks who owns the Secret Service's name, keeps
    // that as the reachability and starts hearing the signals. Fails with the bus's error.
    async fn connect(&self) -> zbus::Result<HeardBus> {
        let connection = Connection::session().await?;
        let bus = DBusProxy::new(&connection).await?;
        let owner_changes = bus
            .receive_name_owner_changed_with_args(&[(0, SECRET_SERVICE_NAME)])
            .await?;
        let collection_rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .interface(SECRET_SERVICE_INTERFACE)?
            .member(COLLECTION_CHANGED_SIGNAL)?
            .build();
        let collection_changes =
            MessageStream::for_match_rule(collection_rule, &connection, None).await?;
        let reachability = match owner(&bus).await? {
            Some(_owner) => Ok(()),
            None => Err(CredentialStoreUnreachable::NoSecretService),
        };
        self.reachability.send_modify(|held| *held = reachability);
        let hearing = tokio::spawn(hear(
            owner_changes,
            collection_changes,
            self.reachability.clone(),
            self.moments.clone(),
        ));
        Ok(HeardBus {
            connection,
            hearing: AbortOnDropHandle::new(hearing),
        })
    }
}

// Keeps the reachability as the owner changes and sends a moment when a program takes the name or
// a collection changes, until the bus closes, which it keeps as the reachability.
async fn hear(
    mut owner_changes: NameOwnerChangedStream,
    mut collection_changes: MessageStream,
    reachability: watch::Sender<Reachability>,
    moments: watch::Sender<()>,
) {
    let closed: Arc<dyn Error + Send + Sync> = loop {
        tokio::select! {
            owner_change = owner_changes.next() => {
                let Some(owner_change) = owner_change else {
                    break bus_closed();
                };
                match owner_change.args() {
                    Ok(change) if change.new_owner().is_some() => {
                        reachability.send_modify(|held| *held = Ok(()));
                        moments.send_replace(());
                    }
                    // A name given up makes nothing usable.
                    Ok(_released) => {
                        reachability.send_modify(|held| {
                            *held = Err(CredentialStoreUnreachable::NoSecretService);
                        });
                    }
                    Err(failure) => break Arc::new(failure),
                }
            }
            collection_change = collection_changes.next() => match collection_change {
                Some(Ok(_change)) => {
                    moments.send_replace(());
                }
                Some(Err(failure)) => break Arc::new(failure),
                None => break bus_closed(),
            },
        }
    };
    reachability
        .send_modify(|held| *held = Err(CredentialStoreUnreachable::SessionBusFailed(closed)));
}

// Whether the default collection exists and is unlocked, each question flagged so that the bus
// never starts a Secret Service to answer it.
async fn read_is_unlocked(connection: &Connection) -> zbus::Result<bool> {
    let service = uncached_proxy(connection, SECRET_SERVICE_PATH, SECRET_SERVICE_INTERFACE).await?;
    let collection: OwnedObjectPath = service
        .call_with_flags(
            "ReadAlias",
            MethodFlags::NoAutoStart.into(),
            &(DEFAULT_ALIAS,),
        )
        .await?
        .expect("a call that expects a reply answers with one");
    if collection.as_str() == NO_COLLECTION {
        return Ok(false);
    }
    let properties = uncached_proxy(connection, collection.as_str(), PROPERTIES_INTERFACE).await?;
    let is_locked: OwnedValue = properties
        .call_with_flags(
            "Get",
            MethodFlags::NoAutoStart.into(),
            &(COLLECTION_INTERFACE, LOCKED_PROPERTY),
        )
        .await?
        .expect("a call that expects a reply answers with one");
    Ok(!bool::try_from(is_locked)?)
}

// A proxy on the Secret Service's object at `path` that caches no property, so building it sends
// nothing.
async fn uncached_proxy<'path>(
    connection: &Connection,
    path: &'path str,
    interface: &'static str,
) -> zbus::Result<Proxy<'path>> {
    zbus::proxy::Builder::<Proxy<'path>>::new(connection)
        .destination(SECRET_SERVICE_NAME)?
        .path(path)?
        .interface(interface)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
}

// The unique name of the connection owning the Secret Service's name, or `None` when nothing owns
// it.
async fn owner(bus: &DBusProxy<'_>) -> zbus::Result<Option<OwnedUniqueName>> {
    match bus
        .get_name_owner(BusName::try_from(SECRET_SERVICE_NAME)?)
        .await
    {
        Ok(owner) => Ok(Some(owner)),
        Err(zbus::fdo::Error::NameHasNoOwner(_)) => Ok(None),
        Err(failure) => Err(failure.into()),
    }
}

// The program holding the Secret Service, by its process's name and id, or `None` when nothing
// does; a process whose name cannot be read is named by its id.
async fn owning_program(connection: &Connection) -> zbus::Result<Option<String>> {
    let bus = DBusProxy::new(connection).await?;
    let Some(owner) = owner(&bus).await? else {
        return Ok(None);
    };
    let process_id = bus
        .get_connection_unix_process_id(BusName::from(owner.into_inner()))
        .await?;
    let name = match read_process_file(process_id, "comm") {
        Ok(Some(name)) => String::from_utf8_lossy(&name).trim().to_owned(),
        Ok(None) => "a process that has ended".to_owned(),
        Err(failure) => format!("a process whose name does not read ({failure})"),
    };
    Ok(Some(format!("{name} (process {process_id})")))
}

fn bus_closed() -> Arc<dyn Error + Send + Sync> {
    Arc::new(std::io::Error::new(
        std::io::ErrorKind::UnexpectedEof,
        "the session bus closed",
    ))
}
