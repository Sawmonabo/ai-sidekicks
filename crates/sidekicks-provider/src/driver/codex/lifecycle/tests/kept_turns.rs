//! The turns a restart kept, ended on the Codex service that runs them: each answer Codex gives
//! read, a stopping run's refused turn followed once, each turn bounded, the session's slot held
//! for the work, the service the home's record keeps joined, draining or not, with none started
//! and the daemon's own taken only where the record names it, a close or a cut join read against
//! whether that service ended, and a service that cannot be joined passed over for the next.

use std::path::Path;
use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::future::BoxFuture;
use interprocess::local_socket::traits::tokio::Listener as _;
use rstest::rstest;
use serde_json::{Map, Value, json};
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_platforms::short_socket_folder;
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio_util::sync::CancellationToken;

use super::super::kept_turns::{
    KeptTurnInterrupt, end_kept_turn, join_kept_service, read_end_after_close,
};
use super::{driver_holding, driver_on_codex_folder};
use crate::captured_logs::CapturedLogs;
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome};
use crate::driver::codex::service::supervisor::test_service::{
    StandInReplies, UnheardEvents, answer_as_codex_service, bind_test_listener,
    keep_former_service, keep_former_service_beside, start_scripted_codex_service,
    test_codex_service_dependencies,
};
use crate::driver::codex::service::supervisor::{
    CodexProgramResolver, CodexService, CodexServiceSocket,
};
use crate::driver::codex::session::detached_conversation::CODEX_DETACHED_INTERRUPT_DEADLINE;
use crate::driver::codex::session::errors::{CodexError, CodexUnansweredCause};
use crate::driver::codex::transport::connection::scripted_service::{
    ScriptedService, scripted_connection,
};
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::{EndKeptTurnsParams, KeptRunTurns};
use crate::driver::test_registry::{new_run_id, new_session_id};
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::spawned_version::ResolvedProviderExecutable;

/// The conversation the kept turn runs on.
const THREAD: &str = "conversation-1";

/// The turn the restart kept, under the id its start recorded.
const KEPT_TURN: &str = "turn-kept";

/// The turn Codex continued the kept one under.
const CONTINUED_TURN: &str = "turn-continued";

// The bound of one kept turn's end, from now.
fn kept_turn_deadline() -> tokio::time::Instant {
    tokio::time::Instant::now() + CODEX_DETACHED_INTERRUPT_DEADLINE
}

// Answers the request `sent` with `answer`, a JSON-RPC `result` or `error` member.
fn reply(script: &ScriptedService, sent: &Value, answer: Value) {
    let mut reply = answer;
    reply["id"] = sent["id"].clone();
    script.send(&reply);
}

// Codex's `-32600` refusal in `message`.
fn refusal(message: &str) -> Value {
    json!({ "error": { "code": -32600, "message": message } })
}

// The newest turn listed as `turn_id` in `status`.
fn newest_turn(turn_id: &str, status: &str) -> Value {
    json!({ "result": { "data": [{ "id": turn_id, "status": status }] } })
}

// Reads the interrupt the connection sent next and checks it names `turn_id` on the conversation.
async fn next_interrupt(script: &mut ScriptedService, turn_id: &str) -> Value {
    let interrupt = script.next_sent().await;
    assert_eq!(interrupt["method"], "turn/interrupt");
    assert_eq!(
        interrupt["params"],
        json!({ "threadId": THREAD, "turnId": turn_id })
    );
    interrupt
}

