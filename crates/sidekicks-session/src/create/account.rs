//! The account a new session's lead runs on: its provider's current account, read when the session
//! is made and held so by a guard inside the session's first write. A row marked for removal is
//! never current, since a crash part way through a removal can leave the mark on the current row.

use std::borrow::Cow;

use rusqlite::{Connection, OptionalExtension, named_params};
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{closed_word, text_column};

use crate::create::SessionCreateError;

const SELECT_CURRENT_ACCOUNT_SQL: &str = "SELECT account_id FROM provider_accounts
  WHERE provider = @provider AND is_default = 1 AND removal_intent = 0";

const SELECT_ANY_ACCOUNT_SQL: &str = "SELECT EXISTS (SELECT 1 FROM provider_accounts
  WHERE provider = @provider AND removal_intent = 0)";

// Holds only while the account the lead was resolved to is still its provider's current one.
const CURRENT_ACCOUNT_GUARD_SQL: &str = "SELECT 1 FROM provider_accounts
  WHERE account_id = @accountId AND provider = @provider AND is_default = 1
    AND removal_intent = 0";

/// The account a lead runs on, with the guard that keeps it current inside the session's first
/// write.
pub(crate) struct ResolvedAccount {
    /// The account.
    pub(crate) provider_account_id: ProviderAccountId,
    /// Refuses the write once the account is no longer its provider's current one.
    pub(crate) guard: WriteStatement,
}

/// `provider`'s current account. Refuses `provider.account.notRegistered` when the provider has no
/// account but those marked for removal, and `provider.account.current.notSet` when it has some
/// and none is current; fails when the read fails or the stored id is not an account id.
pub(crate) fn read_current_account(
    reader: &Connection,
    provider: &ProviderId,
) -> Result<ResolvedAccount, SessionCreateError> {
    let current = reader
        .prepare_cached(SELECT_CURRENT_ACCOUNT_SQL)?
        .query_row(named_params! { "@provider": provider.as_str() }, |row| {
            text_column(row, 0, closed_word::<ProviderAccountId>)
        })
        .optional()?;
    if let Some(provider_account_id) = current {
        let guard = WriteStatement {
            sql: Cow::Borrowed(CURRENT_ACCOUNT_GUARD_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@accountId", provider_account_id.as_str()),
                text_binding("@provider", provider.as_str()),
            ]),
            expected_row_count: Some(1),
        };
        return Ok(ResolvedAccount {
            provider_account_id,
            guard,
        });
    }
    let has_accounts = reader
        .prepare_cached(SELECT_ANY_ACCOUNT_SQL)?
        .query_row(named_params! { "@provider": provider.as_str() }, |row| {
            row.get::<_, bool>(0)
        })?;
    let refusal = if has_accounts {
        DomainError::new(
            "The provider has accounts but none is current.",
            RefusalCode::ProviderAccountCurrentNotSet,
        )
    } else {
        DomainError::new(
            "The provider has no account registered.",
            RefusalCode::ProviderAccountNotRegistered,
        )
    };
    Err(refusal
        .with_detail(json!({ "provider": provider.as_str() }))
        .into())
}
