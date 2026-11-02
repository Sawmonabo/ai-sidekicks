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
//!   never moves the generation. A home reset always raises it, with the sign-in stored as gone.
//! - An account's place on the limits read's throttle ladder is kept on its row, so a restart
//!   resumes a hold where it stood.
//! - The limit resets an account can redeem are kept from its last limits read, none where that
//!   read carried no count.
//! - An account's one memory import is kept on its row once it has run.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use rusqlite::types::{Type, Value};
use rusqlite::{ErrorCode, OptionalExtension, Row};
use serde_json::Value as JsonValue;
use sidekicks_contracts::name_fold::fold_name;
use sidekicks_contracts::provider::account::record::{
    BillingMode, CredentialGeneration, DisplayLabel, PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN,
    ProviderAccountHealthState, ProviderAccountId, ProviderAccountMemoryImportOutcome,
    ProviderAuthMode,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::random_hex::random_hex;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, StatementResult, WriteStatement, nullable_text_binding,
    text_binding,
};
use sidekicks_store::database::stored_column::optional_text_column;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

use crate::account::credential_home::{
    CredentialHome, create_credential_home, remove_credential_home,
};
use crate::account::errors::ProviderAccountRegistryError;
use crate::driver::contract::account::ObservedAccountIdentity;

pub mod record;
pub mod removal;

use self::record::{query_accounts, query_registered_account};

/// The statements the account plane prepares on a read connection: every account, a provider's
/// accounts, one account, every account id with its removal intent, the workflow runs waiting on
/// an account, the stored quota readings, one account's read hold, and the window start's two, an
/// account's window resets and its last window-start turn.
pub const PROVIDER_ACCOUNT_REGISTRY_STATEMENT_CAPACITY: usize = 9;

// The random bytes of a minted account id, written as hexadecimal.
const ACCOUNT_ID_BYTES: usize = 16;

// The provider's first account becomes its current one; a later one leaves the mark where it is.
static INSERT_ACCOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO provider_accounts (account_id, provider, display_label, display_label_folded,
                                       credential_home_path, billing_mode, is_default,
                                       health_state, health_observed_at, observed_auth_mode,
                                       created_at, updated_at)
  SELECT @account_id, @provider, @display_label, @display_label_folded, @credential_home_path,
         @billing_mode,
         NOT EXISTS (SELECT 1 FROM provider_accounts WHERE provider = @provider AND is_default = 1),
         @health_state, @health_observed_at, @observed_auth_mode, {DATABASE_NOW_SQL},
         {DATABASE_NOW_SQL}"
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

// A reset raises the generation whatever the stored state, so a reading from before it is stale.
static RECORD_HOME_RESET_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET credential_generation = credential_generation + 1,
         health_state = @health_state,
         health_observed_at = @health_observed_at,
         updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0
  RETURNING credential_generation"
    )
});

// A replaced token is a new credential for the same account, so its generation rises once here
// and the status read that admitted it is stored with it, never crossing the probe's rule again.
static RECORD_TOKEN_REPLACEMENT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET credential_generation = credential_generation + 1,
         health_state = @health_state,
         health_observed_at = @health_observed_at,
         observed_auth_mode = @observed_auth_mode,
         updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0"
    )
});

const SELECT_READ_HOLD_SQL: &str = "
  SELECT read_hold_rung, read_held_until
    FROM provider_accounts
   WHERE account_id = ? AND removal_intent = 0";

// One rung up; each `@hold_<n>` is when a hold that puts the account on rung `n` ends, the last
// one standing for every rung past it. SQLite reads the old rung on both sides of the `SET`.
static CLIMB_READ_HOLD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET read_hold_rung = read_hold_rung + 1,
         read_held_until = CASE read_hold_rung
                             WHEN 0 THEN @hold_1
                             WHEN 1 THEN @hold_2
                             WHEN 2 THEN @hold_3
                             ELSE @hold_4
                           END,
         updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0
  RETURNING read_hold_rung, read_held_until"
    )
});

// Writes only an account that is on the ladder, so an answered read most often writes nothing.
static CLEAR_READ_HOLD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET read_hold_rung = 0, read_held_until = NULL, updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id
     AND (read_hold_rung != 0 OR read_held_until IS NOT NULL)"
    )
});

static RECORD_RESET_CREDITS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET reset_credits_available = @reset_credits_available, updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0"
    )
});