// What a refused interrupt's follow is answered: the newest turn's listing, then the one interrupt
// it sends, with the turn it names and Codex's answer.
struct Follow {
    listed: Value,
    interrupted: Option<(&'static str, Value)>,
}

// One kept turn ended: one interrupt with its recorded id, read by Codex's answer; a refused turn
// of a stopping run is followed once, the newest turn first and the refusal's `found` turn only
// where none runs, and a refusal for a run not stopping is not followed. Every case ends with
// nothing more sent. Killed by the newest turn not read or read and not interrupted, by the
// `found` turn dropped or tried before the listing (the continued case names another), by a
// follow followed again, by an ended answer read as a failure, by a follow for a run not
// stopping, and by an empty `turnId` sent.
#[rstest]
#[case::stopped(json!({ "result": {} }), true, None, KeptTurnInterrupt::Stopped)]
#[case::already_ended(
    refusal("no active turn to interrupt"),
    true,
    None,
    KeptTurnInterrupt::AlreadyEnded
)]
#[case::thread_gone(
    refusal("thread not found: conversation-1"),
    true,
    None,
    KeptTurnInterrupt::ThreadGone
)]
#[case::continued_under_another_id(
    refusal("expected active turn id turn-kept but found turn-other"),
    true,
    Some(Follow {
        listed: newest_turn(CONTINUED_TURN, "inProgress"),
        interrupted: Some((CONTINUED_TURN, json!({ "result": {} }))),
    }),
    KeptTurnInterrupt::Stopped
)]
#[case::running_turn_named(
    refusal("expected active turn id turn-kept but found turn-continued"),
    true,
    Some(Follow {
        listed: newest_turn(KEPT_TURN, "completed"),
        interrupted: Some((CONTINUED_TURN, json!({ "result": {} }))),
    }),
    KeptTurnInterrupt::Stopped
)]
#[case::no_turn_named(
    refusal("expected active turn id turn-kept but found "),
    true,
    Some(Follow { listed: newest_turn(KEPT_TURN, "completed"), interrupted: None }),
    KeptTurnInterrupt::Refused {
        message: "expected active turn id turn-kept but found ".to_owned(),
    }
)]
#[case::follow_refused(
    refusal("expected active turn id turn-kept but found turn-other"),
    true,
    Some(Follow {
        listed: newest_turn(CONTINUED_TURN, "inProgress"),
        interrupted: Some((
            CONTINUED_TURN,
            refusal("expected active turn id turn-continued but found turn-third"),
        )),
    }),
    KeptTurnInterrupt::Refused {
        message: "expected active turn id turn-continued but found turn-third".to_owned(),
    }
)]
#[case::not_for_stop(
    refusal("expected active turn id turn-kept but found turn-continued"),
    false,
    None,
    KeptTurnInterrupt::Refused {
        message: "expected active turn id turn-kept but found turn-continued".to_owned(),
    }
)]
#[tokio::test]
async fn a_kept_turn_is_ended_by_codexs_answer_and_followed_once_for_a_stop(
    #[case] answer: Value,
    #[case] is_for_stop: bool,
    #[case] follow: Option<Follow>,
    #[case] expected: KeptTurnInterrupt,
) {
    let (connection, mut script, _frames) = scripted_connection();
    let ending = tokio::spawn(async move {
        let ended = end_kept_turn(
            &connection,
            THREAD,
            KEPT_TURN,
            is_for_stop,
            kept_turn_deadline(),
        )
        .await;
        (connection, ended)
    });

    let interrupt = next_interrupt(&mut script, KEPT_TURN).await;
    reply(&script, &interrupt, answer);
    if let Some(follow) = follow {
        let list = script.next_sent().await;
        assert_eq!(list["method"], "thread/turns/list");
        assert_eq!(list["params"]["threadId"], THREAD);
        assert_eq!(list["params"]["limit"], 1);
        reply(&script, &list, follow.listed);
        if let Some((turn_id, answer)) = follow.interrupted {
            let followed = next_interrupt(&mut script, turn_id).await;
            reply(&script, &followed, answer);
        }
    }
    let (_connection, ended) = ending.await.expect("the end ran");

    assert_eq!(ended.expect("the turn's end is read"), expected);
    assert!(
        script.sent.try_recv().is_err(),
        "nothing else is sent to the service"
    );
}

