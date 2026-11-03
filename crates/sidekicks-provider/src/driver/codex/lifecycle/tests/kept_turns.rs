//! The turns a restart kept, ended on the Codex service that runs them: each answer Codex gives
//! read, a stopping run's refused turn followed once, each turn bounded, the session's slot held
//! for the work, and no service started where none runs.

use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::{Map, Value, json};
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_platforms::short_socket_folder;
use tokio_util::sync::CancellationToken;

use super::super::kept_turns::{KeptTurnInterrupt, end_kept_turn};
use super::{driver_holding, driver_on_codex_folder};
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome};
use crate::driver::codex::service::supervisor::test_service::{
    UnheardEvents, start_scripted_codex_service, test_codex_service_dependencies,
};
use crate::driver::codex::service::supervisor::{
    CodexProgramResolver, CodexService, CodexServiceSocket,
};
use crate::driver::codex::session::detached_conversation::{
    CODEX_DETACHED_INTERRUPT_DEADLINE, CodexDetachedFrames,
};
use crate::driver::codex::session::errors::{CodexError, CodexUnansweredCause};
use crate::driver::codex::transport::connection::scripted_service::{
    ScriptedService, connect_scripted_service,
};
use crate::driver::codex::transport::connection::{
    CodexAppServerConnection, CodexConnectionHandlers,
};
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::{EndKeptTurnsParams, KeptRunTurns};
use crate::driver::test_registry::{new_run_id, new_session_id};
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::spawned_version::ResolvedProviderExecutable;

/// The largest message the scripted connection takes, far above any a test sends.
const MESSAGE_LIMIT: usize = 1 << 20;

/// The conversation the kept turn runs on.
const THREAD: &str = "conversation-1";

/// The turn the restart kept, under the id its start recorded.
const KEPT_TURN: &str = "turn-kept";

/// The turn Codex continued the kept one under.
const CONTINUED_TURN: &str = "turn-continued";

// A connection whose service the test scripts.
fn scripted_connection() -> (CodexAppServerConnection, ScriptedService) {
    let (events, _frames) = CodexDetachedFrames::new();
    connect_scripted_service(
        MESSAGE_LIMIT,
        CodexConnectionHandlers {
            events,
            responder: None,
            token_refresher: None,
        },
    )
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
    let (connection, mut script) = scripted_connection();
    let ending = tokio::spawn(async move {
        let ended = end_kept_turn(&connection, THREAD, KEPT_TURN, is_for_stop).await;
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
    let (connection, mut script) = scripted_connection();
    let ending = tokio::spawn(async move {
        let ended = end_kept_turn(&connection, THREAD, KEPT_TURN, true).await;
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
// a resume's claim of the slot waits until the work lets it go, then takes it. Killed by the claim
// dropped or taken after the interrupt (the resume's claim is not held back), and by the slot
// closed (the resume's claim is refused).
#[tokio::test]
async fn the_session_is_held_until_its_kept_turns_are_ended() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let mut scripted = start_scripted_codex_service();
    let driver = driver_holding(&scripted, folder.path());
    let params = kept_lead_turn(CancellationToken::new());
    let session_id = params.session_id;

    driver.end_kept_turns(params).await;
    let interrupt = next_interrupt(&mut scripted.script, KEPT_TURN).await;
    let mut resume_claim = pin!(driver.slots.claim_establishing(session_id));
    assert!(
        futures::poll!(resume_claim.as_mut()).is_pending(),
        "the resume waits while the kept turn is ended"
    );
    scripted.script.answer(&interrupt, &json!({}));

    resume_claim
        .await
        .expect("the resume claims the slot once the work let it go");
}

// The pass's stop ends the work where it stands, an interrupt still unanswered. Killed by the
// stop not selected (the work waits for the interrupt's bound, past the test's).
#[tokio::test(start_paused = true)]
async fn the_stop_ends_the_work_at_once() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let mut scripted = start_scripted_codex_service();
    let driver = driver_holding(&scripted, folder.path());
    let stop = CancellationToken::new();

    driver.end_kept_turns(kept_lead_turn(stop.clone())).await;
    next_interrupt(&mut scripted.script, KEPT_TURN).await;
    stop.cancel();
    driver.tasks.close();

    tokio::time::timeout(Duration::from_secs(1), driver.tasks.wait())
        .await
        .expect("the work ended at the stop");
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

// Where no service listens on the conversation's home, its turns ended with the old one: nothing
// is sent and no service is started. Killed by the probe dropped (the start asks for Codex's
// command, a fresh service launched for turns that ended).
#[tokio::test]
async fn no_service_is_started_where_none_kept_the_turns() {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let starts = Arc::new(CountedStarts::default());
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::clone(&starts) as _,
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let home = CodexServiceHome {
        codex_home: folder.path().join("home"),
        kind: CodexHomeKind::Account(test_provider_account_id()),
    };
    let socket = folder.path().join("codex.sock");
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
    let (mut driver, _services) = driver_on_codex_folder(folder.path());
    driver.registry =
        CodexServiceRegistry::holding_service_on(&service, dependencies, Arc::new(OneHome(home)));

    driver
        .end_kept_turns(kept_lead_turn(CancellationToken::new()))
        .await;
    driver.tasks.close();
    driver.tasks.wait().await;

    assert_eq!(starts.0.load(Ordering::SeqCst), 0);
    assert!(service.connection().is_err());
}
