use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::OptionalExtension as _;
use serde_json::Value;
use sidekicks_approval::service::test_fixture::SETTLE_WAIT;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
use sidekicks_provider::driver::run_control::{FindTakenMessagesParams, TakenMessages};
use sidekicks_session::queue_store::{QueueItemReader, RecordedQueueItemState};
use sidekicks_session::run::engine::test_fixture::stored_run_state;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::test_run_id;
use tokio_util::sync::CancellationToken;

use super::resume::{
    ended_kept_turns, expect_kept_turns_ended, kept_turn, resumed_on, resuming_driver,
    still_running,
};
use crate::session_write_refusal::refuse_call_naming_session;
use crate::stop_intent::{StopIntent, StopIntentFile};
use crate::test_pass::{PassFixture, insert_runs, queue_message};

// What the person's Stop left, and how the pass meets it.
#[derive(Clone, Copy, Debug)]
enum Case {
    // A whole intent over a run of one provider and a kept turn of another.
    Whole,
    // A whole intent over a queued run with a message carrying only words.
    WholeQueuedMessage,
    // No intent, as after a crash, over a queued run with a message.
    NoIntentQueuedMessage,
    // An intent naming one of two sessions.
    NamesOneOfTwo,
    // A pass the service's stop cuts once the settle has written, before the drop.
    CutBetweenSettleAndDrop,
    // A pass the service's stop ends before any settle.
    StoppedBeforeSettle,
    // A whole intent the person's Stop writes again while the pass settles.
    WholeWrittenMidPass,
    // An intent naming a session with a run, one a purge drops mid-pass and one with nothing left.
    NameDroppedMidPass,
    // An intent naming a session whose history is damaged, beside a session it does not name.
    DamagedNamed,
    // An intent whose session's settle is refused: a message is queued for its run at each try.
    SettleRefused,
}

// The intent's names, written as the pass writes them: whole, then named.
async fn write_names(intent: &StopIntentFile, sessions: BTreeSet<SessionId>) {
    intent.write_whole().await.expect("the Stop writes");
    intent
        .name_sessions(&StopIntent::Whole, sessions)
        .await
        .expect("the names are written");
}

// The pass's run of `fixture`, waited out.
async fn run_pass(fixture: &PassFixture, stop: &CancellationToken) {
    tokio::time::timeout(
        SETTLE_WAIT,
        fixture.pass(Arc::clone(&fixture.status)).run(stop),
    )
    .await
    .expect("the pass ends");
}

// The words `session_id`'s draft holds, `None` with no draft row.
fn draft_text(fixture: &PassFixture, session_id: SessionId) -> Option<String> {
    fixture
        .store
        .database
        .reader()
        .query_row(
            "SELECT text FROM session_drafts WHERE session_id = ?1",
            [session_id.text().as_str()],
            |row| row.get(0),
        )
        .optional()
        .expect("the draft reads")
}

// Asserts `run_id` in `session_id` ended `interrupted` by the person's Stop of the service.
fn assert_ended_by_the_stop(fixture: &PassFixture, session_id: SessionId, run_id: RunId) {
    assert_eq!(
        stored_run_state(&fixture.store.database, &run_id).0,
        "interrupted"
    );
    assert_eq!(
        fixture.run_trigger(session_id, run_id).as_deref(),
        Some("daemonStop")
    );
}