// An interrupt Codex never answers fails at the kept turn's own bound, before the connection's
// longer one, with nothing more sent. Killed by the bound dropped (the connection's own deadline
// answers, naming its longer wait).
#[tokio::test(start_paused = true)]
async fn an_unanswered_interrupt_fails_at_its_bound() {
    let (connection, mut script, _frames) = scripted_connection();
    let ending = tokio::spawn(async move {
        let ended = end_kept_turn(&connection, THREAD, KEPT_TURN, true, kept_turn_deadline()).await;
        (connection, ended)
    });

    next_interrupt(&mut script, KEPT_TURN).await;
    let (_connection, ended) = ending.await.expect("the end ran");

    assert!(
        matches!(
            ended,
            Err(CodexError::Unanswered {
                cause: CodexUnansweredCause::Deadline { timeout },
                ..
            }) if timeout == CODEX_DETACHED_INTERRUPT_DEADLINE
        ),
        "the turn failed at its bound: {ended:?}"
    );
    assert!(script.sent.try_recv().is_err());
}

// One stopping lead's turn the restart kept, in a new session on the test's account.
fn kept_lead_turn(stop: CancellationToken) -> EndKeptTurnsParams {
    EndKeptTurnsParams {
        session_id: new_session_id(),
        provider_account_id: test_provider_account_id(),
        conversation: THREAD.to_owned(),
        runtime_metadata: Map::new(),
        runs: vec![KeptRunTurns {
            run_id: new_run_id(),
            subagent_id: None,
            turn_ids: vec![ProviderTurnId::new(KEPT_TURN.to_owned()).expect("a turn id")],
            is_for_stop: true,
        }],
        stop,
    }
}

// The entry answers once its task holds the session's slot, before the interrupt is answered, and
// a resume's claim of the slot waits until the work lets it go, then takes it; the ending reads
// ended only once the interrupt has answered. Killed by the claim dropped or taken after the
// interrupt (the resume's claim is not held back), by the slot closed (the resume's claim is
// refused), and by the ending sent at the claim (it reads ended while the interrupt is held).
#[tokio::test(flavor = "multi_thread")]
async fn the_session_is_held_until_its_kept_turns_are_ended() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let mut scripted = start_scripted_codex_service();
    let driver = driver_holding(&scripted, folder.path());
    // The home's record names the daemon's own process, so the turns go over its connection.
    let own_socket = folder.path().join("own.sock");
    let own = keep_former_service(&scripted.service, folder.path(), &own_socket, false).await;
    scripted.report_process(own.record().id());
    let params = kept_lead_turn(CancellationToken::new());
    let session_id = params.session_id;

    let ending = driver.end_kept_turns(params).await;
    let interrupt = next_interrupt(&mut scripted.script, KEPT_TURN).await;
    // The stand-in outlives the test otherwise, so it ends before any assertion can fail.
    own.kill().expect("the stand-in is ended");
    let mut resume_claim = pin!(driver.slots.claim_establishing(session_id));
    assert!(
        futures::poll!(resume_claim.as_mut()).is_pending(),
        "the resume waits while the kept turn is ended"
    );
    let mut ended = pin!(ending.ended());
    assert!(
        futures::poll!(ended.as_mut()).is_pending(),
        "the ending waits while the interrupt is held"
    );
    scripted.script.answer(&interrupt, &json!({}));

    resume_claim
        .await
        .expect("the resume claims the slot once the work let it go");
    assert!(
        ended.await,
        "the ending reads ended once the interrupt answered"
    );
}

// The pass's stop ends the work where it stands, an interrupt still unanswered, and the ending
// reads cut. Killed by the stop not selected (the work waits for the interrupt's bound, past the
// test's), and by a stop read as answered (the ending reads ended).
#[tokio::test(flavor = "multi_thread")]
async fn the_stop_ends_the_work_at_once() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let mut scripted = start_scripted_codex_service();
    let driver = driver_holding(&scripted, folder.path());
    // The home's record names the daemon's own process, so the turns go over its connection.
    let own_socket = folder.path().join("own.sock");
    let own = keep_former_service(&scripted.service, folder.path(), &own_socket, false).await;
    scripted.report_process(own.record().id());
    let stop = CancellationToken::new();

    let ending = driver.end_kept_turns(kept_lead_turn(stop.clone())).await;
    next_interrupt(&mut scripted.script, KEPT_TURN).await;
    // The stand-in outlives the test otherwise, so it ends before any assertion can fail.
    own.kill().expect("the stand-in is ended");
    stop.cancel();
    driver.tasks.close();

    tokio::time::timeout(Duration::from_secs(1), driver.tasks.wait())
        .await
        .expect("the work ended at the stop");
    assert!(!ending.ended().await, "the ending reads cut by the stop");
}

