mod pausing;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_approval::service::test_fixture::SETTLE_WAIT;
use sidekicks_contracts::daemon::recovery::DaemonRecoveryHaltedRun;
use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
use sidekicks_provider::driver::message_handing::{HandMoment, MessageHanding};
use sidekicks_provider::driver::run_control::{
    ApplyInterventionParams, ApplyInterventionResponse, InterventionResultStatus, TakenMessages,
};
use sidekicks_provider::driver::session_control::{
    DriverResumeResult, EndKeptTurnsParams, KeptRunTurns, ProviderTurnAnswer, ResumeSessionParams,
    ResumedRunAnswer,
};
use sidekicks_provider::runtime_binding::test_store::spawned_build;
use sidekicks_session::queue_store::{
    NewQueueItem, QueueItemBody, QueueItemReader, QueueMessageBody, RecordedQueueItemState,
    insert_queue_item_statement,
};
use sidekicks_session::run::engine::test_fixture::{insert_running_run, stored_run_state};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::test_run_id;
use tokio_util::sync::CancellationToken;

use crate::test_pass::{PassFixture, insert_runs};

/// The words a refused resume's provider gives.
const REFUSED_DETAIL: &str = "The conversation could not be found";

/// A provider that takes a message at once.
const HANDS_AT_ONCE: MessageHanding = MessageHanding {
    hands_at: HandMoment::AtOnce,
    can_withdraw: true,
    kept_by_process: false,
    reads_priority_message: false,
};

// A resume that went on under `binding_id`, answered from the resume's own params: every run it
// names holds its turn as `turn_of` answers for it.
fn resumed_on(
    params: &ResumeSessionParams,
    binding_id: RuntimeBindingId,
    turn_of: impl Fn(RunId) -> ProviderTurnAnswer,
) -> DriverResumeResult {
    DriverResumeResult::Resumed {
        binding_id,
        session_position: SafeInt::ZERO,
        resume_handle: NonEmptyText::new(params.resume_handle.clone()).expect("a resume handle"),
        spawned_version: spawned_build("1.0.1", "/opt/provider/bin"),
        runs: params
            .live_runs
            .iter()
            .map(|run| ResumedRunAnswer {
                run_id: run.run_id,
                turn: turn_of(run.run_id),
            })
            .collect(),
    }
}

// Every run a resume names still holds its turn.
fn still_running(_run_id: RunId) -> ProviderTurnAnswer {
    ProviderTurnAnswer::StillRunning
}

// A driver that resumes once, answering from the resume's params through `answer`.
fn resuming_driver(
    answer: impl Fn(&ResumeSessionParams) -> DriverResumeResult + Send + Sync + 'static,
) -> MockProviderDriver {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_resume_session()
        .times(1)
        .returning(move |params| {
            let answered = answer(&params);
            async move { Ok(answered) }.boxed()
        });
    driver
}

// Has `driver` expect one end of the turns a restart kept, answered at once, and answers where
// the params it is handed are recorded.
fn expect_kept_turns_ended(driver: &mut MockProviderDriver) -> Arc<Mutex<Vec<EndKeptTurnsParams>>> {
    let ended: Arc<Mutex<Vec<EndKeptTurnsParams>>> = Arc::default();
    let recorded = Arc::clone(&ended);
    driver
        .expect_end_kept_turns()
        .times(1)
        .returning(move |params| {
            lock(&recorded).push(params);
            async { Ok(()) }.boxed()
        });
    ended
}

// The one end of kept turns recorded in `ended`: its conversation, and its runs in id order.
fn ended_kept_turns(ended: &Mutex<Vec<EndKeptTurnsParams>>) -> (String, Vec<KeptRunTurns>) {
    let ended = lock(ended);
    let [params] = ended.as_slice() else {
        panic!("the kept turns were ended once: {ended:?}");
    };
    let mut runs = params.runs.clone();
    runs.sort_by_key(|run| run.run_id);
    (params.conversation.clone(), runs)
}

