//! What a step's moves do to its row: the statements the tick's commit writes in one unit of work
//! with the step events that record them, each keyed on the whole step key and refusing the write
//! unless it changes that one row.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::id::{UuidText, UuidTextForm};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowContentHash;
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::events::WorkflowReusedStep;
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowCost, WorkflowPayloadRef, WorkflowStepKey, WorkflowStepSource,
};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};

// The whole step key every statement but an insert matches its one row by.
const STEP_KEY_SQL: &str = "workflow_run_id = @workflow_run_id AND node_id = @node_id
    AND attempt = @attempt AND execution_index = @execution_index";

/// The assignments that empty every wait column of a step's row, which a statement moving a step
/// out of `waiting` sets in that same statement, so no CHECK on the wait columns refuses it.
pub(crate) const CLEAR_WAIT_COLUMNS_SQL: &str = "wait_cause = NULL, resume_at = NULL,
      wait_deadline_at = NULL, wait_account_id = NULL, wait_started_at = NULL, wait_id = NULL";

// A step the walk readied or skipped: its row is new, written at the event's instant.
const INSERT_STEP_SQL: &str = "INSERT INTO workflow_steps (workflow_run_id, node_id, attempt,
    execution_index, source_json, status, started_at, finished_at, input_ref, output_ref, log_ref,
    output_item_counts_json, pin_hash, reused_from_json)
  VALUES (@workflow_run_id, @node_id, @attempt, @execution_index, @source_json, @status,
    @started_at, @finished_at, @input_ref, @output_ref, @log_ref, @output_item_counts_json,
    @pin_hash, @reused_from_json)";

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

static RECORD_STEP_START_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE workflow_steps SET permission_level = @permission_level, pin_hash = @pin_hash
  WHERE {STEP_KEY_SQL}"
    )
});

static CANCEL_STEP_SQL: LazyLock<String> = LazyLock::new(|| {
    let canceled = <&'static str>::from(WorkflowStepStatus::Canceled);
    format!(
        "UPDATE workflow_steps
  SET status = '{canceled}', finished_at = @finished_at,
      total_pool_wait_ms = total_pool_wait_ms + @pool_wait_ms, {CLEAR_WAIT_COLUMNS_SQL}
  WHERE {STEP_KEY_SQL}"
    )
});

// Matches only while the step still holds the wait it is resumed from, so a resume of a wait the
// row no longer holds refuses its write.
static RESUME_STEP_SQL: LazyLock<String> = LazyLock::new(|| {
    let running = <&'static str>::from(WorkflowStepStatus::Running);
    let waiting = <&'static str>::from(WorkflowStepStatus::Waiting);
    format!(
        "UPDATE workflow_steps SET status = '{running}', {CLEAR_WAIT_COLUMNS_SQL}
  WHERE {STEP_KEY_SQL} AND status = '{waiting}' AND wait_id IS @wait_id"
    )
});

static SUCCEED_STEP_SQL: LazyLock<String> = LazyLock::new(|| {
    let succeeded = <&'static str>::from(WorkflowStepStatus::Succeeded);
    format!(
        "UPDATE workflow_steps
  SET status = '{succeeded}', finished_at = @finished_at, output_ref = @output_ref,
      output_item_counts_json = @output_item_counts_json, log_ref = @log_ref,
      cost_usd_micros = @cost_usd_micros, cost_account_id = @cost_account_id,
      {CLEAR_WAIT_COLUMNS_SQL}
  WHERE {STEP_KEY_SQL}"
    )
});

// A step passing its input on stores it as its output and its lists' lengths; any other failure
// keeps the empty output its pending row stored.
static FAIL_STEP_SQL: LazyLock<String> = LazyLock::new(|| {
    let failed = <&'static str>::from(WorkflowStepStatus::Failed);
    format!(
        "UPDATE workflow_steps
  SET status = '{failed}', finished_at = @finished_at, error_json = @error_json,
      decline_reason = @decline_reason, output_ref = COALESCE(@output_ref, output_ref),
      output_item_counts_json = COALESCE(@output_item_counts_json, output_item_counts_json),
      log_ref = @log_ref, total_pool_wait_ms = total_pool_wait_ms + @pool_wait_ms,
      {CLEAR_WAIT_COLUMNS_SQL}
  WHERE {STEP_KEY_SQL}"
    )
});

static WAIT_ON_PERSON_SQL: LazyLock<String> = LazyLock::new(|| {
    let waiting = <&'static str>::from(WorkflowStepStatus::Waiting);
    format!(
        "UPDATE workflow_steps
  SET status = '{waiting}', wait_cause = @wait_cause, wait_started_at = @wait_started_at,
      wait_deadline_at = @wait_deadline_at, wait_id = @wait_id, log_ref = @log_ref
  WHERE {STEP_KEY_SQL}"
    )
});

