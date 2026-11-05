//! Deleting each provider's own copy of a session's conversations, for the whole-session purge:
//! the conversation each of its bindings names and each one it left, handed to the driver that ran
//! it, newest first, so a fork goes before the conversation it was forked from.

use std::sync::Arc;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::session_control::PurgeSessionParams;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};

/// Why a session's provider conversations were not all deleted.
#[derive(Debug, thiserror::Error)]
pub enum ConversationPurgeError {
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
pub struct ConversationPurge {
    /// Where the session's runs, bindings and left conversations are read.
    reads: Arc<DatabaseReadPool>,
    /// The drivers that delete them.
    providers: Arc<ProviderRegistry>,
}

impl ConversationPurge {
    /// A purge reading through `reads` and deleting through the drivers `providers` registered.
    pub fn new(reads: Arc<DatabaseReadPool>, providers: Arc<ProviderRegistry>) -> Self {
        Self { reads, providers }
    }

    /// Deletes every conversation `session_id` ran on from the account home it ran in. Every
    /// provider is looked up before any driver is called, so one no driver answers refuses
    /// `provider.notFound` with nothing deleted; then every driver is asked in turn, and the
    /// failures come back together once all were tried.
    pub async fn delete_conversations(
        &self,
        session_id: SessionId,
    ) -> Result<(), ConversationPurgeError> {
        let conversations = self
            .reads
            .read(ReadLength::Long, move |reader| {
                Ok::<_, ConversationPurgeError>(super::read_session_conversations(
                    reader, session_id,
                )?)
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rusqlite::params;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::registry::{ProviderRegistry, test_provider};
    use sidekicks_provider::driver::test_registry::{
        registrations_of_mock_drivers, test_driver_services,
    };
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::{ConversationPurge, ConversationPurgeError};
    use crate::conversations::SESSION_CONVERSATIONS_STATEMENT_CAPACITY;
    use crate::run::schema::schema_parts;

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
                         '{\"providerAccountId\":\"account-1\",
                           \"resolvedExecutablePath\":\"/bin/provider\"}',
                         '2026-10-19T09:00:00.000Z', '2026-10-19T09:00:00.000Z')",
                params![mint_uuid_v7().to_string(), run_id, provider, resume_handle],
            )
            .expect("the test writes the binding");
    }

    #[tokio::test]
    async fn a_provider_no_driver_answers_refuses_before_any_driver_is_called() {
        let database = TestDatabase::new(schema_parts());
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
        let table = registrations_of_mock_drivers();
        let services = test_driver_services();
        let purge = ConversationPurge::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                SESSION_CONVERSATIONS_STATEMENT_CAPACITY,
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
