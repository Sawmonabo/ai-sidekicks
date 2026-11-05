//! What a step's moves do to its row: the statements the tick's commit writes in one unit of work
//! with the step events that record them, each keyed on the whole step key and refusing the write
//! unless it changes that one row.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowPayloadRef, WorkflowStepKey, WorkflowStepSource,
};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};

// The whole step key every statement but an insert matches its one row by.
const STEP_KEY_SQL: &str = "workflow_run_id = @workflow_run_id AND node_id = @node_id
    AND attempt = @attempt AND execution_index = @execution_index";

// A step the walk readied or skipped: its row is new, written at the event's instant.
const INSERT_STEP_SQL: &str = "INSERT INTO workflow_steps (workflow_run_id, node_id, attempt,
    execution_index, source_json, status, started_at, finished_at, input_ref, output_ref, log_ref)
  VALUES (@workflow_run_id, @node_id, @attempt, @execution_index, @source_json, @status,
    @started_at, @finished_at, @input_ref, @output_ref, @log_ref)";

static HOLD_STEP_SQL: LazyLock<String> = LazyLock::new(|| {
    let waiting_memory = <&'static str>::from(WorkflowStepStatus::WaitingMemory);
    format!("UPDATE workflow_steps SET status = '{waiting_memory}' WHERE {STEP_KEY_SQL}")
});

static ADD_POOL_WAIT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE workflow_steps SET total_pool_wait_ms = total_pool_wait_ms + @pool_wait_ms
  WHERE {STEP_KEY_SQL}"
    )
});

static ADMIT_STEP_SQL: LazyLock<String> = LazyLock::new(|| {
    let running = <&'static str>::from(WorkflowStepStatus::Running);
    format!(
        "UPDATE workflow_steps
  SET status = '{running}', total_pool_wait_ms = total_pool_wait_ms + @pool_wait_ms
  WHERE {STEP_KEY_SQL}"
    )
});

static SET_PERMISSION_LEVEL_SQL: LazyLock<String> = LazyLock::new(|| {
    format!("UPDATE workflow_steps SET permission_level = @permission_level WHERE {STEP_KEY_SQL}")
});

static CANCEL_STEP_SQL: LazyLock<String> = LazyLock::new(|| {
    let canceled = <&'static str>::from(WorkflowStepStatus::Canceled);
    format!(
        "UPDATE workflow_steps
  SET status = '{canceled}', finished_at = @finished_at,
      total_pool_wait_ms = total_pool_wait_ms + @pool_wait_ms
  WHERE {STEP_KEY_SQL}"
    )
});

/// The row of `step`, readied with `sources` on `input_ref` at `started_at`, the instant of the
/// event whose write readied it: `pending`, with an empty output and log.
pub(crate) fn insert_pending_step(
    step: &WorkflowStepKey,
    sources: &[Option<WorkflowStepSource>],
    input_ref: &WorkflowPayloadRef,
    started_at: &WireInstant,
) -> WriteStatement {
    insert_step(
        step,
        sources,
        WorkflowStepStatus::Pending,
        (started_at, None),
        [input_ref, &empty_payload(), &empty_payload()],
    )
}

/// The row of `step`, skipped at `at` with `sources` on `input_ref`, passing `output_ref` on: a
/// disabled node's input, or an empty list for a step whose input carried no items.
pub(crate) fn insert_skipped_step(
    step: &WorkflowStepKey,
    sources: &[Option<WorkflowStepSource>],
    input_ref: &WorkflowPayloadRef,
    output_ref: &WorkflowPayloadRef,
    at: &WireInstant,
) -> WriteStatement {
    insert_step(
        step,
        sources,
        WorkflowStepStatus::Skipped,
        (at, Some(at)),
        [input_ref, output_ref, &empty_payload()],
    )
}

/// Moves `step` to `waitingMemory`, the memory gate's hold.
pub(crate) fn hold_step(step: &WorkflowStepKey) -> WriteStatement {
    keyed_statement(&HOLD_STEP_SQL, step, Vec::new())
}

/// Adds `pool_wait_ms` to `step`'s pool wait, a held step's time since its hold's last report.
pub(crate) fn add_step_pool_wait(step: &WorkflowStepKey, pool_wait_ms: u64) -> WriteStatement {
    keyed_statement(
        &ADD_POOL_WAIT_SQL,
        step,
        vec![pool_wait_binding(pool_wait_ms)],
    )
}