// A program resolver that counts each start that asks for Codex's command and fails it.
#[derive(Default)]
struct CountedStarts(AtomicUsize);

impl CodexProgramResolver for CountedStarts {
    fn resolve<'call>(
        &'call self,
        _home: &'call CodexServiceHome,
    ) -> BoxFuture<'call, Result<ResolvedProviderExecutable, DriverError>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(DriverError::Internal("no codex runs here".into())) })
    }
}

// A driver whose registry holds an unstarted account service on `folder`, its home made, whose
// starts `starts` counts; the home's own socket is `codex.sock` there.
fn driver_with_unstarted_service(
    folder: &Path,
    starts: &Arc<CountedStarts>,
) -> (CodexDriver, Arc<CodexService>) {
    let dependencies = test_codex_service_dependencies(
        folder,
        Arc::clone(starts) as _,
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let home = CodexServiceHome {
        codex_home: folder.join("home"),
        kind: CodexHomeKind::Account(test_provider_account_id()),
    };
    std::fs::create_dir_all(&home.codex_home).expect("the home is made");
    let socket = folder.join("codex.sock");
    let service = CodexService::new(
        home.clone(),
        CodexServiceSocket {
            path: socket.clone(),
            home_socket: socket,
        },
        CodexServiceKind::Account,
        Arc::clone(&dependencies),
        Vec::new(),
    );
    let (mut driver, _services) = driver_on_codex_folder(folder);
    driver.registry =
        CodexServiceRegistry::holding_service_on(&service, dependencies, Arc::new(OneHome(home)));
    (driver, service)
}

// Where no service listens on the conversation's home, its turns ended with the old one: nothing
// is sent, no service is started and the ending reads ended. Killed by a start in place of the
// join (the start asks for Codex's command, a fresh service launched for turns that ended), and by
// the early return dropping the ending's sender (it reads cut, which keeps the name for good).
#[tokio::test]
async fn no_service_is_started_where_none_kept_the_turns() {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let starts = Arc::new(CountedStarts::default());
    let (driver, service) = driver_with_unstarted_service(folder.path(), &starts);

    let ending = driver
        .end_kept_turns(kept_lead_turn(CancellationToken::new()))
        .await;
    driver.tasks.close();
    driver.tasks.wait().await;

    assert_eq!(starts.0.load(Ordering::SeqCst), 0);
    assert!(service.connection().is_err());
    assert!(ending.ended().await, "the turns ended with the old service");
}

// A kept service draining toward its exit still runs the turn the restart kept, on a socket of
// its own while nothing listens on the home's: the turn is interrupted there and no service is
// started. Killed by the draining record answered `None` or the home's socket probed in its place
// (no interrupt reaches the kept service), and by a start in place of the join (the start asks
// for Codex's command).
#[tokio::test(flavor = "multi_thread")]
async fn a_draining_kept_service_is_joined_and_never_started() {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let kept_socket = folder.path().join("kept.sock");
    let mut received = answer_as_kept_service(&kept_socket);
    let starts = Arc::new(CountedStarts::default());
    let (driver, service) = driver_with_unstarted_service(folder.path(), &starts);
    let kept = keep_former_service(&service, folder.path(), &kept_socket, true).await;

    driver
        .end_kept_turns(kept_lead_turn(CancellationToken::new()))
        .await;
    driver.tasks.close();
    driver.tasks.wait().await;
    // The stand-in outlives the test otherwise, so it ends before any assertion can fail.
    kept.kill().expect("the kept service is ended");

    assert_kept_turn_interrupted(&mut received);
    assert_eq!(starts.0.load(Ordering::SeqCst), 0);
    assert!(service.connection().is_err());
}

// A service the daemon started on the home beside a draining one leaves the home's record naming
// the draining process, which still runs the turn the restart kept: the turn is interrupted there
// and nothing goes over the daemon's own connection. Killed by the daemon's own connection taken
// first (the interrupt reaches the fresh service, which never held the turn).
#[tokio::test(flavor = "multi_thread")]
async fn a_draining_record_beside_a_fresh_service_takes_the_interrupt() {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let kept_socket = folder.path().join("kept.sock");
    let mut received = answer_as_kept_service(&kept_socket);
    let mut fresh = start_scripted_codex_service();
    let driver = driver_holding(&fresh, folder.path());
    let kept = keep_former_service(&fresh.service, folder.path(), &kept_socket, true).await;

    driver
        .end_kept_turns(kept_lead_turn(CancellationToken::new()))
        .await;
    driver.tasks.close();
    driver.tasks.wait().await;
    // The stand-in outlives the test otherwise, so it ends before any assertion can fail.
    kept.kill().expect("the kept service is ended");

    assert_kept_turn_interrupted(&mut received);
    assert!(
        fresh.script.sent.try_recv().is_err(),
        "nothing goes over the daemon's own connection"
    );
}

// Answers as a kept Codex service on `kept_socket`, each request it is sent told on the answer.
fn answer_as_kept_service(kept_socket: &Path) -> UnboundedReceiver<Value> {
    let listener =
        bind_test_listener(kept_socket).expect("the system binds a local socket listener");
    let (requests, received) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok(stream) = listener.accept().await {
            let requests = requests.clone();
            tokio::spawn(answer_as_codex_service(
                stream,
                StandInReplies::default(),
                move |request| {
                    let _unread = requests.send(request.clone());
                },
            ));
        }
    });
    received
}

