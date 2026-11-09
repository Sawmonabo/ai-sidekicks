//! A chain's question and its `Keep going`: once a chain has started as many runs as the person
//! allows, the engine asks once, on the chain's first run and in that run's session, under the
//! first run's own id as its wait. `Keep going` marks the first run kept going, appends the
//! answer's row and resumes every step held behind the question, with each held run's status
//! move, in one write across every session those runs live in.

use std::borrow::Cow;
use std::sync::LazyLock;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::ComposedText;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowName, WorkflowVersionId,
};
use sidekicks_contracts::workflow::run::gate_resolution::WorkflowGateKind;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_platforms::HourField;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{safe_int_column, text_column};
use tokio::sync::oneshot;

use crate::engine::ports::WorkflowApprovalCardRequest;
use crate::engine::tick::commit::RunTurnCommit;
use crate::engine::waits::{PersonWaitRefusal, step_key};
use crate::runs::gate_resolution::{RunEventKeys, WorkflowGateAnswer, gate_resolution_statement};

/// What a chain's question names, read from the chain's first run.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
pub(crate) struct ChainQuestion {
    /// The chain's first run, which asks.
    pub(crate) root: WorkflowRunId,
    /// The first run's session, definition and version.
    pub(crate) keys: RunEventKeys,
    /// The name of the workflow the first run pins.
    pub(crate) workflow_name: WorkflowName,
    /// The runs the chain has started, the first run included.
    pub(crate) run_count: SafeInt<1>,
    /// When the first run started.
    pub(crate) started_at: Timestamp,
}

/// A step held behind its chain's question, and the session its run lives in.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
pub(crate) struct ChainHeldStep {
    /// The session of the step's run.
    pub(crate) session_id: SessionId,
    /// The step.
    pub(crate) step: WorkflowStepKey,
}

/// An answer that keeps its chain going: an approval of the chain's question on the chain's first
/// run, the only answer [`keep_going_statements`] takes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct KeepGoingAnswer(WorkflowGateAnswer);

/// Why an answer cannot keep its chain going.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
pub(crate) enum KeepGoingRefusal {
    /// The answer stops the chain rather than keeping it going.
    #[error("the answer does not approve the chain's question")]
    Rejected,
    /// The answer is on a run other than the chain's first.
    #[error("the answer is not on the chain's first run")]
    AnotherRun,
    /// The answer is to an approval step, not to the chain's question.
    #[error("the answer is not to the chain's question")]
    ApprovalStep,
}

impl KeepGoingAnswer {
    /// `answer` as the `Keep going` of the chain whose first run is `root`. Refused unless it is
    /// on `root`, answers the chain's question and approves it.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the start's handlers and the tick, which ask and answer a chain's question"
        )
    )]
    pub(crate) fn new(
        root: &WorkflowRunId,
        answer: WorkflowGateAnswer,
    ) -> Result<Self, KeepGoingRefusal> {
        if answer.workflow_run_id != *root {
            return Err(KeepGoingRefusal::AnotherRun);
        }
        if answer.gate != WorkflowGateKind::Chain {
            return Err(KeepGoingRefusal::ApprovalStep);
        }
        if answer.outcome != ApprovalDecision::Approved {
            return Err(KeepGoingRefusal::Rejected);
        }
        Ok(Self(answer))
    }

    /// The chain's first run, which the answer is on.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the start's handlers and the tick, which ask and answer a chain's question"
        )
    )]
    pub(crate) fn root(&self) -> WorkflowRunId {
        self.0.workflow_run_id
    }
}

/// A `Keep going` as the tick's inbox takes it: the answer, when it was given, and where the tick
/// replies once its write commits, or refused because the chain has no question left to answer.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
pub(crate) struct KeepGoingIntake {
    /// The answer that keeps the chain going.
    pub(crate) answer: KeepGoingAnswer,
    /// When the person answered.
    pub(crate) at: WireInstant,
    /// Where the tick replies.
    pub(crate) reply: oneshot::Sender<Result<(), PersonWaitRefusal>>,
}

/// Where the kept-going update sits among [`keep_going_statements`]; a refusal there means the
/// chain has no question left to answer, which answers `workflow.step.notWaiting`.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
pub(crate) const KEEP_GOING_STATEMENT_INDEX: usize = 0;

