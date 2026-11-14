//! The run controls over runs the tick does not hold, and the tick's refusals as the caller reads
//! them: each answer checked on the rows and events it leaves.

use std::sync::Arc;

use rstest::rstest;
use rusqlite::Connection;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::workflow::run::control::WorkflowCancelReason;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{
    WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
};
use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::EVENT_LOG_STATEMENT_CAPACITY;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_workspace::run_setup_gates::execution_root::context::SessionRunBinder;
use tokio::sync::mpsc;

use super::{WorkflowRunControlError, WorkflowRunControls};
use crate::engine::event_record::EngineRecorder;
use crate::engine::ports::noticed_sessions::NoticedSessions;
use crate::engine::ports::withdrawn_cards::WithdrawnCards;
use crate::engine::ports::{ApprovalCardRaiser, KeptEngineRecords};
use crate::engine::tick::{EngineTickInput, RepinRefusal, RunCancelRefusal, RunResumeRefusal};
use crate::schema::schema_parts;
use crate::test_rows::{
    TEST_SESSION_ID, TestStep, insert_chain_run, insert_run, insert_step, insert_workflow_version,
    stored_rows, test_node_id,
};

const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e60";
const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e61";
const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e62";
const LATER_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e63";
const ENDED_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e64";
const OTHER_CHAIN_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e65";
const STARTED: &str = "2026-10-02T00:00:00.000Z";
const ENDED: &str = "2026-10-02T00:05:00.000Z";

/// The controls over a test database holding one workflow version, a tick that answers every
/// cancel `cancel` and its one Resume `resume`, the binder they tell and the cards they withdraw.
struct ControlsTest {
    run_controls: WorkflowRunControls,
    rows: Connection,
    notices: Arc<NoticedSessions>,
    cards: Arc<WithdrawnCards>,
    _database: TestDatabase,
}

impl ControlsTest {
    async fn new(cancel: RunCancelRefusal, resume: RunResumeRefusal) -> Self {
        let database = TestDatabase::new(schema_parts());
        let TestLog { service, .. } = open_log(&database, None).await;
        let pool = Arc::new(DatabaseReadPool::new(
            database.path(),
            EVENT_LOG_STATEMENT_CAPACITY,
        ));
        let rows = database.reader();
        insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Nightly");
        let notices = Arc::new(NoticedSessions::default());
        let binder = Arc::clone(&notices) as Arc<dyn SessionRunBinder>;
        let cards = Arc::new(WithdrawnCards::default());
        let run_controls = WorkflowRunControls::new(
            refusing_tick(cancel, resume),
            pool,
            service,
            binder,
            Arc::clone(&cards) as Arc<dyn ApprovalCardRaiser>,
            Arc::new(EngineRecorder::new(Arc::new(KeptEngineRecords::default()))),
        );
        Self {
            run_controls,
            rows,
            notices,
            cards,
            _database: database,
        }
    }
}

/// A tick's inbox that answers every cancel `cancel` and its one Resume `resume`.
fn refusing_tick(
    cancel: RunCancelRefusal,
    resume: RunResumeRefusal,
) -> mpsc::Sender<EngineTickInput> {
    let (inbox, mut inputs) = mpsc::channel(8);
    let mut resume = Some(resume);
    tokio::spawn(async move {
        while let Some(input) = inputs.recv().await {
            match input {
                EngineTickInput::Cancel(intake) => {
                    let _unheard = intake.reply.send(Err(cancel));
                }
                EngineTickInput::Resume(intake) => {
                    let refusal = resume.take().expect("the test resumes once");
                    let _unheard = intake.reply.send(Err(refusal));
                }
                EngineTickInput::Started(_)
                | EngineTickInput::Answer(_)
                | EngineTickInput::KeepGoing(_)
                | EngineTickInput::TakeBack(_)
                | EngineTickInput::RunLimitChanged => panic!("the controls send only controls"),
            }
        }
    });
    inbox
}

fn run_id(id: &str) -> WorkflowRunId {
    WorkflowRunId::new(id).expect("the test's run id")
}

