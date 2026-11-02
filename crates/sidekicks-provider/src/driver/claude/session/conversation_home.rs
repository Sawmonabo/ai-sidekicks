//! The home that holds a Claude Code conversation, kept in its binding's recovery data: Claude Code
//! writes a conversation into the configuration home its process runs on, and a switch moves only
//! the sign-in, so after one the conversation stays in a home that is not the account's own, and
//! every later start resumes it there.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};

use crate::runtime_binding::store::{RuntimeBindingStoreError, read_binding};
use crate::runtime_binding::writer::RuntimeBindingWriter;

// The key of a binding's recovery data that names the home holding its conversation.
const CONVERSATION_HOME_KEY: &str = "conversationHome";

/// The configuration home `runtime_metadata` names for its conversation, an absolute path; `None`
/// where it names none, so the conversation lives in the home of the account the binding names.
pub(crate) fn read_claude_conversation_home(
    runtime_metadata: &Map<String, Value>,
) -> Option<PathBuf> {
    runtime_metadata
        .get(CONVERSATION_HOME_KEY)
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
}

/// Recovery data naming `home` as the configuration home that holds the conversation.
pub(crate) fn claude_conversation_home_metadata(home: &Path) -> Map<String, Value> {
    Map::from_iter([(
        CONVERSATION_HOME_KEY.to_owned(),
        Value::from(home.to_string_lossy().into_owned()),
    )])
}

/// The home a switch keeps in each binding it moves off the account whose home holds the
/// conversation, with the pool the bindings' recovery data is read through.
#[derive(Clone)]
pub(crate) struct ClaudeConversationHomeKeep {
    /// Where the bindings' recovery data is read.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The configuration home that holds the conversation, an absolute path.
    pub(crate) home: PathBuf,
}

impl ClaudeConversationHomeKeep {
    /// Writes through `bindings` binding `binding_id`'s recovery data with the member naming the
    /// home, every other member it holds kept; a binding that names that home already is left as
    /// it is. Fails as the read or the write fails, and for a binding with no row.
    pub(crate) async fn keep_in(
        &self,
        bindings: &dyn RuntimeBindingWriter,
        binding_id: RuntimeBindingId,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let read_id = binding_id.clone();
        let binding = self
            .pool
            .read(ReadLength::Short, move |reader| {
                read_binding(reader, &read_id).map_err(RuntimeBindingStoreError::from)
            })
            .await?
            .ok_or_else(|| format!("binding {} has no row", binding_id.as_str()))?;
        if read_claude_conversation_home(&binding.runtime_metadata).as_deref() == Some(&*self.home)
        {
            return Ok(());
        }
        let mut runtime_metadata = binding.runtime_metadata;
        runtime_metadata.extend(claude_conversation_home_metadata(&self.home));
        bindings
            .keep_recovery_data(binding_id, runtime_metadata)
            .await
    }
}
