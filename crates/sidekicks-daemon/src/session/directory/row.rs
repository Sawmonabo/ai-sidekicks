//! The session directory row: one table says what each event type changes, and it is read two
//! ways, as a fold over stored events for a rebuild and as the statements that apply the same
//! change inside the event's own write, so the `sessions` row and a rebuild cannot drift.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value as SqlValue;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use sidekicks_contracts::agent::definition::AgentDefinitionId;
use sidekicks_contracts::event::envelope::{
    DAEMON_SCOPE_SENTINEL_SESSION_ID, EventCategory, EventEnvelope,
};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::run::queue::UserMessageSentPayload;
use sidekicks_contracts::session::directory::SessionActivity;
use sidekicks_contracts::session::events::{
    SessionCreatedPayload, SessionMarkChangePayload, SessionRenamedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{SessionShape, SessionState};
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::text::{FreeFormText, is_ecmascript_whitespace};
use sidekicks_contracts::worktree::events::SessionBranchChangedPayload;

use crate::database::statement::{StatementBindings, WriteStatement, place_value, text_binding};
use crate::events::canonicalizer::{OccurredAtNormalizationRefusal, normalize_occurred_at};
use crate::session::directory::run_activity::run_outcome_of;
use crate::session::records::SessionDirectoryRow;
use crate::text_cut::cut_to_code_points;

/// The members of an event the directory reads, which a stored event and an event about to be
/// appended both carry. Its payload is trusted as the append path's variant check left it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DirectoryEvent<'event> {
    /// The session the event belongs to.
    pub(crate) session_id: &'event SessionId,
    /// When it occurred, as the event carries it.
    pub(crate) occurred_at: &'event str,
    /// The event's category.
    pub(crate) category: EventCategory,
    /// The event's type as stored, which may be one this build does not register.
    pub(crate) event_type: &'event str,
    /// The payload's members.
    pub(crate) payload: &'event Map<String, Value>,
}

impl<'event> From<&'event EventEnvelope> for DirectoryEvent<'event> {
    fn from(envelope: &'event EventEnvelope) -> Self {
        Self {
            session_id: &envelope.session_id,
            occurred_at: envelope.occurred_at.as_str(),
            category: envelope.category,
            event_type: envelope.event_type.as_str(),
            payload: &envelope.payload,
        }
    }
}

