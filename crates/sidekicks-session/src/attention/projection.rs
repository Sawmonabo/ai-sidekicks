//! The attention entries as the log keeps them in step: each event's change, written in the
//! event's own write, raises an entry, resolves a moment's or a step's open entries, deletes a
//! workflow run's, withdraws a muted session's ends, or only tells the readers a name changed.
//!
//! Every set opens with the bump of the machine's and the session's change counts, guarded by the
//! rows it is about to touch, so a set that changes nothing wakes no subscriber. An entry's sequence
//! is read from its source event's row by id, never stored: the projection statements run before
//! the event rows are written, so the sequence does not exist yet when an entry is raised.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::attention::{AttentionBannerState, AttentionSeverity, AttentionTrigger};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement};
use sidekicks_store::events::log_service::ProjectionError;
use sidekicks_store::events::session::appender::UnsequencedEventEnvelope;

use crate::attention::moment::{
    AttentionChange, AttentionEnd, AttentionMoment, AttentionOpenEntries, AttentionRaise,
    AttentionWait, entry_change_of,
};
use crate::attention::schema::word_of;

/// Every event type whose change is not nothing; an event of any other type is not read.
const ATTENTION_EVENT_TYPES: [SessionEventType; 29] = [
    SessionEventType::AgentRunWaitingForApproval,
    SessionEventType::AgentRunWaitingForInput,
    SessionEventType::AgentRunQueued,
    SessionEventType::AgentRunStarting,
    SessionEventType::AgentRunRunning,
    SessionEventType::AgentRunPausing,
    SessionEventType::AgentRunPaused,
    SessionEventType::AgentRunCompleted,
    SessionEventType::AgentRunFailed,
    SessionEventType::AgentRunInterrupted,
    SessionEventType::AgentRunStopped,
    SessionEventType::PlanProposed,
    SessionEventType::PlanAccepted,
    SessionEventType::PlanKept,
    SessionEventType::PlanHandedOff,
    SessionEventType::WorkflowPhaseSuspended,
    SessionEventType::WorkflowPhaseResumed,
    SessionEventType::WorkflowStepCompleted,
    SessionEventType::WorkflowStepFailed,
    SessionEventType::WorkflowStepCanceled,
    SessionEventType::WorkflowRunResumed,
    SessionEventType::WorkflowRunCanceled,
    SessionEventType::WorkflowRunCompleted,
    SessionEventType::WorkflowRunFailed,
    SessionEventType::WorkflowRunDeleted,
    SessionEventType::SessionMuted,
    SessionEventType::SessionRenamed,
    SessionEventType::SessionConverted,
    SessionEventType::UserMessageSent,
];

const ENTRY_COLUMNS: &str = "id, moment_id, session_id, run_id, workflow_run_id, plan_id, node_id,
    attempt, execution_index, trigger, severity, notice_text, source_event_id, created_at";

const ENTRY_VALUES: &str = "@id, @moment_id, @session_id, @run_id, @workflow_run_id, @plan_id,
    @node_id, @attempt, @execution_index, @trigger, @severity, @notice_text, @source_event_id,
    @created_at";

static INSERT_ENTRY_SQL: LazyLock<String> = LazyLock::new(|| {
    format!("INSERT INTO attention_entries ({ENTRY_COLUMNS}) VALUES ({ENTRY_VALUES})")
});

// A run's end raises an entry only for a lead run, which the event itself cannot say.
static INSERT_LEAD_RUN_END_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO attention_entries ({ENTRY_COLUMNS})
  SELECT {ENTRY_VALUES} FROM runs WHERE run_id = @run_id AND parent_run_id IS NULL"
    )
});

// The open entries of a moment, and of one workflow step by its whole key.
const OPEN_MOMENT_ENTRIES: &str = "moment_id = @moment_id AND resolved_at IS NULL";
const OPEN_STEP_ENTRIES: &str = "workflow_run_id = @workflow_run_id AND node_id = @node_id
    AND attempt = @attempt AND execution_index = @execution_index AND resolved_at IS NULL";