// Only a first run holds a count, so another run's id matches nothing.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
const CHAIN_QUESTION_SQL: &str = "SELECT run.session_id, version.definition_id,
    run.workflow_version_id, json_extract(version.definition_body, '$.name'),
    run.chain_run_count, run.started_at
  FROM workflow_runs AS run
  JOIN workflow_versions AS version ON version.id = run.workflow_version_id
  WHERE run.id = @root AND run.chain_run_count IS NOT NULL";

// A chain answered once is not answered again: the second answer matches no row.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
const KEEP_GOING_SQL: &str = "UPDATE workflow_runs SET chain_kept_going = 1
  WHERE id = @root AND chain_run_count IS NOT NULL AND chain_kept_going = 0";

// Execution indexes count per run, so the run's id breaks a tie between runs started together.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
static CHAIN_HELD_STEPS_SQL: LazyLock<String> = LazyLock::new(|| {
    let waiting = <&'static str>::from(WorkflowStepStatus::Waiting);
    let chain = <&'static str>::from(WorkflowWaitCause::Chain);
    format!(
        "SELECT step.workflow_run_id, step.node_id, step.attempt, step.execution_index,
    run.session_id
  FROM workflow_runs AS run
  JOIN workflow_steps AS step ON step.workflow_run_id = run.id
  WHERE run.chain_root_run_id = @root
    AND step.status = '{waiting}' AND step.wait_cause = '{chain}'
  ORDER BY run.started_at, run.id, step.execution_index"
    )
});

/// The wait a chain's question is asked under: its first run's own id, so a card raised again
/// after a restart is the same card.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
pub(crate) fn chain_wait_id(root: &WorkflowRunId) -> UuidTextForm {
    UuidTextForm::new(root.text().as_str()).expect("a run id is a UUID in its text form")
}

/// What the question of the chain whose first run is `root` names; `None` when `root` is not a
/// stored first run. Fails when the read fails or a stored value does not read as its type.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
pub(crate) fn read_chain_question(
    connection: &Connection,
    root: &WorkflowRunId,
) -> rusqlite::Result<Option<ChainQuestion>> {
    connection
        .prepare_cached(CHAIN_QUESTION_SQL)?
        .query_row(named_params! { "@root": root.text().as_str() }, |row| {
            Ok(ChainQuestion {
                root: *root,
                keys: RunEventKeys {
                    session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                    definition_id: text_column(row, 1, |text| WorkflowDefinitionId::new(&text))?,
                    workflow_version_id: text_column(row, 2, |text| WorkflowVersionId::new(&text))?,
                },
                workflow_name: text_column(row, 3, |text| {
                    WorkflowName::new(text).ok_or(StoredNameOutOfBounds)
                })?,
                run_count: safe_int_column(row, 4)?,
                started_at: text_column(row, 5, |text| text.parse::<Timestamp>())?,
            })
        })
        .optional()
}

/// A stored workflow name that is empty or longer than a name may be.
#[derive(Debug, thiserror::Error)]
#[error("a stored workflow name is empty or longer than a name may be")]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
struct StoredNameOutOfBounds;

/// The question's words: the workflow's name, the runs counted with thousands separators and the
/// first run's start in `time_zone`, its hour written as `hour_field` says, both the machine's.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
pub(crate) fn chain_question_prompt(
    question: &ChainQuestion,
    time_zone: &TimeZone,
    hour_field: HourField,
) -> ComposedText {
    let started_at = question.started_at.to_zoned(time_zone.clone());
    let start = hour_field.time_of_day(started_at.hour(), started_at.minute());
    ComposedText::new(format!(
        "{name} has started {count} runs from its {start} start. Keep going?",
        name = question.workflow_name.as_str(),
        count = grouped_thousands(question.run_count.get()),
    ))
    .expect("the question holds its fixed words")
}

