//! The sign-outs a binding's removal owes, so no sign-in stays in the keychain once no binding
//! names its server. A removal records its server's canonical address before the provider's write
//! and settles the records once the write answers: a record whose address a remaining binding
//! still names is cleared and the sign-in kept, any other is signed out as `mcp.server.signOut`
//! signs out and then cleared, and one the keychain refuses stays for the next settle, which runs
//! at the daemon's start and after each sign-in or sign-out press.
//!
//! - Each binding keeps the canonical address its whole address last read as, so a removal whose
//!   address no longer reads, as one whose variable lost its value, still owes that address, and
//!   a remaining binding whose address no longer reads still names it. A read at another address
//!   owes the old one, which the next settle signs out unless a binding still names it.
//! - A removal between its record and its own settle is counted in memory by address, and no
//!   settle clears or signs out an address one is counted at, so a settle that reads the binding
//!   before its write lands never clears the record its removal is about to need. A stop loses
//!   only the counts; the records stay for the next start.
//! - No log line names an address, which may hold credentials.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

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

use crate::binding::store::{McpBindingKey, McpBindingStore, McpBindingStoreError};
use crate::errors::McpRefusal;
use crate::mutation::service::CONFIG_UNREAD_WORDS;
use crate::mutation::service::removal_sign_out::{McpRemovalSignOut, McpRemovalSignOutHold};
use crate::sign_in::canonical_server_address;
use crate::sign_in::service::SignInService;
use crate::sign_in::target::SignInTargetReads;

/// The statements the owed sign-outs' reads run: the list of records.
pub const MCP_OWED_SIGN_OUT_STATEMENT_CAPACITY: usize = 1;

const LIST_OWED_SIGN_OUTS_SQL: &str =
    "SELECT server_address FROM mcp_server_owed_sign_outs ORDER BY server_address";

// A record already there is kept as it is.
const RECORD_OWED_SIGN_OUT_SQL: &str = "INSERT INTO mcp_server_owed_sign_outs (server_address)
  VALUES (@server_address) ON CONFLICT (server_address) DO NOTHING";

const CLEAR_OWED_SIGN_OUT_SQL: &str =
    "DELETE FROM mcp_server_owed_sign_outs WHERE server_address = @server_address";

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

/// The owed sign-outs' records in `mcp_server_owed_sign_outs`, keyed by canonical address, read
/// through the daemon's read pool and written through its writer.
struct OwedSignOutStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

impl OwedSignOutStore {
    // Records the sign-out owed at `canonical_address`; a record already there is kept.
    async fn record(&self, canonical_address: &str) -> Result<(), OwedSignOutError> {
        self.write(RECORD_OWED_SIGN_OUT_SQL, canonical_address)
            .await
    }

    // Every owed sign-out's canonical address, in address order.
    async fn list(&self) -> Result<Vec<String>, OwedSignOutError> {
        self.pool
            .read(ReadLength::Short, |connection| {
                Ok(connection
                    .prepare_cached(LIST_OWED_SIGN_OUTS_SQL)?
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?)
            })
            .await
    }

    // Clears the sign-out owed at `canonical_address`.
    async fn clear(&self, canonical_address: &str) -> Result<(), OwedSignOutError> {
        self.write(CLEAR_OWED_SIGN_OUT_SQL, canonical_address).await
    }

    async fn write(
        &self,
        sql: &'static str,
        canonical_address: &str,
    ) -> Result<(), OwedSignOutError> {
        self.writer
            .write(vec![WriteStatement {
                sql: sql.into(),
                bindings: StatementBindings::Named(vec![text_binding(
                    "@server_address",
                    canonical_address,
                )]),
                expected_row_count: None,
            }])
            .await?;
        Ok(())
    }
}