/// Why an event cannot open or change a session's directory row. None quotes a payload, which
/// may carry a person's words.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DirectoryRowError {
    /// A row opens only from its session's `session.created`, and this event is another type.
    #[error("a session's directory row opens only at session.created, not {event_type}")]
    NotACreation {
        /// The event's type.
        event_type: String,
    },
    /// A second `session.created` would replace the session mid-stream.
    #[error("session.created opens session {session_id} once and is never folded in")]
    CreatedAgain {
        /// The session the row belongs to.
        session_id: SessionId,
    },
    /// The event's `occurredAt` cannot take the stored form.
    #[error("the event's occurredAt cannot take the stored form")]
    OccurredAt(#[source] OccurredAtNormalizationRefusal),
    /// A pin's or a mute's time cannot take the stored form.
    #[error("the mark's time cannot take the stored form")]
    MarkTime(#[source] OccurredAtNormalizationRefusal),
    /// The payload does not read as its registered variant, which only a write past the append
    /// path's variant check can leave.
    #[error("the {} payload does not read as its registered variant", .event_type.as_str())]
    Payload {
        /// The event's type.
        event_type: SessionEventType,
        /// Why the payload does not read.
        #[source]
        source: serde_json::Error,
    },
}

// One event-derived `sessions` column and the value an event writes to it.
enum ColumnValue {
    Shape(SessionShape),
    State(SessionState),
    Name(Option<String>),
    FirstMessagePreview(Option<String>),
    Branch(Option<String>),
    PinnedAt(Option<String>),
    MutedAt(Option<String>),
    LastRunOutcome(SessionActivity),
}

impl ColumnValue {
    // The column's name in `sessions`.
    fn column(&self) -> &'static str {
        match self {
            Self::Shape(_) => "shape",
            Self::State(_) => "state",
            Self::Name(_) => "name",
            Self::FirstMessagePreview(_) => "first_message_preview",
            Self::Branch(_) => "branch",
            Self::PinnedAt(_) => "pinned_at",
            Self::MutedAt(_) => "muted_at",
            Self::LastRunOutcome(_) => "last_run_outcome",
        }
    }

    fn into_sql(self) -> SqlValue {
        match self {
            Self::Shape(shape) => SqlValue::Text(<&'static str>::from(shape).to_owned()),
            Self::State(state) => SqlValue::Text(<&'static str>::from(state).to_owned()),
            Self::LastRunOutcome(outcome) => {
                SqlValue::Text(<&'static str>::from(outcome).to_owned())
            }
            Self::Name(text)
            | Self::FirstMessagePreview(text)
            | Self::Branch(text)
            | Self::PinnedAt(text)
            | Self::MutedAt(text) => SqlValue::from(text),
        }
    }

    // Writes the value into its field of `row`; a keep-first write leaves a field already set.
    fn write_into(self, row: &mut SessionDirectoryRow, keeps_first: bool) {
        let (current, value) = match self {
            Self::Shape(shape) => {
                row.shape = shape;
                return;
            }
            Self::State(state) => {
                row.state = state;
                return;
            }
            Self::LastRunOutcome(outcome) => {
                row.last_run_outcome = outcome;
                return;
            }
            Self::Name(text) => (&mut row.name, text),
            Self::FirstMessagePreview(text) => (&mut row.first_message_preview, text),
            Self::Branch(text) => (&mut row.branch, text),
            Self::PinnedAt(text) => (&mut row.pinned_at, text),
            Self::MutedAt(text) => (&mut row.muted_at, text),
        };
        if !(keeps_first && current.is_some()) {
            *current = value;
        }
    }
}

// A column write; `keeps_first` writes the value only while the column is empty, so a repeat
// keeps the first.
struct ColumnWrite {
    value: ColumnValue,
    keeps_first: bool,
}

// What one event changes in its session's row: the row's opening, or one column.
enum DirectoryChange {
    Create {
        shape: SessionShape,
        scratch_for_definition_id: Option<AgentDefinitionId>,
        parent_session_id: Option<SessionId>,
        place: Option<Place>,
    },
    Column(ColumnWrite),
}

fn set_column(value: ColumnValue) -> DirectoryChange {
    DirectoryChange::Column(ColumnWrite {
        value,
        keeps_first: false,
    })
}

fn keep_first_column(value: ColumnValue) -> DirectoryChange {
    DirectoryChange::Column(ColumnWrite {
        value,
        keeps_first: true,
    })
}

// A payload the append path parsed against its registered variant, read as that variant.
fn payload_as<Payload: DeserializeOwned>(
    event_type: SessionEventType,
    payload: &Map<String, Value>,
) -> Result<Payload, DirectoryRowError> {
    Payload::deserialize(payload)
        .map_err(|source| DirectoryRowError::Payload { event_type, source })
}

// What the event changes, from the one table of event types; `None` for a type that changes no
// column, one this build does not register among them.
fn change_of(event: &DirectoryEvent<'_>) -> Result<Option<DirectoryChange>, DirectoryRowError> {
    let Some(event_type) = SessionEventType::from_wire_name(event.event_type) else {
        return Ok(None);
    };
    let change = match event_type {
        SessionEventType::SessionCreated => {
            let created: SessionCreatedPayload = payload_as(event_type, event.payload)?;
            DirectoryChange::Create {
                shape: created.shape,
                scratch_for_definition_id: created.scratch_for_definition_id,
                parent_session_id: created.parent.map(|parent| parent.session_id),
                place: created.place,
            }
        }
        SessionEventType::SessionActivated | SessionEventType::SessionReactivated => {
            set_column(ColumnValue::State(SessionState::Active))
        }
        SessionEventType::SessionArchived => set_column(ColumnValue::State(SessionState::Archived)),
        SessionEventType::SessionClosed => set_column(ColumnValue::State(SessionState::Closed)),
        SessionEventType::SessionRenamed => {
            let renamed: SessionRenamedPayload = payload_as(event_type, event.payload)?;
            set_column(ColumnValue::Name(
                renamed.name.map(FreeFormText::into_string),
            ))
        }
        SessionEventType::SessionPinned => keep_first_column(ColumnValue::PinnedAt(Some(
            mark_time_of(event_type, event.payload)?,
        ))),
        SessionEventType::SessionUnpinned => set_column(ColumnValue::PinnedAt(None)),
        SessionEventType::SessionMuted => keep_first_column(ColumnValue::MutedAt(Some(
            mark_time_of(event_type, event.payload)?,
        ))),
        SessionEventType::SessionUnmuted => set_column(ColumnValue::MutedAt(None)),
        SessionEventType::SessionConverted => set_column(ColumnValue::Shape(SessionShape::Project)),
        SessionEventType::SessionBranchChanged => {
            let changed: SessionBranchChangedPayload = payload_as(event_type, event.payload)?;
            set_column(ColumnValue::Branch(
                changed.branch.map(FreeFormText::into_string),
            ))
        }
        SessionEventType::UserMessageSent => {
            let sent: UserMessageSentPayload = payload_as(event_type, event.payload)?;
            keep_first_column(ColumnValue::FirstMessagePreview(Some(
                first_message_preview_of(sent.message.as_str()),
            )))
        }
        SessionEventType::AgentRunCompleted
        | SessionEventType::AgentRunFailed
        | SessionEventType::AgentRunInterrupted
        | SessionEventType::AgentRunStopped
        | SessionEventType::AgentRunPaused => {
            return Ok(run_outcome_of(event_type, event.payload)
                .map(|outcome| set_column(ColumnValue::LastRunOutcome(outcome))));
        }
        SessionEventType::AgentRunQueued
        | SessionEventType::AgentRunStarting
        | SessionEventType::AgentRunRunning
        | SessionEventType::AgentRunWaitingForApproval
        | SessionEventType::AgentRunWaitingForInput
        | SessionEventType::AgentRunPausing
        | SessionEventType::AgentRunRolledBack
        | SessionEventType::AgentRunProviderInitialized
        | SessionEventType::AgentTurnStarted
        | SessionEventType::AgentTurnCompleted
        | SessionEventType::AgentTurnInterrupted
        | SessionEventType::AgentTurnFailed
        | SessionEventType::AgentRunWorkerShuttingDown
        | SessionEventType::AgentRunStepLimitReached
        | SessionEventType::AgentRunTokenLimitReached
        | SessionEventType::AgentRunRecoveryStepsAdded
        | SessionEventType::AgentRunRecoveryResolved
        | SessionEventType::AgentRunRefusalChoiceRequested
        | SessionEventType::AgentRunRefusalChoiceResolved
        | SessionEventType::AgentRunUsageCreditsChoiceRequested
        | SessionEventType::AgentRunUsageCreditsChoiceResolved
        | SessionEventType::AgentMessageSent
        | SessionEventType::AgentThinkingUpdated
        | SessionEventType::AgentToolCallInvoked
        | SessionEventType::AgentToolCallCompleted
        | SessionEventType::AgentToolCallFailed
        | SessionEventType::AgentSubagentStarted
        | SessionEventType::AgentSubagentCompleted
        | SessionEventType::AgentCommandEnded
        | SessionEventType::AgentQueueItemCreated
        | SessionEventType::AgentQueueItemAdmitted
        | SessionEventType::AgentQueueItemSuperseded
        | SessionEventType::AgentQueueItemCanceled
        | SessionEventType::AgentQueueItemNotDelivered
        | SessionEventType::AgentInterventionRequested
        | SessionEventType::AgentInterventionAccepted
        | SessionEventType::AgentInterventionApplied
        | SessionEventType::AgentInterventionRejected
        | SessionEventType::AgentInterventionDegraded
        | SessionEventType::AgentInterventionExpired
        | SessionEventType::AgentInterventionFailed
        | SessionEventType::QuestionAsked
        | SessionEventType::ArtifactPublished
        | SessionEventType::ArtifactSuperseded
        | SessionEventType::GitSettled
        | SessionEventType::SessionGoalUpdated
        | SessionEventType::SessionGoalCleared
        | SessionEventType::SessionProviderStatusReported
        | SessionEventType::SessionNoticePosted
        | SessionEventType::SessionSideQuestionAnswered
        | SessionEventType::SessionSpendLimitReached
        | SessionEventType::SessionRestoreCompleted
        | SessionEventType::SessionAdvisorChanged
        | SessionEventType::SessionOutputStyleChanged
        | SessionEventType::AgentProviderBindingChanged
        | SessionEventType::AgentProviderBindingChangeFailed
        | SessionEventType::WorkspacePreparing
        | SessionEventType::WorkspacePrepared
        | SessionEventType::WorkspaceRootLost
        | SessionEventType::WorkspaceArchived
        | SessionEventType::WorktreeCreated
        | SessionEventType::WorktreeBound
        | SessionEventType::WorktreeDirtied
        | SessionEventType::WorktreeMerged
        | SessionEventType::WorktreeRetired
        | SessionEventType::RepoMountHealthChanged
        | SessionEventType::SessionSweptToCheckout
        | SessionEventType::TerminalControlChanged
        | SessionEventType::CloudTaskUpdated
        | SessionEventType::ApprovalRequested
        | SessionEventType::ApprovalApproved
        | SessionEventType::ApprovalRejected
        | SessionEventType::ApprovalCanceled
        | SessionEventType::ApprovalRuleRemembered
        | SessionEventType::ApprovalRuleRevoked
        | SessionEventType::ApprovalReviewerDenied
        | SessionEventType::ApprovalDenialOverridden
        | SessionEventType::ApprovalReviewerFlagged
        | SessionEventType::PlanProposed
        | SessionEventType::PlanAccepted
        | SessionEventType::PlanHandedOff
        | SessionEventType::UsageTokenCountRecorded
        | SessionEventType::UsageCostUpdated
        | SessionEventType::UsageContextWindowUpdated
        | SessionEventType::UsageRateLimitUpdated
        | SessionEventType::UsageApiRequestRetried
        | SessionEventType::AgentRunContextCompacted
        | SessionEventType::AgentTurnRerouted
        | SessionEventType::DaemonRecoveryAttempted
        | SessionEventType::DaemonRecoverySucceeded
        | SessionEventType::DaemonRecoveryFailed
        | SessionEventType::SessionDamagedEventsSkipped
        | SessionEventType::RelayPinRefused
        | SessionEventType::SessionEventCompacted
        | SessionEventType::DaemonBackupCompleted
        | SessionEventType::DaemonBackupFailed
        | SessionEventType::DaemonBackupRestored
        | SessionEventType::AgentRunRejected
        | SessionEventType::McpServerSignInCompleted
        | SessionEventType::WorkflowVersionCreated
        | SessionEventType::WorkflowRunStarted
        | SessionEventType::WorkflowGateReached
        | SessionEventType::WorkflowRunFailed
        | SessionEventType::WorkflowRunCompleted
        | SessionEventType::WorkflowRunResumed
        | SessionEventType::WorkflowRunCanceled
        | SessionEventType::WorkflowRunWaiting
        | SessionEventType::WorkflowRunDeleted
        | SessionEventType::WorkflowScheduleArmed
        | SessionEventType::WorkflowScheduleFired
        | SessionEventType::WorkflowTriggerArmed
        | SessionEventType::WorkflowTriggerFired
        | SessionEventType::WorkflowResultsPosted
        | SessionEventType::WorkflowPhaseAdmitted
        | SessionEventType::WorkflowPhaseWaitingOnPool
        | SessionEventType::WorkflowPhaseStarted
        | SessionEventType::WorkflowPhaseProgressed
        | SessionEventType::WorkflowPhaseCanceling
        | SessionEventType::WorkflowPhaseFailed
        | SessionEventType::WorkflowPhaseRetried
        | SessionEventType::WorkflowPhaseSuspended
        | SessionEventType::WorkflowPhaseResumed
        | SessionEventType::WorkflowPhaseCompleted
        | SessionEventType::WorkflowStepStarted
        | SessionEventType::WorkflowStepCompleted
        | SessionEventType::WorkflowStepFailed
        | SessionEventType::WorkflowStepCanceled
        | SessionEventType::WorkflowStepSkipped
        | SessionEventType::WorkflowParallelJoinBranchesCanceled
        | SessionEventType::WorkflowGateResolved => return Ok(None),
    };
    Ok(Some(change))
}

// Mark times sort pinned sessions, so they are stored in the one form that sorts as text.
fn mark_time_of(
    event_type: SessionEventType,
    payload: &Map<String, Value>,
) -> Result<String, DirectoryRowError> {
    let mark: SessionMarkChangePayload = payload_as(event_type, payload)?;
    normalize_occurred_at(mark.at.as_str())
        .map(|stored| stored.as_str().to_owned())
        .map_err(DirectoryRowError::MarkTime)
}

// The row's preview of a message: its opening, leading whitespace dropped, cut to the session
// name's bound in code points. A message is never blank, so the preview is never empty.
fn first_message_preview_of(message: &str) -> String {
    let opening = message.trim_start_matches(is_ecmascript_whitespace);
    cut_to_code_points(opening, SESSION_NAME_MAX_LEN).to_owned()
}

// One event's change and the activity times it moves, `occurred_at` in the stored form.
struct DirectoryUpdate {
    change: Option<DirectoryChange>,
    occurred_at: String,
    moves_last_activity: bool,
    moves_updated_at: bool,
}

// Maintenance events are the log's own bookkeeping, so they never say when the session was last
// active. A reasoning update arrives many times within one turn, and each move of last activity
// would re-order the list, change its shown time and make the search index re-read the session's
// tag rows, so it does not move it either.
fn describe_directory_update(
    event: &DirectoryEvent<'_>,
) -> Result<DirectoryUpdate, DirectoryRowError> {
    Ok(DirectoryUpdate {
        change: change_of(event)?,
        occurred_at: normalize_occurred_at(event.occurred_at)
            .map_err(DirectoryRowError::OccurredAt)?
            .as_str()
            .to_owned(),
        moves_last_activity: event.category != EventCategory::EventMaintenance
            && event.event_type != SessionEventType::AgentThinkingUpdated.as_str(),
        moves_updated_at: event.category == EventCategory::SessionLifecycle,
    })
}

// Moves `current` to `candidate` when it is later. Both are in the stored form, whose text order
// is time order.
fn move_to_later(current: &mut String, candidate: &str) {
    if candidate > current.as_str() {
        candidate.clone_into(current);
    }
}

/// Opens a session's directory row from its `session.created` event. Fails with
/// [`DirectoryRowError::NotACreation`] for any other type, since a row exists only from its
/// session's creation, and as the event's own read fails.
pub(crate) fn open_directory_row(
    created: &DirectoryEvent<'_>,
) -> Result<SessionDirectoryRow, DirectoryRowError> {
    let update = describe_directory_update(created)?;
    let Some(DirectoryChange::Create {
        shape,
        scratch_for_definition_id,
        parent_session_id,
        place,
    }) = update.change
    else {
        return Err(DirectoryRowError::NotACreation {
            event_type: created.event_type.to_owned(),
        });
    };
    Ok(SessionDirectoryRow {
        session_id: *created.session_id,
        shape,
        state: SessionState::Provisioning,
        name: None,
        first_message_preview: None,
        branch: None,
        pinned_at: None,
        muted_at: None,
        scratch_for_definition_id,
        parent_session_id,
        place,
        last_run_outcome: SessionActivity::Idle,
        created_at: update.occurred_at.clone(),
        updated_at: update.occurred_at.clone(),
        last_activity_at: update.occurred_at,
    })
}

/// `row` with one later event applied, the input left as it was. Fails with
/// [`DirectoryRowError::CreatedAgain`] for a second `session.created`, which would replace the
/// session mid-stream, and as the event's own read fails.
pub(crate) fn fold_directory_row(
    row: &SessionDirectoryRow,
    event: &DirectoryEvent<'_>,
) -> Result<SessionDirectoryRow, DirectoryRowError> {
    let update = describe_directory_update(event)?;
    let mut next = row.clone();
    match update.change {
        Some(DirectoryChange::Create { .. }) => {
            return Err(DirectoryRowError::CreatedAgain {
                session_id: row.session_id,
            });
        }
        Some(DirectoryChange::Column(write)) => {
            write.value.write_into(&mut next, write.keeps_first);
        }
        None => {}
    }
    if update.moves_last_activity {
        move_to_later(&mut next.last_activity_at, &update.occurred_at);
    }
    if update.moves_updated_at {
        move_to_later(&mut next.updated_at, &update.occurred_at);
    }
    Ok(next)
}

static INSERT_CREATED_ROW_SQL: LazyLock<String> = LazyLock::new(|| {
    let provisioning = <&'static str>::from(SessionState::Provisioning);
    format!(
        "INSERT INTO sessions
        (id, shape, state, scratch_for_definition_id, parent_session_id, place,
         created_at, updated_at, last_activity_at)
      VALUES (?, ?, '{provisioning}', ?, ?, ?, ?, ?, ?)"
    )
});

/// The statements that apply one event's change to the `sessions` row, run in the event's own
/// write before its row. Each is relative to the event alone. The update expects its one row, so
/// an event for a session with no row refuses the write; an event of the machine's own sentinel
/// session has none and gets no statements. Fails as the event's own read fails.
pub(crate) fn directory_statements_for(
    event: &DirectoryEvent<'_>,
) -> Result<Vec<WriteStatement>, DirectoryRowError> {
    if *event.session_id == *DAEMON_SCOPE_SENTINEL_SESSION_ID {
        return Ok(Vec::new());
    }
    let update = describe_directory_update(event)?;
    let mut assignments: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();
    match update.change {
        Some(DirectoryChange::Create {
            shape,
            scratch_for_definition_id,
            parent_session_id,
            place,
        }) => {
            return Ok(vec![WriteStatement {
                sql: Cow::Borrowed(INSERT_CREATED_ROW_SQL.as_str()),
                bindings: StatementBindings::Positional(vec![
                    SqlValue::Text(event.session_id.to_string()),
                    SqlValue::Text(<&'static str>::from(shape).to_owned()),
                    SqlValue::from(scratch_for_definition_id.map(|id| id.to_string())),
                    SqlValue::from(parent_session_id.map(|id| id.to_string())),
                    place_value(place.as_ref()),
                    SqlValue::Text(update.occurred_at.clone()),
                    SqlValue::Text(update.occurred_at.clone()),
                    SqlValue::Text(update.occurred_at),
                ]),
                expected_row_count: None,
            }]);
        }
        Some(DirectoryChange::Column(write)) => {
            let column = write.value.column();
            assignments.push(if write.keeps_first {
                format!("{column} = COALESCE({column}, ?)")
            } else {
                format!("{column} = ?")
            });
            values.push(write.value.into_sql());
        }
        None => {}
    }
    if update.moves_last_activity {
        assignments.push("last_activity_at = max(last_activity_at, ?)".to_owned());
        values.push(SqlValue::Text(update.occurred_at.clone()));
    }
    if update.moves_updated_at {
        assignments.push("updated_at = max(updated_at, ?)".to_owned());
        values.push(SqlValue::Text(update.occurred_at));
    }
    if assignments.is_empty() {
        return Ok(Vec::new());
    }
    values.push(SqlValue::Text(event.session_id.to_string()));
    Ok(vec![WriteStatement {
        sql: Cow::Owned(format!(
            "UPDATE sessions SET {} WHERE id = ?",
            assignments.join(", ")
        )),
        bindings: StatementBindings::Positional(values),
        expected_row_count: Some(1),
    }])
}

const UPSERT_ROW_SQL: &str = "INSERT INTO sessions
        (id, shape, state, name, first_message_preview, branch, pinned_at, muted_at,
         scratch_for_definition_id, parent_session_id, place, last_run_outcome, created_at,
         updated_at, last_activity_at)
      VALUES (@id, @shape, @state, @name, @firstMessagePreview, @branch, @pinnedAt, @mutedAt,
              @scratchForDefinitionId, @parentSessionId, @place, @lastRunOutcome, @createdAt,
              @updatedAt, @lastActivityAt)
      ON CONFLICT (id) DO UPDATE SET
        shape = excluded.shape, state = excluded.state, name = excluded.name,
        first_message_preview = excluded.first_message_preview, branch = excluded.branch,
        pinned_at = excluded.pinned_at, muted_at = excluded.muted_at,
        scratch_for_definition_id = excluded.scratch_for_definition_id,
        parent_session_id = excluded.parent_session_id, place = excluded.place,
        last_run_outcome = excluded.last_run_outcome, created_at = excluded.created_at,
        updated_at = excluded.updated_at, last_activity_at = excluded.last_activity_at";

/// The statement that writes a folded row's every event-derived column over the session's row, or
/// inserts the row when the database lost it; the columns services write and its group are kept.
pub(crate) fn directory_row_statement(row: &SessionDirectoryRow) -> WriteStatement {
    let optional_text = |text: Option<&str>| SqlValue::from(text.map(str::to_owned));
    WriteStatement {
        sql: Cow::Borrowed(UPSERT_ROW_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", row.session_id.text().as_str()),
            text_binding("@shape", row.shape.into()),
            text_binding("@state", row.state.into()),
            (Cow::Borrowed("@name"), optional_text(row.name.as_deref())),
            (
                Cow::Borrowed("@firstMessagePreview"),
                optional_text(row.first_message_preview.as_deref()),
            ),
            (
                Cow::Borrowed("@branch"),
                optional_text(row.branch.as_deref()),
            ),
            (
                Cow::Borrowed("@pinnedAt"),
                optional_text(row.pinned_at.as_deref()),
            ),
            (
                Cow::Borrowed("@mutedAt"),
                optional_text(row.muted_at.as_deref()),
            ),
            (
                Cow::Borrowed("@scratchForDefinitionId"),
                optional_text(
                    row.scratch_for_definition_id
                        .map(|id| id.text())
                        .as_ref()
                        .map(UuidText::as_str),
                ),
            ),
            (
                Cow::Borrowed("@parentSessionId"),
                optional_text(
                    row.parent_session_id
                        .map(|id| id.text())
                        .as_ref()
                        .map(UuidText::as_str),
                ),
            ),
            (Cow::Borrowed("@place"), place_value(row.place.as_ref())),
            text_binding("@lastRunOutcome", row.last_run_outcome.into()),
            text_binding("@createdAt", &row.created_at),
            text_binding("@updatedAt", &row.updated_at),
            text_binding("@lastActivityAt", &row.last_activity_at),
        ]),
        expected_row_count: None,
    }
}