/// The statements that resolve one kind of open entries.
struct ResolveSql {
    /// Raises the counts when an entry is open.
    bump: String,
    /// Takes down the resolving entries' raised banners.
    withdraw: String,
    /// Hands back the banner of each open entry merged into a resolving one, undecided.
    unmerge: String,
    /// Marks the entries resolved.
    resolve: String,
}

impl ResolveSql {
    fn of(open_entries: &str) -> Self {
        let raised = raised_banner_states();
        Self {
            bump: version_bump_sql(&format!(
                "EXISTS (SELECT 1 FROM attention_entries WHERE {open_entries})"
            )),
            withdraw: format!(
                "UPDATE attention_deliveries SET banner_state = '{withdrawn}'
  WHERE banner_state IN ({raised})
    AND entry_id IN (SELECT id FROM attention_entries WHERE {open_entries})",
                withdrawn = word_of(AttentionBannerState::Withdrawn),
            ),
            // An entry resolving in the same set keeps its merge: it is never decided.
            unmerge: format!(
                "UPDATE attention_deliveries SET banner_state = NULL, merged_into = NULL
  WHERE merged_into IN (SELECT id FROM attention_entries WHERE {open_entries})
    AND entry_id NOT IN (SELECT id FROM attention_entries WHERE {open_entries})
    AND EXISTS (SELECT 1 FROM attention_entries AS own
                 WHERE own.id = attention_deliveries.entry_id AND own.resolved_at IS NULL)"
            ),
            resolve: format!(
                "UPDATE attention_entries SET resolved_at = @resolved_at WHERE {open_entries}"
            ),
        }
    }
}

static MOMENT_RESOLVE_SQL: LazyLock<ResolveSql> =
    LazyLock::new(|| ResolveSql::of(OPEN_MOMENT_ENTRIES));
static STEP_RESOLVE_SQL: LazyLock<ResolveSql> = LazyLock::new(|| ResolveSql::of(OPEN_STEP_ENTRIES));

static BUMP_ALWAYS_SQL: LazyLock<String> = LazyLock::new(|| version_bump_sql("true"));

// A run's end changes rows when its moment has an open entry or the run is a lead run.
static BUMP_IF_OPEN_OR_LEAD_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    version_bump_sql(&format!(
        "EXISTS (SELECT 1 FROM attention_entries WHERE {OPEN_MOMENT_ENTRIES})
     OR EXISTS (SELECT 1 FROM runs WHERE run_id = @run_id AND parent_run_id IS NULL)"
    ))
});

static BUMP_IF_WORKFLOW_RUN_ENTRIES_SQL: LazyLock<String> = LazyLock::new(|| {
    version_bump_sql(
        "EXISTS (SELECT 1 FROM attention_entries WHERE workflow_run_id = @workflow_run_id)",
    )
});

const DELETE_WORKFLOW_RUN_DELIVERIES_SQL: &str = "DELETE FROM attention_deliveries
  WHERE entry_id IN (SELECT id FROM attention_entries WHERE workflow_run_id = @workflow_run_id)";

const DELETE_WORKFLOW_RUN_ENTRIES_SQL: &str =
    "DELETE FROM attention_entries WHERE workflow_run_id = @workflow_run_id";

// A muted session's raised end banners; its waits and its Notify steps keep theirs.
static MUTED_END_BANNERS: LazyLock<String> = LazyLock::new(|| {
    format!(
        "banner_state IN ({raised}) AND entry_id IN (SELECT id FROM attention_entries
    WHERE session_id = @session_id AND trigger IN ('{completed}', '{failed}'))",
        raised = raised_banner_states(),
        completed = word_of(AttentionTrigger::RunCompleted),
        failed = word_of(AttentionTrigger::RunFailed),
    )
});

static BUMP_IF_MUTED_END_BANNERS_SQL: LazyLock<String> = LazyLock::new(|| {
    version_bump_sql(&format!(
        "EXISTS (SELECT 1 FROM attention_deliveries WHERE {})",
        *MUTED_END_BANNERS
    ))
});

static WITHDRAW_MUTED_END_BANNERS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE attention_deliveries SET banner_state = '{withdrawn}' WHERE {muted}",
        withdrawn = word_of(AttentionBannerState::Withdrawn),
        muted = *MUTED_END_BANNERS,
    )
});

