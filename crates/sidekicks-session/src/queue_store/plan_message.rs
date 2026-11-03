//! The marker of a plan message on a `queue_items` row, held in one place: the read of a plan's
//! message and every write guarded on whether one is queued match it through the same predicate.

use std::sync::LazyLock;

use rusqlite::{OptionalExtension, named_params};
use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::run::queue::{PlanMessageKind, QueueItemState};
use sidekicks_contracts::session::id::SessionId;

use super::{COLUMNS, QUEUE_ORDER, QueueItemReader, QueueItemRecord, record_of};

/// SQL true for the `queue_items` row aliased `item` that is the lead's plan message of the plan
/// `plan_id_sql` names and of the kind `kind_sql` names, both SQL expressions; the caller matches
/// the session and the state.
pub fn plan_message_item_sql(item: &str, plan_id_sql: &str, kind_sql: &str) -> String {
    format!(
        "{item}.child_handle IS NULL
    AND json_extract({item}.payload, '$.kind') = 'planMessage'
    AND json_extract({item}.payload, '$.planMessage.planId') = {plan_id_sql}
    AND json_extract({item}.payload, '$.planMessage.kind') = {kind_sql}"
    )
}

// The lead's plan message of one plan and kind that a retry has not superseded; a retry
// supersedes the item it sends again, so at most one such item stands.
static SELECT_PLAN_MESSAGE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {COLUMNS} FROM queue_items AS item
  WHERE item.session_id = @session_id AND {} AND item.state <> '{}'
  {QUEUE_ORDER} LIMIT 1",
        plan_message_item_sql("item", "@plan_id", "@kind"),
        <&'static str>::from(QueueItemState::Superseded)
    )
});

impl QueueItemReader<'_> {
    /// The session's plan message of `kind` for `plan_id` that no retry superseded, whatever key
    /// it was sent under, or `None`.
    pub fn get_plan_message(
        &self,
        session_id: &SessionId,
        plan_id: &PlanId,
        kind: PlanMessageKind,
    ) -> rusqlite::Result<Option<QueueItemRecord>> {
        self.reader
            .prepare_cached(&SELECT_PLAN_MESSAGE_SQL)?
            .query_row(
                named_params! {
                    "@session_id": session_id.text().as_str(),
                    "@plan_id": plan_id.text().as_str(),
                    "@kind": <&'static str>::from(kind),
                },
                record_of,
            )
            .optional()
    }
}
