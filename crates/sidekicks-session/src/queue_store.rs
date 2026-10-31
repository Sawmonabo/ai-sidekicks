//! The `queue_items` rows: the statements that write them, each guarded so a change decided from a
//! stale read is refused whole, and the reads of a queue in its order. A row is never deleted while
//! its session is kept; a message's words ride its payload beside its `user.message.sent` row.

pub mod send_now;
pub mod summary;

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Row, named_params};
use serde::{Deserialize, Serialize};
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::artifacts::attachment_reference::AttachmentReferenceList;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::repo::mount::WorkspaceId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::queue::{
    MessageContent, QueueItemId, QueueItemNotDeliveredKind, QueueItemNotDeliveredReason,
    QueueItemState,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::{ClientUuid, UuidText};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::run_control::PickedSkill;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};

use crate::directory::lookups::ENDED_SESSION_STATES_SQL;
use crate::run::transitions::RUN_TERMINAL_STATES_SQL;

/// What a queued item carries, as its payload stores it under its `kind`: a person's message, or
/// a review of the session's changes, which opens a run of its own and is never handed into a
/// running or continued turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum QueueItemBody {
    /// A message.
    Message(QueueMessageBody),
    /// The provider's own review.
    Review {
        /// What the review covers.
        target: SessionReviewTarget,
    },
}

impl QueueItemBody {
    /// The message the item carries, `None` for a review.
    pub fn as_message(&self) -> Option<&QueueMessageBody> {
        match self {
            Self::Message(message) => Some(message),
            Self::Review { .. } => None,
        }
    }
}

/// What a queued message carries: the words and what rides with them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueMessageBody {
    /// The words.
    pub content: MessageContent,
    /// The message's files in staging order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<AttachmentReferenceList>,
    /// The skills the person picked for it, in the order picked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<PickedSkill>>,
    /// The question it answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers_question_id: Option<QuestionId>,
    /// The output-speed level its turn alone runs at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_speed_for_turn: Option<ProviderToken>,
    /// The repository the run it starts binds to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
}

impl QueueMessageBody {
    /// The ids of the message's files in staging order, none when it carries none.
    pub fn attachment_ids(&self) -> Vec<ArtifactId> {
        self.attachments
            .as_ref()
            .map(|attachments| attachments.0.clone())
            .unwrap_or_default()
    }
}

/// Where a queued message stands, as its row holds it: only a message never delivered carries,
/// and always carries, the reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordedQueueItemState {
    /// Waiting for the agent's next step.
    Queued,
    /// Taken by the run.
    Admitted,
    /// Replaced by an edit or a retry.
    Superseded,
    /// Removed.
    Canceled,
    /// Taken but never delivered.
    NotDelivered {
        /// Why it was never delivered.
        reason: QueueItemNotDeliveredReason,
    },
}

/// One queued message as its row holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueItemRecord {
    /// The item.
    pub id: QueueItemId,
    /// The session whose queue holds it.
    pub session_id: SessionId,
    /// Where it stands.
    pub state: RecordedQueueItemState,
    /// What it carries.
    pub body: QueueItemBody,
    /// The run the message goes to; absent on an orchestration-authored item.
    pub target_run_id: Option<RunId>,
    /// The child whose queue holds it; absent on the lead's queue.
    pub child_handle: Option<ChildHandle>,
    /// Its place in its queue's order, lowest first.
    pub position: SafeInt<0>,
    /// The send's own key; absent on the system's own items.
    pub client_idempotency_key: Option<ClientUuid>,
    /// When it was queued.
    pub created_at: WireInstant,
    /// When it last changed.
    pub updated_at: WireInstant,
    /// The id the answer of the person's `Send now` that marked it to go ahead of what its
    /// provider holds carries; absent on an item no `Send now` marked.
    pub sent_now_id: Option<InterventionId>,
}

