//! The provider account registry: the accounts this machine runs providers on, one row each in
//! `provider_accounts`, read on the daemon's read connections and written only through its
//! database writer, each act one write.
//!
//! - A new account's id and home are minted at its sign-in's start and held in memory; only an
//!   admission, once a sign-in or status read found it signed in, writes its row. The home is
//!   always the one minted under the data folder: no act takes a path from a caller.
//! - Making an account current clears the provider's mark, then sets it, in one write, so no
//!   reader sees two current accounts or none.
//! - The generation rises when a probe sees the account cross into or out of being signed in, in
//!   the same statement that stores the reading; the background observer stores its reading and
//!   never moves the generation.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use rusqlite::types::{Type, Value};
use rusqlite::{Connection, OptionalExtension, Row};
use serde_json::Value as JsonValue;
use sidekicks_contracts::provider::account::record::{
    BillingMode, CredentialGeneration, ProviderAccountHealthState, ProviderAccountId,
    ProviderAuthMode,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_std::random_hex::random_hex;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, StatementResult, WriteStatement, text_binding,
};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

use crate::account::credential_home::{
    CredentialHome, create_credential_home, remove_credential_home,
};
use crate::account::errors::ProviderAccountRegistryError;

/// The statements a [`ProviderAccountRegistry`] prepares on a read connection: every account, a
/// provider's accounts, and one account.
pub const PROVIDER_ACCOUNT_REGISTRY_STATEMENT_CAPACITY: usize = 3;

// The random bytes of a minted account id, written as hexadecimal.
const ACCOUNT_ID_BYTES: usize = 16;

// An account whose removal has begun is no longer read as registered.
const ACCOUNT_COLUMNS_SQL: &str = "
  SELECT account_id, provider, credential_home_path, credential_generation, billing_mode,
         is_default, health_state, health_observed_at, probe_enabled, window_start_enabled,
         wake_for_window_start_enabled, observed_auth_mode
    FROM provider_accounts
   WHERE removal_intent = 0";

static SELECT_ACCOUNTS_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{ACCOUNT_COLUMNS_SQL} ORDER BY created_at, account_id"));

static SELECT_PROVIDER_ACCOUNTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!("{ACCOUNT_COLUMNS_SQL} AND provider = ? ORDER BY created_at, account_id")
});

static SELECT_ACCOUNT_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{ACCOUNT_COLUMNS_SQL} AND account_id = ?"));

// The provider's first account becomes its current one; a later one leaves the mark where it is.
static INSERT_ACCOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO provider_accounts (account_id, provider, credential_home_path, billing_mode,
                                       is_default, health_state, health_observed_at, created_at,
                                       updated_at)
  SELECT @account_id, @provider, @credential_home_path, @billing_mode,
         NOT EXISTS (SELECT 1 FROM provider_accounts WHERE provider = @provider AND is_default = 1),
         @health_state, @health_observed_at, {DATABASE_NOW_SQL}, {DATABASE_NOW_SQL}"
    )
});

static CLEAR_CURRENT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET is_default = 0, updated_at = {DATABASE_NOW_SQL}
   WHERE is_default = 1
     AND account_id != @account_id
     AND provider = (SELECT provider FROM provider_accounts WHERE account_id = @account_id)"
    )
});

static SET_CURRENT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET is_default = 1, updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0"
    )
});

// `IS` compares a never-observed NULL as not signed in, so a first signed-in reading crosses in.
static RECORD_HEALTH_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET credential_generation = credential_generation
           + (@bumps_generation
              AND ((health_state IS @authenticated) != (@health_state IS @authenticated))),
         health_state = @health_state,
         health_observed_at = @health_observed_at,
         updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0
  RETURNING credential_generation"
    )
});

// A step parked on the account holds its removal: it expects no row.
static WAITING_STEP_GUARD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM workflow_steps
   WHERE wait_account_id = @account_id AND status = '{waiting}' AND wait_cause = '{account}'",
        waiting = <&'static str>::from(WorkflowStepStatus::Waiting),
        account = <&'static str>::from(WorkflowWaitCause::Account),
    )
});

static MARK_REMOVAL_INTENT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET removal_intent = 1, updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0"
    )
});

static CHANGE_SETTINGS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET probe_enabled = COALESCE(@probe_enabled, probe_enabled),
         window_start_enabled = COALESCE(@window_start_enabled, window_start_enabled),
         wake_for_window_start_enabled =
           COALESCE(@wake_for_window_start_enabled, wake_for_window_start_enabled),
         updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0"
    )
});

