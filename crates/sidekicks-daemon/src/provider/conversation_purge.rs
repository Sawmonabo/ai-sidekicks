//! Deleting each provider's own copy of the conversations a session ran on, for the whole-session
//! purge: the conversation each of its bindings names and each one it left, handed to the driver
//! that ran it, newest first, so a fork goes before the conversation it was forked from.

use std::collections::HashSet;
use std::sync::Arc;

use rusqlite::{Connection, named_params};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::stored_column::text_column;
use crate::ipc::domain_error::DomainError;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::session_control::{PurgeSessionParams, PurgedConversation};
use crate::provider::left_conversations::read_left_conversations;
use crate::provider::runtime_binding::store::read_bindings_of_runs;
use crate::session::run::ids::SESSION_RUN_IDS_SQL;
use crate::settle_all::{SettleFailures, settle_all};

/// The statements the purge's read prepares on a read connection: the session's runs, their
/// bindings and the conversations the session left.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start sizes the read connections' statement caches with it"
    )
)]
pub(crate) const CONVERSATION_PURGE_STATEMENT_CAPACITY: usize = 3;

/// Why a session's provider conversations were not all deleted.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ConversationPurgeError {
    /// The session's conversations could not be read; nothing was deleted.
    #[error("reading the session's provider conversations failed")]
    Read(#[from] rusqlite::Error),
    /// No read connection could be had; nothing was deleted.
    #[error("reading the session's provider conversations failed")]
    ReadPool(#[from] DatabaseReadError),
    /// A conversation ran on a provider no registered driver answers (`provider.notFound`);
    /// nothing was deleted.
    #[error(transparent)]
    ProviderNotFound(DomainError),
    /// Every driver was asked, and these failed; the others' conversations are deleted.
    #[error(transparent)]
    Drivers(SettleFailures<DriverError>),
}

/// Deletes the provider's own copy of every conversation a session ran on.
pub(crate) struct ConversationPurge {
    /// Where the session's runs, bindings and left conversations are read.
    reads: Arc<DatabaseReadPool>,
    /// The drivers that delete them.
    providers: Arc<ProviderRegistry>,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "a session's purge deletes its provider conversations through it"
    )
)]
impl ConversationPurge {
    /// A purge reading through `reads` and deleting through the drivers `providers` registered.
    pub(crate) fn new(reads: Arc<DatabaseReadPool>, providers: Arc<ProviderRegistry>) -> Self {
        Self { reads, providers }
    }

    /// Deletes every conversation `session_id` ran on from the account home it ran in. Every
    /// provider is looked up before any driver is called, so one no driver answers refuses
    /// `provider.notFound` with nothing deleted; then every driver is asked in turn, and the
    /// failures come back together once all were tried.
    pub(crate) async fn delete_conversations(
        &self,
        session_id: SessionId,
    ) -> Result<(), ConversationPurgeError> {
        let conversations = self
            .reads
            .read(ReadLength::Long, move |reader| {
                Ok::<_, ConversationPurgeError>(read_conversations(reader, &session_id)?)
            })
            .await?;
        let mut purges = Vec::with_capacity(conversations.len());
        for (provider, conversations) in conversations {
            let driver = self
                .providers
                .lookup(&provider)
                .map_err(ConversationPurgeError::ProviderNotFound)?;
            purges.push((
                driver,
                PurgeSessionParams {
                    session_id,
                    conversations,
                },
            ));
        }
        let mut outcomes = Vec::with_capacity(purges.len());
        for (driver, params) in purges {
            outcomes.push(driver.purge_session(params).await);
        }
        settle_all(outcomes, "deleting the session's provider conversations")
            .map_err(ConversationPurgeError::Drivers)?;
        Ok(())
    }
}