// A run's one kept turn, `turn_id`, ended for its own stop where `is_for_stop`.
fn kept_turn(run_id: RunId, turn_id: &str, is_for_stop: bool) -> KeptRunTurns {
    KeptRunTurns {
        run_id,
        subagent_id: None,
        turn_ids: vec![ProviderTurnId::new(turn_id.to_owned()).expect("a turn id")],
        is_for_stop,
    }
}

impl PassFixture {
    // Ends the store's seeded run, so only the test's sessions hold work in progress.
    fn end_seeded_run(&self) {
        self.store
            .database
            .reader()
            .execute(
                "UPDATE runs SET state = 'completed' WHERE run_id = ?1",
                [self.store.run_id.text().as_str()],
            )
            .expect("the seeded run ended");
    }

    // A new session with a running run on the table's provider at `provider_index`, its
    // conversation held by a binding of the run; answers the session, the run and the binding.
    async fn running_session(&self, provider_index: usize) -> (SessionId, RunId, RuntimeBindingId) {
        let session_id = self.new_session();
        let run_id = test_run_id();
        insert_running_run(&self.store.database, session_id, run_id);
        let binding_id = self.bind_resumable(run_id, provider_index).await;
        (session_id, run_id, binding_id)
    }

    // The runs the status read lists under `session_id` as needing the person.
    async fn halted_runs(&self, session_id: SessionId) -> Option<Vec<DaemonRecoveryHaltedRun>> {
        self.status
            .read(&self.store.reads)
            .await
            .sessions
            .into_iter()
            .find(|session| session.session_id == session_id)
            .and_then(|session| session.halted_runs)
    }

