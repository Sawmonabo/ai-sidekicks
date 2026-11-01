//! What a limits read that answered figures leaves: its quota windows recorded as the account's
//! whole set, and on the account's row the identity the provider reported and when it last
//! renewed the home's sign-in, each column written only where the provider reported it, so an
//! absent one keeps what an earlier read stored, and a read that reported none writes nothing
//! there. Neither moves the account's generation.

use std::borrow::Cow;
use std::sync::LazyLock;

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};

use crate::account::observer::{ObserverShared, ProviderAccountObserverError};
use crate::account::registry::{RegisteredAccount, refusal_or_failure};
use crate::driver::contract::account::ProviderAccountFigures;

static RECORD_REPORTED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET observed_account_email = COALESCE(@email, observed_account_email),
         observed_account_plan = COALESCE(@plan, observed_account_plan),
         observed_account_org_id = COALESCE(@org_id, observed_account_org_id),
         observed_account_org_name = COALESCE(@org_name, observed_account_org_name),
         last_refresh_observed_at = COALESCE(@refreshed_at, last_refresh_observed_at),
         updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0"
    )
});

impl ObserverShared {
    /// Records `figures`, what a read of `account` answered: its windows as the account's whole
    /// set, then what it reported of the account on its row. Fails when the windows cannot be
    /// recorded, and with [`crate::account::errors::ProviderAccountRegistryError::NotFound`] for
    /// an account no longer registered.
    pub(super) async fn store_figures(
        &self,
        account: &RegisteredAccount,
        figures: &ProviderAccountFigures,
    ) -> Result<(), ProviderAccountObserverError> {
        self.usage
            .record_whole_quota_windows(
                account.provider.clone(),
                account.account_id.clone(),
                figures.windows.clone(),
            )
            .await
            .map_err(ProviderAccountObserverError::WindowsNotRecorded)?;
        let identity = &figures.identity;
        let has_report = identity.email.is_some()
            || identity.plan.is_some()
            || identity.org_id.is_some()
            || identity.org_name.is_some()
            || figures.refreshed_at.is_some();
        if !has_report {
            return Ok(());
        }
        self.database_writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(RECORD_REPORTED_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@account_id", account.account_id.as_str()),
                    nullable_text_binding(
                        "@email",
                        identity.email.as_ref().map(FreeFormText::as_str),
                    ),
                    nullable_text_binding(
                        "@plan",
                        identity.plan.as_ref().map(FreeFormText::as_str),
                    ),
                    nullable_text_binding(
                        "@org_id",
                        identity.org_id.as_ref().map(FreeFormText::as_str),
                    ),
                    nullable_text_binding(
                        "@org_name",
                        identity.org_name.as_ref().map(FreeFormText::as_str),
                    ),
                    nullable_text_binding(
                        "@refreshed_at",
                        figures.refreshed_at.as_ref().map(WireInstant::as_str),
                    ),
                ]),
                expected_row_count: Some(1),
            }])
            .await
            .map_err(refusal_or_failure)?;
        Ok(())
    }
}