static RECORD_MEMORY_IMPORT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET memory_import_outcome = @outcome, memory_import_count = @count,
         memory_imported_at = @imported_at, updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0"
    )
});

static CHANGE_SETTINGS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET display_label = COALESCE(@display_label, display_label),
         display_label_folded = COALESCE(@display_label_folded, display_label_folded),
         billing_mode = COALESCE(@billing_mode, billing_mode),
         probe_enabled = COALESCE(@probe_enabled, probe_enabled),
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

/// What an admission writes beside the minted id and home: how the account is charged, the
/// observation that admitted it, if any, and what that observation saw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountAdmission {
    /// The name the person typed for a pasted-token account, `None` for one its provider names.
    pub display_label: Option<DisplayLabel>,
    /// How the account is charged.
    pub billing_mode: BillingMode,
    /// The observation that found it signed in; `None` for an account registered before any
    /// sign-in, which its own sign-in or the observer reads next.
    pub health: Option<HealthObservation>,
    /// The mode the provider's own status read reported, `None` where none was observed.
    pub observed_auth_mode: Option<ProviderAuthMode>,
}

/// The per-account settings `provider.account.update` changes; `None` leaves one as it is.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountSettingsChange {
    /// A new name for an account added from a pasted token or API key; the row refuses one on
    /// any other account, so the caller checks that first.
    pub display_label: Option<DisplayLabel>,
    /// How the account is charged.
    pub billing_mode: Option<BillingMode>,
    /// The background observer's opt-out.
    pub probe_enabled: Option<bool>,
    /// Start each usage window as it opens.
    pub window_start_enabled: Option<bool>,
    /// Wake the machine for a window that resets while it sleeps.
    pub wake_for_window_start_enabled: Option<bool>,
}

/// An account's place on the limits read's throttle ladder: how many reads in a row the provider
/// refused, and when the latest hold ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReadHold {
    /// 0 once a read answered, one more for each refused read since.
    pub(crate) rung: u32,
    /// When the latest hold ends; `None` until one is set.
    pub(crate) held_until: Option<WireInstant>,
}

/// The name the person typed for an account added from a pasted token or API key.
pub type StoredDisplayLabel = FreeFormText<PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN>;

