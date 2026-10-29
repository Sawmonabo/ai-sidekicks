//! A pasted token's limits read by a turn: a token minted for inference alone cannot read its
//! account's limits, but every answer to it carries them, so on a provider whose descriptor says
//! so the observer's read of such an account sends the window-start turn in place of the limits
//! read, under the same single flight and home lock, and the turn's answer is the reading. The
//! turn's spend is written as a usage row of its own and, since it also starts the account's closed
//! windows, as the account's last window-start turn.

use sidekicks_contracts::provider::account::record::ProviderAuthMode;

use crate::account::observer::{ObserverShared, ProviderAccountObserverError, READ_BOUND};
use crate::account::registry::RegisteredAccount;
use crate::driver::contract::account::ProviderObservation;
use crate::driver::{ProviderAccountFolders, descriptor_of};

/// Whether `account`'s limits are read by a turn: a pasted token on a provider whose token cannot
/// read them itself.
pub(super) fn reads_limits_by_turn(account: &RegisteredAccount) -> bool {
    account.observed_auth_mode == Some(ProviderAuthMode::OauthToken)
        && descriptor_of(account.provider.as_str())
            .is_some_and(|descriptor| descriptor.token_limits_read_by_turn)
}

impl ObserverShared {
    /// Reads `account`'s limits by one turn in `folders` on its sealed token, bounded, and writes
    /// the turn's spend; answers the turn's reading, `None` where the turn failed or took too
    /// long. Fails when the provider has no such turn, the token cannot be read or the spend
    /// cannot be written.
    pub(super) async fn read_token_limits(
        &self,
        account: &RegisteredAccount,
        folders: ProviderAccountFolders,
    ) -> Result<Option<ProviderObservation>, ProviderAccountObserverError> {
        let legs = self
            .window_turn_legs
            .get(&account.provider)
            .ok_or(ProviderAccountObserverError::ProviderUnobserved)?;
        let token = self.token_custody.read_token(&account.account_id).await?;
        match tokio::time::timeout(
            READ_BOUND,
            legs.read_token_limits(&account.account_id, &folders, &token),
        )
        .await
        {
            Ok(Ok(reading)) => {
                if let Some(spend) = &reading.spend {
                    self.record_window_turn(&account.account_id, spend).await?;
                }
                Ok(Some(reading.observation))
            }
            Ok(Err(error)) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "an account's token read by a turn failed"
                );
                Ok(None)
            }
            Err(_elapsed) => {
                tracing::warn!("an account's token read by a turn took too long");
                Ok(None)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use secrecy::SecretString;
    use sidekicks_contracts::provider::account::record::ProviderAuthMode;
    use sidekicks_store::credential_store::SecretKeychain as _;
    use sidekicks_store::database::writer::test_file::TestDatabase;

    use crate::account::observer::ReadAsker;
    use crate::account::observer::tests::{
        Fixture, ScriptedLegs, claude, new_clock, read_reading, usage_rows,
    };
    use crate::driver::contract::account::ProviderObservation;
    use crate::driver::schema::schema_parts;

    // The five-minute read of a pasted Claude token sends a turn on the sealed token in place of
    // the limits read, takes its answer as the reading and writes its spend as one row with no
    // session. Killed by the limits read run on the token (a read counted, no token handed) and by
    // the turn's spend dropped (no row).
    #[tokio::test(start_paused = true)]
    async fn a_pasted_token_is_read_by_a_turn_that_writes_a_sessionless_row() {
        let database = TestDatabase::new(schema_parts());
        let data_folder = tempfile::tempdir().expect("a data folder");
        let fixture = Fixture::open(
            &database,
            data_folder.path(),
            new_clock(),
            ScriptedLegs::default(),
        )
        .await;
        let account = fixture
            .register_on(claude(), Some(ProviderAuthMode::OauthToken))
            .await;
        fixture
            .keychain
            .write(
                account.account_id.as_str(),
                &SecretString::from("pasted-token"),
            )
            .await
            .expect("the token is sealed");

        let reading = read_reading(fixture.read(&account, ReadAsker::Cadence).await);

        assert_eq!(reading.observation, Some(ProviderObservation::Figures));
        assert_eq!(fixture.legs.reads(), 0);
        assert_eq!(fixture.turns[&claude()].tokens_read(), ["pasted-token"]);
        assert_eq!(usage_rows(&database, &account), [(None::<String>, 1_i64)]);
    }
}
