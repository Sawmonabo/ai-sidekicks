//! The sign-outs a binding's removal owes, so no sign-in stays in the keychain once no binding
//! names its server. A removal records its server's digest before the provider's write and
//! settles the records once the write answers: a record whose server a remaining binding still
//! names is cleared and the sign-in kept, any other is signed out as `mcp.server.signOut` signs out
//! and then cleared, and one the keychain refuses stays for the next settle, which runs at the
//! daemon's start and after each sign-in or sign-out press.
//!
//! - Each binding keeps the digest of the address its whole address last read as, so a removal
//!   whose address no longer reads, as one whose variable lost its value, still owes that server,
//!   and a remaining binding whose address no longer reads still names it. A read at another
//!   address owes the old one, which the next settle signs out unless a binding still names it.
//! - A removal between its record and its own settle is counted in memory by digest, and each
//!   count stamps the server with the next removal's number. No settle clears or signs out a server
//!   a removal is counted at, or one stamped since its scan began, so a settle that read a binding
//!   before its removal landed never clears the record that removal needs. A stop loses only the
//!   counts; the records stay for the next start.
//! - One settle runs at a time, on a task the sign-in service's stop ends: a request while one runs
//!   has it run once more after, so a burst of presses costs two scans, and a removal waits for a
//!   run that began after its write.
//! - A record is decided under a lock every removal's count takes, released while the keychain
//!   signs the server out, then taken again to clear the record unless a removal was counted since.
//! - No log line names an address, which may hold credentials.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};

use futures::future::BoxFuture;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use tokio::sync::watch;

use crate::binding::store::{McpBindingKey, McpBindingStore, McpBindingStoreError};
use crate::errors::McpRefusal;
use crate::mutation::service::CONFIG_UNREAD_WORDS;
use crate::mutation::service::removal_sign_out::{McpRemovalSignOut, McpRemovalSignOutHold};
use crate::sign_in::address_digest::{ServerAddressDigest, ServerAddressKeyError};
use crate::sign_in::server::SignInTargetReads;
use crate::sign_in::service::SignInService;

/// The statements the owed sign-outs' reads run: the list of records.
pub const MCP_OWED_SIGN_OUT_STATEMENT_CAPACITY: usize = 1;

const LIST_OWED_SIGN_OUTS_SQL: &str =
    "SELECT server_address_digest FROM mcp_server_owed_sign_outs ORDER BY server_address_digest";

// A record already there is kept as it is.
const RECORD_OWED_SIGN_OUT_SQL: &str = "INSERT INTO mcp_server_owed_sign_outs
  (server_address_digest) VALUES (@server_address_digest)
  ON CONFLICT (server_address_digest) DO NOTHING";

const CLEAR_OWED_SIGN_OUT_SQL: &str =
    "DELETE FROM mcp_server_owed_sign_outs WHERE server_address_digest = @server_address_digest";

