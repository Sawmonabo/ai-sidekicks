//! The attention entries as a rebuild writes them from the session's log: each event through the
//! live write's own statements at the event's own instant, so each resolving set ends with the
//! fold's retention, the rule under the cut the session keeps, and the entries a rebuild writes
//! are the entries the live writes kept. A Notify step's entry, which its step's own write keeps
//! and no event raises, stays through the clear, and what became of each entry's banner and
//! web-address message is never cleared.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::attention::AttentionTrigger;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement};
use sidekicks_store::events::projection::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};

use crate::attention::moment::{ATTENTION_EVENT_TYPES, entry_change_of};
use crate::attention::projection::{EventSource, change_statements};

static CLEAR_ENTRIES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "DELETE FROM attention_entries WHERE session_id = ? AND trigger <> '{}'",
        <&'static str>::from(AttentionTrigger::WorkflowNotify)
    )
});

/// The `attention_entries` rows as a rebuild replaces them. Its fold keeps no state, so the
/// projection is its own fold.
#[derive(Clone, Copy, Debug)]
pub struct AttentionEntriesProjection;

impl SessionProjection for AttentionEntriesProjection {
    fn name(&self) -> &'static str {
        "attention entries"
    }

    fn event_types(&self) -> &[SessionEventType] {
        &ATTENTION_EVENT_TYPES
    }

    fn clear_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        vec![WriteStatement {
            sql: Cow::Borrowed(CLEAR_ENTRIES_SQL.as_str()),
            bindings: StatementBindings::Positional(vec![Value::Text(
                session_id.text().as_str().to_owned(),
            )]),
            expected_row_count: None,
        }]
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(*self)
    }
}

impl SessionProjectionFold for AttentionEntriesProjection {
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        let source = EventSource {
            event_id: envelope.id.as_str(),
            session_id: envelope.session_id,
            occurred_at: envelope.occurred_at.as_str(),
        };
        statements.extend(change_statements(&entry_change_of(event), &source));
        Ok(())
    }
}
