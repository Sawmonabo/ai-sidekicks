//! The conversations a session left on its provider, over the `left_conversations` table: the one
//! a fork moved it off, or the one a daemon restart's resume forked away from. Each row is written
//! in the same write as the binding's new resume handle, so no conversation the session left is
//! ever both unrecorded and unbound.

use std::borrow::Cow;

use rusqlite::Connection;
use rusqlite::types::Type;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;

use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};

/// A conversation a session moved off, on the account whose home holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::struct_field_names,
    reason = "each member is an id, named for what it identifies"
)]
pub(crate) struct LeftConversation {
    /// The session that left it.
    pub(crate) session_id: SessionId,
    /// The account whose home holds it; `None` on the machine's default home.
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
    pub(crate) provider_name: ProviderId,
    /// When the session left it.
    pub(crate) left_at: String,
}

// Lands only beside the binding update stamped `@left_at` in the same write, and takes the
// provider from that binding.
const INSERT_LEFT_CONVERSATION_SQL: &str = "
  INSERT OR IGNORE INTO left_conversations
    (session_id, provider_name, provider_account_id, conversation_id, left_at)
  SELECT @session_id, provider_name, @provider_account_id, @conversation_id, @left_at
    FROM runtime_bindings
   WHERE id = @binding_id AND updated_at = @left_at";

// Every row it returns is the asked session's, so the session id is not read back.
const SELECT_LEFT_CONVERSATIONS_SQL: &str = "
  SELECT provider_name, provider_account_id, conversation_id, left_at
    FROM left_conversations
   WHERE session_id = ?
   ORDER BY left_at, conversation_id";

/// The statement recording `conversation`, written after the update that stamped binding
/// `binding_id` with `left_at`; it adds nothing when that update changed no row, so it expects no
/// row count.
pub(crate) fn compose_left_conversation_insert(
    binding_id: &RuntimeBindingId,
    left_at: &str,
    conversation: &LeftConversation,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(INSERT_LEFT_CONVERSATION_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@binding_id", binding_id.as_str()),
            text_binding("@left_at", left_at),
            text_binding("@session_id", conversation.session_id.text().as_str()),
            nullable_text_binding(
                "@provider_account_id",
                conversation
                    .provider_account_id
                    .as_ref()
                    .map(ProviderAccountId::as_str),
            ),
            text_binding("@conversation_id", &conversation.conversation_id),
        ]),
        expected_row_count: None,
    }
}

/// Every conversation `session_id` left on its providers, oldest first, for the whole-session
/// purge, which deletes each one from its provider. A row keeps its provider id as written, a
/// provider this build has no driver for included; fails on a database error, or on a stored id
/// that is no valid provider id, which fails the whole read rather than skip a row.
pub(crate) fn read_left_conversations(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Vec<LeftConversationRecord>> {
    let mut statement = reader.prepare_cached(SELECT_LEFT_CONVERSATIONS_SQL)?;
    let rows = statement.query_map([session_id.text().as_str()], |row| {
        let stored_provider_name: String = row.get(0)?;
        let provider_name = ProviderId::new(stored_provider_name).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                Type::Text,
                Box::new(StoredProviderIdInvalidError),
            )
        })?;
        Ok(LeftConversationRecord {
            conversation: LeftConversation {
                session_id: *session_id,
                provider_account_id: read_provider_account_id(row.get(1)?)?,
                conversation_id: row.get(2)?,
            },
            provider_name,
            left_at: row.get(3)?,
        })
    })?;
    rows.collect()
}

/// A stored provider id that is not a valid one.
#[derive(Debug, thiserror::Error)]
#[error("the stored provider id is not a valid provider id")]
struct StoredProviderIdInvalidError;

/// A stored account id that is not a valid one: empty or past its length bound.
#[derive(Debug, thiserror::Error)]
#[error("the stored provider account id is not a valid account id")]
struct StoredAccountIdInvalidError;

// The stored account id, `None` on the machine's default home; a value that is no valid id fails
// the read rather than pass as the default home.
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