/// An item to insert. It takes the place of `replaces_queue_item_id` when it is an edit, else
/// the place after every item its queue has held.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewQueueItem {
    /// The new item.
    pub id: QueueItemId,
    /// The session whose lead queue takes it.
    pub session_id: SessionId,
    /// What it carries.
    pub body: QueueItemBody,
    /// The run it goes to.
    pub target_run_id: RunId,
    /// The device that sent it; absent on a review the daemon queues.
    pub device_id: Option<DeviceId>,
    /// The send's own key; absent on a review the daemon queues.
    pub client_idempotency_key: Option<ClientUuid>,
    /// The waiting item an edit replaces.
    pub replaces_queue_item_id: Option<QueueItemId>,
    /// When it is queued.
    pub now: WireInstant,
}

/// Where a waiting message goes once it leaves `queued` other than by an edit: taken, by the run
/// named, removed, or never delivered, with the reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueueItemOutcome {
    /// Taken by the run.
    Admitted {
        /// The run that took it.
        run_id: RunId,
    },
    /// Removed.
    Canceled,
    /// Never delivered.
    NotDelivered {
        /// Why.
        reason: QueueItemNotDeliveredReason,
    },
}

/// The state a waiting message leaves `queued` for: an outcome, or replaced by an edit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueueItemExit {
    /// An outcome other than an edit.
    Outcome(QueueItemOutcome),
    /// Replaced by an edit.
    Superseded,
}

/// The session's current lead run and its state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CurrentLeadRun {
    /// The run.
    pub run_id: RunId,
    /// Its state.
    pub state: RunState,
}

/// The columns every read of an item selects, in the order `record_of` reads them.
pub const COLUMNS: &str = "id, session_id, state, not_delivered_reason, payload, \
    target_run_id, child_handle, position, client_idempotency_key, created_at, updated_at, \
    send_now_id, not_delivered_words";

/// The columns `COLUMNS` names; a read's own column follows them.
pub const COLUMN_COUNT: usize = 13;

/// An item's order within its queue: by place, and an edit's superseded item after its
/// replacement.
pub const QUEUE_ORDER: &str = "ORDER BY position, created_at DESC, id";

// Changes no row when the send's key was already spent in the session, so the write that carries
// it is refused and nothing saved is replaced; an item with no key never conflicts. Only a
// person's send and a review reach here, so the queue is the lead's.
static INSERT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO queue_items
    (id, session_id, state, payload, target_run_id, device_id, child_handle, position,
     client_idempotency_key, created_at, updated_at)
  VALUES (@id, @session_id, '{}', @payload, @target_run_id, @device_id, NULL,
    COALESCE(
      (SELECT position FROM queue_items WHERE id = @replaces_id),
      (SELECT MAX(position) + 1 FROM queue_items
        WHERE session_id = @session_id AND child_handle IS NULL),
      0),
    @client_idempotency_key, @now, @now)
  ON CONFLICT (session_id, client_idempotency_key) DO NOTHING",
        <&'static str>::from(QueueItemState::Queued)
    )
});

static LEAVE_QUEUED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE queue_items
    SET state = @to, not_delivered_reason = @reason, not_delivered_words = @words,
      updated_at = @now
  WHERE id = @id AND state = '{}'",
        <&'static str>::from(QueueItemState::Queued)
    )
});

// A message read not delivered that the agent took after all.
static ADMIT_UNDELIVERED_SQL: LazyLock<String> =
    LazyLock::new(|| leave_not_delivered_sql(QueueItemState::Admitted));

// A message read not delivered that a retry sends again.
static SUPERSEDE_UNDELIVERED_SQL: LazyLock<String> =
    LazyLock::new(|| leave_not_delivered_sql(QueueItemState::Superseded));

static RETARGET_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE queue_items SET target_run_id = @run_id, updated_at = @now
  WHERE id = @id AND state = '{}'",
        <&'static str>::from(QueueItemState::Queued)
    )
});

static PLACE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE queue_items SET position = @position, updated_at = @now
  WHERE id = @id AND state = '{}'",
        <&'static str>::from(QueueItemState::Queued)
    )
});