// A pass under the stop intent ends each named session's runs as the person's Stop ends them and
// opens none of them, ends their kept turns for the stop, puts a queued message's words back in
// the draft, and drops each name only once its settle has committed; with no intent a crash's
// queued message waits for the queue to send it. Every named session refuses calls from the
// pass's listing, one with nothing left among them; a name a purge drops mid-pass holds back no
// other drop; a damaged session, and one whose settle is refused, keep their names. Killed by the
// drop before the settle (the names are gone at the settle's pause), by `Stopped` taken as settled
// (the intent is rewritten or removed), by the intent ignored (a run resumes, or a driver with no
// resume expected is called), by the kept turns ended without `is_for_stop`, by a Stop's message
// sent or failed with its run (it is not canceled, or the draft is empty), by a crash's waiting
// message held back or ended (it is not left waiting for its queued run), by a named session with
// nothing left not marked (it takes calls at the pause), by a drop held to the names the pass read
// (the mid-pass drop leaves the other names), and by a damaged or refused session's name dropped.
#[rstest]
#[case::a_whole_intent(Case::Whole)]
#[case::a_whole_intent_over_a_queued_message(Case::WholeQueuedMessage)]
#[case::no_intent_over_a_queued_message(Case::NoIntentQueuedMessage)]
#[case::an_intent_naming_one_of_two_sessions(Case::NamesOneOfTwo)]
#[case::a_pass_cut_between_the_settle_and_the_drop(Case::CutBetweenSettleAndDrop)]
#[case::a_pass_stopped_before_the_settle(Case::StoppedBeforeSettle)]
#[case::a_whole_intent_written_mid_pass(Case::WholeWrittenMidPass)]
#[case::a_name_dropped_mid_pass(Case::NameDroppedMidPass)]
#[case::a_damaged_named_session(Case::DamagedNamed)]
#[case::a_named_session_whose_settle_is_refused(Case::SettleRefused)]
#[tokio::test]
async fn a_pass_under_the_stop_intent_settles_named_sessions_by_the_stop(#[case] case: Case) {
    // The first provider's runs are never resumed; the second keeps a turn the Stop ends, or
    // resumes the session the intent does not name.
    let mut second = match case {
        Case::NamesOneOfTwo | Case::DamagedNamed => resuming_driver(1, |params| {
            resumed_on(params, params.binding_id.clone(), still_running)
        }),
        Case::Whole
        | Case::WholeQueuedMessage
        | Case::NoIntentQueuedMessage
        | Case::CutBetweenSettleAndDrop
        | Case::StoppedBeforeSettle
        | Case::WholeWrittenMidPass
        | Case::NameDroppedMidPass
        | Case::SettleRefused => MockProviderDriver::new(),
    };
    let kept_ends = match case {
        Case::Whole => Some(expect_kept_turns_ended(&mut second)),
        Case::WholeQueuedMessage
        | Case::NoIntentQueuedMessage
        | Case::NamesOneOfTwo
        | Case::CutBetweenSettleAndDrop
        | Case::StoppedBeforeSettle
        | Case::WholeWrittenMidPass
        | Case::NameDroppedMidPass
        | Case::DamagedNamed
        | Case::SettleRefused => None,
    };
    let fixture = PassFixture::over_drivers(vec![
        Arc::new(MockProviderDriver::new()) as Arc<dyn ProviderDriver>,
        Arc::new(second),
    ])
    .await;
    fixture.end_seeded_run();
    let intent = fixture.stop_intent();
    let stop = CancellationToken::new();

    match case {
        Case::Whole => {
            let (first_session, first_run, _) = fixture.running_session(0).await;
            let (kept_session, kept_run, _) = fixture.running_session(1).await;
            fixture
                .open_turn(kept_session, kept_run, Some("turn-kept"))
                .await;
            intent.write_whole().await.expect("the Stop writes");

            run_pass(&fixture, &stop).await;

            assert_ended_by_the_stop(&fixture, first_session, first_run);
            assert_ended_by_the_stop(&fixture, kept_session, kept_run);
            let kept_ends = kept_ends.expect("the kept turns' ends are recorded");
            assert_eq!(
                ended_kept_turns(&kept_ends).1,
                vec![kept_turn(kept_run, "turn-kept", true)]
            );
            assert_eq!(intent.read().await, None);
        }
        Case::WholeQueuedMessage | Case::NoIntentQueuedMessage => {
            let session_id = fixture.new_session();
            let run_id = test_run_id();
            insert_runs(&fixture.store.database, session_id, &[(run_id, "queued")]);
            let item_id = queue_message(&fixture.store.writer, session_id, run_id).await;
            if matches!(case, Case::WholeQueuedMessage) {
                intent.write_whole().await.expect("the Stop writes");
            }

            run_pass(&fixture, &stop).await;

            let unstarted = QueueItemReader::new(&fixture.store.database.reader())
                .list_sessions_with_unstarted_waiting()
                .expect("the queue's recover reads its sessions");
            let draft = draft_text(&fixture, session_id);
            if matches!(case, Case::WholeQueuedMessage) {
                assert_eq!(
                    stored_run_state(&fixture.store.database, &run_id).0,
                    "stopped"
                );
                let stopped =
                    fixture.run_payloads(session_id, SessionEventType::AgentRunStopped, run_id);
                let [stopped] = stopped.as_slice() else {
                    panic!("the queued run stopped once: {stopped:?}");
                };
                assert_eq!(stopped["trigger"], "daemonStop");
                assert_eq!(
                    fixture.run_payloads(session_id, SessionEventType::AgentRunFailed, run_id),
                    Vec::<Value>::new()
                );
                assert_eq!(
                    fixture.queue_item_state(item_id),
                    RecordedQueueItemState::Canceled
                );
                assert_eq!(draft.as_deref(), Some("Look again"));
                assert!(
                    unstarted.is_empty(),
                    "the queue starts nothing: {unstarted:?}"
                );
            } else {
                assert_eq!(
                    stored_run_state(&fixture.store.database, &run_id).0,
                    "queued"
                );
                assert_eq!(
                    fixture.queue_item_state(item_id),
                    RecordedQueueItemState::Queued
                );
                assert_eq!(draft, None);
                assert_eq!(unstarted, vec![session_id], "the queue sends the message");
            }
        }
        Case::NamesOneOfTwo => {
            let (resumed_session, resumed_run, _) = fixture.running_session(1).await;
            let (named_session, named_run, _) = fixture.running_session(0).await;
            write_names(&intent, BTreeSet::from([named_session])).await;

            run_pass(&fixture, &stop).await;

            assert_ended_by_the_stop(&fixture, named_session, named_run);
            assert_eq!(
                stored_run_state(&fixture.store.database, &resumed_run).0,
                "running"
            );
            assert_eq!(
                fixture.payloads(&resumed_session, SessionEventType::AgentRunInterrupted),
                Vec::<Value>::new()
            );
            assert_eq!(intent.read().await, None);
        }
        Case::CutBetweenSettleAndDrop => {
            let (session_id, run_id, _) = fixture.running_session(0).await;
            intent.write_whole().await.expect("the Stop writes");
            let paused = fixture.engine.restart_facts_pause().arm();
            let running = tokio::spawn({
                let pass = fixture.pass(Arc::clone(&fixture.status));
                let stop = stop.clone();
                async move { pass.run(&stop).await }
            });
            tokio::time::timeout(SETTLE_WAIT, paused.reached)
                .await
                .expect("the run's settle reads its facts")
                .expect("the pause reports");
            stop.cancel();
            paused.release.send(()).expect("the settle is let go");
            tokio::time::timeout(SETTLE_WAIT, running)
                .await
                .expect("the pass ends")
                .expect("the pass's task ends");
            assert_ended_by_the_stop(&fixture, session_id, run_id);
            assert_eq!(
                intent.read().await,
                Some(StopIntent::Sessions(BTreeSet::from([session_id])))
            );
            let head = fixture.head(&session_id);

            run_pass(&fixture, &CancellationToken::new()).await;

            assert_eq!(fixture.head(&session_id), head, "the settle writes nothing");
            assert_eq!(intent.read().await, None);
        }
        Case::StoppedBeforeSettle => {
            let (_session_id, run_id, _) = fixture.running_session(0).await;
            intent.write_whole().await.expect("the Stop writes");
            stop.cancel();

            run_pass(&fixture, &stop).await;

            assert_eq!(
                stored_run_state(&fixture.store.database, &run_id).0,
                "running"
            );
            assert_eq!(intent.read().await, Some(StopIntent::Whole));
        }
        Case::WholeWrittenMidPass => {
            let (first_session, first_run, _) = fixture.running_session(0).await;
            let (second_session, second_run, _) = fixture.running_session(0).await;
            intent.write_whole().await.expect("the Stop writes");
            let paused = fixture.engine.restart_facts_pause().arm();
            let running = tokio::spawn({
                let pass = fixture.pass(Arc::clone(&fixture.status));
                async move { pass.run(&CancellationToken::new()).await }
            });
            tokio::time::timeout(SETTLE_WAIT, paused.reached)
                .await
                .expect("the first run's settle reads its facts")
                .expect("the pause reports");
            assert_eq!(
                intent.read().await,
                Some(StopIntent::Sessions(BTreeSet::from([
                    first_session,
                    second_session
                ]))),
                "no name is dropped before its settle"
            );
            intent.write_whole().await.expect("a second Stop writes");
            paused.release.send(()).expect("the settle is let go");
            tokio::time::timeout(SETTLE_WAIT, running)
                .await
                .expect("the pass ends")
                .expect("the pass's task ends");

            assert_ended_by_the_stop(&fixture, first_session, first_run);
            assert_ended_by_the_stop(&fixture, second_session, second_run);
            assert_eq!(intent.read().await, Some(StopIntent::Whole));
        }
        Case::NameDroppedMidPass => {
            let (settled_session, settled_run, _) = fixture.running_session(0).await;
            let (purged_session, empty_session) = (fixture.new_session(), fixture.new_session());
            write_names(
                &intent,
                BTreeSet::from([settled_session, purged_session, empty_session]),
            )
            .await;
            let paused = fixture.engine.restart_facts_pause().arm();
            let running = tokio::spawn({
                let pass = fixture.pass(Arc::clone(&fixture.status));
                async move { pass.run(&CancellationToken::new()).await }
            });
            tokio::time::timeout(SETTLE_WAIT, paused.reached)
                .await
                .expect("the first run's settle reads its facts")
                .expect("the pause reports");
            let refusal_of = |session_id: &SessionId| {
                refuse_call_naming_session(&fixture.status, session_id, "session.pin")
                    .err()
                    .map(|refusal| refusal.code)
            };
            assert_eq!(
                refusal_of(&empty_session),
                Some(RefusalCode::SessionRebuilding)
            );
            intent
                .drop_named(&purged_session)
                .await
                .expect("a purge drops its session's name");
            paused.release.send(()).expect("the settle is let go");
            tokio::time::timeout(SETTLE_WAIT, running)
                .await
                .expect("the pass ends")
                .expect("the pass's task ends");

            assert_ended_by_the_stop(&fixture, settled_session, settled_run);
            assert_eq!(intent.read().await, None);
            assert_eq!(refusal_of(&empty_session), None);
        }
        Case::DamagedNamed => {
            let (damaged, damaged_run) = fixture.stale_session(3, Some(1)).await;
            let (resumed_session, resumed_run, _) = fixture.running_session(1).await;
            write_names(&intent, BTreeSet::from([damaged])).await;

            run_pass(&fixture, &stop).await;

            assert_eq!(
                stored_run_state(&fixture.store.database, &damaged_run).0,
                "running"
            );
            assert_eq!(
                stored_run_state(&fixture.store.database, &resumed_run).0,
                "running"
            );
            assert_eq!(
                fixture.payloads(&resumed_session, SessionEventType::AgentRunInterrupted),
                Vec::<Value>::new()
            );
            assert_eq!(
                intent.read().await,
                Some(StopIntent::Sessions(BTreeSet::from([damaged])))
            );
        }
        Case::SettleRefused => {
            let (session_id, run_id, _) = fixture.running_session(0).await;
            intent.write_whole().await.expect("the Stop writes");
            let (first_try, second_try) = (
                fixture.engine.restart_facts_pause().arm(),
                fixture.engine.restart_facts_pause().arm(),
            );
            let running = tokio::spawn({
                let pass = fixture.pass(Arc::clone(&fixture.status));
                async move { pass.run(&CancellationToken::new()).await }
            });
            for paused in [first_try, second_try] {
                tokio::time::timeout(SETTLE_WAIT, paused.reached)
                    .await
                    .expect("the run's settle reads its facts")
                    .expect("the pause reports");
                // Queued after the read, so the settle's guard refuses its write.
                queue_message(&fixture.store.writer, session_id, run_id).await;
                paused.release.send(()).expect("the settle is let go");
            }
            tokio::time::timeout(SETTLE_WAIT, running)
                .await
                .expect("the pass ends")
                .expect("the pass's task ends");

            assert_eq!(
                stored_run_state(&fixture.store.database, &run_id).0,
                "running"
            );
            assert_eq!(
                intent.read().await,
                Some(StopIntent::Sessions(BTreeSet::from([session_id])))
            );
        }
    }
}

