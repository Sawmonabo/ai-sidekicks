//! The conversations a session left on its provider, over the `left_conversations` table: the one
//! a fork moved it off, or the one a daemon restart's resume forked away from. Each row is written
//! in the same write as the binding's new resume handle, so no conversation the session left is
//! ever both unrecorded and unbound. Each row keeps the left leg's own recovery data.

use std::borrow::Cow;

use rusqlite::Connection;
use rusqlite::types::Type;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::json_object_column;

use crate::output_validation::check_resume_handle;
use crate::runtime_binding::store::{RuntimeBinding, RuntimeBindingStoreError};

/// A conversation a session moved off, on the account whose home holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeftConversation {
    /// The session that left it.
    pub session_id: SessionId,
    /// The account whose home holds it.
    pub provider_account_id: ProviderAccountId,
    /// The provider's own id for the conversation.
    pub conversation_id: String,
    /// The provider's recovery data of the leg that left it, as that leg kept it, so the
    /// conversation is reached through its own home.
    pub runtime_metadata: Map<String, Value>,
}

impl LeftConversation {
    /// The conversation `predecessor` ran on, with its account and recovery data, when a relaunch
    /// runs on another; `None` when it had none or the relaunch runs on the same one.
    #[must_use]
    pub fn of_relaunch(
        session_id: SessionId,
        predecessor: &RuntimeBinding,
        resume_handle: &str,
    ) -> Option<Self> {
        predecessor
            .resume_handle
            .as_ref()
            .filter(|handle| handle.as_str() != resume_handle)
            .map(|handle| Self {
                session_id,
                provider_account_id: predecessor.spawn_config.provider_account_id.clone(),
                conversation_id: handle.clone(),
                runtime_metadata: predecessor.runtime_metadata.clone(),
            })
    }
}

/// A recorded left conversation, with the provider whose binding recorded it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeftConversationRecord {
    /// The conversation left.
    pub conversation: LeftConversation,
    /// The provider whose binding recorded it.
    pub provider_name: ProviderId,
    /// When the session left it.
    pub(crate) left_at: String,
}

// Lands only beside the binding update stamped `@left_at` in the same write, and takes the
// provider from that binding. The recovery data is bound, never read from that binding, whose
// row by then holds the new leg's data, or another binding's after a fork onto it.
const INSERT_LEFT_CONVERSATION_SQL: &str = "
  INSERT OR IGNORE INTO left_conversations
    (session_id, provider_name, provider_account_id, conversation_id, left_at, runtime_metadata)
  SELECT @session_id, provider_name, @provider_account_id, @conversation_id, @left_at,
         @runtime_metadata
    FROM runtime_bindings
   WHERE id = @binding_id AND updated_at = @left_at";

// Takes the provider from the binding the session forked off, with no stamp to match, since it
// lands in the fork's own cut, before the fork's binding is written.
const INSERT_FORK_LEFT_CONVERSATION_SQL: &str = "
  INSERT OR IGNORE INTO left_conversations
    (session_id, provider_name, provider_account_id, conversation_id, left_at, runtime_metadata)
  SELECT @session_id, provider_name, @provider_account_id, @conversation_id, @left_at,
         @runtime_metadata
    FROM runtime_bindings
   WHERE id = @binding_id";

// Every row it returns is the asked session's, so the session id is not read back.
const SELECT_LEFT_CONVERSATIONS_SQL: &str = "
  SELECT provider_name, provider_account_id, conversation_id, left_at, runtime_metadata
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
    compose_insert(
        INSERT_LEFT_CONVERSATION_SQL,
        binding_id,
        left_at,
        conversation,
    )
}

/// The statement recording the fork `fork_handle`, the conversation a cut moved `source`'s session
/// onto, as one the session left on `source`'s account and recovery data, for the cut's own write,
/// so the purge reaches the fork whatever becomes of its own binding's row. Fails with
/// [`RuntimeBindingStoreError::InvalidOutput`] for a handle the store refuses.
pub fn compose_fork_left_conversation_insert(
    session_id: SessionId,
    source: &RuntimeBinding,
    fork_handle: &str,
) -> Result<WriteStatement, RuntimeBindingStoreError> {
    check_resume_handle(fork_handle)?;
    let conversation = LeftConversation {
        session_id,
        provider_account_id: source.spawn_config.provider_account_id.clone(),
        conversation_id: fork_handle.to_owned(),
        runtime_metadata: source.runtime_metadata.clone(),
    };
    Ok(compose_insert(
        INSERT_FORK_LEFT_CONVERSATION_SQL,
        &source.id,
        WireInstant::now().as_str(),
        &conversation,
    ))
}

// The statement `sql` binds for `conversation`, left from binding `binding_id` at `left_at`.
fn compose_insert(
    sql: &'static str,
    binding_id: &RuntimeBindingId,
    left_at: &str,
    conversation: &LeftConversation,
) -> WriteStatement {
    let runtime_metadata = Value::Object(conversation.runtime_metadata.clone()).to_string();
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(vec![
            text_binding("@binding_id", binding_id.as_str()),
            text_binding("@left_at", left_at),
            text_binding("@session_id", conversation.session_id.text().as_str()),
            text_binding(
                "@provider_account_id",
                conversation.provider_account_id.as_str(),
            ),
            text_binding("@conversation_id", &conversation.conversation_id),
            text_binding("@runtime_metadata", &runtime_metadata),
        ]),
        expected_row_count: None,
    }
}

/// Every conversation `session_id` left on its providers, oldest first, for the whole-session
/// purge, which deletes each one from its provider. A row keeps its provider id as written, a
/// provider this build has no driver for included; fails on a database error, or on a stored id
/// that is no valid provider id, which fails the whole read rather than skip a row.
pub fn read_left_conversations(
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
                runtime_metadata: json_object_column(row, 4)?,
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
pub(crate) struct StoredProviderIdInvalidError;

/// A stored account id that is not a valid one: empty or past its length bound.
#[derive(Debug, thiserror::Error)]
#[error("the stored provider account id is not a valid account id")]
struct StoredAccountIdInvalidError;

// The stored account id; a value that is no valid id fails the read.
fn read_provider_account_id(stored: String) -> rusqlite::Result<ProviderAccountId> {
    ProviderAccountId::new(stored).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            Type::Text,
            Box::new(StoredAccountIdInvalidError),
        )
    })
}