/// One registered account as the registry stores it.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "each flag is one setting or mark the account's row stores"
)]
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
    /// The name the person typed for a pasted-token account, `None` for one its provider names.
    pub display_label: Option<StoredDisplayLabel>,
    /// The identity the provider last reported, each member kept from the read that reported it.
    pub observed_identity: ObservedAccountIdentity,
    /// When the home's credential was issued, `None` where nothing produced the time.
    pub signed_in_at: Option<WireInstant>,
    /// When the credential was last seen renewed, `None` for none seen.
    pub last_refresh_observed_at: Option<WireInstant>,
    /// The account's one memory import, `None` until it has run.
    pub memory_import: Option<ProviderAccountMemoryImportOutcome>,
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
        let home = create_credential_home(&self.data_folder, &provider, &account_id)
            .map_err(ProviderAccountRegistryError::CredentialHome)?;
        Ok(MintedAccount {
            account_id,
            provider,
            home,
        })
    }

    /// Writes `minted`'s row with `admission`, at generation 1, current where its provider has no
    /// current account, and answers it. Fails with
    /// [`ProviderAccountRegistryError::DisplayLabelTaken`] for a name another account of the
    /// provider holds, and when the write is not kept, including for an account already
    /// admitted; the minted home stays for the caller to abandon.
    pub async fn admit(
        &self,
        minted: &MintedAccount,
        admission: &AccountAdmission,
    ) -> Result<RegisteredAccount, ProviderAccountRegistryError> {
        let home_path = minted.home.path().to_string_lossy();
        let display_label = admission.display_label.as_ref().map(DisplayLabel::as_str);
        let display_label_folded = display_label.map(fold_name);
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(INSERT_ACCOUNT_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@account_id", minted.account_id.as_str()),
                    text_binding("@provider", minted.provider.as_str()),
                    nullable_text_binding("@display_label", display_label),
                    nullable_text_binding("@display_label_folded", display_label_folded.as_deref()),
                    text_binding("@credential_home_path", &home_path),
                    text_binding("@billing_mode", admission.billing_mode.into()),
                    nullable_text_binding(
                        "@health_state",
                        admission.health.as_ref().map(|health| health.state.into()),
                    ),
                    nullable_text_binding(
                        "@health_observed_at",
                        admission
                            .health
                            .as_ref()
                            .map(|health| health.observed_at.as_str()),
                    ),
                    nullable_text_binding(
                        "@observed_auth_mode",
                        admission.observed_auth_mode.map(<&'static str>::from),
                    ),
                ]),
                expected_row_count: Some(1),
            }])
            .await
            .map_err(label_refusal_or_failure)?;
        self.read(minted.account_id.clone()).await
    }

    /// The daemon's data folder, which holds every home and the agents' shared memory.
    pub(super) fn data_folder(&self) -> &Path {
        &self.data_folder
    }

    /// Removes the home of `minted`, an account no sign-in admitted. Fails when the home cannot
    /// be removed.
    #[expect(
        clippy::needless_pass_by_value,
        reason = "abandoning consumes the minted account, so it cannot be admitted after"
    )]
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
                query_registered_account(connection, &account_id)?
                    .ok_or(ProviderAccountRegistryError::NotFound)
            })
            .await
    }

    /// Makes `account_id` its provider's current account: the provider's mark cleared, then set
    /// on it, in one write. Fails with [`ProviderAccountRegistryError::NotFound`] for an account
    /// not registered or being removed, and with [`ProviderAccountRegistryError::CurrentConflict`]
    /// when the one-current index refuses the mark; either keeps the old mark.
    pub async fn make_current(
        &self,
        account_id: ProviderAccountId,
    ) -> Result<RegisteredAccount, ProviderAccountRegistryError> {
        let bindings =
            StatementBindings::Named(vec![text_binding("@account_id", account_id.as_str())]);
        self.writer
            .write(vec![
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
            .await
            .map_err(current_refusal_or_failure)?;
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
        returned_generation(&results)
    }

    /// Stores a reset of `account_id`'s home: its generation raised by one and its sign-in stored
    /// as gone, observed at `observed_at`, in one statement, answering the generation after it.
    /// Fails with [`ProviderAccountRegistryError::NotFound`] for an account not registered or
    /// being removed.
    pub(super) async fn record_home_reset(
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

    /// Stores a replaced token's admission on `account_id`: its generation raised by one, with
    /// `health` and `observed_auth_mode` from the status read that admitted the token, in one
    /// write. Fails with [`ProviderAccountRegistryError::NotFound`] for an account not registered
    /// or being removed, keeping nothing.
    pub async fn record_token_replacement(
        &self,
        account_id: ProviderAccountId,
        health: &HealthObservation,
        observed_auth_mode: ProviderAuthMode,
    ) -> Result<RegisteredAccount, ProviderAccountRegistryError> {
        self.write(vec![WriteStatement {
            sql: Cow::Borrowed(RECORD_TOKEN_REPLACEMENT_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@account_id", account_id.as_str()),
                text_binding("@health_state", health.state.into()),
                text_binding("@health_observed_at", health.observed_at.as_str()),
                text_binding("@observed_auth_mode", observed_auth_mode.into()),
            ]),
            expected_row_count: Some(1),
        }])
        .await?;
        self.read(account_id).await
    }

    /// `account_id`'s place on the read's throttle ladder. Fails with
    /// [`ProviderAccountRegistryError::NotFound`] for an account not registered or being removed.
    pub(super) async fn read_hold(
        &self,
        account_id: ProviderAccountId,
    ) -> Result<ReadHold, ProviderAccountRegistryError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                connection
                    .prepare_cached(SELECT_READ_HOLD_SQL)?
                    .query_row([account_id.as_str()], read_hold)
                    .optional()?
                    .ok_or(ProviderAccountRegistryError::NotFound)
            })
            .await
    }

    /// Puts `account_id` one rung up the read's throttle ladder, held until `hold_ends[n - 1]`
    /// where `n` is its new rung, the last entry for every rung past the fourth, in one statement,
    /// and answers its new place. Fails with [`ProviderAccountRegistryError::NotFound`] for an
    /// account not registered or being removed.
    pub(super) async fn climb_read_hold(
        &self,
        account_id: &ProviderAccountId,
        hold_ends: &[WireInstant; 4],
    ) -> Result<ReadHold, ProviderAccountRegistryError> {
        let [first, second, third, fourth] = hold_ends;
        let results = self
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(CLIMB_READ_HOLD_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@account_id", account_id.as_str()),
                    text_binding("@hold_1", first.as_str()),
                    text_binding("@hold_2", second.as_str()),
                    text_binding("@hold_3", third.as_str()),
                    text_binding("@hold_4", fourth.as_str()),
                ]),
                expected_row_count: Some(1),
            }])
            .await?;
        returned_read_hold(&results).map_err(ProviderAccountRegistryError::Query)
    }

    /// Takes `account_id` off the read's throttle ladder, a write only where it was on it. An
    /// account not registered is left as it is. Fails when the write is not kept.
    pub(super) async fn clear_read_hold(
        &self,
        account_id: &ProviderAccountId,
    ) -> Result<(), ProviderAccountRegistryError> {
        self.write(vec![WriteStatement {
            sql: Cow::Borrowed(CLEAR_READ_HOLD_SQL.as_str()),
            bindings: StatementBindings::Named(vec![text_binding(
                "@account_id",
                account_id.as_str(),
            )]),
            expected_row_count: None,
        }])
        .await?;
        Ok(())
    }

    /// Stores `available`, the limit resets `account_id` can redeem as its last limits read
    /// counted them, `None` where the read carried no count. Fails with
    /// [`ProviderAccountRegistryError::NotFound`] for an account not registered or being removed.
    pub async fn record_reset_credits(
        &self,
        account_id: &ProviderAccountId,
        available: Option<u32>,
    ) -> Result<(), ProviderAccountRegistryError> {
        self.write(vec![WriteStatement {
            sql: Cow::Borrowed(RECORD_RESET_CREDITS_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@account_id", account_id.as_str()),
                (
                    Cow::Borrowed("@reset_credits_available"),
                    available.map_or(Value::Null, |count| Value::Integer(i64::from(count))),
                ),
            ]),
            expected_row_count: Some(1),
        }])
        .await
        .map(drop)
    }

    /// Stores `outcome` as `account_id`'s one memory import. Fails with
    /// [`ProviderAccountRegistryError::NotFound`] for an account not registered or being removed.
    pub(super) async fn record_memory_import(
        &self,
        account_id: &ProviderAccountId,
        outcome: &ProviderAccountMemoryImportOutcome,
    ) -> Result<(), ProviderAccountRegistryError> {
        let (count, imported_at) = match outcome {
            ProviderAccountMemoryImportOutcome::Imported { count, imported_at } => (
                Value::Integer(i64::try_from(count.get()).expect("a safe integer fits an i64")),
                Some(imported_at.as_str()),
            ),
            ProviderAccountMemoryImportOutcome::NothingToImport {} => (Value::Null, None),
        };
        self.write(vec![WriteStatement {
            sql: Cow::Borrowed(RECORD_MEMORY_IMPORT_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@account_id", account_id.as_str()),
                text_binding("@outcome", outcome.into()),
                (Cow::Borrowed("@count"), count),
                nullable_text_binding("@imported_at", imported_at),
            ]),
            expected_row_count: Some(1),
        }])
        .await
        .map(drop)
    }

    /// Changes `account_id`'s settings as `change` names and answers the account. Fails with
    /// [`ProviderAccountRegistryError::NotFound`] for an account not registered or being removed,
    /// and with [`ProviderAccountRegistryError::DisplayLabelTaken`] for a name another account of
    /// the provider holds.
    pub async fn change_settings(
        &self,
        account_id: ProviderAccountId,
        change: AccountSettingsChange,
    ) -> Result<RegisteredAccount, ProviderAccountRegistryError> {
        let display_label = change.display_label.as_ref().map(DisplayLabel::as_str);
        let display_label_folded = display_label.map(fold_name);
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(CHANGE_SETTINGS_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@account_id", account_id.as_str()),
                    nullable_text_binding("@display_label", display_label),
                    nullable_text_binding("@display_label_folded", display_label_folded.as_deref()),
                    nullable_text_binding(
                        "@billing_mode",
                        change.billing_mode.map(<&'static str>::from),
                    ),
                    switch_binding("@probe_enabled", change.probe_enabled),
                    switch_binding("@window_start_enabled", change.window_start_enabled),
                    switch_binding(
                        "@wake_for_window_start_enabled",
                        change.wake_for_window_start_enabled,
                    ),
                ]),
                expected_row_count: Some(1),
            }])
            .await
            .map_err(label_refusal_or_failure)?;
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
pub(super) fn refusal_or_failure(error: WriteError) -> ProviderAccountRegistryError {
    if error.refused_statement_index().is_some() {
        ProviderAccountRegistryError::NotFound
    } else {
        ProviderAccountRegistryError::Write(error)
    }
}