// Moves an item read not delivered to `to`, clearing its reason.
fn leave_not_delivered_sql(to: QueueItemState) -> String {
    format!(
        "UPDATE queue_items
    SET state = '{}', not_delivered_reason = NULL, not_delivered_words = NULL, updated_at = @now
  WHERE id = @id AND state = '{}'",
        <&'static str>::from(to),
        <&'static str>::from(QueueItemState::NotDelivered)
    )
}

static RUN_LIVE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM runs WHERE run_id = @run_id AND state NOT IN ({})",
        *RUN_TERMINAL_STATES_SQL
    )
});

// Matches the session while it takes messages: neither closed nor being purged.
static SESSION_TAKES_MESSAGES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM sessions WHERE id = @session_id AND state NOT IN ({})",
        *ENDED_SESSION_STATES_SQL
    )
});

// The condition that the run `alias` names is a lead run: no run started it.
fn compose_lead_run_predicate(alias: &str) -> String {
    format!("{alias}.parent_run_id IS NULL")
}

// Matches the session's lead runs that have not ended; a send that starts one expects none.
static LIVE_LEAD_RUNS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM runs
  WHERE session_id = @session_id AND {}
    AND state NOT IN ({})",
        compose_lead_run_predicate("runs"),
        *RUN_TERMINAL_STATES_SQL
    )
});

// The sessions with a lead message waiting for a run that ended or has not started.
static SESSIONS_WITH_UNSTARTED_WAITING_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT DISTINCT queue_items.session_id
  FROM queue_items JOIN runs ON runs.run_id = queue_items.target_run_id
  WHERE queue_items.state = '{}' AND queue_items.child_handle IS NULL
    AND runs.state IN ('{}', {})",
        <&'static str>::from(QueueItemState::Queued),
        <&'static str>::from(RunState::Queued),
        *RUN_TERMINAL_STATES_SQL
    )
});

// The condition that the lead run `alias` names counts as its session's current one: any but one
// whose start failed before it ever ran, such as the run of a turn a provider started itself that
// failed to open, which never stood in for the run before it.
fn compose_current_lead_run_predicate(alias: &str) -> String {
    format!(
        "({alias}.state <> '{}'
    OR EXISTS (SELECT 1 FROM session_events
      WHERE session_events.session_id = {alias}.session_id AND session_events.type = '{}'
        AND session_events.run_id = {alias}.run_id))",
        <&'static str>::from(RunState::Failed),
        SessionEventType::AgentRunRunning.as_str()
    )
}

// The session's current lead run, whatever its state: its newest but those whose start failed. Run
// ids are minted in time order.
static CURRENT_LEAD_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run_id, state FROM runs
  WHERE session_id = ? AND {} AND {}
  ORDER BY run_id DESC LIMIT 1",
        compose_lead_run_predicate("runs"),
        compose_current_lead_run_predicate("runs")
    )
});

// No lead run of the session of the `runs` row is newer and counts as current.
static NO_NEWER_CURRENT_LEAD_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "NOT EXISTS (SELECT 1 FROM runs AS newer
      WHERE newer.session_id = runs.session_id AND {}
        AND newer.run_id > runs.run_id AND {})",
        compose_lead_run_predicate("newer"),
        compose_current_lead_run_predicate("newer")
    )
});

// The interrupted lead run a send continues, while it is its session's current lead run.
static CURRENT_INTERRUPTED_LEAD_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM runs
  WHERE run_id = @run_id AND state = '{}' AND {}
    AND {}",
        <&'static str>::from(RunState::Interrupted),
        compose_lead_run_predicate("runs"),
        *NO_NEWER_CURRENT_LEAD_RUN_SQL
    )
});

// A lead message waiting for the session's current lead run while it rests interrupted, which the
// run's continue takes as the session's next turn.
static CONTINUE_WAITING_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM queue_items JOIN runs ON runs.run_id = queue_items.target_run_id
  WHERE queue_items.session_id = @session_id AND queue_items.child_handle IS NULL
    AND queue_items.state = '{}' AND runs.state = '{}'
    AND {}
    AND {}
  LIMIT 1",
        <&'static str>::from(QueueItemState::Queued),
        <&'static str>::from(RunState::Interrupted),
        compose_lead_run_predicate("runs"),
        *NO_NEWER_CURRENT_LEAD_RUN_SQL
    )
});

