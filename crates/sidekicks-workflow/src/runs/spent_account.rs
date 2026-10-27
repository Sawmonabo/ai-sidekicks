//! A spent provider account as a waiting step and the runs needing someone name it: its columns
//! read from `provider_accounts` beside the step that waits on it, then labeled the way every
//! screen labels an account by the caller that holds the provider's words. Healing a damaged
//! session can bring back a wait whose later events are lost, while the account registry is not
//! rebuilt from the log, so a wait may name an account removed since; a read names the account
//! only while its row is stored.

use rusqlite::Row;
use sidekicks_contracts::provider::account::label::account_label;
use sidekicks_contracts::provider::account::record::{
    AccountLabelFields, PROVIDER_ACCOUNT_LABEL_MAX_LEN, ProviderAuthMode,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::provider::settings::ProviderPlanWord;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column};

use crate::runs::record::column;

const PROVIDER_ALIAS: &str = "account_provider";
const DISPLAY_LABEL_ALIAS: &str = "account_display_label";
const OBSERVED_AUTH_MODE_ALIAS: &str = "account_observed_auth_mode";
const OBSERVED_EMAIL_ALIAS: &str = "account_observed_email";
const OBSERVED_PLAN_ALIAS: &str = "account_observed_plan";
const OBSERVED_ORG_NAME_ALIAS: &str = "account_observed_org_name";

/// The select-list that reads [`SpentAccountColumns`] from the `provider_accounts` row joined
/// under `account_alias`, each column under its own alias.
pub(crate) fn spent_account_columns(account_alias: &str) -> String {
    format!(
        "{account_alias}.provider AS {PROVIDER_ALIAS}, \
         {account_alias}.display_label AS {DISPLAY_LABEL_ALIAS}, \
         {account_alias}.observed_auth_mode AS {OBSERVED_AUTH_MODE_ALIAS}, \
         {account_alias}.observed_account_email AS {OBSERVED_EMAIL_ALIAS}, \
         {account_alias}.observed_account_plan AS {OBSERVED_PLAN_ALIAS}, \
         {account_alias}.observed_account_org_name AS {OBSERVED_ORG_NAME_ALIAS}"
    )
}

/// The stored columns a spent account is named from, as [`spent_account_columns`] selects them.
#[expect(
    dead_code,
    reason = "the workflow handlers name a spent account once they hold the provider read"
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SpentAccountColumns {
    /// The account's provider, read as written and never checked against the drivers, so an
    /// account of a provider this build has no driver for still reads.
    pub(crate) provider: ProviderId,
    display_label: Option<String>,
    observed_auth_mode: Option<ProviderAuthMode>,
    observed_account_email: Option<String>,
    observed_account_plan: Option<String>,
    observed_account_org_name: Option<String>,
}

impl SpentAccountColumns {
    /// The columns from `row` by their aliases, `None` where no account row matched (the provider
    /// column is NULL); fails on a missing alias or a stored word or id that does not read.
    pub(crate) fn read(row: &Row<'_>) -> rusqlite::Result<Option<Self>> {
        let Some(provider) =
            optional_text_column(row, column(row, PROVIDER_ALIAS)?, closed_word::<ProviderId>)?
        else {
            return Ok(None);
        };
        Ok(Some(Self {
            provider,
            display_label: row.get(column(row, DISPLAY_LABEL_ALIAS)?)?,
            observed_auth_mode: optional_text_column(
                row,
                column(row, OBSERVED_AUTH_MODE_ALIAS)?,
                closed_word,
            )?,
            observed_account_email: row.get(column(row, OBSERVED_EMAIL_ALIAS)?)?,
            observed_account_plan: row.get(column(row, OBSERVED_PLAN_ALIAS)?)?,
            observed_account_org_name: row.get(column(row, OBSERVED_ORG_NAME_ALIAS)?)?,
        }))
    }

    /// The account's provider and its label, drawn with the provider's name and plan words from
    /// the provider read; fails when the stored account has no label it can be named by.
    #[expect(
        dead_code,
        reason = "the workflow handlers name a spent account once they hold the provider read"
    )]
    pub(crate) fn name(
        &self,
        provider_name: &str,
        plan_words: &[ProviderPlanWord],
    ) -> Result<SpentAccountName, UnlabeledSpentAccount> {
        let fields = AccountLabelFields {
            display_label: self.display_label.as_deref(),
            observed_auth_mode: self.observed_auth_mode,
            observed_account_email: self.observed_account_email.as_deref(),
            observed_account_plan: self.observed_account_plan.as_deref(),
            observed_account_org_name: self.observed_account_org_name.as_deref(),
        };
        let label = account_label(&fields, provider_name, plan_words).ok_or_else(|| {
            UnlabeledSpentAccount {
                provider: self.provider.clone(),
                refused: None,
            }
        })?;
        let label = FreeFormText::new(label).map_err(|refused| UnlabeledSpentAccount {
            provider: self.provider.clone(),
            refused: Some(refused),
        })?;
        Ok(SpentAccountName {
            provider: self.provider.clone(),
            label,
        })
    }
}

/// A spent account's provider and the label every screen names it by.
#[expect(
    dead_code,
    reason = "the workflow handlers name a spent account once they hold the provider read"
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SpentAccountName {
    /// Its provider.
    pub(crate) provider: ProviderId,
    /// Its label.
    pub(crate) label: FreeFormText<PROVIDER_ACCOUNT_LABEL_MAX_LEN>,
}

/// A stored spent account with no label it can be named by: none of the members a label is drawn
/// from, or a label the label's text rules refuse, kept as the cause; it carries no value of the
/// account. A provider account that has run a step always has a label.
#[expect(
    dead_code,
    reason = "the workflow handlers name a spent account once they hold the provider read"
)]
#[derive(Debug, thiserror::Error)]
#[error("A step waits on a {} account that has no label it can be named by", .provider.as_str())]
pub(crate) struct UnlabeledSpentAccount {
    provider: ProviderId,
    #[source]
    refused: Option<TextError>,
}