// The current mark's write: the one constraint it can break is the one-current index.
fn current_refusal_or_failure(error: WriteError) -> ProviderAccountRegistryError {
    if is_constraint_failure(&error) {
        ProviderAccountRegistryError::CurrentConflict
    } else {
        refusal_or_failure(error)
    }
}

// A write naming an account: the one constraint it can break is the unique typed name, since the
// rest hold by construction (a minted id and home, a default only where none is).
fn label_refusal_or_failure(error: WriteError) -> ProviderAccountRegistryError {
    if is_constraint_failure(&error) {
        ProviderAccountRegistryError::DisplayLabelTaken
    } else {
        refusal_or_failure(error)
    }
}

// Whether a statement of the write broke a constraint.
fn is_constraint_failure(error: &WriteError) -> bool {
    error.failed_statement().is_some_and(|(_, failure)| {
        failure.sqlite_error_code() == Some(ErrorCode::ConstraintViolation)
    })
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

// The ladder place the write's one statement returned.
fn returned_read_hold(results: &[StatementResult]) -> rusqlite::Result<ReadHold> {
    let row = results.first().and_then(|result| result.rows.first());
    match row.map(Vec::as_slice) {
        Some([Value::Integer(rung), held_until]) => Ok(ReadHold {
            rung: u32::try_from(*rung).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(0, Type::Integer, Box::new(error))
            })?,
            held_until: match held_until {
                Value::Text(text) => {
                    Some(WireInstant::try_from(text.clone()).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(1, Type::Text, Box::new(error))
                    })?)
                }
                Value::Null => None,
                other @ (Value::Integer(_) | Value::Real(_) | Value::Blob(_)) => {
                    return Err(rusqlite::Error::FromSqlConversionFailure(
                        1,
                        other.data_type(),
                        "the stored hold end is no text".into(),
                    ));
                }
            },
        }),
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            0,
            Type::Null,
            "the stored ladder place is not a rung and a hold end".into(),
        )),
    }
}