// Each provider's conversations, newest first, in one read snapshot: the ones the bindings name,
// latest write first, then the ones the session left, latest left first. A conversation is listed
// once, and the providers keep the order each was first met in.
fn read_conversations(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Vec<(ProviderId, Vec<PurgedConversation>)>> {
    let snapshot = reader.unchecked_transaction()?;
    let run_ids = snapshot
        .prepare_cached(SESSION_RUN_IDS_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            |row| text_column(row, 0, |text| RunId::new(&text)),
        )?
        .collect::<rusqlite::Result<Vec<RunId>>>()?;
    let mut bound: Vec<_> = read_bindings_of_runs(&snapshot, &run_ids)?
        .into_iter()
        .filter_map(|binding| {
            let resume_handle = binding.resume_handle.filter(|handle| !handle.is_empty())?;
            Some((
                binding.updated_at,
                binding.provider_name,
                resume_handle,
                binding.spawn_config.provider_account_id,
            ))
        })
        .collect();
    bound.sort_by(|first, second| second.0.cmp(&first.0));
    let mut left = read_left_conversations(&snapshot, session_id)?;
    left.reverse();

    let mut by_provider: Vec<(ProviderId, Vec<PurgedConversation>)> = Vec::new();
    let mut listed: HashSet<(ProviderId, String)> = HashSet::new();
    let conversations = bound
        .into_iter()
        .map(|(_, provider, resume_handle, account)| (provider, resume_handle, account))
        .chain(left.into_iter().map(|record| {
            (
                record.provider_name,
                record.conversation.conversation_id,
                record.conversation.provider_account_id,
            )
        }));
    for (provider, resume_handle, provider_account_id) in conversations {
        if !listed.insert((provider.clone(), resume_handle.clone())) {
            continue;
        }
        let conversation = PurgedConversation {
            resume_handle,
            provider_account_id,
        };
        match by_provider
            .iter_mut()
            .find(|(listed, _)| *listed == provider)
        {
            Some((_, conversations)) => conversations.push(conversation),
            None => by_provider.push((provider, vec![conversation])),
        }
    }
    Ok(by_provider)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rusqlite::params;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_platforms::Spawner;
    use tokio::runtime::Handle;

    use super::{CONVERSATION_PURGE_STATEMENT_CAPACITY, ConversationPurge, ConversationPurgeError};
    use crate::database::connection::read_pool::DatabaseReadPool;
    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use crate::provider::driver::contract::MockProviderDriver;
    use crate::provider::driver::registry::{ProviderRegistry, test_provider};
    use crate::provider::driver::{DriverServices, PROVIDERS, ProviderRegistration};
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    // A binding row of `run_id` on `provider` naming `resume_handle`.
    fn insert_binding(
        reader: &rusqlite::Connection,
        run_id: &str,
        provider: &str,
        resume_handle: &str,
    ) {
        reader
            .execute(
                "INSERT INTO runtime_bindings
                   (id, run_id, provider_name, contract_version, cli_version_raw, resume_handle,
                    spawn_config, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '1.0.0', '2.1.0', ?4,
                         '{\"resolvedExecutablePath\":\"/bin/provider\"}',
                         '2026-10-19T09:00:00.000Z', '2026-10-19T09:00:00.000Z')",
                params![mint_uuid_v7().to_string(), run_id, provider, resume_handle],
            )
            .expect("the test writes the binding");
    }

    #[tokio::test]
    async fn a_provider_no_driver_answers_refuses_before_any_driver_is_called() {
        let database = TestDatabase::new();
        // Opening the writer creates the file with the daemon's schema.
        let _writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let session_id = test_session_id();
        let run_id = mint_uuid_v7().to_string();
        let reader = database.reader();
        reader
            .execute(
                "INSERT INTO runs (run_id, session_id, state, run_version)
                 VALUES (?1, ?2, 'completed', 1)",
                params![run_id, session_id.text().as_str()],
            )
            .expect("the test writes the run");
        let registered = PROVIDERS.first().expect("the table holds a provider");
        insert_binding(&reader, &run_id, registered.id, "registered-conversation");
        insert_binding(
            &reader,
            &run_id,
            test_provider().as_str(),
            "unknown-conversation",
        );

        // A driver with no expectations fails the test on any call, the purge among them.
        let table: Vec<ProviderRegistration> = PROVIDERS
            .iter()
            .map(|descriptor| ProviderRegistration {
                descriptor,
                build: |_| Arc::new(MockProviderDriver::new()),
            })
            .collect();
        let services = DriverServices {
            spawner: Spawner::new(Handle::current()).expect("the spawner thread starts"),
            data_folder: database.path(),
        };
        let purge = ConversationPurge::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                CONVERSATION_PURGE_STATEMENT_CAPACITY,
            )),
            Arc::new(ProviderRegistry::register_from(&table, &services)),
        );

        let refusal = purge.delete_conversations(session_id).await;

        let Err(ConversationPurgeError::ProviderNotFound(refusal)) = refusal else {
            panic!("the purge refuses the unknown provider, got {refusal:?}");
        };
        assert_eq!(refusal.code, RefusalCode::ProviderNotFound);
    }
}