/// The code of `refused`, a refusal.
fn refusal_code<Answer: std::fmt::Debug>(
    refused: Result<Answer, WorkflowRunControlError>,
) -> RefusalCode {
    match refused {
        Err(WorkflowRunControlError::Refused(refusal)) => refusal.code,
        other => panic!("a refusal, not {other:?}"),
    }
}

/// Each event of the log, as its id, type and payload, in sequence order.
fn events(rows: &Connection) -> Vec<(String, String, Value)> {
    rows.prepare("SELECT id, type, payload FROM session_events ORDER BY sequence")
        .expect("the test reads the log")
        .query_map([], |row| {
            let payload: String = row.get(2)?;
            Ok((
                row.get(0)?,
                row.get(1)?,
                serde_json::from_str(&payload).expect("a payload is JSON"),
            ))
        })
        .expect("the test reads the log")
        .collect::<rusqlite::Result<_>>()
        .expect("the log reads")
}

/// A cancel of a going run the tick does not hold writes `workflow.run.canceled`, with the
/// person's reason and the error carrying it, then `question.wait.settled` `ended` for its reply
/// wait, then a chat run's results, in one write that ends the run's row and cancels its running
/// step, answers the canceled event's id, tells the session's binder and then withdraws its
/// approval wait's card; a second cancel answers that same id as already canceled and writes
/// nothing. Mutations: answer the results event's id; post a manual run's results; skip the
/// binder; write a second canceled event; settle no question; withdraw no card.
#[rstest]
#[case::chat(WorkflowRunMode::Chat, true)]
#[case::manual(WorkflowRunMode::Manual, false)]
#[tokio::test]
async fn a_cancel_of_an_unheld_run_writes_its_end_once(
    #[case] mode: WorkflowRunMode,
    #[case] posts: bool,
) {
    let test = ControlsTest::new(RunCancelRefusal::NotHeld, RunResumeRefusal::NotHeld).await;
    insert_run(
        &test.rows,
        RUN_ID,
        VERSION_ID,
        WorkflowRunStatus::Running,
        STARTED,
        None,
    );
    test.rows
        .execute(
            "UPDATE workflow_runs SET mode = ?1 WHERE id = ?2",
            [<&'static str>::from(mode), RUN_ID],
        )
        .expect("the test sets the run's mode");
    let steps = [
        (WorkflowStepStatus::Running, None),
        (WorkflowStepStatus::Waiting, Some(WorkflowWaitCause::Reply)),
        (
            WorkflowStepStatus::Waiting,
            Some(WorkflowWaitCause::Approval),
        ),
    ];
    for (execution_index, (status, wait_cause)) in (0..).zip(steps) {
        let step = TestStep {
            execution_index,
            status,
            wait_cause,
            wait_account_id: None,
            resume_at: None,
        };
        insert_step(&test.rows, RUN_ID, &step);
    }
    let wait_id = |execution_index: u32| -> UuidTextForm {
        let text: String = test
            .rows
            .query_row(
                "SELECT wait_id FROM workflow_steps WHERE execution_index = ?1",
                [execution_index],
                |row| row.get(0),
            )
            .expect("the step waits");
        UuidTextForm::new(&text).expect("a stored wait id")
    };
    let (reply_wait, approval_wait) = (wait_id(1), wait_id(2));
    let reason = WorkflowCancelReason::new("Wrong input".to_owned());

    let first = test
        .run_controls
        .cancel(run_id(RUN_ID), reason)
        .await
        .expect("the cancel is taken");

    let logged = events(&test.rows);
    let types: Vec<&str> = logged
        .iter()
        .map(|(_, event_type, _)| event_type.as_str())
        .collect();
    let expected: &[&str] = if posts {
        &[
            "workflow.run.canceled",
            "question.wait.settled",
            "workflow.results.posted",
        ]
    } else {
        &["workflow.run.canceled", "question.wait.settled"]
    };
    assert_eq!(types, expected);
    let session_id = SessionId::new(TEST_SESSION_ID).expect("the test's session");
    assert_eq!(
        logged[1].2,
        json!({ "sessionId": session_id, "waitId": reply_wait, "outcome": "ended" })
    );
    assert_eq!(test.cards.withdrawn(), [(session_id, approval_wait)]);
    let (canceled_id, _, canceled) = &logged[0];
    assert_eq!(first.canceled_event_id.as_str(), canceled_id.as_str());
    assert!(!first.already_canceled);
    assert_eq!(canceled["reason"], json!("Wrong input"));
    assert_eq!(canceled["error"]["message"], json!("Wrong input"));
    let (status, step_status): (String, String) = test
        .rows
        .query_row(
            "SELECT run.status, step.status FROM workflow_runs AS run
             JOIN workflow_steps AS step ON step.workflow_run_id = run.id
             WHERE step.execution_index = 0",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the rows read");
    assert_eq!(
        (status.as_str(), step_status.as_str()),
        ("canceled", "canceled")
    );
    assert_eq!(test.notices.sessions(), [session_id]);
    let before = stored_rows(&test.rows);

    let second = test
        .run_controls
        .cancel(run_id(RUN_ID), None)
        .await
        .expect("a second cancel answers the first");

    assert_eq!(second.canceled_event_id, first.canceled_event_id);
    assert!(second.already_canceled);
    assert_eq!(stored_rows(&test.rows), before);
    assert_eq!(test.cards.withdrawn().len(), 1);
}

/// A cancel of a run that has ended, or that no row answers to, is refused with the words that
/// say so and leaves every row and event as it was. Mutations: drop the end check, which writes a
/// second ending; answer a missing run as not cancelable.
#[rstest]
#[case::succeeded(
    Some(WorkflowRunStatus::Succeeded),
    RefusalCode::WorkflowRunNotCancelable
)]
#[case::crashed(
    Some(WorkflowRunStatus::Crashed),
    RefusalCode::WorkflowRunNotCancelable
)]
#[case::failed_and_ended(Some(WorkflowRunStatus::Failed), RefusalCode::WorkflowRunNotCancelable)]
#[case::missing(None, RefusalCode::WorkflowRunNotFound)]
#[tokio::test]
async fn a_cancel_of_an_ended_run_is_refused_and_writes_nothing(
    #[case] status: Option<WorkflowRunStatus>,
    #[case] code: RefusalCode,
) {
    let test = ControlsTest::new(RunCancelRefusal::NotHeld, RunResumeRefusal::NotHeld).await;
    if let Some(status) = status {
        insert_run(
            &test.rows,
            ENDED_RUN_ID,
            VERSION_ID,
            status,
            STARTED,
            Some(ENDED),
        );
    }
    let before = stored_rows(&test.rows);

    let refused = test.run_controls.cancel(run_id(ENDED_RUN_ID), None).await;

    assert_eq!(refusal_code(refused), code);
    assert_eq!(stored_rows(&test.rows), before);
    assert_eq!(test.notices.sessions(), []);
}