// A name an entry shows changed: only a session with entries has readers to tell.
static BUMP_IF_SESSION_ENTRIES_SQL: LazyLock<String> = LazyLock::new(|| {
    version_bump_sql("EXISTS (SELECT 1 FROM attention_entries WHERE session_id = @session_id)")
});

/// The statements that keep the attention entries in step with an append, run in the append's
/// own write for each event it stores. Fails when the event's payload does not read as its type's,
/// which refuses the append.
pub fn attention_projection_statements(
    envelope: &UnsequencedEventEnvelope,
) -> Result<Vec<WriteStatement>, ProjectionError> {
    if !ATTENTION_EVENT_TYPES.contains(&envelope.event_type()) {
        return Ok(Vec::new());
    }
    let event = SessionEvent::from_payload(envelope.event_type(), envelope.payload())?;
    let source = EventSource {
        event_id: envelope.id.as_str(),
        session_id: envelope.session_id(),
        occurred_at: envelope.occurred_at.as_str(),
    };
    Ok(change_statements(&entry_change_of(&event), &source))
}

/// The statements that raise a workflow's Notify step's entry, for the prelude of the step's
/// `workflow.step.completed` write: the entry, under its moment's id, and the counts' bump. The
/// entry's source is the step's `workflow.step.started` event, `started_event_id`, and it is made
/// at `occurred_at`, in the stored form.
pub fn notify_entry_statements(
    session_id: SessionId,
    workflow_run_id: WorkflowRunId,
    node_id: &WorkflowNodeId,
    execution_index: SafeInt<0>,
    started_event_id: &str,
    notice: &NonEmptyText,
    occurred_at: &str,
) -> Vec<WriteStatement> {
    let moment_id = AttentionMoment::Notify {
        workflow_run_id,
        node_id: node_id.clone(),
        execution_index,
    }
    .id()
    .as_str()
    .to_owned();
    let entry = EntryRow {
        id: moment_id.clone(),
        moment_id,
        session_id: session_id.to_string(),
        run_id: None,
        workflow_run_id: Some(workflow_run_id.to_string()),
        plan_id: None,
        node_id: Some(node_id.as_str().to_owned()),
        attempt: None,
        execution_index: Some(i64::from(execution_index)),
        trigger: word_of(AttentionTrigger::WorkflowNotify),
        severity: word_of(AttentionSeverity::Informational),
        notice_text: Some(notice.as_str().to_owned()),
        source_event_id: started_event_id.to_owned(),
        created_at: occurred_at.to_owned(),
    };
    vec![
        statement(&BUMP_ALWAYS_SQL, vec![session_binding(session_id)]),
        statement(&INSERT_ENTRY_SQL, entry.into_bindings()),
    ]
}

/// The event a change comes from: its id, its session and its instant in the stored form.
struct EventSource<'event> {
    event_id: &'event str,
    session_id: SessionId,
    occurred_at: &'event str,
}

/// One `attention_entries` row as an insert binds it.
struct EntryRow {
    id: String,
    moment_id: String,
    session_id: String,
    run_id: Option<String>,
    workflow_run_id: Option<String>,
    plan_id: Option<String>,
    node_id: Option<String>,
    attempt: Option<i64>,
    execution_index: Option<i64>,
    trigger: String,
    severity: String,
    notice_text: Option<String>,
    source_event_id: String,
    created_at: String,
}