// A pass under the stop intent asks a running lead's provider which of its waiting messages its
// record holds, in queue order: the one it took is admitted into the run, and only the other's
// words go back into the draft. Killed by the taken set left out of the Stop's write, or the
// provider not asked (the taken message reads canceled and the draft holds both lines).
#[tokio::test]
async fn a_pass_under_the_stop_intent_admits_the_messages_the_provider_took() {
    let asked: Arc<Mutex<Vec<FindTakenMessagesParams>>> = Arc::default();
    let mut driver = MockProviderDriver::new();
    {
        let asked = Arc::clone(&asked);
        driver
            .expect_find_taken_messages()
            .times(1)
            .returning(move |params| {
                let taken = params.message_ids[..1].to_vec();
                lock(&asked).push(params);
                async move { Ok(TakenMessages { taken }) }.boxed()
            });
    }
    let fixture =
        PassFixture::over_drivers(vec![Arc::new(driver) as Arc<dyn ProviderDriver>]).await;
    fixture.end_seeded_run();
    let (session_id, run_id, _) = fixture.running_session(0).await;
    let taken = queue_message(&fixture.store.writer, session_id, run_id).await;
    let returned = queue_message(&fixture.store.writer, session_id, run_id).await;
    fixture
        .stop_intent()
        .write_whole()
        .await
        .expect("the Stop writes");

    run_pass(&fixture, &CancellationToken::new()).await;

    let asked: Vec<(RunId, Vec<QueueItemId>)> = lock(&asked)
        .iter()
        .map(|params| (params.run_id, params.message_ids.clone()))
        .collect();
    assert_eq!(asked, vec![(run_id, vec![taken, returned])]);
    assert_ended_by_the_stop(&fixture, session_id, run_id);
    assert_eq!(
        fixture.queue_item_state(taken),
        RecordedQueueItemState::Admitted
    );
    assert_eq!(
        fixture.queue_item_state(returned),
        RecordedQueueItemState::Canceled
    );
    assert_eq!(
        draft_text(&fixture, session_id).as_deref(),
        Some("Look again")
    );
}