/// Moves `step` to `running`, admitted, adding `pool_wait_ms`, its hold's time since that hold's
/// last report.
pub(crate) fn admit_step(step: &WorkflowStepKey, pool_wait_ms: u64) -> WriteStatement {
    keyed_statement(&ADMIT_STEP_SQL, step, vec![pool_wait_binding(pool_wait_ms)])
}

/// Records on `step` the level it runs at in place of its run's.
pub(crate) fn set_step_permission_level(
    step: &WorkflowStepKey,
    permission_level: PermissionLevel,
) -> WriteStatement {
    keyed_statement(
        &SET_PERMISSION_LEVEL_SQL,
        step,
        vec![text_binding(
            "@permission_level",
            <&'static str>::from(permission_level),
        )],
    )
}

/// Moves `step` to `canceled`, ended at `finished_at`, adding `pool_wait_ms`, the time a hold the
/// cancel cut ran since its last report.
pub(crate) fn cancel_step(
    step: &WorkflowStepKey,
    finished_at: &WireInstant,
    pool_wait_ms: u64,
) -> WriteStatement {
    keyed_statement(
        &CANCEL_STEP_SQL,
        step,
        vec![
            text_binding("@finished_at", finished_at.as_str()),
            pool_wait_binding(pool_wait_ms),
        ],
    )
}

// The new row of `step` at `status`, started and finished at `instants`, storing `payloads`: its
// input, output and log.
fn insert_step(
    step: &WorkflowStepKey,
    sources: &[Option<WorkflowStepSource>],
    status: WorkflowStepStatus,
    (started_at, finished_at): (&WireInstant, Option<&WireInstant>),
    [input_ref, output_ref, log_ref]: [&WorkflowPayloadRef; 3],
) -> WriteStatement {
    let source_json =
        serde_json::to_string(sources).expect("a step's sources write as JSON, holding only ids");
    let mut bindings = vec![
        text_binding("@source_json", &source_json),
        text_binding("@status", <&'static str>::from(status)),
        text_binding("@started_at", started_at.as_str()),
        nullable_text_binding("@finished_at", finished_at.map(WireInstant::as_str)),
        (Cow::Borrowed("@input_ref"), payload_value(input_ref)),
        (Cow::Borrowed("@output_ref"), payload_value(output_ref)),
        (Cow::Borrowed("@log_ref"), payload_value(log_ref)),
    ];
    bindings.extend(step_key_bindings(step));
    WriteStatement {
        sql: Cow::Borrowed(INSERT_STEP_SQL),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: Some(1),
    }
}

// `sql` on the one row of `step`, binding `bindings` beside the step key.
fn keyed_statement(
    sql: &'static LazyLock<String>,
    step: &WorkflowStepKey,
    mut bindings: Vec<(Cow<'static, str>, Value)>,
) -> WriteStatement {
    bindings.extend(step_key_bindings(step));
    WriteStatement {
        sql: Cow::Borrowed(sql.as_str()),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: Some(1),
    }
}

fn step_key_bindings(step: &WorkflowStepKey) -> [(Cow<'static, str>, Value); 4] {
    [
        text_binding("@workflow_run_id", step.workflow_run_id.text().as_str()),
        text_binding("@node_id", step.node_id.as_str()),
        (Cow::Borrowed("@attempt"), safe_integer(step.attempt.get())),
        (
            Cow::Borrowed("@execution_index"),
            safe_integer(step.execution_index.get()),
        ),
    ]
}

fn pool_wait_binding(pool_wait_ms: u64) -> (Cow<'static, str>, Value) {
    // No hold runs for the 292 million years past which the milliseconds overflow the column.
    (
        Cow::Borrowed("@pool_wait_ms"),
        Value::Integer(i64::try_from(pool_wait_ms).unwrap_or(i64::MAX)),
    )
}

fn safe_integer(value: u64) -> Value {
    Value::Integer(i64::try_from(value).expect("a safe integer fits in an i64"))
}

fn payload_value(payload: &WorkflowPayloadRef) -> Value {
    Value::Text(
        serde_json::to_string(payload)
            .expect("a payload ref writes as JSON, its items being JSON values"),
    )
}

fn empty_payload() -> WorkflowPayloadRef {
    WorkflowPayloadRef::Inline { items: Vec::new() }
}