// `count` with a comma between each group of three digits: 2,000.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
fn grouped_thousands(count: u64) -> String {
    let digits = count.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (position, digit) in digits.chars().enumerate() {
        if position > 0 && (digits.len() - position).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// The card that asks `question` as `prompt`, raised on the chain's first run, in its session and
/// under [`chain_wait_id`]; it names no step, since the question belongs to the run.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
pub(crate) fn chain_card_request(
    question: &ChainQuestion,
    prompt: ComposedText,
) -> WorkflowApprovalCardRequest {
    WorkflowApprovalCardRequest {
        session_id: question.keys.session_id,
        run_id: question.root,
        step: None,
        wait_id: chain_wait_id(&question.root),
        prompt,
    }
}

/// The statements of `Keep going`: the chain's first run, the run `answer` is on, reads kept going,
/// and `answer`'s row is appended. The write is refused at [`KEEP_GOING_STATEMENT_INDEX`] when that
/// run is no first run or its chain was already answered.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
pub(crate) fn keep_going_statements(answer: &KeepGoingAnswer) -> Vec<WriteStatement> {
    let KeepGoingAnswer(answer) = answer;
    vec![
        WriteStatement {
            sql: Cow::Borrowed(KEEP_GOING_SQL),
            bindings: StatementBindings::Named(vec![text_binding(
                "@root",
                answer.workflow_run_id.text().as_str(),
            )]),
            expected_row_count: Some(1),
        },
        gate_resolution_statement(answer),
    ]
}

/// The steps held behind the question of the chain whose first run is `root`, by their run's start
/// and then their execution index, through the chain's index. The caller writes one
/// `workflow.phase.resumed` per step, and the event of each run's new status, in the write that
/// answers `Keep going`. Fails when the read fails or a stored value does not read as its type.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
pub(crate) fn read_chain_held_steps(
    connection: &Connection,
    root: &WorkflowRunId,
) -> rusqlite::Result<Vec<ChainHeldStep>> {
    connection
        .prepare_cached(&CHAIN_HELD_STEPS_SQL)?
        .query_map(named_params! { "@root": root.text().as_str() }, |row| {
            Ok(ChainHeldStep {
                session_id: text_column(row, 4, |text| SessionId::new(&text))?,
                step: step_key(row)?,
            })
        })?
        .collect()
}

/// Keep going's write of `answer` at `at` over `commits`, one fresh turn of each run it touches,
/// the chain's first run's among them: the first run's turn first, holding the kept-going update
/// and the answer's row ahead of every other statement and `workflow.gate.resolved` with no node,
/// then each of `held` resumed in its run's turn. Each turn's status move is drafted as it
/// commits; the caller commits them together with [`RunTurnCommit::append_together`], whose
/// refusal at [`KEEP_GOING_STATEMENT_INDEX`] means the chain has no question left to answer.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start's handlers and the tick, which ask and answer a chain's question"
    )
)]
pub(crate) fn keep_going_write(
    answer: &KeepGoingAnswer,
    mut commits: Vec<RunTurnCommit>,
    held: &[ChainHeldStep],
    at: &WireInstant,
) -> Vec<RunTurnCommit> {
    let KeepGoingAnswer(gate) = answer;
    let root = commits
        .iter()
        .position(|commit| commit.run_id() == gate.workflow_run_id)
        .expect("the chain's first run has its turn");
    commits[..=root].rotate_right(1);
    commits[0].answer_gate(gate, keep_going_statements(answer), at);
    for held_step in held {
        commits
            .iter_mut()
            .find(|commit| commit.run_id() == held_step.step.workflow_run_id)
            .expect("each held step's run has its turn")
            .resume_step(&held_step.step, None, WorkflowWaitCause::Chain, at);
    }
    commits
}