    // Records the person's accepted interrupt of `run_id`, sending the waiting messages as the
    // next turn.
    fn record_person_interrupt(&self, run_id: RunId) {
        self.record_intervention(run_id, "interrupt", "accepted", r#"{"pending":"nextTurn"}"#);
    }

    // Writes a running helper the provider of `lead` dispatched beneath it in `session_id`.
    fn insert_helper(&self, session_id: SessionId, lead: RunId) -> RunId {
        let helper = test_run_id();
        insert_running_run(&self.store.database, session_id, helper);
        self.store
            .database
            .reader()
            .execute(
                "UPDATE runs SET parent_run_id = ?1, reached_by = ?2 WHERE run_id = ?3",
                params![
                    lead.text().as_str(),
                    <&'static str>::from(ChildRunProvenance::ProviderSubagent),
                    helper.text().as_str()
                ],
            )
            .expect("the test makes the run a helper");
        helper
    }

    // Opens `run_id`'s first turn in `session_id`, under the provider's id `provider_turn_id`
    // where it reported one.
    async fn open_turn(
        &self,
        session_id: SessionId,
        run_id: RunId,
        provider_turn_id: Option<&str>,
    ) {
        let mut payload = json!({"sessionId": session_id, "runId": run_id, "runVersion": 1,
                                 "turnNumber": 1});
        if let Some(provider_turn_id) = provider_turn_id {
            payload["providerTurnId"] = json!(provider_turn_id);
        }
        self.append(
            session_id,
            json!({"type": "agent.turn.started", "payload": payload}),
        )
        .await;
    }

    // Queues a message for `run_id` in `session_id` and answers its id.
    async fn queue_message(&self, session_id: SessionId, run_id: RunId) -> QueueItemId {
        let item = NewQueueItem {
            id: QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id"),
            session_id,
            body: QueueItemBody::Message(QueueMessageBody {
                content: FreeFormText::new("Look again".to_owned()).expect("a test message"),
                attachments: None,
                skills: None,
                answers_question_id: None,
                output_speed_for_turn: None,
                workspace_id: None,
            }),
            target_run_id: run_id,
            device_id: None,
            client_idempotency_key: Some(
                ClientUuid::new(mint_uuid_v7().to_string()).expect("a minted UUID is a client key"),
            ),
            replaces_queue_item_id: None,
            now: WireInstant::now(),
        };
        self.store
            .writer
            .write(vec![insert_queue_item_statement(&item)])
            .await
            .expect("the test queues its message");
        item.id
    }

    // The recorded state of queue item `item_id`.
    fn queue_item_state(&self, item_id: QueueItemId) -> RecordedQueueItemState {
        QueueItemReader::new(&self.store.database.reader())
            .get(&item_id)
            .expect("the test reads its message")
            .expect("the test's message is stored")
            .state
    }

    // The payloads of `run_id`'s `event_type` events in `session_id`, in log order.
    fn run_payloads(
        &self,
        session_id: SessionId,
        event_type: SessionEventType,
        run_id: RunId,
    ) -> Vec<Value> {
        self.payloads(&session_id, event_type)
            .into_iter()
            .filter(|payload| payload["runId"] == json!(run_id))
            .collect()
    }

    // The trigger of `run_id`'s one interrupted end in `session_id`, `None` when it carries none.
    fn run_trigger(&self, session_id: SessionId, run_id: RunId) -> Option<String> {
        let ends = self.run_payloads(session_id, SessionEventType::AgentRunInterrupted, run_id);
        let [end] = ends.as_slice() else {
            panic!("run {run_id} ended interrupted once: {ends:?}");
        };
        end["trigger"].as_str().map(str::to_owned)
    }

    // The runtime bindings recorded for `run_id`.
    fn binding_count(&self, run_id: RunId) -> i64 {
        self.store
            .database
            .reader()
            .query_row(
                "SELECT COUNT(*) FROM runtime_bindings WHERE run_id = ?1",
                [run_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the bindings read")
    }
}

// Two sessions with a run in progress at the restart: one whose provider kept its process across
// the restart and answers on the binding that brought it up, as a lasting service does, and one
// whose conversation is relaunched under the binding the resume minted. Each run is named to its
// provider, still running after the pass with no end written, the relaunched one under a binding
// recorded for it; a completed session is not opened, and the pass counts one binding restored and
// two runs resumed. Killed by the settle failing a resumed run (a run reads `failed`), by the
// resume skipped (each driver's one resume is missed), and by the counts left zero.
#[tokio::test]
async fn a_pass_resumes_each_session_with_work_in_progress_and_counts_it() {
    let kept_leg: Arc<Mutex<Option<RuntimeBindingId>>> = Arc::default();
    let kept = resuming_driver({
        let kept_leg = Arc::clone(&kept_leg);
        move |params| {
            let leg = lock(&kept_leg)
                .clone()
                .expect("the kept session's leg is recorded");
            resumed_on(params, leg, still_running)
        }
    });
    let relaunched =
        resuming_driver(|params| resumed_on(params, params.binding_id.clone(), still_running));
    let fixture = PassFixture::over_drivers(vec![
        Arc::new(kept) as Arc<dyn ProviderDriver>,
        Arc::new(relaunched),
    ])
    .await;
    fixture.end_seeded_run();
    let (kept_session, kept_run, kept_binding) = fixture.running_session(0).await;
    *lock(&kept_leg) = Some(kept_binding);
    let (relaunched_session, relaunched_run, _) = fixture.running_session(1).await;

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;

    for (session_id, run_id) in [
        (kept_session, kept_run),
        (relaunched_session, relaunched_run),
    ] {
        assert_eq!(
            stored_run_state(&fixture.store.database, &run_id).0,
            "running"
        );
        for ended in [
            SessionEventType::AgentRunFailed,
            SessionEventType::AgentRunInterrupted,
        ] {
            assert!(fixture.payloads(&session_id, ended).is_empty(), "{ended:?}");
        }
    }
    assert_eq!(fixture.binding_count(kept_run), 1);
    assert_eq!(fixture.binding_count(relaunched_run), 2);
    let succeeded = fixture.payloads(
        &DAEMON_SCOPE_SENTINEL_SESSION_ID,
        SessionEventType::DaemonRecoverySucceeded,
    );
    let [succeeded] = succeeded.as_slice() else {
        panic!("one pass succeeded: {succeeded:?}");
    };
    assert_eq!(succeeded["bindingsRestored"], json!(1));
    assert_eq!(succeeded["runsResumed"], json!(2));
    assert_eq!(succeeded["runsFailedDeterministically"], json!(0));
}

// The table of runs a pending stop waits on at a restart. A session whose runs in progress each
// wait on a stop of their own (session A) is not opened, no process started for it: a lead with
// the person's interrupt ends by it as the person's, and a run owing its token limit stops at it.
// A session with a live run beside its stopping ones (session B) is opened, each named to the
// provider as stopping or not: a stopping run whose provider still runs its turn, `pausing` among
// them, has the person's interrupt handed again and ends by it, and a run owing its step limit has
// that limit's interrupt handed again, one driver call each; a stopping `paused` run, and one whose
// turn is gone or ended, ends by its stop with no call; a helper whose turn is gone reads
// interrupted by the restart, one still running stays running with no call, and so do the live run
// and the queued run with its message waiting. A session whose stopping lead has a helper with no
// stop of its own (session C) is opened, since the reopen check counts only a run's own stops: both
// are named stopping, the lead ends by the person's interrupt and the helper, its turn gone, reads
// interrupted by the restart with its turn ended the same way, neither handed an interrupt.
// Killed by the hand-again dropped (the still-running stopping runs stay live and the wait for
// their ends runs out), by the pause arms tried first (`pausing` reads `paused` and `paused` is
// left), by limit rows handed as a person's (a second call for the step-limit run), by the lead's
// rows handed to a helper (a call for the helper), by `any` read for `all` (the first provider's
// driver, which expects no resume, is called), by the all-stopping check dropped (the same), by
// the stopping helper's arm dropped, and by the reopen check reading stops up to the lead (session
// C is not opened and its runs are not named). Session A's kept turns are handed to its provider
// once, on its leg's conversation, for both its runs, and none of session C's. Killed by the
// hand-off skipped or read after the settle (no call).
#[tokio::test]
async fn a_pass_ends_each_stopping_run_by_its_stop_and_hands_the_persons_interrupt_again() {
    let answers: Arc<Mutex<HashMap<RunId, ProviderTurnAnswer>>> = Arc::default();
    let named: Arc<Mutex<Vec<(RunId, bool)>>> = Arc::default();
    let interrupted: Arc<Mutex<Vec<RunId>>> = Arc::default();
    let mut unopened = MockProviderDriver::new();
    let kept_ends = expect_kept_turns_ended(&mut unopened);
    let mut resumed = resuming_driver({
        let answers = Arc::clone(&answers);
        let named = Arc::clone(&named);
        move |params| {
            lock(&named).extend(
                params
                    .live_runs
                    .iter()
                    .map(|run| (run.run_id, run.is_stopping)),
            );
            let answers = lock(&answers);
            resumed_on(params, params.binding_id.clone(), |run_id| {
                *answers
                    .get(&run_id)
                    .expect("the table answers every run the resume names")
            })
        }
    });
    resumed.expect_message_handing().return_const(HANDS_AT_ONCE);
    resumed
        .expect_find_taken_messages()
        .returning(|_| async { Ok(TakenMessages { taken: Vec::new() }) }.boxed());
    {
        let interrupted = Arc::clone(&interrupted);
        resumed
            .expect_apply_intervention()
            .returning(move |params| {
                if let ApplyInterventionParams::Interrupt { target_run_id, .. } = params {
                    lock(&interrupted).push(target_run_id);
                }
                async {
                    Ok(ApplyInterventionResponse {
                        status: InterventionResultStatus::Applied,
                        fallback_action: None,
                        delivered_run_id: None,
                        canceled: Vec::new(),
                    })
                }
                .boxed()
            });
    }
    let fixture = PassFixture::over_drivers(vec![
        Arc::new(unopened) as Arc<dyn ProviderDriver>,
        Arc::new(resumed),
    ])
    .await;
    fixture.end_seeded_run();

    // Session A: every run in progress stops.
    let (stopped_session, stopped_lead, _) = fixture.running_session(0).await;
    fixture.record_person_interrupt(stopped_lead);
    fixture
        .open_turn(stopped_session, stopped_lead, Some("turn-lead"))
        .await;
    let token_run = test_run_id();
    insert_running_run(&fixture.store.database, stopped_session, token_run);
    fixture
        .open_turn(stopped_session, token_run, Some("turn-token"))
        .await;
    fixture
        .append(
            stopped_session,
            json!({
                "type": "agent.run.tokenLimit.reached",
                "payload": {"sessionId": stopped_session, "runId": token_run, "tokenLimit": 1000},
            }),
        )
        .await;

    // Session B: a live run beside the stopping ones.
    let (mixed_session, live_run, _) = fixture.running_session(1).await;
    let (still_running, still_pausing, still_paused, gone, ended, step_run, queued_run) = (
        test_run_id(),
        test_run_id(),
        test_run_id(),
        test_run_id(),
        test_run_id(),
        test_run_id(),
        test_run_id(),
    );
    insert_runs(
        &fixture.store.database,
        mixed_session,
        &[
            (still_running, "running"),
            (still_pausing, "pausing"),
            (still_paused, "paused"),
            (gone, "running"),
            (ended, "pausing"),
            (step_run, "running"),
            (queued_run, "queued"),
        ],
    );
    for run_id in [still_running, still_pausing, still_paused, gone, ended] {
        fixture.record_person_interrupt(run_id);
    }
    for run_id in [
        still_running,
        still_pausing,
        still_paused,
        gone,
        ended,
        step_run,
    ] {
        fixture.bind_resumable(run_id, 1).await;
    }
    fixture
        .append(
            mixed_session,
            json!({
                "type": "agent.run.stepLimit.reached",
                "payload": {"sessionId": mixed_session, "runId": step_run, "count": 3},
            }),
        )
        .await;
    let gone_helper = fixture.insert_helper(mixed_session, still_running);
    let kept_helper = fixture.insert_helper(mixed_session, still_pausing);
    let waiting_message = fixture.queue_message(mixed_session, queued_run).await;

    // Session C: a stopping lead and its helper with no stop of its own.
    let (helper_session, stopping_lead, _) = fixture.running_session(1).await;
    fixture.record_person_interrupt(stopping_lead);
    let cut_helper = fixture.insert_helper(helper_session, stopping_lead);
    fixture
        .open_turn(helper_session, cut_helper, Some("turn-helper"))
        .await;
    fixture
        .open_turn(helper_session, stopping_lead, Some("turn-stopping-lead"))
        .await;
    lock(&answers).extend([
        (stopping_lead, ProviderTurnAnswer::Gone),
        (cut_helper, ProviderTurnAnswer::Gone),
    ]);
    lock(&answers).extend([
        (live_run, ProviderTurnAnswer::StillRunning),
        (still_running, ProviderTurnAnswer::StillRunning),
        (still_pausing, ProviderTurnAnswer::StillRunning),
        (still_paused, ProviderTurnAnswer::StillRunning),
        (gone, ProviderTurnAnswer::Gone),
        (ended, ProviderTurnAnswer::EndedByProvider),
        (step_run, ProviderTurnAnswer::StillRunning),
        (gone_helper, ProviderTurnAnswer::Gone),
        (kept_helper, ProviderTurnAnswer::StillRunning),
        (queued_run, ProviderTurnAnswer::StillRunning),
    ]);
    let bound = [
        live_run,
        still_running,
        still_pausing,
        still_paused,
        gone,
        ended,
        step_run,
    ];
    let bindings_before: i64 = bound.iter().map(|run| fixture.binding_count(*run)).sum();
    let mut changes = fixture.followers.change_count(&mixed_session);

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;
    let handed = [still_running, still_pausing, step_run];
    tokio::time::timeout(SETTLE_WAIT, async {
        while !handed
            .iter()
            .all(|run_id| stored_run_state(&fixture.store.database, run_id).0 == "interrupted")
        {
            changes
                .changed()
                .await
                .expect("the session's changes are followed");
        }
    })
    .await
    .expect("each run handed again ends by its stop");

    for (run_id, state) in [(stopped_lead, "interrupted"), (token_run, "stopped")] {
        assert_eq!(
            stored_run_state(&fixture.store.database, &run_id).0,
            state,
            "{run_id}"
        );
    }
    assert_eq!(fixture.run_trigger(stopped_session, stopped_lead), None);
    let stopped = fixture.run_payloads(
        stopped_session,
        SessionEventType::AgentRunStopped,
        token_run,
    );
    let [stopped] = stopped.as_slice() else {
        panic!("the token limit's run stopped once: {stopped:?}");
    };
    assert_eq!(stopped["trigger"], json!("tokenLimit"));
    assert_eq!(
        fixture.payloads(&stopped_session, SessionEventType::AgentRunFailed),
        Vec::<Value>::new()
    );
    let mut kept = vec![
        kept_turn(stopped_lead, "turn-lead", true),
        kept_turn(token_run, "turn-token", true),
    ];
    kept.sort_by_key(|run| run.run_id);
    assert_eq!(
        ended_kept_turns(&kept_ends),
        ("conversation-1".to_owned(), kept)
    );

    for run_id in [stopping_lead, cut_helper] {
        assert_eq!(
            stored_run_state(&fixture.store.database, &run_id).0,
            "interrupted",
            "{run_id}"
        );
    }
    assert_eq!(fixture.run_trigger(helper_session, stopping_lead), None);
    assert_eq!(
        fixture.run_trigger(helper_session, cut_helper).as_deref(),
        Some("daemonRestart")
    );
    let turn_ends = fixture.run_payloads(
        helper_session,
        SessionEventType::AgentTurnInterrupted,
        cut_helper,
    );
    let [turn_end] = turn_ends.as_slice() else {
        panic!("the helper's turn ended once: {turn_ends:?}");
    };
    assert_eq!(turn_end["cause"], json!("daemonRestart"));

    let mut calls = lock(&interrupted).clone();
    calls.sort();
    let mut expected_calls = handed.to_vec();
    expected_calls.sort();
    assert_eq!(calls, expected_calls);
    for run_id in [still_running, still_pausing, still_paused, gone, ended] {
        assert_eq!(
            stored_run_state(&fixture.store.database, &run_id).0,
            "interrupted",
            "{run_id}"
        );
        assert_eq!(fixture.run_trigger(mixed_session, run_id), None, "{run_id}");
    }
    assert_eq!(
        fixture.run_trigger(mixed_session, step_run).as_deref(),
        Some("stepLimit")
    );
    assert_eq!(
        stored_run_state(&fixture.store.database, &gone_helper).0,
        "interrupted"
    );
    assert_eq!(
        fixture.run_trigger(mixed_session, gone_helper).as_deref(),
        Some("daemonRestart")
    );
    for run_id in [kept_helper, live_run] {
        assert_eq!(
            stored_run_state(&fixture.store.database, &run_id).0,
            "running",
            "{run_id}"
        );
    }
    assert_eq!(
        stored_run_state(&fixture.store.database, &queued_run).0,
        "queued"
    );
    assert_eq!(
        fixture.queue_item_state(waiting_message),
        RecordedQueueItemState::Queued
    );
    let mut names = lock(&named).clone();
    names.sort();
    let mut expected_names: Vec<(RunId, bool)> = [
        (live_run, false),
        (queued_run, false),
        (still_running, true),
        (still_pausing, true),
        (still_paused, true),
        (gone, true),
        (ended, true),
        (step_run, true),
        (gone_helper, true),
        (kept_helper, true),
        (stopping_lead, true),
        (cut_helper, true),
    ]
    .to_vec();
    expected_names.sort();
    assert_eq!(names, expected_names);
    let bindings_after: i64 = bound.iter().map(|run| fixture.binding_count(*run)).sum();
    assert_eq!(bindings_after, bindings_before + 1);
}

// A resume the provider refuses fails the session's running run with the provider's own words,
// while a stopping run beside it ends by its stop, as the person's; the status read lists the
// failed run under its session with what its recovery needs and a provider failure; once the
// session's next run starts, the entry is gone; the kept turns of both runs are handed to the
// provider, each ended for a stop only where the run has one of its own. Killed by
// `mark_run_halted` not called (no entry), by the restart's own words written (the detail differs),
// by the failure detail winning over the run's stop (the stopping run reads `failed`), by the entry
// never cleared, by the refused session's runs left out (no call), and by `is_for_stop` set alike
// for both.
#[tokio::test]
async fn a_refused_resume_fails_its_run_and_lists_it_until_the_sessions_next_run() {
    let mut refusing = resuming_driver(|_params| DriverResumeResult::Failed {
        recovery_condition: RecoveryCondition::RecoveryNeeded,
        provider_failure_detail: FreeFormText::new(REFUSED_DETAIL.to_owned())
            .expect("the refusal's words"),
    });
    let kept_ends = expect_kept_turns_ended(&mut refusing);
    let fixture =
        PassFixture::over_drivers(vec![Arc::new(refusing) as Arc<dyn ProviderDriver>]).await;
    let _run_starts = fixture.status.follow_run_starts(&fixture.followers);
    fixture.end_seeded_run();
    let (session_id, run_id, _) = fixture.running_session(0).await;
    let stopping_run = test_run_id();
    insert_running_run(&fixture.store.database, session_id, stopping_run);
    fixture.record_person_interrupt(stopping_run);
    fixture
        .open_turn(session_id, run_id, Some("turn-failed"))
        .await;
    fixture
        .open_turn(session_id, stopping_run, Some("turn-stopping"))
        .await;

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;

    assert_eq!(
        stored_run_state(&fixture.store.database, &run_id).0,
        "failed"
    );
    let failed = fixture.payloads(&session_id, SessionEventType::AgentRunFailed);
    let [failed] = failed.as_slice() else {
        panic!("the run failed once: {failed:?}");
    };
    assert_eq!(failed["providerFailureDetail"], json!(REFUSED_DETAIL));
    assert_eq!(
        stored_run_state(&fixture.store.database, &stopping_run).0,
        "interrupted"
    );
    assert_eq!(fixture.run_trigger(session_id, stopping_run), None);
    let mut kept = vec![
        kept_turn(run_id, "turn-failed", false),
        kept_turn(stopping_run, "turn-stopping", true),
    ];
    kept.sort_by_key(|run| run.run_id);
    assert_eq!(ended_kept_turns(&kept_ends).1, kept);
    assert_eq!(
        fixture.halted_runs(session_id).await,
        Some(vec![DaemonRecoveryHaltedRun {
            run_id,
            recovery_condition: RecoveryCondition::RecoveryNeeded,
            failure_category: Some(RunFailureCategory::ProviderFailure),
        }])
    );

    let next_run = test_run_id();
    fixture
        .append(
            session_id,
            json!({
                "type": "agent.run.starting",
                "payload": {"sessionId": session_id, "runId": next_run, "runVersion": 1,
                            "previousState": "queued", "newState": "starting"},
            }),
        )
        .await;

    assert_eq!(fixture.halted_runs(session_id).await, None);
}
