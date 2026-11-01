//! The one account resolver: a provider's current account, read alike for a new session's lead
//! and for a run's admission, with the guard that holds a session's first write to it, and the
//! daemon's accounts reader, which resolves an account's folders before any process starts on it.
//!
//! - A row marked for removal is never current and never resolves, since a crash part way through
//!   a removal can leave the mark on the current row.
//! - An account's folders resolve only for a registered account whose home is there; no sign-in
//!   check runs, so a run on an account whose login has gone starts and meets the provider's own
//!   refusal.
//! - A pasted token is read from the daemon's keychain, never from the account's home.

use std::borrow::Cow;
use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::{Connection, OptionalExtension, named_params};
use secrecy::SecretString;
use sidekicks_contracts::provider::account::record::{
    CredentialGeneration, ProviderAccountId, ProviderAuthMode,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_store::credential_store::SecretKeychain;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{closed_word, text_column};

use crate::account::credential_home::{CredentialHomeCondition, classify_credential_home};
use crate::account::registry::query_registered_account;
use crate::account::token_custody::read_sealed_token;
use crate::driver::{
    AccountFoldersError, CurrentProviderAccount, ProviderAccountFolders, ProviderAccountReader,
    descriptor_of,
};

/// The statements the accounts reader prepares on a read connection: the current account,
/// whether any is registered, and one registered account.
pub const PROVIDER_ACCOUNTS_STATEMENT_CAPACITY: usize = 3;

const SELECT_CURRENT_ACCOUNT_SQL: &str = "SELECT account_id FROM provider_accounts
  WHERE provider = @provider AND is_default = 1 AND removal_intent = 0";

const SELECT_ANY_ACCOUNT_SQL: &str = "SELECT EXISTS (SELECT 1 FROM provider_accounts
  WHERE provider = @provider AND removal_intent = 0)";

// Holds only while the account the lead was resolved to is still its provider's current one.
const CURRENT_ACCOUNT_GUARD_SQL: &str = "SELECT 1 FROM provider_accounts
  WHERE account_id = @accountId AND provider = @provider AND is_default = 1
    AND removal_intent = 0";

/// `provider`'s current account, or why it has none: no account but those marked for removal, or
/// some and none current. Fails when the read fails or the stored id is not an account id.
pub fn select_current_account(
    reader: &Connection,
    provider: &ProviderId,
) -> rusqlite::Result<CurrentProviderAccount> {
    let current = reader
        .prepare_cached(SELECT_CURRENT_ACCOUNT_SQL)?
        .query_row(named_params! { "@provider": provider.as_str() }, |row| {
            text_column(row, 0, closed_word::<ProviderAccountId>)
        })
        .optional()?;
    if let Some(provider_account_id) = current {
        return Ok(CurrentProviderAccount::Current(provider_account_id));
    }
    let has_accounts = reader
        .prepare_cached(SELECT_ANY_ACCOUNT_SQL)?
        .query_row(named_params! { "@provider": provider.as_str() }, |row| {
            row.get::<_, bool>(0)
        })?;
    Ok(if has_accounts {
        CurrentProviderAccount::NoneCurrent
    } else {
        CurrentProviderAccount::NoneRegistered
    })
}