/// The tick's refusals reach the caller as their codes: a cancel of a run whose ending is under
/// way is not cancelable; a Resume of a run waiting only on an answer awaits it, one with nothing
/// to lift is not parked; a Resume of a run the tick does not hold is not parked where its row
/// stands and not found where none does; a re-pin's refusal answers its repair code. Mutations: map
/// the ending to a cancel written from the rows; swap the Resume refusals; answer an unheld run as
/// not found whatever its row; answer a re-pin's refusal as the plain Resume's.
#[rstest]
#[case::awaits_answer(
    RunResumeRefusal::AwaitsAnswer,
    true,
    RefusalCode::WorkflowRunResumeAwaitsAnswer
)]
#[case::not_parked(
    RunResumeRefusal::NotParked,
    true,
    RefusalCode::WorkflowRunResumeNotParked
)]
#[case::unheld(
    RunResumeRefusal::NotHeld,
    true,
    RefusalCode::WorkflowRunResumeNotParked
)]
#[case::missing(RunResumeRefusal::NotHeld, false, RefusalCode::WorkflowRunNotFound)]
#[case::repin_unaccountable(
    RunResumeRefusal::Repin(RepinRefusal::VersionUnaccountable),
    true,
    RefusalCode::WorkflowRunRepairVersionUnaccountable
)]
#[case::repin_failed_node_missing(
    RunResumeRefusal::Repin(RepinRefusal::FailedNodesMissing(vec![test_node_id("F")])),
    true,
    RefusalCode::WorkflowRunRepairFailedNodeMissing
)]
#[tokio::test]
async fn the_ticks_refusals_answer_their_codes(
    #[case] resume: RunResumeRefusal,
    #[case] is_stored: bool,
    #[case] code: RefusalCode,
) {
    let test = ControlsTest::new(RunCancelRefusal::Ending, resume).await;
    if is_stored {
        insert_run(
            &test.rows,
            RUN_ID,
            VERSION_ID,
            WorkflowRunStatus::Succeeded,
            STARTED,
            Some(ENDED),
        );
    }
    let before = stored_rows(&test.rows);

    assert_eq!(
        refusal_code(test.run_controls.cancel(run_id(RUN_ID), None).await),
        RefusalCode::WorkflowRunNotCancelable
    );
    assert_eq!(
        refusal_code(test.run_controls.resume(run_id(RUN_ID), None).await),
        code
    );
    assert_eq!(stored_rows(&test.rows), before);
}

