//! An account's removal in the registry: its intent marked, refused while a workflow step waits
//! on the account, every stored id read with that mark, and a marked row deleted with its quota
//! readings and usage turns.

use std::borrow::Cow;
use std::sync::LazyLock;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, text_binding,
};
use sidekicks_store::database::stored_column::text_column;

use super::{ProviderAccountRegistry, StoredValueRefused, refusal_or_failure};
use crate::account::errors::ProviderAccountRegistryError;

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

impl ProviderAccountRegistry {
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
