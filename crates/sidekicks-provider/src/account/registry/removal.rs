//! An account's removal: refused while a session runs on the account or a workflow step waits on
//! it, naming the sessions or the workflow runs, then its intent marked, its sealed token
//! destroyed, a mark naming its provider written beside the homes, its row deleted with its quota
//! readings and usage turns, and what each driver keeps in memory for it dropped. Its home stays on
//! disk as it is. A crash between those writes leaves a marked row, which the start's sweep
//! finishes.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::OptionalExtension;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::methods::ProviderAccountInUseDetails;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::file::run_on_blocking_thread;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, text_binding,
};
use sidekicks_store::database::stored_column::text_column;

use super::{ProviderAccountRegistry, StoredValueRefused, refusal_or_failure};
use crate::account::credential_home::marks::{clear_minted_mark, mark_removed};
use crate::account::errors::ProviderAccountRegistryError;
use crate::account::home_lock::AccountHomeLock;
use crate::account::observer::AccountLiveTurns;
use crate::account::token_custody::{ProviderTokenCustody, TokenCustodyError};
use crate::driver::registry::ProviderRegistry;

// Every row, those whose removal has begun included.
const SELECT_ACCOUNT_REMOVAL_INTENTS_SQL: &str =
    "SELECT account_id, removal_intent FROM provider_accounts ORDER BY account_id";

const SELECT_MARKED_ACCOUNT_PROVIDER_SQL: &str =
    "SELECT provider FROM provider_accounts WHERE account_id = @account_id AND removal_intent = 1";

const DELETE_MARKED_ACCOUNT_SQL: &str =
    "DELETE FROM provider_accounts WHERE account_id = @account_id AND removal_intent = 1";

// The account's usage sightings, which name it by value, gone in the write that removes it.
const DELETE_ACCOUNT_SIGHTINGS_SQL: &str =
    "DELETE FROM usage_sightings WHERE account_id = @account_id";

// The steps parked waiting on the account.
static WAITING_STEPS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "FROM workflow_steps
   WHERE wait_account_id = @account_id AND status = '{waiting}' AND wait_cause = '{account}'",
        waiting = <&'static str>::from(WorkflowStepStatus::Waiting),
        account = <&'static str>::from(WorkflowWaitCause::Account),
    )
});

// A step parked on the account holds its removal: it expects no row.
static WAITING_STEP_GUARD_SQL: LazyLock<String> =
    LazyLock::new(|| format!("SELECT 1 {}", *WAITING_STEPS_SQL));