/// Why an owed sign-out, or a binding's last declared address, was not read or kept.
#[derive(Debug, thiserror::Error)]
pub(crate) enum OwedSignOutError {
    /// The writer did not keep the record.
    #[error("an owed MCP sign-out was not recorded or cleared")]
    Write(#[from] WriteError),
    /// SQLite refused the read, or a stored value did not read as text.
    #[error("the owed MCP sign-outs could not be read")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The binding store did not read or keep a binding's last declared address.
    #[error(transparent)]
    Binding(#[from] McpBindingStoreError),
    /// The address key a server's digest is made with could not be read or made.
    #[error(transparent)]
    AddressKey(#[from] ServerAddressKeyError),
}

impl From<OwedSignOutError> for McpRefusal {
    /// A digest or a row that could not be read or kept fails the call closed as the store
    /// unavailable, naming the keychain's cause where the address key was the one refused.
    fn from(error: OwedSignOutError) -> Self {
        match error {
            OwedSignOutError::AddressKey(error) => Self::from(error),
            error @ (OwedSignOutError::Write(_)
            | OwedSignOutError::Database(_)
            | OwedSignOutError::Pool(_)
            | OwedSignOutError::Binding(_)) => Self::BindingStoreUnavailable {
                cause: None,
                source: Some(Box::new(error)),
            },
        }
    }
}

/// Why a settle stopped before it reached every record, which it keeps.
#[derive(Debug, thiserror::Error)]
enum SettleError {
    /// A record or a binding's last declared address was not read or kept.
    #[error(transparent)]
    Store(#[from] OwedSignOutError),
    /// The remaining bindings' addresses could not be read.
    #[error("the MCP bindings' addresses could not be read")]
    Addresses(#[source] HandlerError),
}

/// The owed sign-outs' records in `mcp_server_owed_sign_outs`, keyed by digest, read through the
/// daemon's read pool and written through its writer.
struct OwedSignOutStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

impl OwedSignOutStore {
    // Records the sign-out owed at `digest`'s server; a record already there is kept.
    async fn record(&self, digest: &ServerAddressDigest) -> Result<(), OwedSignOutError> {
        self.write(RECORD_OWED_SIGN_OUT_SQL, digest).await
    }

    // Every owed sign-out's digest, in digest order.
    async fn list(&self) -> Result<Vec<ServerAddressDigest>, OwedSignOutError> {
        self.pool
            .read(ReadLength::Short, |connection| {
                Ok(connection
                    .prepare_cached(LIST_OWED_SIGN_OUTS_SQL)?
                    .query_map([], |row| row.get(0).map(ServerAddressDigest::from_stored))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    // Clears the sign-out owed at `digest`'s server.
    async fn clear(&self, digest: &ServerAddressDigest) -> Result<(), OwedSignOutError> {
        self.write(CLEAR_OWED_SIGN_OUT_SQL, digest).await
    }

    async fn write(
        &self,
        sql: &'static str,
        digest: &ServerAddressDigest,
    ) -> Result<(), OwedSignOutError> {
        self.writer
            .write(vec![WriteStatement {
                sql: sql.into(),
                bindings: StatementBindings::Named(vec![text_binding(
                    "@server_address_digest",
                    digest.as_str(),
                )]),
                expected_row_count: None,
            }])
            .await?;
        Ok(())
    }
}

// The removals between their record and their own settle: how many are counted at each server,
// and the number of the latest removal counted at each, which a settle compares with the number
// it began at.
#[derive(Default)]
struct RemovalsInFlight {
    counts: HashMap<ServerAddressDigest, usize>,
    counted_at: HashMap<ServerAddressDigest, u64>,
    next: u64,
}

impl RemovalsInFlight {
    // Whether a settle that began at `began` leaves `digest`'s record: a removal is counted there
    // or was counted since the settle began.
    fn holds(&self, digest: &ServerAddressDigest, began: u64) -> bool {
        self.counts.contains_key(digest)
            || self
                .counted_at
                .get(digest)
                .is_some_and(|counted| *counted >= began)
    }
}

// The one settle task's state: whether it runs, and how many runs were asked for.
#[derive(Default)]
struct SettleRuns {
    is_running: bool,
    requested: u64,
}

/// The sign-outs the bindings' removals owe: recorded before each removal's write and settled
/// after it, at the daemon's start and after each sign-in or sign-out press.
pub struct OwedSignOuts {
    this: Weak<Self>,
    sign_ins: Arc<SignInService>,
    targets: SignInTargetReads,
    records: OwedSignOutStore,
    bindings: McpBindingStore,
    /// The removals in flight, by digest.
    in_flight: Arc<Mutex<RemovalsInFlight>>,
    /// Held while a removal is counted and while a settle decides on one record or clears it, so
    /// a removal counted after a settle's check never has its record cleared by that settle.
    deciding: tokio::sync::Mutex<()>,
    /// The one settle task's state.
    runs: Mutex<SettleRuns>,
    /// The number of the last run asked for that has finished.
    finished: watch::Sender<u64>,
}

impl OwedSignOuts {
    /// The owed sign-outs signed out through `sign_ins`, the bindings' addresses read through
    /// `targets`, the records and each binding's last declared address read on `reads` and
    /// written through `writer`.
    pub fn new(
        sign_ins: Arc<SignInService>,
        targets: SignInTargetReads,
        reads: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|this| Self {
            this: Weak::clone(this),
            sign_ins,
            targets,
            records: OwedSignOutStore {
                pool: Arc::clone(&reads),
                writer: Arc::clone(&writer),
            },
            bindings: McpBindingStore::new(writer, reads),
            in_flight: Arc::default(),
            deciding: tokio::sync::Mutex::new(()),
            runs: Mutex::default(),
            finished: watch::Sender::new(0),
        })
    }

    /// Keeps the digest of `address`, which `binding`'s whole address just read as, as the
    /// binding's last declared one, owing the sign-out of the one it held where that differs, and
    /// answers it. Fails with [`OwedSignOutError`] when the address key, the binding store or the
    /// record does not read or keep, the column then left as it was.
    pub(crate) async fn note_declared(
        &self,
        binding: &McpServerBindingRef,
        address: &McpServerAddress,
    ) -> Result<ServerAddressDigest, OwedSignOutError> {
        let digest = self.sign_ins.custody.digest(address).await?;
        let last = self.read_last_declared(binding).await?;
        self.keep_declared(binding, &digest, last.as_ref()).await?;
        Ok(digest)
    }

    /// The digest of the server a sign-out of `binding` reaches: `address`'s, kept as the
    /// binding's last declared one, or where the address no longer reads, the one it last read
    /// as; `None` where it never read. Fails with [`OwedSignOutError`] when the address key or the
    /// binding store does not read or keep.
    pub(crate) async fn sign_out_digest(
        &self,
        binding: &McpServerBindingRef,
        address: Option<&McpServerAddress>,
    ) -> Result<Option<ServerAddressDigest>, OwedSignOutError> {
        match address {
            Some(address) => self.note_declared(binding, address).await.map(Some),
            None => self.read_last_declared(binding).await,
        }
    }

    /// Asks the one settle task for a run, as a press does once it has answered and the daemon's
    /// start does once the providers' first reads have ended.
    pub fn start_settle(&self) {
        self.request_run();
    }

    // The digest `binding` last read as, if one has.
    async fn read_last_declared(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<Option<ServerAddressDigest>, OwedSignOutError> {
        Ok(self
            .bindings
            .read_last_declared_digests(binding.provider())
            .await?
            .remove(&McpBindingKey::of(binding)))
    }

    // Writes `digest` as `binding`'s last declared one where `last`, the one it holds, differs,
    // recording `last`'s sign-out owed first so a write that fails between the two owes it again
    // at the next read.
    async fn keep_declared(
        &self,
        binding: &McpServerBindingRef,
        digest: &ServerAddressDigest,
        last: Option<&ServerAddressDigest>,
    ) -> Result<(), OwedSignOutError> {
        if last == Some(digest) {
            return Ok(());
        }
        if let Some(last) = last {
            self.records.record(last).await?;
        }
        self.bindings
            .record_last_declared_digest(binding, digest)
            .await?;
        Ok(())
    }

    // Owes the sign-out at the address `binding` reads as, or at the one it last read as where it
    // no longer reads, counted in flight until the answered hold drops.
    async fn owe(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<McpRemovalSignOutHold, McpRefusal> {
        let declared = self
            .targets
            .read_declared_address(binding)
            .await
            .map_err(|error| {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    provider = binding.provider().as_str(),
                    "an MCP binding's address could not be read before its removal"
                );
                McpRefusal::ProviderRefusedWrite {
                    binding: Box::new(binding.clone()),
                    words: CONFIG_UNREAD_WORDS.to_owned(),
                }
            })?;
        let digest = match declared {
            Some(address) => self
                .note_declared(binding, &address)
                .await
                .map_err(McpRefusal::from)?,
            None => match self
                .read_last_declared(binding)
                .await
                .map_err(McpRefusal::from)?
            {
                Some(last) => last,
                None => return Ok(McpRemovalSignOutHold::default()),
            },
        };
        let hold = {
            let _deciding = self.deciding.lock().await;
            self.count_in_flight(&digest)
        };
        self.records
            .record(&digest)
            .await
            .map_err(McpRefusal::from)?;
        Ok(hold)
    }

    // Counts a removal in flight at `digest`'s server, stamping it with the removal's number, and
    // answers the hold that uncounts it.
    fn count_in_flight(&self, digest: &ServerAddressDigest) -> McpRemovalSignOutHold {
        {
            let mut in_flight = lock(&self.in_flight);
            let number = in_flight.next;
            in_flight.next += 1;
            in_flight.counted_at.insert(digest.clone(), number);
            *in_flight.counts.entry(digest.clone()).or_default() += 1;
        }
        let in_flight = Arc::clone(&self.in_flight);
        let digest = digest.clone();
        McpRemovalSignOutHold::new(move || {
            let mut in_flight = lock(&in_flight);
            let count = in_flight
                .counts
                .get_mut(&digest)
                .expect("a removal stays counted until its hold drops");
            *count -= 1;
            if *count == 0 {
                in_flight.counts.remove(&digest);
            }
        })
    }

    // Asks for a run and answers its number: a run starts on a task the sign-in service's stop
    // ends where none runs, and a running one runs once more after it.
    fn request_run(&self) -> u64 {
        let mut runs = lock(&self.runs);
        runs.requested += 1;
        let number = runs.requested;
        if runs.is_running {
            return number;
        }
        let Some(owed) = self.this.upgrade() else {
            return number;
        };
        runs.is_running = true;
        let stop = self.sign_ins.revocations.token().clone();
        tokio::spawn(async move {
            loop {
                let asked = lock(&owed.runs).requested;
                tokio::select! {
                    () = stop.cancelled() => {
                        lock(&owed.runs).is_running = false;
                        return;
                    }
                    () = owed.settle() => {}
                }
                owed.finished.send_replace(asked);
                let mut runs = lock(&owed.runs);
                if runs.requested == asked {
                    runs.is_running = false;
                    return;
                }
            }
        });
        number
    }

    // Asks for a run and waits until it has finished, or the sign-in service stops.
    async fn settle_after_request(&self) {
        let number = self.request_run();
        let mut finished = self.finished.subscribe();
        let stop = self.sign_ins.revocations.token().clone();
        tokio::select! {
            () = stop.cancelled() => {}
            _finished = finished.wait_for(|finished| *finished >= number) => {}
        }
    }

    // Settles the owed sign-outs, logging a settle that stopped short, its records kept.
    async fn settle(&self) {
        if let Err(error) = self.settle_records().await {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the owed MCP sign-outs were not settled; they are settled again later"
            );
        }
    }

    // Reads the records and, where there are any, the servers the remaining bindings name, then
    // clears each record a binding names and signs out and clears each other one, leaving those a
    // removal in flight or counted since the scan began holds and those the keychain refuses.
    async fn settle_records(&self) -> Result<(), SettleError> {
        if self.records.list().await?.is_empty() {
            return Ok(());
        }
        let began = lock(&self.in_flight).next;
        let named = self.read_named_digests().await?;
        for digest in self.records.list().await? {
            {
                let _deciding = self.deciding.lock().await;
                if lock(&self.in_flight).holds(&digest, began) {
                    continue;
                }
            }
            if !named.contains(&digest)
                && let Err(refusal) = self.sign_ins.sign_out_at(&digest).await
            {
                tracing::warn!(
                    error = &refusal as &(dyn std::error::Error + 'static),
                    "the keychain kept an MCP sign-out a removal owes; the next settle tries again"
                );
                continue;
            }
            let _deciding = self.deciding.lock().await;
            if !lock(&self.in_flight).holds(&digest, began) {
                self.records.clear(&digest).await?;
            }
        }
        let mut in_flight = lock(&self.in_flight);
        in_flight
            .counted_at
            .retain(|_digest, counted| *counted >= began);
        Ok(())
    }

    // The digest of the server each remaining remote binding names: the one its address reads as,
    // kept as its last declared one, or where it no longer reads, the one it last read as.
    async fn read_named_digests(&self) -> Result<HashSet<ServerAddressDigest>, SettleError> {
        let key = self
            .sign_ins
            .custody
            .address_key()
            .await
            .map_err(OwedSignOutError::from)?;
        let mut last_declared: HashMap<ProviderId, HashMap<McpBindingKey, ServerAddressDigest>> =
            HashMap::new();
        let mut named = HashSet::new();
        for (binding, address) in self
            .targets
            .read_remote_addresses()
            .await
            .map_err(SettleError::Addresses)?
        {
            let provider = binding.provider();
            if !last_declared.contains_key(provider) {
                let read = self
                    .bindings
                    .read_last_declared_digests(provider)
                    .await
                    .map_err(OwedSignOutError::from)?;
                last_declared.insert(provider.clone(), read);
            }
            let last = last_declared
                .get(provider)
                .and_then(|digests| digests.get(&McpBindingKey::of(&binding)))
                .cloned();
            match address {
                Some(address) => {
                    let digest = key.digest(&address);
                    if let Err(error) = self.keep_declared(&binding, &digest, last.as_ref()).await {
                        tracing::warn!(
                            error = &error as &(dyn std::error::Error + 'static),
                            "an MCP binding's last declared address was not kept"
                        );
                    }
                    named.insert(digest);
                }
                None => named.extend(last),
            }
        }
        Ok(named)
    }
}

impl McpRemovalSignOut for OwedSignOuts {
    fn owe_sign_out<'a>(
        &'a self,
        binding: &'a McpServerBindingRef,
    ) -> BoxFuture<'a, Result<McpRemovalSignOutHold, McpRefusal>> {
        Box::pin(self.owe(binding))
    }

    fn settle_owed_sign_outs(&self) -> BoxFuture<'_, ()> {
        Box::pin(self.settle_after_request())
    }
}

#[cfg(test)]
mod tests;