fn read_hold(row: &Row<'_>) -> rusqlite::Result<ReadHold> {
    Ok(ReadHold {
        rung: row.get(0)?,
        held_until: optional_text_column(row, 1, WireInstant::try_from)?,
    })
}

fn switch_binding(name: &'static str, switch: Option<bool>) -> (Cow<'static, str>, Value) {
    (
        Cow::Borrowed(name),
        switch.map_or(Value::Null, |switch| Value::Integer(i64::from(switch))),
    )
}

/// The generation stored in the column at `index`, read through its wire form, which refuses one
/// below 1 or past 2^53 − 1.
pub(crate) fn credential_generation(
    index: usize,
    stored: i64,
) -> rusqlite::Result<CredentialGeneration> {
    serde_json::from_value(JsonValue::from(stored)).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(error))
    })
}

/// A stored value its type refuses: a damaged row, never a caller's input.
#[derive(Debug, thiserror::Error)]
#[error("the stored {0} is not valid")]
pub(crate) struct StoredValueRefused(pub(crate) &'static str);

/// A registry over the test `database` with homes minted under `data_folder`, and the writer it
/// shares, for the account tests.
#[cfg(test)]
pub(crate) async fn open_test_registry(
    database: &sidekicks_store::database::writer::test_file::TestDatabase,
    data_folder: &std::path::Path,
) -> (ProviderAccountRegistry, Arc<DatabaseWriter>) {
    let writer = Arc::new(
        DatabaseWriter::open(
            database.opener(),
            sidekicks_store::database::writer::DatabaseWriterOptions::default(),
        )
        .await
        .expect("the writer opens its database"),
    );
    let reads = DatabaseReadPool::new(
        database.path(),
        PROVIDER_ACCOUNT_REGISTRY_STATEMENT_CAPACITY,
    );
    let registry =
        ProviderAccountRegistry::new(Arc::new(reads), Arc::clone(&writer), data_folder.to_owned());
    (registry, writer)
}

#[cfg(test)]
pub(crate) mod tests;
