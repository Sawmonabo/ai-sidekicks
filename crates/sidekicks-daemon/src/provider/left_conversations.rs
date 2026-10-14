//! The conversations a session left on its provider, over the `left_conversations` table: the one
//! a fork moved it off, or the one a daemon restart's resume forked away from. Each row is written
//! in the same write as the binding's new resume handle, so no conversation the session left is
//! ever both unrecorded and unbound.

use std::borrow::Cow;

use rusqlite::Connection;
use rusqlite::types::{Type, Value};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::name::ProviderName;
use sidekicks_contracts::session::id::SessionId;

use crate::database::statement::{StatementBindings, WriteStatement, text_binding};

/// A conversation a session moved off, on the account whose home holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::struct_field_names,
    reason = "each member is an id, named for what it identifies"
)]
pub(crate) struct LeftConversation {
    /// The session that left it.
    pub(crate) session_id: SessionId,
    /// The account whose home holds it; `None` on the node's default home.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The provider's own id for the conversation.
    pub(crate) conversation_id: String,
}

/// A recorded left conversation, with the provider whose binding recorded it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LeftConversationRecord {
    /// The conversation left.
    pub(crate) conversation: LeftConversation,
    /// The provider whose binding recorded it.
    pub(crate) driver_name: ProviderName,
    /// When the session left it.
    pub(crate) left_at: String,
}

// Lands only beside the binding update stamped `@left_at` in the same write, and takes the
// provider from that binding.
const INSERT_LEFT_CONVERSATION_SQL: &str = "
  INSERT OR IGNORE INTO left_conversations
    (session_id, driver_name, provider_account_id, conversation_id, left_at)
  SELECT @session_id, driver_name, @provider_account_id, @conversation_id, @left_at
    FROM runtime_bindings
   WHERE id = @binding_id AND updated_at = @left_at";

// Every row it returns is the asked session's, so the session id is not read back.
const SELECT_LEFT_CONVERSATIONS_SQL: &str = "
  SELECT driver_name, provider_account_id, conversation_id, left_at
    FROM left_conversations
   WHERE session_id = ?
   ORDER BY left_at, conversation_id";

/// The statement recording `conversation`, written after the update that stamped binding
/// `binding_id` with `left_at`; it adds nothing when that update changed no row, so it expects no
/// row count.
pub(crate) fn compose_left_conversation_insert(
    binding_id: &str,
    left_at: &str,
    conversation: &LeftConversation,
) -> WriteStatement {
    let provider_account_id = conversation
        .provider_account_id
        .as_ref()
        .map_or(Value::Null, |account_id| {
            Value::Text(account_id.as_str().to_owned())
        });
    WriteStatement {
        sql: Cow::Borrowed(INSERT_LEFT_CONVERSATION_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@binding_id", binding_id),
            text_binding("@left_at", left_at),
            text_binding("@session_id", conversation.session_id.as_str()),
            (Cow::Borrowed("@provider_account_id"), provider_account_id),
            text_binding("@conversation_id", &conversation.conversation_id),
        ]),
        expected_row_count: None,
    }
}

/// Every conversation `session_id` left on its providers, oldest first, for the whole-session
/// purge, which deletes each one from its provider. Fails on a database error, or when a row's
/// provider name is not one this build drives, which fails the whole read rather than skip a row.
pub(crate) fn read_left_conversations(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Vec<LeftConversationRecord>> {
    let mut statement = reader.prepare_cached(SELECT_LEFT_CONVERSATIONS_SQL)?;
    let rows = statement.query_map([session_id.as_str()], |row| {
        let stored_driver_name: String = row.get(0)?;
        let driver_name = stored_driver_name
            .parse::<ProviderName>()
            .map_err(|parse_failure| {
                rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(parse_failure))
            })?;
        Ok(LeftConversationRecord {
            conversation: LeftConversation {
                session_id: session_id.clone(),
                provider_account_id: read_provider_account_id(row.get(1)?)?,
                conversation_id: row.get(2)?,
            },
            driver_name,
            left_at: row.get(3)?,
        })
    })?;
    rows.collect()
}

/// A stored account id that is not a valid one: empty or past its length bound.
#[derive(Debug, thiserror::Error)]
#[error("the stored provider account id is not a valid account id")]
struct StoredAccountIdInvalidError;

// The stored account id, `None` on the node's default home; a value that is no valid id fails the
// read rather than pass as the default home.
fn read_provider_account_id(stored: Option<String>) -> rusqlite::Result<Option<ProviderAccountId>> {
    stored
        .map(|text| {
            ProviderAccountId::new(text).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    Type::Text,
                    Box::new(StoredAccountIdInvalidError),
                )
            })
        })
        .transpose()
}
