//! A registered account as its row reads, and as `provider.account.*` sends it: the stored columns
//! the registry owns, the identity its provider last reported, and its one memory import. Only an
//! undecided account goes without the time its health was observed.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, Row};
use sidekicks_contracts::provider::account::record::{
    MemoryImportOutcomeKind, ObservedHealthState, ObservedProviderAccount, ProviderAccount,
    ProviderAccountHealthState, ProviderAccountId, ProviderAccountMemoryImportOutcome,
    UndecidedHealthState, UndecidedProviderAccount,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};

use super::{HealthObservation, RegisteredAccount, StoredValueRefused};
use crate::account::credential_home::CredentialHome;
use crate::account::errors::ProviderAccountRegistryError;
use crate::driver::contract::account::ObservedAccountIdentity;

// An account whose removal has begun is no longer read as registered.
const ACCOUNT_COLUMNS_SQL: &str = "
  SELECT account_id, provider, credential_home_path, credential_generation, billing_mode,
         is_default, health_state, health_observed_at, probe_enabled, window_start_enabled,
         wake_for_window_start_enabled, observed_auth_mode, display_label,
         observed_account_email, observed_account_plan, observed_account_org_id,
         observed_account_org_name, logged_in_at, last_refresh_observed_at,
         memory_import_outcome, memory_import_count, memory_imported_at
    FROM provider_accounts
   WHERE removal_intent = 0";

static SELECT_ACCOUNTS_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{ACCOUNT_COLUMNS_SQL} ORDER BY created_at, account_id"));

static SELECT_PROVIDER_ACCOUNTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!("{ACCOUNT_COLUMNS_SQL} AND provider = ? ORDER BY created_at, account_id")
});

static SELECT_ACCOUNT_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{ACCOUNT_COLUMNS_SQL} AND account_id = ?"));

impl RegisteredAccount {
    /// The account as `provider.account.*` sends it: an observed health state with its time, or
    /// `indeterminate` with the time where one was observed. No rule of the provider's sign-in
    /// lifetime is held here, so the re-login estimate is unknown, and no computer place is
    /// named, so `homePlaces` is absent.
    pub fn to_provider_account(&self) -> ProviderAccount {
        macro_rules! account_arm {
            ($arm:ident { $($health:tt)* }) => {
                $arm {
                    account_id: self.account_id.clone(),
                    provider: self.provider.clone(),
                    display_label: self.display_label.clone(),
                    credential_generation: self.credential_generation,
                    billing_mode: self.billing_mode,
                    observed_account_email: self.observed_identity.email.clone(),
                    observed_account_org_id: self.observed_identity.org_id.clone(),
                    observed_account_org_name: self.observed_identity.org_name.clone(),
                    observed_account_plan: self.observed_identity.plan.clone(),
                    is_default: self.is_default,
                    home_places: None,
                    $($health)*
                    observed_auth_mode: self.observed_auth_mode,
                    signed_in_at: self.signed_in_at.clone(),
                    last_refresh_observed_at: self.last_refresh_observed_at.clone(),
                    sign_in_needed_at_estimate: None,
                    probe_enabled: self.probe_enabled,
                    window_start_enabled: self.window_start_enabled,
                    wake_for_window_start_enabled: self.wake_for_window_start_enabled,
                    memory_import: self.memory_import.clone(),
                }
            };
        }
        let observed = self.health.as_ref().and_then(|health| {
            let state = match health.state {
                ProviderAccountHealthState::Authenticated => ObservedHealthState::Authenticated,
                ProviderAccountHealthState::ReauthRequired => ObservedHealthState::ReauthRequired,
                ProviderAccountHealthState::HomeMissing => ObservedHealthState::HomeMissing,
                ProviderAccountHealthState::Indeterminate => return None,
            };
            Some((state, health.observed_at.clone()))
        });
        match observed {
            Some((health_state, health_observed_at)) => {
                ProviderAccount::Observed(account_arm!(ObservedProviderAccount {
                    health_state,
                    health_observed_at,
                }))
            }
            None => ProviderAccount::Undecided(account_arm!(UndecidedProviderAccount {
                health_state: UndecidedHealthState::Indeterminate,
                health_observed_at: self
                    .health
                    .as_ref()
                    .map(|health| health.observed_at.clone()),
            })),
        }
    }
}

/// Every registered account, or `provider`'s alone, oldest first.
pub(super) fn query_accounts(
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

/// The registered account `account_id`, `None` for one not registered or being removed.
pub(crate) fn query_registered_account(
    connection: &Connection,
    account_id: &ProviderAccountId,
) -> rusqlite::Result<Option<RegisteredAccount>> {
    connection
        .prepare_cached(&SELECT_ACCOUNT_SQL)?
        .query_row([account_id.as_str()], read_account)
        .optional()
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
        credential_generation: super::credential_generation(3, row.get(3)?)?,
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
        display_label: optional_text_column(row, 12, FreeFormText::new)?,
        observed_identity: ObservedAccountIdentity {
            email: optional_text_column(row, 13, FreeFormText::new)?,
            plan: optional_text_column(row, 14, FreeFormText::new)?,
            org_id: optional_text_column(row, 15, FreeFormText::new)?,
            org_name: optional_text_column(row, 16, FreeFormText::new)?,
        },
        signed_in_at: optional_text_column(row, 17, WireInstant::try_from)?,
        last_refresh_observed_at: optional_text_column(row, 18, WireInstant::try_from)?,
        memory_import: read_memory_import(row, 19)?,
    })
}

// The import's outcome at `index`, its count and its time in the two columns after it; the table
// holds a count and a time exactly on an import that copied something.
fn read_memory_import(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<ProviderAccountMemoryImportOutcome>> {
    let imported = <&'static str>::from(MemoryImportOutcomeKind::Imported);
    let outcome: Option<String> = row.get(index)?;
    Ok(match outcome {
        None => None,
        Some(outcome) if outcome == imported => {
            Some(ProviderAccountMemoryImportOutcome::Imported {
                count: stored_count(row, index + 1)?,
                imported_at: text_column(row, index + 2, WireInstant::try_from)?,
            })
        }
        Some(_) => Some(ProviderAccountMemoryImportOutcome::NothingToImport {}),
    })
}

// The positive count stored in the column at `index`.
fn stored_count(row: &Row<'_>, index: usize) -> rusqlite::Result<SafeInt<1>> {
    let stored: i64 = row.get(index)?;
    u64::try_from(stored)
        .ok()
        .and_then(SafeInt::new)
        .ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Integer,
                Box::new(StoredValueRefused("memory import count")),
            )
        })
}