static SELECT_WAITING_WORKFLOW_RUNS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT DISTINCT workflow_run_id {} ORDER BY workflow_run_id",
        *WAITING_STEPS_SQL
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
    /// Workflow runs have a step parked waiting on the account, so its removal was not begun.
    #[error("a workflow step is waiting on the provider account")]
    StepsWaiting(BoundedVec<WorkflowRunId, 1, { usize::MAX }>),
    /// The registry refused or failed the removal's writes.
    #[error(transparent)]
    Registry(#[from] ProviderAccountRegistryError),
    /// The account's sealed token could not be destroyed; its marked row is left for the start's
    /// sweep.
    #[error(transparent)]
    TokenCustody(#[from] TokenCustodyError),
}

impl From<ProviderAccountRemovalError> for HandlerError {
    /// Running sessions and waiting steps refuse `provider.account.inUse` naming the sessions or
    /// the workflow runs; a registry or custody failure answers as its own.
    fn from(error: ProviderAccountRemovalError) -> Self {
        match error {
            ProviderAccountRemovalError::SessionsRunning(session_ids) => Self::Refused(
                DomainError::new(
                    "Sessions are running on the provider account",
                    RefusalCode::ProviderAccountInUse,
                )
                .with_detail(ProviderAccountInUseDetails::Sessions { session_ids }),
            ),
            ProviderAccountRemovalError::StepsWaiting(workflow_run_ids) => Self::Refused(
                DomainError::new(
                    "A workflow step is waiting on the provider account",
                    RefusalCode::ProviderAccountInUse,
                )
                .with_detail(ProviderAccountInUseDetails::WaitingSteps { workflow_run_ids }),
            ),
            ProviderAccountRemovalError::Registry(failure) => failure.into(),
            ProviderAccountRemovalError::TokenCustody(failure) => failure.into(),
        }
    }
}

impl ProviderAccountRegistry {
    /// Removes `account_id` holding its home in `home_lock` throughout, so no sign-in or renewal
    /// writes there meanwhile: refused while `live_turns` names a session on it, then its intent
    /// marked, its token in `token_custody` destroyed, a mark naming its provider written beside
    /// the homes, its row deleted with its quota readings and usage turns, and every driver in
    /// `drivers` told to forget it; its home is left as it is.
    /// Fails with [`ProviderAccountRemovalError::SessionsRunning`],
    /// [`ProviderAccountRemovalError::StepsWaiting`] or [`ProviderAccountRegistryError::NotFound`]
    /// with nothing written, and when a later write fails, the marked row kept for the sweep.
    pub async fn remove_account(
        &self,
        account_id: &ProviderAccountId,
        live_turns: &dyn AccountLiveTurns,
        token_custody: &ProviderTokenCustody,
        drivers: &ProviderRegistry,
        home_lock: &AccountHomeLock,
    ) -> Result<(), ProviderAccountRemovalError> {
        let _home = home_lock.hold(account_id.clone()).await;
        if let Some(sessions) = BoundedVec::new(live_turns.sessions_with_live_turns(account_id)) {
            return Err(ProviderAccountRemovalError::SessionsRunning(sessions));
        }
        // The mark's guard refuses a step parked since the read, which the next read then names.
        loop {
            if let Some(runs) = BoundedVec::new(self.read_waiting_workflow_runs(account_id).await?)
            {
                return Err(ProviderAccountRemovalError::StepsWaiting(runs));
            }
            match self.mark_removal_intent(account_id).await {
                Err(ProviderAccountRegistryError::StepWaiting) => {}
                marked => break marked?,
            }
        }
        token_custody.destroy_token(account_id).await?;
        self.delete_marked_account(account_id).await?;
        for (_, driver) in drivers.drivers() {
            driver.forget_account(account_id);
        }
        Ok(())
    }

    // The workflow runs with a step parked waiting on `account_id`.
    async fn read_waiting_workflow_runs(
        &self,
        account_id: &ProviderAccountId,
    ) -> Result<Vec<WorkflowRunId>, ProviderAccountRegistryError> {
        let account_id = account_id.clone();
        self.reads
            .read(ReadLength::Short, move |connection| {
                let mut statement = connection.prepare_cached(&SELECT_WAITING_WORKFLOW_RUNS_SQL)?;
                let runs = statement
                    .query_map(
                        rusqlite::named_params! { "@account_id": account_id.as_str() },
                        |row| text_column(row, 0, |text| WorkflowRunId::new(&text)),
                    )?
                    .collect::<Result<_, _>>()?;
                Ok(runs)
            })
            .await
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

    /// Writes a mark naming the provider of `account_id`, whose removal has begun, beside the
    /// homes and clears any minted mark left beside it, so no start's sweep takes the home, then
    /// deletes its row, its quota readings and usage turns going with it; its home stays on disk,
    /// and the mark keeps it known to the erase. A stop between the two leaves both, and the row
    /// wins. Fails with [`ProviderAccountRegistryError::NotFound`] when no marked row of that id
    /// is stored, and with [`ProviderAccountRegistryError::RemovedMark`] when the marks cannot be
    /// written, the row kept.
    pub async fn delete_marked_account(
        &self,
        account_id: &ProviderAccountId,
    ) -> Result<(), ProviderAccountRegistryError> {
        let marked = account_id.clone();
        let provider = self
            .reads
            .read(ReadLength::Short, move |connection| {
                connection
                    .query_row(
                        SELECT_MARKED_ACCOUNT_PROVIDER_SQL,
                        rusqlite::named_params! { "@account_id": marked.as_str() },
                        |row| {
                            text_column(row, 0, |text| {
                                ProviderId::new(text).ok_or(StoredValueRefused("provider id"))
                            })
                        },
                    )
                    .optional()?
                    .ok_or(ProviderAccountRegistryError::NotFound)
            })
            .await?;
        let (data_folder, marked) = (self.data_folder.clone(), account_id.clone());
        run_on_blocking_thread(move || {
            mark_removed(&data_folder, &marked, &provider)?;
            clear_minted_mark(&data_folder, &marked)
        })
        .await
        .map_err(ProviderAccountRegistryError::RemovedMark)?;
        let account_binding =
            || StatementBindings::Named(vec![text_binding("@account_id", account_id.as_str())]);
        self.write(vec![
            WriteStatement {
                sql: Cow::Borrowed(DELETE_MARKED_ACCOUNT_SQL),
                bindings: account_binding(),
                expected_row_count: Some(1),
            },
            WriteStatement {
                sql: Cow::Borrowed(DELETE_ACCOUNT_SIGHTINGS_SQL),
                bindings: account_binding(),
                expected_row_count: None,
            },
        ])
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
            .observed_auth_modes
            .write_and_forget(
                &self.writer,
                account_id,
                vec![
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
                ],
            )
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