static WAIT_ON_ACCOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    let waiting = <&'static str>::from(WorkflowStepStatus::Waiting);
    let account = <&'static str>::from(WorkflowWaitCause::Account);
    format!(
        "UPDATE workflow_steps
  SET status = '{waiting}', wait_cause = '{account}', wait_account_id = @wait_account_id,
      wait_started_at = @wait_started_at, resume_at = @resume_at,
      total_pool_wait_ms = total_pool_wait_ms + @pool_wait_ms
  WHERE {STEP_KEY_SQL}"
    )
});

/// The row of `step`, readied with `sources` on `input_ref` at `started_at`, the instant of the
/// event whose write readied it: `pending`, with an empty output and log and no output lists.
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
        &[],
        (None, None),
    )
}

/// The row of `step`, skipped at `at` with `sources` on `input_ref`, passing `output_ref` on: a
/// disabled node's input, an empty list for a step whose input carried no items, or a reused
/// step's output, which holds `output_lengths` items on each main output in output order. A
/// reused skip stores the step it reused and the hash of that step's pin, each `None` elsewhere.
pub(crate) fn insert_skipped_step(
    step: &WorkflowStepKey,
    sources: &[Option<WorkflowStepSource>],
    input_ref: &WorkflowPayloadRef,
    output_ref: &WorkflowPayloadRef,
    output_lengths: &[usize],
    at: &WireInstant,
    (reused_from, pin_hash): (Option<&WorkflowReusedStep>, Option<&WorkflowContentHash>),
) -> WriteStatement {
    insert_step(
        step,
        sources,
        WorkflowStepStatus::Skipped,
        (at, Some(at)),
        [input_ref, output_ref, &empty_payload()],
        output_lengths,
        (reused_from, pin_hash),
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

/// Records on started `step` the level it runs at in place of its run's and the hash of the pin it
/// gave, each `None` where it has none.
pub(crate) fn record_step_start(
    step: &WorkflowStepKey,
    permission_level: Option<PermissionLevel>,
    pin_hash: Option<&WorkflowContentHash>,
) -> WriteStatement {
    keyed_statement(
        &RECORD_STEP_START_SQL,
        step,
        vec![
            nullable_text_binding(
                "@permission_level",
                permission_level.map(<&'static str>::from),
            ),
            nullable_text_binding("@pin_hash", pin_hash.map(|pin_hash| pin_hash.0.as_str())),
        ],
    )
}

/// Moves `step` to `canceled`, ended at `finished_at`, with every wait column emptied, adding
/// `pool_wait_ms`, the time a hold the cancel cut ran since its last report.
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

/// Moves `step` from `waiting` back to `running` with every wait column emptied, while it still
/// waits under `wait_id`, `None` for a wait with no id (a chain's question); the write is refused
/// at this statement when the row no longer holds that wait.
pub(crate) fn resume_step(
    step: &WorkflowStepKey,
    wait_id: Option<&UuidTextForm>,
) -> WriteStatement {
    let wait_id = wait_id.map(UuidTextForm::text);
    keyed_statement(
        &RESUME_STEP_SQL,
        step,
        vec![nullable_text_binding(
            "@wait_id",
            wait_id.as_ref().map(UuidText::as_str),
        )],
    )
}

/// Moves `step` to `succeeded` at `finished_at`, storing its output, joined from lists of
/// `output_lengths` items in output order, its log and `cost`, where a provider was billed, with
/// every wait column emptied.
pub(crate) fn succeed_step(
    step: &WorkflowStepKey,
    finished_at: &WireInstant,
    output_ref: &WorkflowPayloadRef,
    output_lengths: &[usize],
    log_ref: &WorkflowPayloadRef,
    cost: Option<&WorkflowCost>,
) -> WriteStatement {
    keyed_statement(
        &SUCCEED_STEP_SQL,
        step,
        vec![
            text_binding("@finished_at", finished_at.as_str()),
            (Cow::Borrowed("@output_ref"), payload_value(output_ref)),
            (
                Cow::Borrowed("@output_item_counts_json"),
                output_lengths_value(output_lengths),
            ),
            (Cow::Borrowed("@log_ref"), payload_value(log_ref)),
            (
                Cow::Borrowed("@cost_usd_micros"),
                cost.map_or(Value::Null, |cost| safe_integer(cost.usd_micros.0.get())),
            ),
            nullable_text_binding(
                "@cost_account_id",
                cost.map(|cost| cost.provider_account_id.as_str()),
            ),
        ],
    )
}

/// What a failed step's row stores beside its status.
pub(crate) struct FailedStepRow<'row> {
    /// When it failed.
    pub(crate) finished_at: &'row WireInstant,
    /// Its error.
    pub(crate) error: &'row WorkflowStepError,
    /// The words typed with the Decline that failed it.
    pub(crate) decline_reason: Option<&'row NonEmptyText>,
    /// The input it passed on as its output, beside how many items each of its output lists
    /// holds; `None` keeps the stored output.
    pub(crate) output: Option<(&'row WorkflowPayloadRef, &'row [usize])>,
    /// Its log.
    pub(crate) log_ref: &'row WorkflowPayloadRef,
    /// The time a hold the failure cut ran since its last report, in milliseconds.
    pub(crate) pool_wait_ms: u64,
}

/// Moves `step` to `failed` as `row` says, from wherever it stood, with every wait column emptied.
pub(crate) fn fail_step(step: &WorkflowStepKey, row: &FailedStepRow<'_>) -> WriteStatement {
    let error_json =
        serde_json::to_string(row.error).expect("a step error writes as JSON, holding only text");
    keyed_statement(
        &FAIL_STEP_SQL,
        step,
        vec![
            text_binding("@finished_at", row.finished_at.as_str()),
            text_binding("@error_json", &error_json),
            nullable_text_binding(
                "@decline_reason",
                row.decline_reason.map(NonEmptyText::as_str),
            ),
            (
                Cow::Borrowed("@output_ref"),
                row.output
                    .map_or(Value::Null, |(output_ref, _)| payload_value(output_ref)),
            ),
            (
                Cow::Borrowed("@output_item_counts_json"),
                row.output.map_or(Value::Null, |(_, output_lengths)| {
                    output_lengths_value(output_lengths)
                }),
            ),
            (Cow::Borrowed("@log_ref"), payload_value(row.log_ref)),
            pool_wait_binding(row.pool_wait_ms),
        ],
    )
}

/// Moves `step` to `waiting` on a person, the wait `wait_id` on `cause` since `started_at`, giving
/// up at `deadline_at` where one is set, storing the log it recorded before it waited.
pub(crate) fn wait_step_on_person(
    step: &WorkflowStepKey,
    cause: WorkflowWaitCause,
    wait_id: UuidTextForm,
    started_at: &WireInstant,
    deadline_at: Option<&WireInstant>,
    log_ref: &WorkflowPayloadRef,
) -> WriteStatement {
    keyed_statement(
        &WAIT_ON_PERSON_SQL,
        step,
        vec![
            text_binding("@wait_cause", <&'static str>::from(cause)),
            text_binding("@wait_started_at", started_at.as_str()),
            nullable_text_binding("@wait_deadline_at", deadline_at.map(WireInstant::as_str)),
            text_binding("@wait_id", wait_id.text().as_str()),
            (Cow::Borrowed("@log_ref"), payload_value(log_ref)),
        ],
    )
}

/// Moves `step` to `waiting` on the spent account `account_id` since `started_at`, resuming at
/// `resume_at` where one is armed, adding `pool_wait_ms`, the time a hold the wait cut ran since
/// its last report.
pub(crate) fn wait_step_on_account(
    step: &WorkflowStepKey,
    account_id: &ProviderAccountId,
    started_at: &WireInstant,
    resume_at: Option<&WireInstant>,
    pool_wait_ms: u64,
) -> WriteStatement {
    keyed_statement(
        &WAIT_ON_ACCOUNT_SQL,
        step,
        vec![
            text_binding("@wait_account_id", account_id.as_str()),
            text_binding("@wait_started_at", started_at.as_str()),
            nullable_text_binding("@resume_at", resume_at.map(WireInstant::as_str)),
            pool_wait_binding(pool_wait_ms),
        ],
    )
}

// The new row of `step` at `status`, started and finished at `instants`, storing `payloads`: its
// input, output and log, the output holding `output_lengths` items on each main output, and the
// step a reused skip reused with the hash of that step's pin.
fn insert_step(
    step: &WorkflowStepKey,
    sources: &[Option<WorkflowStepSource>],
    status: WorkflowStepStatus,
    (started_at, finished_at): (&WireInstant, Option<&WireInstant>),
    [input_ref, output_ref, log_ref]: [&WorkflowPayloadRef; 3],
    output_lengths: &[usize],
    (reused_from, pin_hash): (Option<&WorkflowReusedStep>, Option<&WorkflowContentHash>),
) -> WriteStatement {
    let source_json =
        serde_json::to_string(sources).expect("a step's sources write as JSON, holding only ids");
    let reused_from_json = reused_from.map(|reused_from| {
        serde_json::to_string(reused_from).expect("a reused step writes as JSON, holding only ids")
    });
    let mut bindings = vec![
        text_binding("@source_json", &source_json),
        text_binding("@status", <&'static str>::from(status)),
        text_binding("@started_at", started_at.as_str()),
        nullable_text_binding("@finished_at", finished_at.map(WireInstant::as_str)),
        (Cow::Borrowed("@input_ref"), payload_value(input_ref)),
        (Cow::Borrowed("@output_ref"), payload_value(output_ref)),
        (Cow::Borrowed("@log_ref"), payload_value(log_ref)),
        (
            Cow::Borrowed("@output_item_counts_json"),
            output_lengths_value(output_lengths),
        ),
        nullable_text_binding("@pin_hash", pin_hash.map(|pin_hash| pin_hash.0.as_str())),
        nullable_text_binding("@reused_from_json", reused_from_json.as_deref()),
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

fn output_lengths_value(output_lengths: &[usize]) -> Value {
    Value::Text(serde_json::to_string(output_lengths).expect("a list of lengths writes as JSON"))
}

fn empty_payload() -> WorkflowPayloadRef {
    WorkflowPayloadRef::Inline { items: Vec::new() }
}