impl EntryRow {
    /// The row `raise` writes for the event `source`, under the event's own id.
    fn raised(raise: &AttentionRaise, source: &EventSource<'_>) -> Self {
        let mut row = Self {
            id: source.event_id.to_owned(),
            moment_id: raise.moment().id().as_str().to_owned(),
            session_id: source.session_id.to_string(),
            run_id: None,
            workflow_run_id: None,
            plan_id: None,
            node_id: None,
            attempt: None,
            execution_index: None,
            trigger: word_of(raise.trigger()),
            severity: word_of(raise.severity()),
            notice_text: None,
            source_event_id: source.event_id.to_owned(),
            created_at: source.occurred_at.to_owned(),
        };
        match raise {
            AttentionRaise::Wait {
                wait: AttentionWait::Run(run_id),
                ..
            }
            | AttentionRaise::End {
                end: AttentionEnd::Run(run_id),
                ..
            } => row.run_id = Some(run_id.to_string()),
            AttentionRaise::Wait {
                wait: AttentionWait::Plan(plan_id),
                ..
            } => row.plan_id = Some(plan_id.to_string()),
            AttentionRaise::Wait {
                wait: AttentionWait::Step(step),
                ..
            } => {
                row.workflow_run_id = Some(step.workflow_run_id.to_string());
                row.node_id = Some(step.node_id.as_str().to_owned());
                row.attempt = Some(i64::from(step.attempt));
                row.execution_index = Some(i64::from(step.execution_index));
            }
            AttentionRaise::End {
                end: AttentionEnd::WorkflowRun(workflow_run_id),
                ..
            } => row.workflow_run_id = Some(workflow_run_id.to_string()),
        }
        row
    }

    fn into_bindings(self) -> Vec<(Cow<'static, str>, Value)> {
        vec![
            binding("@id", Value::Text(self.id)),
            binding("@moment_id", Value::Text(self.moment_id)),
            binding("@session_id", Value::Text(self.session_id)),
            binding("@run_id", Value::from(self.run_id)),
            binding("@workflow_run_id", Value::from(self.workflow_run_id)),
            binding("@plan_id", Value::from(self.plan_id)),
            binding("@node_id", Value::from(self.node_id)),
            binding("@attempt", Value::from(self.attempt)),
            binding("@execution_index", Value::from(self.execution_index)),
            binding("@trigger", Value::Text(self.trigger)),
            binding("@severity", Value::Text(self.severity)),
            binding("@notice_text", Value::from(self.notice_text)),
            binding("@source_event_id", Value::Text(self.source_event_id)),
            binding("@created_at", Value::Text(self.created_at)),
        ]
    }
}

/// The statements `change` takes for the event `source`, the counts' bump first.
fn change_statements(change: &AttentionChange, source: &EventSource<'_>) -> Vec<WriteStatement> {
    let session = session_binding(source.session_id);
    match change {
        AttentionChange::Raise(raise) => vec![
            statement(&BUMP_ALWAYS_SQL, vec![session]),
            raise_statement(raise, source),
        ],
        AttentionChange::Resolve { entries, then } => {
            let (sql, open_entries) = match entries {
                AttentionOpenEntries::Run(run_id) => (
                    &*MOMENT_RESOLVE_SQL,
                    moment_bindings(AttentionMoment::Run(*run_id)),
                ),
                AttentionOpenEntries::Plan(plan_id) => (
                    &*MOMENT_RESOLVE_SQL,
                    moment_bindings(AttentionMoment::Plan(*plan_id)),
                ),
                AttentionOpenEntries::WorkflowRun(workflow_run_id) => (
                    &*MOMENT_RESOLVE_SQL,
                    moment_bindings(AttentionMoment::WorkflowRun(*workflow_run_id)),
                ),
                AttentionOpenEntries::Step(step) => (&*STEP_RESOLVE_SQL, step_bindings(step)),
            };
            let bump = match then {
                None => statement(&sql.bump, with(&open_entries, [session])),
                Some(AttentionRaise::End {
                    end: AttentionEnd::Run(run_id),
                    ..
                }) => statement(
                    &BUMP_IF_OPEN_OR_LEAD_RUN_SQL,
                    with(
                        &open_entries,
                        [session, binding("@run_id", Value::Text(run_id.to_string()))],
                    ),
                ),
                Some(_) => statement(&BUMP_ALWAYS_SQL, vec![session]),
            };
            let resolved_at = binding("@resolved_at", Value::Text(source.occurred_at.to_owned()));
            let mut statements = vec![
                bump,
                statement(&sql.withdraw, open_entries.clone()),
                statement(&sql.unmerge, open_entries.clone()),
                statement(&sql.resolve, with(&open_entries, [resolved_at])),
            ];
            statements.extend(then.iter().map(|raise| raise_statement(raise, source)));
            statements
        }
        AttentionChange::DeleteWorkflowRun(workflow_run_id) => {
            let workflow_run =
                binding("@workflow_run_id", Value::Text(workflow_run_id.to_string()));
            vec![
                statement(
                    &BUMP_IF_WORKFLOW_RUN_ENTRIES_SQL,
                    vec![session, workflow_run.clone()],
                ),
                statement(
                    DELETE_WORKFLOW_RUN_DELIVERIES_SQL,
                    vec![workflow_run.clone()],
                ),
                statement(DELETE_WORKFLOW_RUN_ENTRIES_SQL, vec![workflow_run]),
            ]
        }
        AttentionChange::WithdrawMuted(muted_session_id) => vec![
            statement(
                &BUMP_IF_MUTED_END_BANNERS_SQL,
                vec![session_binding(*muted_session_id)],
            ),
            statement(
                &WITHDRAW_MUTED_END_BANNERS_SQL,
                vec![session_binding(*muted_session_id)],
            ),
        ],
        AttentionChange::NameChanged(named_session_id) => vec![statement(
            &BUMP_IF_SESSION_ENTRIES_SQL,
            vec![session_binding(*named_session_id)],
        )],
        AttentionChange::Nothing => Vec::new(),
    }
}