// Checks the kept turn's interrupt was among the requests `received` was told.
fn assert_kept_turn_interrupted(received: &mut UnboundedReceiver<Value>) {
    let mut sent = Vec::new();
    while let Ok(request) = received.try_recv() {
        sent.push(request);
    }
    assert!(
        sent.iter()
            .any(|request| request["method"] == "turn/interrupt"
                && request["params"] == json!({ "threadId": THREAD, "turnId": KEPT_TURN })),
        "the kept turn was not interrupted on the kept service: {sent:?}"
    );
}

// A connection that closed before Codex answered the interrupt reads the service's record again:
// a process that has ended ended the turn with it, and one still running leaves the failure.
// Killed by the record not read again (the ended case answers the failure).
#[rstest]
#[case::the_service_ended(true)]
#[case::the_service_runs(false)]
#[tokio::test(flavor = "multi_thread")]
async fn a_close_after_the_interrupt_reads_the_turn_ended_with_its_service(
    #[case] has_service_ended: bool,
) {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let starts = Arc::new(CountedStarts::default());
    let (_driver, service) = driver_with_unstarted_service(folder.path(), &starts);
    let kept_socket = folder.path().join("kept.sock");
    let kept = keep_former_service(&service, folder.path(), &kept_socket, true).await;
    if has_service_ended {
        kept.kill().expect("the kept service is ended");
        kept.wait_for_end()
            .await
            .expect("the kept service's end reads");
    }
    let closed = Err(CodexError::Unanswered {
        method: "turn/interrupt".to_owned(),
        cause: CodexUnansweredCause::ConnectionClosed {
            reason: "the service disconnected every client".to_owned(),
        },
    });

    let ended =
        read_end_after_close(&service, kept.record().id(), closed, kept_turn_deadline()).await;
    // The stand-in outlives the test otherwise, so it ends before any assertion can fail.
    kept.kill().expect("the kept service is ended");

    if has_service_ended {
        assert_eq!(
            ended.expect("the turn's end is read"),
            KeptTurnInterrupt::EndedWithService
        );
    } else {
        assert!(
            matches!(
                ended,
                Err(CodexError::Unanswered {
                    cause: CodexUnansweredCause::ConnectionClosed { .. },
                    ..
                })
            ),
            "the close stands while the service runs: {ended:?}"
        );
    }
}