// Points the lead messages waiting for the session's interrupted lead runs at the run that takes
// over from them; their places, and so their order, stay as they are.
static TAKE_OVER_INTERRUPTED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE queue_items
    SET target_run_id = @run_id, updated_at = @now
  WHERE session_id = @session_id AND child_handle IS NULL AND state = '{}'
    AND target_run_id IN (SELECT run_id FROM runs
      WHERE session_id = @session_id AND {}
        AND state = '{}')",
        <&'static str>::from(QueueItemState::Queued),
        compose_lead_run_predicate("runs"),
        <&'static str>::from(RunState::Interrupted)
    )
});

// The session's newest lead run that has not ended.
static LIVE_LEAD_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run_id FROM runs
  WHERE session_id = ? AND {}
    AND state NOT IN ({})
  ORDER BY run_id DESC LIMIT 1",
        compose_lead_run_predicate("runs"),
        *RUN_TERMINAL_STATES_SQL
    )
});

static SELECT_BY_ID_SQL: LazyLock<String> =
    LazyLock::new(|| format!("SELECT {COLUMNS} FROM queue_items WHERE id = ?"));

static SELECT_BY_KEY_SQL: LazyLock<String> = LazyLock::new(|| {
    format!("SELECT {COLUMNS} FROM queue_items WHERE session_id = ? AND client_idempotency_key = ?")
});

static SELECT_QUEUE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {COLUMNS} FROM queue_items
  WHERE session_id = @session_id AND child_handle IS @child_handle
    AND (state = @state OR (@state IS NULL AND state IN ({})))
  {QUEUE_ORDER}",
        sql_list_of(
            [QueueItemState::Queued, QueueItemState::NotDelivered].map(<&'static str>::from)
        )
    )
});

/// The queued messages that target one run, bound to its id at the one `?`, in queue order; a
/// write that must find none uses it as its guard.
pub(crate) static SELECT_WAITING_FOR_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {COLUMNS} FROM queue_items
  WHERE target_run_id = ? AND state = '{}'
  {QUEUE_ORDER}",
        <&'static str>::from(QueueItemState::Queued)
    )
});