/// `Stop them all` cancels every run of the chain still going, the first run included, each with
/// no reason, and passes over a run of the chain that ended and a run of another chain.
/// Mutations: read the runs by session rather than by chain; include the chain's ended run, whose
/// refusal fails the stop; give the cancels a reason.
#[tokio::test]
async fn stop_them_all_cancels_every_going_run_of_the_chain() {
    let test = ControlsTest::new(RunCancelRefusal::NotHeld, RunResumeRefusal::NotHeld).await;
    insert_chain_run(
        &test.rows,
        RUN_ID,
        VERSION_ID,
        TEST_SESSION_ID,
        STARTED,
        None,
    );
    insert_chain_run(
        &test.rows,
        LATER_RUN_ID,
        VERSION_ID,
        TEST_SESSION_ID,
        ENDED,
        Some(RUN_ID),
    );
    insert_chain_run(
        &test.rows,
        ENDED_RUN_ID,
        VERSION_ID,
        TEST_SESSION_ID,
        STARTED,
        Some(RUN_ID),
    );
    test.rows
        .execute(
            "UPDATE workflow_runs SET status = 'succeeded', finished_at = ?1 WHERE id = ?2",
            [ENDED, ENDED_RUN_ID],
        )
        .expect("the test ends a run of the chain");
    insert_chain_run(
        &test.rows,
        OTHER_CHAIN_RUN_ID,
        VERSION_ID,
        TEST_SESSION_ID,
        STARTED,
        None,
    );

    let stopped = test
        .run_controls
        .stop_chain(run_id(RUN_ID))
        .await
        .expect("the chain stops");

    let canceled: Vec<WorkflowRunId> = stopped
        .iter()
        .map(|response| response.workflow_run_id)
        .collect();
    assert_eq!(canceled, [run_id(RUN_ID), run_id(LATER_RUN_ID)]);
    let statuses: Vec<(String, String)> = test
        .rows
        .prepare("SELECT id, status FROM workflow_runs ORDER BY id")
        .expect("the test reads the runs")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the test reads the runs")
        .collect::<rusqlite::Result<_>>()
        .expect("the runs read");
    let status_of = |id: &str| {
        statuses
            .iter()
            .find(|(stored, _)| stored == id)
            .map(|(_, status)| status.clone())
            .expect("the run is stored")
    };
    assert_eq!(status_of(RUN_ID), "canceled");
    assert_eq!(status_of(LATER_RUN_ID), "canceled");
    assert_eq!(status_of(ENDED_RUN_ID), "succeeded");
    assert_eq!(status_of(OTHER_CHAIN_RUN_ID), "waiting");
    assert!(
        events(&test.rows)
            .iter()
            .all(|(_, _, payload)| payload.get("reason").is_none()),
        "Stop them all gives no reason"
    );
}
