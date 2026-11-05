//! An account's stored health: each reading of whether it is signed in, with the credential
//! generation a crossing raises, and the reset of its home, which always raises it.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::{Type, Value};
use sidekicks_contracts::provider::account::record::{
    CredentialGeneration, ProviderAccountHealthState, ProviderAccountId, ProviderAuthMode,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, StatementResult, WriteStatement, nullable_text_binding,
    text_binding,
};

use super::{
    HealthObservation, HealthObserver, KNOWN_HEALTH_STATE_SQL, ProviderAccountRegistry,
    credential_generation, refusal_or_failure,
};
use crate::account::errors::ProviderAccountRegistryError;

// A crossing is judged against the last reading that told, never against one that could not, and
// a reading that cannot tell crosses nothing. `IS` compares a never-told NULL as not signed in, so
// a first signed-in reading crosses in. A reading that reports the kind of sign-in stores it too.
static RECORD_HEALTH_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET credential_generation = credential_generation
           + (@bumps_generation
              AND @health_state IS NOT @indeterminate
              AND ((known_health_state IS @authenticated) != (@health_state IS @authenticated))),
         health_state = @health_state,
         health_observed_at = @health_observed_at,
         known_health_state = COALESCE({KNOWN_HEALTH_STATE_SQL}, known_health_state),
         observed_auth_mode = COALESCE(@observed_auth_mode, observed_auth_mode),
         updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0
  RETURNING credential_generation"
    )
});

// A reset raises the generation whatever the stored state, so a reading from before it is stale.
static RECORD_HOME_RESET_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET credential_generation = credential_generation + 1,
         health_state = @health_state,
         health_observed_at = @health_observed_at,
         known_health_state = @health_state,
         updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0
  RETURNING credential_generation"
    )
});

impl ProviderAccountRegistry {
    /// Stores `observation` as `account_id`'s health pair and answers its generation after it: a
    /// [`HealthObserver::Probe`] observation crossing into or out of being signed in from the last
    /// reading that could tell raises it by one in the same statement, while one that cannot tell
    /// and a background one never move it. Fails with
    /// [`ProviderAccountRegistryError::NotFound`] for an account not registered or being removed;
    /// a failed write keeps neither the reading nor the rise.
    pub async fn record_health(
        &self,
        account_id: &ProviderAccountId,
        observation: &HealthObservation,
        observer: HealthObserver,
    ) -> Result<CredentialGeneration, ProviderAccountRegistryError> {
        self.write_health(account_id, observation, observer, None)
            .await
    }

    /// Stores the status read a sign-in on `account_id` took as a [`HealthObserver::Probe`]
    /// reading does, with `observed_auth_mode`, the kind of sign-in it read, in the same
    /// statement, where it read one; answers the generation after it. Fails as
    /// [`Self::record_health`] does.
    pub async fn record_sign_in(
        &self,
        account_id: &ProviderAccountId,
        observation: &HealthObservation,
        observed_auth_mode: Option<ProviderAuthMode>,
    ) -> Result<CredentialGeneration, ProviderAccountRegistryError> {
        self.write_health(
            account_id,
            observation,
            HealthObserver::Probe,
            observed_auth_mode,
        )
        .await
    }

    // The health write both readings share, the kind of sign-in kept where `observed_auth_mode`
    // is `None`.
    async fn write_health(
        &self,
        account_id: &ProviderAccountId,
        observation: &HealthObservation,
        observer: HealthObserver,
        observed_auth_mode: Option<ProviderAuthMode>,
    ) -> Result<CredentialGeneration, ProviderAccountRegistryError> {
        let statements = vec![WriteStatement {
            sql: Cow::Borrowed(RECORD_HEALTH_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@account_id", account_id.as_str()),
                text_binding("@health_state", observation.state.into()),
                text_binding("@health_observed_at", observation.observed_at.as_str()),
                nullable_text_binding(
                    "@observed_auth_mode",
                    observed_auth_mode.map(<&'static str>::from),
                ),
                text_binding(
                    "@authenticated",
                    ProviderAccountHealthState::Authenticated.into(),
                ),
                text_binding(
                    "@indeterminate",
                    ProviderAccountHealthState::Indeterminate.into(),
                ),
                (
                    Cow::Borrowed("@bumps_generation"),
                    Value::Integer(i64::from(observer == HealthObserver::Probe)),
                ),
            ]),
            expected_row_count: Some(1),
        }];
        let results = match observed_auth_mode {
            Some(_) => self
                .observed_auth_modes
                .write_and_forget(&self.writer, account_id, statements)
                .await
                .map_err(refusal_or_failure)?,
            None => self.write(statements).await?,
        };
        returned_generation(&results)
    }

    /// Stores a reset of `account_id`'s home: its generation raised by one and its sign-in stored
    /// as gone, observed at `observed_at`, in one statement, answering the generation after it.
    /// Fails with [`ProviderAccountRegistryError::NotFound`] for an account not registered or
    /// being removed.
    pub(in crate::account) async fn record_home_reset(
        &self,
        account_id: &ProviderAccountId,
        observed_at: &WireInstant,
    ) -> Result<CredentialGeneration, ProviderAccountRegistryError> {
        let results = self
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(RECORD_HOME_RESET_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@account_id", account_id.as_str()),
                    text_binding(
                        "@health_state",
                        ProviderAccountHealthState::ReauthRequired.into(),
                    ),
                    text_binding("@health_observed_at", observed_at.as_str()),
                ]),
                expected_row_count: Some(1),
            }])
            .await?;
        returned_generation(&results)
    }
}

// The generation the write's one statement returned.
fn returned_generation(
    results: &[StatementResult],
) -> Result<CredentialGeneration, ProviderAccountRegistryError> {
    let generation = results
        .first()
        .and_then(|result| result.rows.first())
        .and_then(|row| row.first());
    match generation {
        Some(Value::Integer(generation)) => credential_generation(0, *generation),
        other => Err(rusqlite::Error::FromSqlConversionFailure(
            0,
            other.map_or(Type::Null, Value::data_type),
            "the stored generation is no integer".into(),
        )),
    }
    .map_err(ProviderAccountRegistryError::Query)
}