/// The statement that inserts `item` as `queued`; refused when its key was already spent.
pub fn insert_queue_item_statement(item: &NewQueueItem) -> WriteStatement {
    let payload =
        serde_json::to_string(&item.body).expect("a body of typed members serializes to JSON");
    WriteStatement {
        sql: Cow::Borrowed(INSERT_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", item.id.text().as_str()),
            text_binding("@session_id", item.session_id.text().as_str()),
            text_binding("@payload", &payload),
            text_binding("@target_run_id", item.target_run_id.text().as_str()),
            nullable_text_binding("@device_id", item.device_id.as_ref().map(DeviceId::as_str)),
            nullable_text_binding(
                "@replaces_id",
                item.replaces_queue_item_id
                    .map(|id| id.text())
                    .as_ref()
                    .map(UuidText::as_str),
            ),
            nullable_text_binding(
                "@client_idempotency_key",
                item.client_idempotency_key.as_ref().map(ClientUuid::as_str),
            ),
            text_binding("@now", item.now.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that moves a waiting item out of `queued`; refused once it has left.
pub fn leave_queued_statement(
    id: &QueueItemId,
    exit: &QueueItemExit,
    now: &WireInstant,
) -> WriteStatement {
    let (to, reason) = match exit {
        QueueItemExit::Outcome(QueueItemOutcome::Admitted { .. }) => {
            (QueueItemState::Admitted, None)
        }
        QueueItemExit::Outcome(QueueItemOutcome::Canceled) => (QueueItemState::Canceled, None),
        QueueItemExit::Outcome(QueueItemOutcome::NotDelivered { reason }) => {
            (QueueItemState::NotDelivered, Some(reason))
        }
        QueueItemExit::Superseded => (QueueItemState::Superseded, None),
    };
    WriteStatement {
        sql: Cow::Borrowed(LEAVE_QUEUED_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", id.text().as_str()),
            text_binding("@to", <&'static str>::from(to)),
            nullable_text_binding(
                "@reason",
                reason.map(|reason| <&'static str>::from(QueueItemNotDeliveredKind::from(reason))),
            ),
            nullable_text_binding("@words", reason.and_then(words_of)),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that admits an item read not delivered; refused unless it reads not delivered.
pub fn admit_undelivered_statement(id: &QueueItemId, now: &WireInstant) -> WriteStatement {
    item_change_statement(&ADMIT_UNDELIVERED_SQL, id, now)
}

/// The statement that marks an item read not delivered superseded by its retry; refused unless it
/// reads not delivered.
pub fn supersede_undelivered_statement(id: &QueueItemId, now: &WireInstant) -> WriteStatement {
    item_change_statement(&SUPERSEDE_UNDELIVERED_SQL, id, now)
}

/// The statement that points a waiting item at the run it now goes to; refused once it has left.
pub fn retarget_statement(id: &QueueItemId, run_id: &RunId, now: &WireInstant) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RETARGET_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", id.text().as_str()),
            text_binding("@run_id", run_id.text().as_str()),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statements that give the waiting items `ordered` the places they hold between them, in that
/// order; each is refused once its item has left the queue.
pub fn placement_statements(ordered: &[QueueItemRecord], now: &WireInstant) -> Vec<WriteStatement> {
    let mut positions: Vec<SafeInt<0>> = ordered.iter().map(|item| item.position).collect();
    positions.sort_unstable();
    ordered
        .iter()
        .zip(positions)
        .map(|(item, position)| WriteStatement {
            sql: Cow::Borrowed(PLACE_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@id", item.id.text().as_str()),
                (
                    Cow::Borrowed("@position"),
                    SqlValue::Integer(i64::from(position)),
                ),
                text_binding("@now", now.as_str()),
            ]),
            expected_row_count: Some(1),
        })
        .collect()
}

/// Holds only while `run_id` has not ended, so a message never goes to a run that ended first.
pub fn run_live_statement(run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RUN_LIVE_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding("@run_id", run_id.text().as_str())]),
        expected_row_count: Some(1),
    }
}

/// Holds only while the session takes messages: it is neither closed nor being purged.
pub fn session_takes_messages_statement(session_id: &SessionId) -> WriteStatement {
    session_statement(&SESSION_TAKES_MESSAGES_SQL, session_id, 1)
}

/// Holds only while the session has no lead run that has not ended.
pub fn no_live_lead_run_statement(session_id: &SessionId) -> WriteStatement {
    session_statement(&LIVE_LEAD_RUNS_SQL, session_id, 0)
}

/// Holds only while `run_id` reads interrupted and is its session's current lead run.
pub fn current_interrupted_lead_run_statement(run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(CURRENT_INTERRUPTED_LEAD_RUN_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding("@run_id", run_id.text().as_str())]),
        expected_row_count: Some(1),
    }
}

/// Holds only while no lead message waits for the session's current lead run as it rests
/// interrupted, so no continue of that run holds the session's next turn.
pub(crate) fn no_continue_waiting_statement(session_id: &SessionId) -> WriteStatement {
    session_statement(&CONTINUE_WAITING_SQL, session_id, 0)
}

/// The statement that moves the lead messages waiting for the session's interrupted lead runs to
/// `run_id`, a newer lead run that takes over from them, in their order. Written with that run's
/// `running`, so a run that never runs leaves them for the interrupted run's continue.
pub(crate) fn take_over_interrupted_statement(
    session_id: &SessionId,
    run_id: &RunId,
    now: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(TAKE_OVER_INTERRUPTED_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@session_id", session_id.text().as_str()),
            text_binding("@run_id", run_id.text().as_str()),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count: None,
    }
}

/// Reads queue rows on the daemon's read-only connection. A stored value that does not read as its
/// type fails the read with `rusqlite::Error::FromSqlConversionFailure`, keeping why.
pub struct QueueItemReader<'reader> {
    reader: &'reader Connection,
}

impl<'reader> QueueItemReader<'reader> {
    /// A reader over `reader`, the daemon's read-only connection.
    pub fn new(reader: &'reader Connection) -> Self {
        Self { reader }
    }

    /// The item `id`, or `None` for one the daemon has no row for.
    pub fn get(&self, id: &QueueItemId) -> rusqlite::Result<Option<QueueItemRecord>> {
        self.reader
            .prepare_cached(&SELECT_BY_ID_SQL)?
            .query_row([id.text().as_str()], record_of)
            .optional()
    }

    /// The item a send under `client_idempotency_key` saved in the session, or `None`.
    pub fn get_by_idempotency_key(
        &self,
        session_id: &SessionId,
        client_idempotency_key: &ClientUuid,
    ) -> rusqlite::Result<Option<QueueItemRecord>> {
        self.reader
            .prepare_cached(&SELECT_BY_KEY_SQL)?
            .query_row(
                [session_id.text().as_str(), client_idempotency_key.as_str()],
                record_of,
            )
            .optional()
    }

    /// A queue, the lead's or a child's, in its order: the items in `state` when it is given, else
    /// every item waiting or not delivered.
    pub fn list(
        &self,
        session_id: &SessionId,
        child_handle: Option<&ChildHandle>,
        state: Option<QueueItemState>,
    ) -> rusqlite::Result<Vec<QueueItemRecord>> {
        self.reader
            .prepare_cached(&SELECT_QUEUE_SQL)?
            .query_map(
                named_params! {
                    "@session_id": session_id.text().as_str(),
                    "@child_handle": child_handle.map(ChildHandle::as_str),
                    "@state": state.map(<&'static str>::from),
                },
                record_of,
            )?
            .collect()
    }

    /// The messages still waiting for `run_id`, in their queue's order.
    pub fn list_waiting_for_run(&self, run_id: &RunId) -> rusqlite::Result<Vec<QueueItemRecord>> {
        self.reader
            .prepare_cached(&SELECT_WAITING_FOR_RUN_SQL)?
            .query_map([run_id.text().as_str()], record_of)?
            .collect()
    }

    /// The session's newest lead run that has not ended, or `None` while none is live.
    pub fn read_live_lead_run(&self, session_id: &SessionId) -> rusqlite::Result<Option<RunId>> {
        self.reader
            .prepare_cached(&LIVE_LEAD_RUN_SQL)?
            .query_row([session_id.text().as_str()], |row| {
                text_column(row, 0, |text| RunId::new(&text))
            })
            .optional()
    }

    /// The session's current lead run and its state: its newest, but one whose start failed before
    /// it ran leaves the run before it current; `None` before its first run.
    pub fn read_current_lead_run(
        &self,
        session_id: &SessionId,
    ) -> rusqlite::Result<Option<CurrentLeadRun>> {
        self.reader
            .prepare_cached(&CURRENT_LEAD_RUN_SQL)?
            .query_row([session_id.text().as_str()], |row| {
                Ok(CurrentLeadRun {
                    run_id: text_column(row, 0, |text| RunId::new(&text))?,
                    state: text_column(row, 1, closed_word)?,
                })
            })
            .optional()
    }

    /// The sessions with a lead message waiting for a run that ended or has not started.
    pub fn list_sessions_with_unstarted_waiting(&self) -> rusqlite::Result<Vec<SessionId>> {
        self.reader
            .prepare_cached(&SESSIONS_WITH_UNSTARTED_WAITING_SQL)?
            .query_map([], |row| text_column(row, 0, |text| SessionId::new(&text)))?
            .collect()
    }
}

/// A stored state paired with a reason only a not-delivered item carries, or a reason paired with
/// words only a hook's refusal carries, or the reverse, which the table's checks refuse to write.
#[derive(Debug, thiserror::Error)]
#[error("the stored queue item state and its not-delivered reason do not pair")]
struct UnpairedNotDeliveredReason;

/// Stored text that is not a child's handle.
#[derive(Debug, thiserror::Error)]
#[error("the stored child handle is not a handle")]
struct NotAChildHandle;

/// The item a row of `COLUMNS` holds; fails with `rusqlite::Error::FromSqlConversionFailure` when a
/// value does not read as its type. The payload is written only by `insert_queue_item_statement`,
/// from a typed body.
pub fn record_of(row: &Row<'_>) -> rusqlite::Result<QueueItemRecord> {
    let state: QueueItemState = text_column(row, 2, closed_word)?;
    let kind: Option<QueueItemNotDeliveredKind> = optional_text_column(row, 3, closed_word)?;
    let words = optional_text_column(row, 12, FreeFormText::new)?;
    let reason = match (kind, words) {
        (None, None) => None,
        (Some(QueueItemNotDeliveredKind::TimedOut), None) => {
            Some(QueueItemNotDeliveredReason::TimedOut {})
        }
        (Some(QueueItemNotDeliveredKind::Failed), None) => {
            Some(QueueItemNotDeliveredReason::Failed {})
        }
        (Some(QueueItemNotDeliveredKind::RefusedByHook), Some(words)) => {
            Some(QueueItemNotDeliveredReason::RefusedByHook { words })
        }
        (
            Some(QueueItemNotDeliveredKind::TimedOut | QueueItemNotDeliveredKind::Failed) | None,
            Some(_),
        )
        | (Some(QueueItemNotDeliveredKind::RefusedByHook), None) => {
            return Err(unpaired_reason());
        }
    };
    let state = match (state, reason) {
        (QueueItemState::Queued, None) => RecordedQueueItemState::Queued,
        (QueueItemState::Admitted, None) => RecordedQueueItemState::Admitted,
        (QueueItemState::Superseded, None) => RecordedQueueItemState::Superseded,
        (QueueItemState::Canceled, None) => RecordedQueueItemState::Canceled,
        (QueueItemState::NotDelivered, Some(reason)) => {
            RecordedQueueItemState::NotDelivered { reason }
        }
        (
            QueueItemState::Queued
            | QueueItemState::Admitted
            | QueueItemState::Superseded
            | QueueItemState::Canceled,
            Some(_),
        )
        | (QueueItemState::NotDelivered, None) => {
            return Err(unpaired_reason());
        }
    };
    Ok(QueueItemRecord {
        id: text_column(row, 0, |text| QueueItemId::new(&text))?,
        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
        state,
        body: text_column(row, 4, |text| serde_json::from_str::<QueueItemBody>(&text))?,
        target_run_id: optional_text_column(row, 5, |text| RunId::new(&text))?,
        child_handle: optional_text_column(row, 6, |text| {
            ChildHandle::new(text).ok_or(NotAChildHandle)
        })?,
        position: safe_int_column(row, 7)?,
        client_idempotency_key: optional_text_column(row, 8, ClientUuid::new)?,
        created_at: text_column(row, 9, WireInstant::try_from)?,
        updated_at: text_column(row, 10, WireInstant::try_from)?,
        sent_now_id: optional_text_column(row, 11, |text| InterventionId::new(&text))?,
    })
}

// The read of a stored state, reason and words that do not pair.
fn unpaired_reason() -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        3,
        rusqlite::types::Type::Text,
        Box::new(UnpairedNotDeliveredReason),
    )
}

// The words a reason carries: a hook's refusal carries the hook's own.
fn words_of(reason: &QueueItemNotDeliveredReason) -> Option<&str> {
    match reason {
        QueueItemNotDeliveredReason::RefusedByHook { words } => Some(words.as_str()),
        QueueItemNotDeliveredReason::TimedOut {} | QueueItemNotDeliveredReason::Failed {} => None,
    }
}

// A statement on one item that changes only its time besides what its text sets.
fn item_change_statement(
    sql: &'static LazyLock<String>,
    id: &QueueItemId,
    now: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", id.text().as_str()),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

// A guard on one session that expects `expected_row_count` rows.
fn session_statement(
    sql: &'static LazyLock<String>,
    session_id: &SessionId,
    expected_row_count: usize,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql.as_str()),
        bindings: StatementBindings::Named(vec![text_binding(
            "@session_id",
            session_id.text().as_str(),
        )]),
        expected_row_count: Some(expected_row_count),
    }
}