/// The statement that refuses a write once `provider_account_id` is no longer `provider`'s
/// current account: it expects one row.
pub fn current_account_guard(
    provider_account_id: &ProviderAccountId,
    provider: &ProviderId,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(CURRENT_ACCOUNT_GUARD_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@accountId", provider_account_id.as_str()),
            text_binding("@provider", provider.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The daemon's accounts reader, over its read connections and its keychain service for provider
/// tokens.
pub struct ProviderAccounts {
    reads: Arc<DatabaseReadPool>,
    provider_tokens: Arc<dyn SecretKeychain>,
}

impl ProviderAccounts {
    /// A reader over `reads`, sized with [`PROVIDER_ACCOUNTS_STATEMENT_CAPACITY`] among the rest,
    /// reading sealed tokens from `provider_tokens`.
    pub fn new(reads: Arc<DatabaseReadPool>, provider_tokens: Arc<dyn SecretKeychain>) -> Self {
        Self {
            reads,
            provider_tokens,
        }
    }
}

impl ProviderAccountReader for ProviderAccounts {
    // The account's home is its configuration folder, and its credential store is the folder its
    // provider names under the home, the home itself where it names none. The folder is looked at
    // on the read's blocking thread.
    fn resolve_account_folders(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<ProviderAccountFolders, AccountFoldersError>> {
        async move {
            self.reads
                .read(ReadLength::Short, move |connection| {
                    let account = query_registered_account(connection, &provider_account_id)
                        .map_err(|error| AccountFoldersError::Read(Box::new(error)))?
                        .ok_or(AccountFoldersError::NotFound)?;
                    let stored_health = account.health.map(|health| health.state);
                    match classify_credential_home(&account.credential_home, stored_health) {
                        Ok(CredentialHomeCondition::Absent) => {
                            Err(AccountFoldersError::CredentialHomeUnavailable)
                        }
                        Ok(CredentialHomeCondition::Husked | CredentialHomeCondition::SignedIn) => {
                            let home = account.credential_home.path().to_path_buf();
                            let store_components = descriptor_of(account.provider.as_str())
                                .map_or(&[][..], |descriptor| {
                                    descriptor.account_home_credential_store_folder
                                });
                            let credential_store_folder = store_components
                                .iter()
                                .fold(home.clone(), |path, part| path.join(part));
                            Ok(ProviderAccountFolders {
                                configuration_folder: home,
                                credential_store_folder,
                            })
                        }
                        Err(error) => Err(AccountFoldersError::Read(Box::new(error))),
                    }
                })
                .await
        }
        .boxed()
    }

    fn current_account(
        &self,
        provider_id: ProviderId,
    ) -> BoxFuture<'_, Result<CurrentProviderAccount, Box<dyn Error + Send + Sync>>> {
        async move {
            self.reads
                .read(ReadLength::Short, move |connection| {
                    select_current_account(connection, &provider_id).map_err(Into::into)
                })
                .await
        }
        .boxed()
    }

    fn read_credential_generation(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<CredentialGeneration, Box<dyn Error + Send + Sync>>> {
        async move {
            self.reads
                .read(ReadLength::Short, move |connection| {
                    query_registered_account(connection, &provider_account_id)?
                        .map(|account| account.credential_generation)
                        .ok_or_else(|| "the account is not registered".into())
                })
                .await
        }
        .boxed()
    }

    fn read_observed_auth_mode(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<Option<ProviderAuthMode>, Box<dyn Error + Send + Sync>>> {
        async move {
            self.reads
                .read(ReadLength::Short, move |connection| {
                    query_registered_account(connection, &provider_account_id)?
                        .map(|account| account.observed_auth_mode)
                        .ok_or_else(|| "the account is not registered".into())
                })
                .await
        }
        .boxed()
    }

    fn read_sealed_token(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<Option<SecretString>, Box<dyn Error + Send + Sync>>> {
        async move {
            Ok(read_sealed_token(self.provider_tokens.as_ref(), &provider_account_id).await?)
        }
        .boxed()
    }
}

impl From<DatabaseReadError> for AccountFoldersError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Read(Box::new(error))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use rusqlite::Connection;
    use sidekicks_contracts::provider::account::record::{
        ProviderAccountHealthState, ProviderAccountId,
    };
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;

    use super::{PROVIDER_ACCOUNTS_STATEMENT_CAPACITY, ProviderAccounts, select_current_account};
    use crate::account::registry::tests::register;
    use crate::account::registry::{HealthObservation, HealthObserver, open_test_registry};
    use crate::account::token_custody::tests::ScriptedKeychain;
    use crate::driver::schema::schema_parts;
    use crate::driver::{AccountFoldersError, CurrentProviderAccount, ProviderAccountReader};

    fn accounts_over(database: &TestDatabase) -> ProviderAccounts {
        ProviderAccounts::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                PROVIDER_ACCOUNTS_STATEMENT_CAPACITY,
            )),
            Arc::new(ScriptedKeychain::default()),
        )
    }

    fn claude() -> ProviderId {
        ProviderId::new("claude".to_owned()).expect("a test provider id")
    }

    // A default marked for removal is current neither for a session's create nor for a run's
    // admission, and its folders do not resolve. Killed by the `removal_intent` filter dropped
    // from the current read or from the account read.
    #[tokio::test]
    async fn a_default_marked_for_removal_is_not_current_for_create_and_admission_alike() {
        let database = TestDatabase::new(schema_parts());
        let data_folder = tempfile::tempdir().expect("a data folder");
        let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
        let marked = register(&registry, "claude").await;
        register(&registry, "claude").await;
        assert!(marked.is_default, "the first account is current");
        let connection = Connection::open(database.path()).expect("the test opens the database");
        connection
            .execute(
                "UPDATE provider_accounts SET removal_intent = 1 WHERE account_id = ?1",
                [marked.account_id.as_str()],
            )
            .expect("the current account is marked for removal");
        let accounts = accounts_over(&database);

        let for_create =
            select_current_account(&connection, &claude()).expect("the current account is read");
        let for_admission = accounts
            .current_account(claude())
            .await
            .expect("the current account is read");
        assert_eq!(for_create, CurrentProviderAccount::NoneCurrent);
        assert_eq!(for_admission, CurrentProviderAccount::NoneCurrent);
        assert!(matches!(
            accounts
                .resolve_account_folders(marked.account_id.clone())
                .await,
            Err(AccountFoldersError::NotFound)
        ));
    }

    // The reader is what every spawn context awaits before a process is built, so each refusal
    // here leaves no child process. An unregistered account refuses, a removed home refuses
    // though its stored reading is signed in, and a run resumed on it never falls back to the
    // current account; a present home resolves whatever its stored reading. Killed by the home
    // check dropped and by a sign-in check added.
    #[tokio::test]
    async fn folders_resolve_for_a_registered_account_with_its_home_whatever_its_sign_in() {
        let database = TestDatabase::new(schema_parts());
        let data_folder = tempfile::tempdir().expect("a data folder");
        let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
        let current = register(&registry, "claude").await;
        let removed_home = register(&registry, "claude").await;
        registry
            .record_health(
                &current.account_id,
                &HealthObservation {
                    state: ProviderAccountHealthState::ReauthRequired,
                    observed_at: WireInstant::now(),
                },
                HealthObserver::Probe,
            )
            .await
            .expect("the signed-out reading is stored");
        std::fs::remove_dir_all(removed_home.credential_home.path()).expect("the home is removed");
        let stored = registry
            .read(removed_home.account_id.clone())
            .await
            .expect("the account is read");
        assert_eq!(
            stored.health.map(|health| health.state),
            Some(ProviderAccountHealthState::Authenticated)
        );
        let accounts = accounts_over(&database);

        let unregistered = ProviderAccountId::new("0".repeat(32)).expect("an account id");
        assert!(matches!(
            accounts.resolve_account_folders(unregistered).await,
            Err(AccountFoldersError::NotFound)
        ));
        assert!(matches!(
            accounts
                .resolve_account_folders(removed_home.account_id.clone())
                .await,
            Err(AccountFoldersError::CredentialHomeUnavailable)
        ));
        let folders = accounts
            .resolve_account_folders(current.account_id.clone())
            .await
            .expect("a present home resolves signed out");
        assert_eq!(folders.configuration_folder, current.credential_home.path());
    }

    // An account's configuration folder is its home, and its credential store the folder its
    // provider names under the home: Claude Code's store folder, Codex's home itself. Killed by
    // the store folder read as the home, and by Claude Code's store folder given to Codex.
    #[rstest]
    #[case::claude_code("claude", &["store"])]
    #[case::codex("codex", &[])]
    #[tokio::test]
    async fn an_accounts_credential_store_is_the_folder_its_provider_keeps_under_its_home(
        #[case] provider: &str,
        #[case] store_components: &[&str],
    ) {
        let database = TestDatabase::new(schema_parts());
        let data_folder = tempfile::tempdir().expect("a data folder");
        let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
        let account = register(&registry, provider).await;
        let home = account.credential_home.path();

        let folders = accounts_over(&database)
            .resolve_account_folders(account.account_id.clone())
            .await
            .expect("the account's folders resolve");

        assert_eq!(folders.configuration_folder, home);
        assert_eq!(
            folders.credential_store_folder,
            store_components
                .iter()
                .fold(home.to_path_buf(), |path, part| path.join(part))
        );
    }

    // Two runs on two accounts of one provider resolve their folders at once, each its own
    // account's, both folders under its own home and neither under the other's. Killed by one
    // account's folders reused for the other.
    #[tokio::test]
    async fn two_accounts_of_one_provider_resolved_at_once_each_answer_their_own_folders() {
        let database = TestDatabase::new(schema_parts());
        let data_folder = tempfile::tempdir().expect("a data folder");
        let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
        let first = register(&registry, "claude").await;
        let second = register(&registry, "claude").await;
        let accounts = accounts_over(&database);

        let (first_folders, second_folders) = tokio::join!(
            accounts.resolve_account_folders(first.account_id.clone()),
            accounts.resolve_account_folders(second.account_id.clone()),
        );

        for (account, other, folders) in [
            (&first, &second, first_folders),
            (&second, &first, second_folders),
        ] {
            let folders = folders.expect("each account's folders resolve");
            for folder in [
                &folders.configuration_folder,
                &folders.credential_store_folder,
            ] {
                assert!(folder.starts_with(account.credential_home.path()));
                assert!(!folder.starts_with(other.credential_home.path()));
            }
        }
    }
}