/// The insert `raise` takes: a lead-run-only insert for an agent run's end.
fn raise_statement(raise: &AttentionRaise, source: &EventSource<'_>) -> WriteStatement {
    let sql = match raise {
        AttentionRaise::End {
            end: AttentionEnd::Run(_),
            ..
        } => &*INSERT_LEAD_RUN_END_SQL,
        AttentionRaise::Wait { .. }
        | AttentionRaise::End {
            end: AttentionEnd::WorkflowRun(_),
            ..
        } => &*INSERT_ENTRY_SQL,
    };
    statement(sql, EntryRow::raised(raise, source).into_bindings())
}

/// The bump of the machine's count, keyed `''`, and the session's, when `guard` holds before the
/// set's other statements run.
fn version_bump_sql(guard: &str) -> String {
    format!(
        "INSERT INTO attention_versions (scope_key, version)
  SELECT scope_key, 1 FROM (SELECT '' AS scope_key UNION ALL SELECT @session_id)
   WHERE {guard}
  ON CONFLICT (scope_key) DO UPDATE SET version = version + 1"
    )
}

fn raised_banner_states() -> String {
    format!(
        "'{}', '{}'",
        word_of(AttentionBannerState::Pending),
        word_of(AttentionBannerState::Posted)
    )
}

fn moment_bindings(moment: AttentionMoment) -> Vec<(Cow<'static, str>, Value)> {
    vec![binding(
        "@moment_id",
        Value::Text(moment.id().as_str().to_owned()),
    )]
}

fn step_bindings(step: &WorkflowStepKey) -> Vec<(Cow<'static, str>, Value)> {
    vec![
        binding(
            "@workflow_run_id",
            Value::Text(step.workflow_run_id.to_string()),
        ),
        binding("@node_id", Value::Text(step.node_id.as_str().to_owned())),
        binding("@attempt", Value::Integer(i64::from(step.attempt))),
        binding(
            "@execution_index",
            Value::Integer(i64::from(step.execution_index)),
        ),
    ]
}

fn session_binding(session_id: SessionId) -> (Cow<'static, str>, Value) {
    binding("@session_id", Value::Text(session_id.to_string()))
}

fn binding(name: &'static str, value: Value) -> (Cow<'static, str>, Value) {
    (Cow::Borrowed(name), value)
}

fn with<const COUNT: usize>(
    bindings: &[(Cow<'static, str>, Value)],
    more: [(Cow<'static, str>, Value); COUNT],
) -> Vec<(Cow<'static, str>, Value)> {
    bindings.iter().cloned().chain(more).collect()
}

fn statement(sql: &'static str, bindings: Vec<(Cow<'static, str>, Value)>) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: None,
    }
}

#[cfg(test)]
mod tests;
