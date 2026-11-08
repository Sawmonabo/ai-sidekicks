//! The executor's asks about a process's network access, `network/policyRequest`, each sent to the
//! connection that started the process and answered by that connection alone; an ask no connection
//! can answer is denied by the relay at once, as the executor denies one it cannot send.

use std::collections::HashMap;

use serde_json::value::RawValue;

use super::RelayConnectionId;

/// The reason the relay's deny gives, the one the executor gives where no controller can answer.
const DENY_REASON: &str = "not_allowed";

/// The asks a connection has not answered, keyed by the executor's id as raw JSON text.
#[derive(Default)]
pub(super) struct PolicyRequests {
    asks: HashMap<String, RelayConnectionId>,
}

impl PolicyRequests {
    /// Keeps the ask `id` until `connection`, which it was sent to, answers it or goes.
    pub(super) fn ask(&mut self, id: &RawValue, connection: RelayConnectionId) {
        self.asks.insert(id.get().to_owned(), connection);
    }

    /// Takes the ask `id` as `connection`'s to answer; false for one not asked of it.
    pub(super) fn answer(&mut self, id: &RawValue, connection: RelayConnectionId) -> bool {
        if self.asks.get(id.get()) != Some(&connection) {
            return false;
        }
        self.asks.remove(id.get());
        true
    }

    /// Takes every ask `connection` has not answered, by its id as raw JSON text.
    pub(super) fn take_connection(&mut self, connection: RelayConnectionId) -> Vec<String> {
        self.asks
            .extract_if(|_id, asked| *asked == connection)
            .map(|(id, _asked)| id)
            .collect()
    }

    /// Forgets every ask, once the executor's connection ended.
    pub(super) fn clear(&mut self) {
        self.asks.clear();
    }
}

/// The relay's deny of the ask whose id is `id`, raw JSON text.
pub(super) fn deny_answer(id: &str) -> String {
    format!(r#"{{"id":{id},"result":{{"decision":{{"type":"deny","reason":"{DENY_REASON}"}}}}}}"#)
}