#[cfg(test)]
mod tests {
    use jiff::tz::TimeZone;
    use rstest::rstest;
    use rusqlite::Connection;
    use sidekicks_contracts::approval::ApprovalDecision;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::UuidTextForm;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
    use sidekicks_contracts::workflow::run::gate_resolution::WorkflowGateKind;
    use sidekicks_contracts::workflow::run::id::WorkflowRunId;
    use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
    use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
    use sidekicks_platforms::{HourCycle, HourField};
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};

    use super::{
        ChainHeldStep, KEEP_GOING_STATEMENT_INDEX, KeepGoingAnswer, KeepGoingRefusal,
        chain_card_request, chain_question_prompt, keep_going_statements, read_chain_held_steps,
        read_chain_question,
    };
    use crate::runs::gate_resolution::tests::gate_answer;
    use crate::schema::schema_parts;
    use crate::test_rows::{
        TEST_NODE_ID, TEST_SESSION_ID, TestStep, insert_chain_run, insert_step,
        insert_workflow_version, workflow_tables,
    };

    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e80";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e81";
    const ROOT_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e82";
    const FIRST_JOINED_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e83";
    const SECOND_JOINED_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e84";
    const OTHER_ROOT_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e85";

    fn run_id(text: &str) -> WorkflowRunId {
        WorkflowRunId::new(text).expect("the test's run id")
    }

    fn insert_waiting_step(
        rows: &Connection,
        run: &str,
        execution_index: u32,
        cause: WorkflowWaitCause,
    ) {
        insert_step(
            rows,
            run,
            &TestStep {
                execution_index,
                status: WorkflowStepStatus::Waiting,
                wait_cause: Some(cause),
                wait_account_id: None,
                resume_at: None,
            },
        );
    }

    fn held_step(run: &str, execution_index: u64) -> ChainHeldStep {
        ChainHeldStep {
            session_id: SessionId::new(TEST_SESSION_ID).expect("the test's session"),
            step: WorkflowStepKey {
                workflow_run_id: run_id(run),
                node_id: WorkflowNodeId::new(TEST_NODE_ID.to_owned()).expect("the test's node"),
                attempt: SafeInt::new(1).expect("a first attempt"),
                execution_index: SafeInt::new(execution_index).expect("an execution index"),
            },
        }
    }

    // Each stored answer's sequence, node, gate kind, category and outcome.
    type GateRow = (i64, Option<String>, String, Option<String>, String);

    fn gate_rows(rows: &Connection) -> Vec<GateRow> {
        rows.prepare(
            "SELECT sequence, node_id, gate_kind, approval_category, outcome \
             FROM workflow_gate_resolutions ORDER BY rowid",
        )
        .expect("the test reads the answers")
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .expect("the test reads the answers")
        .collect::<rusqlite::Result<_>>()
        .expect("the answers read")
    }

    // The `Keep going` of the test chain's first run, its answer id ending in `id_suffix`.
    fn keep_going(id_suffix: u8) -> KeepGoingAnswer {
        KeepGoingAnswer::new(
            &run_id(ROOT_RUN_ID),
            gate_answer(
                ROOT_RUN_ID,
                id_suffix,
                WorkflowGateKind::Chain,
                ApprovalDecision::Approved,
            ),
        )
        .expect("the first run's approval keeps its chain going")
    }

    /// Mutation: drop the outcome check, so `Stop them all` marks the chain kept going; or drop
    /// either of the other two checks, so another run's or an approval step's answer does.
    #[rstest]
    #[case::a_rejection(
        ROOT_RUN_ID,
        WorkflowGateKind::Chain,
        ApprovalDecision::Rejected,
        KeepGoingRefusal::Rejected
    )]
    #[case::another_run(
        FIRST_JOINED_RUN_ID,
        WorkflowGateKind::Chain,
        ApprovalDecision::Approved,
        KeepGoingRefusal::AnotherRun
    )]
    #[case::an_approval_step(
        ROOT_RUN_ID,
        WorkflowGateKind::HumanApproval,
        ApprovalDecision::Approved,
        KeepGoingRefusal::ApprovalStep
    )]
    fn only_the_first_runs_approval_of_its_question_keeps_a_chain_going(
        #[case] answer_run_id: &str,
        #[case] gate: WorkflowGateKind,
        #[case] outcome: ApprovalDecision,
        #[case] expected: KeepGoingRefusal,
    ) {
        assert_eq!(
            KeepGoingAnswer::new(
                &run_id(ROOT_RUN_ID),
                gate_answer(answer_run_id, 1, gate, outcome)
            ),
            Err(expected)
        );
    }

    /// Mutations: drop the update's `chain_kept_going = 0`, so a second answer is taken and
    /// appends a second row; drop the held read's chain filter, so another chain's step is read;
    /// write the chain's row with a node, which the row's check refuses.
    #[tokio::test]
    async fn keep_going_answers_a_chain_once_and_finds_every_held_step() {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens the test database");
        let rows = database.reader();
        insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Summarize folder");
        insert_chain_run(
            &rows,
            ROOT_RUN_ID,
            VERSION_ID,
            TEST_SESSION_ID,
            "2026-10-02T02:00:00.000Z",
            None,
        );
        rows.execute(
            "UPDATE workflow_runs SET chain_run_count = 100 WHERE id = ?1",
            [ROOT_RUN_ID],
        )
        .expect("the test counts the chain's runs");
        insert_chain_run(
            &rows,
            FIRST_JOINED_RUN_ID,
            VERSION_ID,
            TEST_SESSION_ID,
            "2026-10-02T02:01:00.000Z",
            Some(ROOT_RUN_ID),
        );
        insert_chain_run(
            &rows,
            SECOND_JOINED_RUN_ID,
            VERSION_ID,
            TEST_SESSION_ID,
            "2026-10-02T02:02:00.000Z",
            Some(ROOT_RUN_ID),
        );
        insert_waiting_step(&rows, FIRST_JOINED_RUN_ID, 2, WorkflowWaitCause::Chain);
        insert_waiting_step(&rows, SECOND_JOINED_RUN_ID, 0, WorkflowWaitCause::Chain);
        insert_waiting_step(&rows, SECOND_JOINED_RUN_ID, 1, WorkflowWaitCause::Approval);
        insert_chain_run(
            &rows,
            OTHER_ROOT_RUN_ID,
            VERSION_ID,
            TEST_SESSION_ID,
            "2026-10-02T01:00:00.000Z",
            None,
        );
        insert_waiting_step(&rows, OTHER_ROOT_RUN_ID, 0, WorkflowWaitCause::Chain);
        let root = run_id(ROOT_RUN_ID);

        writer
            .write(keep_going_statements(&keep_going(1)))
            .await
            .expect("the chain's first answer commits");
        let second = writer.write(keep_going_statements(&keep_going(2))).await;

        let kept_going: i64 = rows
            .query_row(
                "SELECT chain_kept_going FROM workflow_runs WHERE id = ?1",
                [ROOT_RUN_ID],
                |row| row.get(0),
            )
            .expect("the test reads the first run");
        assert_eq!(kept_going, 1);
        assert!(matches!(
            second,
            Err(WriteError::Refused {
                statement_index: KEEP_GOING_STATEMENT_INDEX,
                row_count: 0
            })
        ));
        assert_eq!(
            gate_rows(&rows),
            vec![(
                1,
                None,
                "chain".to_owned(),
                Some("gate".to_owned()),
                "approved".to_owned()
            )]
        );
        assert_eq!(
            read_chain_held_steps(&rows, &root).expect("the held steps read"),
            vec![
                held_step(FIRST_JOINED_RUN_ID, 2),
                held_step(SECOND_JOINED_RUN_ID, 0),
            ]
        );
    }

    /// Mutations: write the start in UTC, write it on a clock other than the field's, drop the
    /// thousands separator, or ask under a wait id other than the first run's own.
    #[test]
    fn the_chain_question_names_the_first_run_and_its_start_in_the_machines_clock() {
        let rows = workflow_tables();
        insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Nightly sync");
        insert_chain_run(
            &rows,
            ROOT_RUN_ID,
            VERSION_ID,
            TEST_SESSION_ID,
            "2026-10-02T10:00:00Z",
            None,
        );
        rows.execute(
            "UPDATE workflow_runs SET chain_run_count = 2000 WHERE id = ?1",
            [ROOT_RUN_ID],
        )
        .expect("the test counts the chain's runs");
        let root = run_id(ROOT_RUN_ID);
        let time_zone = TimeZone::get("America/Los_Angeles").expect("the zone database knows LA");

        let question = read_chain_question(&rows, &root)
            .expect("the question reads")
            .expect("the first run asks");
        let request = chain_card_request(
            &question,
            chain_question_prompt(
                &question,
                &time_zone,
                HourField {
                    cycle: HourCycle::H23,
                    is_padded: true,
                },
            ),
        );

        assert_eq!(
            request.prompt.as_str(),
            "Nightly sync has started 2,000 runs from its 03:00 start. Keep going?"
        );
        assert_eq!(
            request.wait_id,
            UuidTextForm::new(ROOT_RUN_ID).expect("the root's id")
        );
        assert_eq!(request.run_id, root);
        assert_eq!(request.step, None);
    }
}
