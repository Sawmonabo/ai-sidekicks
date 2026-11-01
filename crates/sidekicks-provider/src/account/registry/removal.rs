//! An account's removal: refused while a session runs on the account or a workflow step waits on
//! it, then its intent marked, its sealed token destroyed, its row deleted with its quota readings
//! and usage turns, and what each driver keeps in memory for it dropped. Its home stays on disk
//! as it is. A crash between those writes leaves a marked row, which the start's sweep finishes.

use std::borrow::Cow;
use std::sync::LazyLock;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::methods::ProviderAccountInUseDetails;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, text_binding,
};
use sidekicks_store::database::stored_column::text_column;

use super::{ProviderAccountRegistry, StoredValueRefused, refusal_or_failure};
use crate::account::errors::ProviderAccountRegistryError;
use crate::account::observer::AccountLiveTurns;
use crate::account::token_custody::{ProviderTokenCustody, TokenCustodyError};
use crate::driver::registry::ProviderRegistry;

// Every row, those whose removal has begun included.
const SELECT_ACCOUNT_REMOVAL_INTENTS_SQL: &str =
    "SELECT account_id, removal_intent FROM provider_accounts ORDER BY account_id";

const DELETE_MARKED_ACCOUNT_SQL: &str =
    "DELETE FROM provider_accounts WHERE account_id = @account_id AND removal_intent = 1";

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

/// Every stored account id split by its removal intent: the registered accounts, and those whose
/// removal has begun.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountIdsByRemovalIntent {
    /// Accounts not marked for removal.
    pub registered: Vec<ProviderAccountId>,
    /// Accounts marked for removal whose rows are still stored.
    pub marked: Vec<ProviderAccountId>,
}

/// Why an account's removal failed; a refusal leaves the account registered as it was.
#[derive(Debug, thiserror::Error)]
pub enum ProviderAccountRemovalError {
    /// Sessions run on the account, so its removal was not begun.
    #[error("sessions are running on the provider account")]
    SessionsRunning(BoundedVec<SessionId, 1, { usize::MAX }>),
    /// The registry refused or failed the removal's writes.
    #[error(transparent)]
    Registry(#[from] ProviderAccountRegistryError),
    /// The account's sealed token could not be destroyed; its marked row is left for the start's
    /// sweep.
    #[error(transparent)]
    TokenCustody(#[from] TokenCustodyError),
}

impl From<ProviderAccountRemovalError> for HandlerError {
    /// Running sessions refuse `provider.account.inUse` naming them; a registry or custody failure
    /// answers as its own.
    fn from(error: ProviderAccountRemovalError) -> Self {
        match error {
            ProviderAccountRemovalError::SessionsRunning(session_ids) => Self::Refused(
                DomainError::new(
                    "Sessions are running on the provider account",
                    RefusalCode::ProviderAccountInUse,
                )
                .with_detail(ProviderAccountInUseDetails { session_ids }),
            ),
            ProviderAccountRemovalError::Registry(failure) => failure.into(),
            ProviderAccountRemovalError::TokenCustody(failure) => failure.into(),
        }
    }
}

impl ProviderAccountRegistry {
    /// Removes `account_id`: refused while `live_turns` names a session on it, then its intent
    /// marked, its token in `token_custody` destroyed, its row deleted with its quota readings and
    /// usage turns, and every driver in `drivers` told to forget it; its home is left as it is.
    /// Fails with [`ProviderAccountRemovalError::SessionsRunning`] and with
    /// [`ProviderAccountRegistryError::StepWaiting`] or [`ProviderAccountRegistryError::NotFound`]
    /// with nothing written, and when a later write fails, the marked row kept for the sweep.
    pub async fn remove_account(
        &self,
        account_id: &ProviderAccountId,
        live_turns: &dyn AccountLiveTurns,
        token_custody: &ProviderTokenCustody,
        drivers: &ProviderRegistry,
    ) -> Result<(), ProviderAccountRemovalError> {
        if let Some(sessions) = BoundedVec::new(live_turns.sessions_with_live_turns(account_id)) {
            return Err(ProviderAccountRemovalError::SessionsRunning(sessions));
        }
        self.mark_removal_intent(account_id).await?;
        token_custody.destroy_token(account_id).await?;
        self.delete_marked_account(account_id).await?;
        for (_, driver) in drivers.drivers() {
            driver.forget_account(account_id);
        }
        Ok(())
    }

    /// Every stored account id, split by whether its removal has begun. Fails when the accounts
    /// cannot be read.
    pub async fn read_account_ids_by_removal_intent(
        &self,
    ) -> Result<AccountIdsByRemovalIntent, ProviderAccountRegistryError> {
        self.reads
            .read(ReadLength::Short, |connection| {
                let mut ids = AccountIdsByRemovalIntent::default();
                let mut statement =
                    connection.prepare_cached(SELECT_ACCOUNT_REMOVAL_INTENTS_SQL)?;
                let mut rows = statement.query([])?;
                while let Some(row) = rows.next()? {
                    let account_id = text_column(row, 0, |text| {
                        ProviderAccountId::new(text).ok_or(StoredValueRefused("account id"))
                    })?;
                    if row.get::<_, bool>(1)? {
                        ids.marked.push(account_id);
                    } else {
                        ids.registered.push(account_id);
                    }
                }
                Ok(ids)
            })
            .await
    }

    /// Deletes the row of `account_id`, whose removal has begun, its quota readings and usage
    /// turns going with it; its home stays on disk. Fails with
    /// [`ProviderAccountRegistryError::NotFound`] when no marked row of that id is stored.
    pub async fn delete_marked_account(
        &self,
        account_id: &ProviderAccountId,
    ) -> Result<(), ProviderAccountRegistryError> {
        self.write(vec![WriteStatement {
            sql: Cow::Borrowed(DELETE_MARKED_ACCOUNT_SQL),
            bindings: StatementBindings::Named(vec![text_binding(
                "@account_id",
                account_id.as_str(),
            )]),
            expected_row_count: Some(1),
        }])
        .await
        .map(drop)
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
}

#[cfg(test)]
mod tests;