/// A new account's id and credential home, minted at its sign-in's start and held in memory until
/// [`ProviderAccountRegistry::admit`] writes its row or [`ProviderAccountRegistry::abandon`]
/// removes its home.
#[derive(Debug)]
pub struct MintedAccount {
    account_id: ProviderAccountId,
    provider: ProviderId,
    home: CredentialHome,
}

impl MintedAccount {
    /// The account's minted id.
    pub fn account_id(&self) -> &ProviderAccountId {
        &self.account_id
    }

    /// The provider the account signs in to.
    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }

    /// The home its sign-in runs in.
    pub fn home(&self) -> &CredentialHome {
        &self.home
    }
}

/// One observation of an account's health: the state and when it was seen, always together.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HealthObservation {
    /// The state seen.
    pub state: ProviderAccountHealthState,
    /// When it was seen.
    pub observed_at: WireInstant,
}

/// Who took a health observation: a probe, whose crossing of the signed-in boundary moves the
/// generation, or the background observer, whose crossing never does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HealthObserver {
    /// The probe verb, or a sign-in's or registration's status read.
    Probe,
    /// The background observer's cadence.
    Background,
}

/// What an admission writes beside the minted id and home: how the account is charged and the
/// observation that admitted it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountAdmission {
    /// How the account is charged.
    pub billing_mode: BillingMode,
    /// The observation that found it signed in.
    pub health: HealthObservation,
}

/// The per-account switches `provider.account.update` changes; `None` leaves one as it is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AccountSettingsChange {
    /// The background observer's opt-out.
    pub probe_enabled: Option<bool>,
    /// Start each usage window as it opens.
    pub window_start_enabled: Option<bool>,
    /// Wake the machine for a window that resets while it sleeps.
    pub wake_for_window_start_enabled: Option<bool>,
}

/// One registered account as the registry stores it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegisteredAccount {
    /// The account's id.
    pub account_id: ProviderAccountId,
    /// Its provider.
    pub provider: ProviderId,
    /// Its credential home.
    pub credential_home: CredentialHome,
    /// Its credential generation.
    pub credential_generation: CredentialGeneration,
    /// How it is charged.
    pub billing_mode: BillingMode,
    /// Whether it is its provider's current account.
    pub is_default: bool,
    /// Its last stored observation, `None` until one is made.
    pub health: Option<HealthObservation>,
    /// The background observer's opt-out.
    pub probe_enabled: bool,
    /// Start each usage window as it opens.
    pub window_start_enabled: bool,
    /// Wake the machine for a window that resets while it sleeps.
    pub wake_for_window_start_enabled: bool,
    /// The mode the provider's own status output last reported, `None` until one is observed.
    pub observed_auth_mode: Option<ProviderAuthMode>,
}

/// The registry of provider accounts, over the daemon's read connections and its one writer; it
/// holds no write handle of its own.
pub struct ProviderAccountRegistry {
    reads: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    data_folder: PathBuf,
}

impl ProviderAccountRegistry {
    /// A registry reading through `reads`, writing through `writer`, and minting homes under
    /// `data_folder`, the daemon's absolute data folder.
    pub fn new(
        reads: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
        data_folder: PathBuf,
    ) -> Self {
        Self {
            reads,
            writer,
            data_folder,
        }
    }

    /// Mints a new `provider` account's id and makes its home, writing no row. Fails when the
    /// system gives no random bytes or the home cannot be made.
    pub fn mint(
        &self,
        provider: ProviderId,
    ) -> Result<MintedAccount, ProviderAccountRegistryError> {
        let account_id = ProviderAccountId::new(
            random_hex(ACCOUNT_ID_BYTES).map_err(ProviderAccountRegistryError::Mint)?,
        )
        .expect("a hexadecimal id of a fixed length is an account id");
        let home = create_credential_home(&self.data_folder, &account_id)
            .map_err(ProviderAccountRegistryError::CredentialHome)?;
        Ok(MintedAccount {
            account_id,
            provider,
            home,
        })
    }