// A join cut while connecting reads the service's record again: a process that has ended leaves
// no service to join and no failure, and one still running reports the cut. Killed by the record
// not read again (the ended case answers the failure).
#[rstest]
#[case::the_service_ended(true)]
#[case::the_service_runs(false)]
#[tokio::test(flavor = "multi_thread")]
async fn a_join_cut_while_connecting_reads_whether_the_service_ended(
    #[case] has_service_ended: bool,
) {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let kept_socket = folder.path().join("kept.sock");
    let listener =
        bind_test_listener(&kept_socket).expect("the system binds a local socket listener");
    let starts = Arc::new(CountedStarts::default());
    let (_driver, service) = driver_with_unstarted_service(folder.path(), &starts);
    let kept = Arc::new(keep_former_service(&service, folder.path(), &kept_socket, true).await);
    let exiting = Arc::clone(&kept);
    // The first connection is the probe; the service cuts the join's, ending first where it exits.
    tokio::spawn(async move {
        let mut accepted = 0;
        while let Ok(stream) = listener.accept().await {
            accepted += 1;
            if accepted > 1 && has_service_ended {
                exiting.kill().expect("the kept service is ended");
                exiting
                    .wait_for_end()
                    .await
                    .expect("the kept service's end reads");
            }
            drop(stream);
        }
    });

    let joined = join_kept_service(&service, kept_turn_deadline()).await;
    // The stand-in outlives the test otherwise, so it ends before any assertion can fail.
    kept.kill().expect("the kept service is ended");

    if has_service_ended {
        assert!(
            matches!(&joined, Ok(connections) if connections.is_empty()),
            "an ended service leaves nothing to join and no failure: {:?}",
            joined.map(|connections| connections.len())
        );
    } else {
        assert!(
            joined.is_err(),
            "the cut is reported while the service runs: {:?}",
            joined.map(|connections| connections.len())
        );
    }
}

// A kept service whose join fails while it runs is logged once and passed over, and the next one
// the home's records keep is still joined. Killed by the join that returns at the first failure,
// which joins neither.
#[tokio::test(flavor = "multi_thread")]
async fn a_kept_service_that_cannot_be_joined_leaves_the_next_one_joined() {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let starts = Arc::new(CountedStarts::default());
    let (_driver, service) = driver_with_unstarted_service(folder.path(), &starts);
    // The home's own record: a service that takes the probe and cuts every join.
    let cut_socket = folder.path().join("cut.sock");
    let listener =
        bind_test_listener(&cut_socket).expect("the system binds a local socket listener");
    tokio::spawn(async move {
        while let Ok(stream) = listener.accept().await {
            drop(stream);
        }
    });
    let cut = keep_former_service(&service, folder.path(), &cut_socket, false).await;
    // A record of its own: a service beside it that answers as Codex.
    let beside_folder = folder.path().join("beside");
    std::fs::create_dir_all(&beside_folder).expect("the folder is made");
    let beside_socket = folder.path().join("beside.sock");
    let _requests = answer_as_kept_service(&beside_socket);
    let beside =
        keep_former_service_beside(&service, &beside_folder, &beside_socket, &beside_socket).await;
    let (logs, logging) = CapturedLogs::start();

    let joined = join_kept_service(&service, kept_turn_deadline()).await;
    drop(logging);
    // The stand-ins outlive the test otherwise, so they end before any assertion can fail.
    cut.kill().expect("the cut service is ended");
    beside.kill().expect("the service beside is ended");

    let joined: Vec<u32> = joined
        .expect("the service beside is joined")
        .iter()
        .map(|kept| kept.process_id)
        .collect();
    assert_eq!(joined, [beside.record().id()]);
    assert_eq!(
        logs.text()
            .matches("could not be joined; the others are")
            .count(),
        1,
        "the cut join is not logged once: {}",
        logs.text()
    );
}
