//! What a limits read that answered figures leaves: its quota windows recorded as the account's
//! whole set, and on the account's row when the read was taken, the identity the provider reported
//! and when it last renewed the home's sign-in, each reported column written only where the
//! provider reported it, so an absent one keeps what an earlier read stored. The read's time is
//! state on the row rather than an event, so a read that changed no window still says when its
//! windows were read without growing the log; each of the account's windows then goes out as read
//! then. Neither moves the account's generation.

use std::borrow::Cow;
use std::sync::LazyLock;

use sidekicks_contracts::provider::account::record::ProviderAccountNotification;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};

use crate::account::observer::window_store::read_usage_windows;
use crate::account::observer::{ObserverShared, ProviderAccountObserverError};
use crate::account::registry::{RegisteredAccount, refusal_or_failure};
use crate::driver::contract::account::ProviderAccountFigures;

static RECORD_READ_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE provider_accounts
     SET limits_read_at = @read_at,
         observed_account_email = COALESCE(@email, observed_account_email),
         observed_account_plan = COALESCE(@plan, observed_account_plan),
         observed_account_org_id = COALESCE(@org_id, observed_account_org_id),
         observed_account_org_name = COALESCE(@org_name, observed_account_org_name),
         last_refresh_observed_at = COALESCE(@refreshed_at, last_refresh_observed_at),
         updated_at = {DATABASE_NOW_SQL}
   WHERE account_id = @account_id AND removal_intent = 0"
    )
});

impl ObserverShared {
    /// Records `figures`, what a read of `account` taken at `read_at` answered: its windows as the
    /// account's whole set, then the read's time and what it reported of the account on its row,
    /// then publishes each of the account's windows as it now reads. Fails when the windows cannot
    /// be recorded or read back, and with
    /// [`crate::account::errors::ProviderAccountRegistryError::NotFound`] for an account no longer
    /// registered.
    pub(super) async fn store_figures(
        &self,
        account: &RegisteredAccount,
        figures: &ProviderAccountFigures,
        read_at: &WireInstant,
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
        self.database_writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(RECORD_READ_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@account_id", account.account_id.as_str()),
                    text_binding("@read_at", read_at.as_str()),
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
        for window in read_usage_windows(&self.database_reads, Some(account.provider.clone()))
            .await?
            .into_iter()
            .filter(|window| window.account_id == account.account_id)
        {
            self.publisher
                .publish(ProviderAccountNotification::UsageWindowUpdated {
                    account_id: window.account_id.clone(),
                    window,
                });
        }
        Ok(())
    }
}