    /// Writes `minted`'s row with `admission`, at generation 1, current where its provider has no
    /// current account, and answers it. Fails when the write is not kept, including for an
    /// account already admitted; the minted home stays for the caller to abandon.
    pub async fn admit(
        &self,
        minted: &MintedAccount,
        admission: &AccountAdmission,
    ) -> Result<RegisteredAccount, ProviderAccountRegistryError> {
        let home_path = minted.home.path().to_string_lossy();
        self.write(vec![WriteStatement {
            sql: Cow::Borrowed(INSERT_ACCOUNT_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@account_id", minted.account_id.as_str()),
                text_binding("@provider", minted.provider.as_str()),
                text_binding("@credential_home_path", &home_path),
                text_binding("@billing_mode", admission.billing_mode.into()),
                text_binding("@health_state", admission.health.state.into()),
                text_binding("@health_observed_at", admission.health.observed_at.as_str()),
            ]),
            expected_row_count: Some(1),
        }])
        .await?;
        self.read(minted.account_id.clone()).await
    }

    /// Removes the home of `minted`, an account no sign-in admitted. Fails when the home cannot
    /// be removed.
    pub fn abandon(&self, minted: MintedAccount) -> Result<(), ProviderAccountRegistryError> {
        remove_credential_home(&minted.home).map_err(ProviderAccountRegistryError::CredentialHome)
    }

    /// Every registered account, or `provider`'s alone, oldest first. Fails when the accounts
    /// cannot be read.
    pub async fn list(
        &self,
        provider: Option<ProviderId>,
    ) -> Result<Vec<RegisteredAccount>, ProviderAccountRegistryError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                query_accounts(connection, provider.as_ref())
            })
            .await
    }

    /// The registered account `account_id`. Fails with
    /// [`ProviderAccountRegistryError::NotFound`] for an account not registered or being removed,
    /// and when it cannot be read.
    pub async fn read(
        &self,
        account_id: ProviderAccountId,
    ) -> Result<RegisteredAccount, ProviderAccountRegistryError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                connection
                    .prepare_cached(&SELECT_ACCOUNT_SQL)?
                    .query_row([account_id.as_str()], read_account)
                    .optional()?
                    .ok_or(ProviderAccountRegistryError::NotFound)
            })
            .await
    }

    /// Makes `account_id` its provider's current account: the provider's mark cleared, then set
    /// on it, in one write. Fails with [`ProviderAccountRegistryError::NotFound`] for an account
    /// not registered or being removed, keeping the old mark.
    pub async fn make_current(
        &self,
        account_id: ProviderAccountId,
    ) -> Result<RegisteredAccount, ProviderAccountRegistryError> {
        let bindings =
            StatementBindings::Named(vec![text_binding("@account_id", account_id.as_str())]);
        self.write(vec![
            WriteStatement {
                sql: Cow::Borrowed(CLEAR_CURRENT_SQL.as_str()),
                bindings: bindings.clone(),
                expected_row_count: None,
            },
            WriteStatement {
                sql: Cow::Borrowed(SET_CURRENT_SQL.as_str()),
                bindings,
                expected_row_count: Some(1),
            },
        ])
        .await?;
        self.read(account_id).await
    }

    /// Stores `observation` as `account_id`'s health pair and answers its generation after it: a
    /// [`HealthObserver::Probe`] observation crossing into or out of being signed in raises it by
    /// one in the same statement, and a background one never moves it. Fails with
    /// [`ProviderAccountRegistryError::NotFound`] for an account not registered or being removed;
    /// a failed write keeps neither the reading nor the rise.
    pub async fn record_health(
        &self,
        account_id: &ProviderAccountId,
        observation: &HealthObservation,
        observer: HealthObserver,
    ) -> Result<CredentialGeneration, ProviderAccountRegistryError> {
        let results = self
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(RECORD_HEALTH_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@account_id", account_id.as_str()),
                    text_binding("@health_state", observation.state.into()),
                    text_binding("@health_observed_at", observation.observed_at.as_str()),
                    text_binding(
                        "@authenticated",
                        ProviderAccountHealthState::Authenticated.into(),
                    ),
                    (
                        Cow::Borrowed("@bumps_generation"),
                        Value::Integer(i64::from(observer == HealthObserver::Probe)),
                    ),
                ]),
                expected_row_count: Some(1),
            }])
            .await?;
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

    /// Marks `account_id` for removal, the first write of its removal: refused while a workflow
    /// step waits on the account. Fails with [`ProviderAccountRegistryError::StepWaiting`] then,
    /// and with [`ProviderAccountRegistryError::NotFound`] for an account not registered or
    /// already marked; either way nothing is marked.
    pub async fn mark_removal_intent(
        &self,
        account_id: &ProviderAccountId,
    ) -> Result<(), ProviderAccountRegistryError> {
        let bindings =
            StatementBindings::Named(vec![text_binding("@account_id", account_id.as_str())]);
        match self
            .writer
            .write(vec![
                WriteStatement {
                    sql: Cow::Borrowed(WAITING_STEP_GUARD_SQL.as_str()),
                    bindings: bindings.clone(),
                    expected_row_count: Some(0),
                },
                WriteStatement {
                    sql: Cow::Borrowed(MARK_REMOVAL_INTENT_SQL.as_str()),
                    bindings,
                    expected_row_count: Some(1),
                },
            ])
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if error.refused_statement_index() == Some(0) => {
                Err(ProviderAccountRegistryError::StepWaiting)
            }
            Err(error) => Err(refusal_or_failure(error)),
        }
    }

    /// Changes `account_id`'s per-account switches as `change` names and answers the account.
    /// Fails with [`ProviderAccountRegistryError::NotFound`] for an account not registered or
    /// being removed.
    pub async fn change_settings(
        &self,
        account_id: ProviderAccountId,
        change: AccountSettingsChange,
    ) -> Result<RegisteredAccount, ProviderAccountRegistryError> {
        self.write(vec![WriteStatement {
            sql: Cow::Borrowed(CHANGE_SETTINGS_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@account_id", account_id.as_str()),
                switch_binding("@probe_enabled", change.probe_enabled),
                switch_binding("@window_start_enabled", change.window_start_enabled),
                switch_binding(
                    "@wake_for_window_start_enabled",
                    change.wake_for_window_start_enabled,
                ),
            ]),
            expected_row_count: Some(1),
        }])
        .await?;
        self.read(account_id).await
    }

    // Runs `statements` as one write, a refused count answering that no registered account
    // matched.
    async fn write(
        &self,
        statements: Vec<WriteStatement>,
    ) -> Result<Vec<StatementResult>, ProviderAccountRegistryError> {
        self.writer
            .write(statements)
            .await
            .map_err(refusal_or_failure)
    }
}