/// The sign-outs the bindings' removals owe: recorded before each removal's write and settled
/// after it, at the daemon's start and after each sign-in or sign-out press.
pub struct OwedSignOuts {
    sign_ins: Arc<SignInService>,
    targets: SignInTargetReads,
    records: OwedSignOutStore,
    bindings: McpBindingStore,
    /// The removals between their record and their own settle, counted by canonical address.
    in_flight: Arc<Mutex<HashMap<String, usize>>>,
    /// Held while a removal is counted and while a settle decides on one record and acts on it,
    /// so a removal counted after a settle's check never has its record cleared by that settle.
    deciding: tokio::sync::Mutex<()>,
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
        Arc::new(Self {
            sign_ins,
            targets,
            records: OwedSignOutStore {
                pool: Arc::clone(&reads),
                writer: Arc::clone(&writer),
            },
            bindings: McpBindingStore::new(writer, reads),
            in_flight: Arc::default(),
            deciding: tokio::sync::Mutex::new(()),
        })
    }

    /// Keeps `address`, which `binding`'s whole address just read as, as the binding's last
    /// declared address, owing the sign-out of the one it held where that differs, and answers its
    /// canonical form. Fails with [`OwedSignOutError`] when the binding store or the record does
    /// not read or keep, the column then left as it was.
    pub(crate) async fn note_declared(
        &self,
        binding: &McpServerBindingRef,
        address: &McpServerAddress,
    ) -> Result<String, OwedSignOutError> {
        let last = self.read_last_declared(binding).await?;
        let canonical_address = canonical_server_address(address);
        self.keep_declared(binding, &canonical_address, last.as_deref())
            .await?;
        Ok(canonical_address)
    }

    /// Settles the owed sign-outs on a task the sign-in service's stop ends, as a press does once
    /// it has answered and the daemon's start does once the providers' first reads have ended.
    pub fn start_settle(self: &Arc<Self>) {
        let owed = Arc::clone(self);
        let stop = self.sign_ins.revocations.token().clone();
        tokio::spawn(async move {
            tokio::select! {
                () = stop.cancelled() => {}
                () = owed.settle() => {}
            }
        });
    }

    // The canonical address `binding` last read as, if one has.
    async fn read_last_declared(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<Option<String>, OwedSignOutError> {
        Ok(self
            .bindings
            .read_last_declared_addresses(binding.provider())
            .await?
            .remove(&McpBindingKey::of(binding)))
    }

    // Writes `canonical_address` as `binding`'s last declared address where `last`, the one it
    // holds, differs, recording `last`'s sign-out owed first so a write that fails between the
    // two owes it again at the next read.
    async fn keep_declared(
        &self,
        binding: &McpServerBindingRef,
        canonical_address: &str,
        last: Option<&str>,
    ) -> Result<(), OwedSignOutError> {
        if last == Some(canonical_address) {
            return Ok(());
        }
        if let Some(last) = last {
            self.records.record(last).await?;
        }
        self.bindings
            .record_last_declared_address(binding, canonical_address)
            .await?;
        Ok(())
    }

    // Owes the sign-out at the address `binding` reads as, or at the one it last read as where it
    // no longer reads, counted in flight until the answered hold drops.
    async fn owe(
        &self,
        binding: &McpServerBindingRef,
    ) -> Result<McpRemovalSignOutHold, McpRefusal> {
        let unkept = |error: OwedSignOutError| McpRefusal::BindingStoreUnavailable {
            cause: None,
            source: Some(Box::new(error)),
        };
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
        let canonical_address = match declared {
            Some(address) => self
                .note_declared(binding, &address)
                .await
                .map_err(unkept)?,
            None => match self.read_last_declared(binding).await.map_err(unkept)? {
                Some(last) => last,
                None => return Ok(McpRemovalSignOutHold::default()),
            },
        };
        let hold = {
            let _deciding = self.deciding.lock().await;
            self.count_in_flight(&canonical_address)
        };
        self.records
            .record(&canonical_address)
            .await
            .map_err(unkept)?;
        Ok(hold)
    }

    // Counts a removal in flight at `canonical_address`, answering the hold that uncounts it.
    fn count_in_flight(&self, canonical_address: &str) -> McpRemovalSignOutHold {
        *lock(&self.in_flight)
            .entry(canonical_address.to_owned())
            .or_default() += 1;
        let in_flight = Arc::clone(&self.in_flight);
        let canonical_address = canonical_address.to_owned();
        McpRemovalSignOutHold::new(move || {
            let mut in_flight = lock(&in_flight);
            let count = in_flight
                .get_mut(&canonical_address)
                .expect("a removal stays counted until its hold drops");
            *count -= 1;
            if *count == 0 {
                in_flight.remove(&canonical_address);
            }
        })
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

    // Reads the records and, where there are any, the addresses the remaining bindings name, then
    // clears each record a binding names and signs out and clears each other one, leaving those a
    // removal in flight holds and those the keychain refuses.
    async fn settle_records(&self) -> Result<(), SettleError> {
        if self.records.list().await?.is_empty() {
            return Ok(());
        }
        let named = self.read_named_addresses().await?;
        for canonical_address in self.records.list().await? {
            let _deciding = self.deciding.lock().await;
            if lock(&self.in_flight).contains_key(&canonical_address) {
                continue;
            }
            if !named.contains(&canonical_address) {
                let Some(address) = McpServerAddress::new(&canonical_address) else {
                    tracing::warn!("an owed MCP sign-out's stored address is no web address");
                    continue;
                };
                if let Err(refusal) = self.sign_ins.sign_out_at(&address).await {
                    tracing::warn!(
                        error = &refusal as &(dyn std::error::Error + 'static),
                        "the keychain kept an MCP sign-out a removal owes; the next settle tries \
                         again"
                    );
                    continue;
                }
            }
            self.records.clear(&canonical_address).await?;
        }
        Ok(())
    }

    // The canonical address each remaining remote binding names: the one it reads as, kept as its
    // last declared address, or where it no longer reads, the one it last read as.
    async fn read_named_addresses(&self) -> Result<HashSet<String>, SettleError> {
        let mut last_declared: HashMap<ProviderId, HashMap<McpBindingKey, String>> = HashMap::new();
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
                    .read_last_declared_addresses(provider)
                    .await
                    .map_err(OwedSignOutError::from)?;
                last_declared.insert(provider.clone(), read);
            }
            let last = last_declared
                .get(provider)
                .and_then(|addresses| addresses.get(&McpBindingKey::of(&binding)))
                .cloned();
            match address {
                Some(address) => {
                    let canonical_address = canonical_server_address(&address);
                    if let Err(error) = self
                        .keep_declared(&binding, &canonical_address, last.as_deref())
                        .await
                    {
                        tracing::warn!(
                            error = &error as &(dyn std::error::Error + 'static),
                            "an MCP binding's last declared address was not kept"
                        );
                    }
                    named.insert(canonical_address);
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
        Box::pin(self.settle())
    }
}

#[cfg(test)]
mod tests;