// A statement that matched no registered account, or the write's own failure.
fn refusal_or_failure(error: WriteError) -> ProviderAccountRegistryError {
    if error.refused_statement_index().is_some() {
        ProviderAccountRegistryError::NotFound
    } else {
        ProviderAccountRegistryError::Write(error)
    }
}

fn switch_binding(name: &'static str, switch: Option<bool>) -> (Cow<'static, str>, Value) {
    (
        Cow::Borrowed(name),
        switch.map_or(Value::Null, |switch| Value::Integer(i64::from(switch))),
    )
}

fn query_accounts(
    connection: &Connection,
    provider: Option<&ProviderId>,
) -> Result<Vec<RegisteredAccount>, ProviderAccountRegistryError> {
    let accounts = match provider {
        Some(provider) => connection
            .prepare_cached(&SELECT_PROVIDER_ACCOUNTS_SQL)?
            .query_map([provider.as_str()], read_account)?
            .collect::<Result<_, _>>()?,
        None => connection
            .prepare_cached(&SELECT_ACCOUNTS_SQL)?
            .query_map([], read_account)?
            .collect::<Result<_, _>>()?,
    };
    Ok(accounts)
}

fn read_account(row: &Row<'_>) -> rusqlite::Result<RegisteredAccount> {
    let health_state: Option<ProviderAccountHealthState> =
        optional_text_column(row, 6, closed_word)?;
    let health_observed_at = optional_text_column(row, 7, WireInstant::try_from)?;
    Ok(RegisteredAccount {
        account_id: text_column(row, 0, |text| {
            ProviderAccountId::new(text).ok_or(StoredValueRefused("account id"))
        })?,
        provider: text_column(row, 1, |text| {
            ProviderId::new(text).ok_or(StoredValueRefused("provider id"))
        })?,
        credential_home: CredentialHome::from_stored(row.get(2)?),
        credential_generation: credential_generation(3, row.get(3)?)?,
        billing_mode: text_column(row, 4, closed_word)?,
        is_default: row.get(5)?,
        // The table refuses a state without its time and a time without its state.
        health: health_state
            .zip(health_observed_at)
            .map(|(state, observed_at)| HealthObservation { state, observed_at }),
        probe_enabled: row.get(8)?,
        window_start_enabled: row.get(9)?,
        wake_for_window_start_enabled: row.get(10)?,
        observed_auth_mode: optional_text_column(row, 11, closed_word)?,
    })
}

// The generation stored in the column at `index`, read through its wire form, which refuses one
// below 1 or past 2^53 − 1.
fn credential_generation(index: usize, stored: i64) -> rusqlite::Result<CredentialGeneration> {
    serde_json::from_value(JsonValue::from(stored)).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(error))
    })
}

/// A stored value its type refuses: a damaged row, never a caller's input.
#[derive(Debug, thiserror::Error)]
#[error("the stored {0} is not valid")]
struct StoredValueRefused(&'static str);

#[cfg(test)]
mod tests;
