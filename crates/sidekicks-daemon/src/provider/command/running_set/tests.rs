use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::command::{
    AgentCommandEndedPayload, AgentCommandSubscribeFrame, CommandEnding, CommandId, ExitCode,
    RunningCommand,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeSignedInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use tokio::sync::mpsc;

use super::{
    CommandEndingAppender, CommandInput, RunningCommandFeed, RunningCommandSets, WrapperCommand,
};
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::ipc::stream::feed::{CreditGate, Feed as _};
use crate::provider::driver::contract::DriverError;
use crate::provider::port::running_command_publisher::{
    CommandActs, CommandStart, ProviderCommandEnd, ReseedScope, RunningCommandPublisher as _,
};

const SESSION: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e";
const RUN: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0f";

/// An ending as appended: the binding it went on, its payload and its body.
type Appended = (RuntimeBindingId, AgentCommandEndedPayload, Option<String>);

/// Endings handed to the test as they are appended.
struct SentEndings(mpsc::UnboundedSender<Appended>);

impl CommandEndingAppender for SentEndings {
    fn append(
        &self,
        binding_id: RuntimeBindingId,
        ending: AgentCommandEndedPayload,
        summary: Option<String>,
    ) -> BoxFuture<'_, ()> {
        self.0
            .send((binding_id, ending, summary))
            .expect("the test reads every ending");
        async {}.boxed()
    }
}

/// A provider whose stop and move answer as set, noting each act asked of it.
struct ScriptedActs {
    stop: Mutex<Option<DriverError>>,
    moved: bool,
    acts: Mutex<Vec<&'static str>>,
}

impl ScriptedActs {
    fn answering(moved: bool) -> Arc<Self> {
        Arc::new(Self {
            stop: Mutex::new(None),
            moved,
            acts: Mutex::new(Vec::new()),
        })
    }

    fn note(&self, act: &'static str) {
        self.acts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(act);
    }

    fn asked(&self) -> Vec<&'static str> {
        self.acts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl CommandActs for ScriptedActs {
    fn stop(
        &self,
        _session_id: SessionId,
        _command_id: CommandId,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.note("stop");
        let refusal = self
            .stop
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        async move { refusal.map_or(Ok(()), Err) }.boxed()
    }

    fn move_to_background(
        &self,
        _session_id: SessionId,
        _command_id: CommandId,
    ) -> BoxFuture<'_, Result<bool, DriverError>> {
        self.note("background");
        let moved = self.moved;
        async move { Ok(moved) }.boxed()
    }

    fn write_input(
        &self,
        _session_id: SessionId,
        _command_id: CommandId,
        _text: Option<String>,
        _is_end_of_input: bool,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.note("write");
        async { Ok(()) }.boxed()
    }
}

struct Fixture {
    sets: RunningCommandSets,
    endings: mpsc::UnboundedReceiver<Appended>,
    binding: Arc<Mutex<RuntimeBindingId>>,
}

fn binding(id: &str) -> RuntimeBindingId {
    RuntimeBindingId::new(id.to_owned()).expect("a binding id")
}

fn fixture() -> Fixture {
    let (sender, endings) = mpsc::unbounded_channel();
    let binding = Arc::new(Mutex::new(self::binding("binding-a")));
    let bound = Arc::clone(&binding);
    let sets = RunningCommandSets::new(
        Arc::new(move |_session: &SessionId| {
            Some(bound.lock().unwrap_or_else(PoisonError::into_inner).clone())
        }),
        Arc::new(SentEndings(sender)),
    );
    Fixture {
        sets,
        endings,
        binding,
    }
}

fn session() -> SessionId {
    SessionId::new(SESSION).expect("a session id")
}

fn command(id: &str) -> CommandId {
    CommandId::new(id.to_owned()).expect("a command id")
}

fn exit_code(code: i64) -> Option<ExitCode> {
    SafeSignedInt::new(code)
}

/// A command `id` running `name`, through `acts`.
fn start(id: &str, name: &str, acts: &Arc<ScriptedActs>) -> CommandStart {
    CommandStart {
        session_id: session(),
        command_id: command(id),
        run_id: RunId::new(RUN).expect("a run id"),
        name: NonEmptyText::new(name.to_owned()).expect("a name"),
        started_at: WireInstant::now(),
        process_id: None,
        is_backgrounded: false,
        can_move_to_background: true,
        accepts_input: false,
        acts: Arc::clone(acts) as Arc<dyn CommandActs>,
    }
}

async fn next_frame(feed: &mut RunningCommandFeed) -> AgentCommandSubscribeFrame {
    let gate = CreditGate::with_credit(1);
    tokio::time::timeout(Duration::from_secs(5), feed.next(&gate))
        .await
        .expect("a frame comes")
        .expect("the feed reads")
        .expect("the feed is open")
}

/// The set the feed sends next, skipping output.
async fn next_set(feed: &mut RunningCommandFeed) -> Vec<RunningCommand> {
    loop {
        if let AgentCommandSubscribeFrame::Commands { commands, .. } = next_frame(feed).await {
            return commands.as_slice().to_vec();
        }
    }
}

async fn next_ending(fixture: &mut Fixture) -> Appended {
    tokio::time::timeout(Duration::from_secs(5), fixture.endings.recv())
        .await
        .expect("an ending comes")
        .expect("the endings stay open")
}

fn refusal_code(error: HandlerError) -> RefusalCode {
    match error {
        HandlerError::Refused(refusal) => refusal.code,
        other @ (HandlerError::Internal(_) | HandlerError::Canceled) => {
            panic!("not a refusal: {other}")
        }
    }
}

fn end(code: Option<i64>, summary: Option<&str>) -> ProviderCommandEnd {
    ProviderCommandEnd {
        exit_code: code.and_then(SafeSignedInt::new),
        summary: summary.map(str::to_owned),
    }
}

// Each cell of the running set's table. Fails when a cell's branch is changed: the person's stop
// not ending a command by the person, a summary kept on a finished ending or dropped from a failed
// one, a reseed that keeps an unlisted background row or ends a foreground one outside its scope,
// a move refused or allowed in the wrong state, a write taken by a command that takes no input,
// a refused stop that leaves the row stopping, or a provider exit that drops the wrapper's code.
#[tokio::test]
async fn each_cell_of_the_table_moves_a_row_as_its_event_says() {
    let mut fixture = fixture();
    let acts = ScriptedActs::answering(true);
    let mut feed = fixture.sets.subscribe(session());
    assert_eq!(next_set(&mut feed).await, Vec::new());

    // Absent: output is dropped, a stop answers at once, a move and a write are refused.
    fixture
        .sets
        .publish_output(session(), command("absent"), "lost".to_owned());
    fixture
        .sets
        .stop(session(), &command("absent"))
        .await
        .expect("a command not running is stopped");
    let refused = fixture
        .sets
        .move_to_background(session(), &command("absent"))
        .await;
    assert_eq!(
        refusal_code(refused.expect_err("refused")),
        RefusalCode::AgentCommandNotInForeground
    );
    let input = CommandInput {
        text: Some("y".to_owned()),
        is_end_of_input: false,
    };
    let refused = fixture
        .sets
        .write(session(), &command("absent"), input.clone())
        .await;
    assert_eq!(
        refusal_code(refused.expect_err("refused")),
        RefusalCode::AgentCommandTakesNoInput
    );
    assert_eq!(acts.asked(), Vec::<&str>::new());

    // Start: added in the foreground; the same id again is ignored. A start in the background and
    // a move whose start was missed both add a background row.
    fixture
        .sets
        .command_started(start("stop-me", "sleep 1", &acts));
    fixture
        .sets
        .command_started(start("stop-me", "sleep 2", &acts));
    let set = next_set(&mut feed).await;
    assert_eq!(set.len(), 1);
    assert!(set[0].waiting_in_foreground && set[0].can_move_to_background);
    fixture
        .sets
        .command_moved_to_background(start("missed", "make", &acts));
    let set = next_set(&mut feed).await;
    assert!(!set[1].waiting_in_foreground && !set[1].can_move_to_background);

    // Output of a held row is an output frame.
    fixture
        .sets
        .publish_output(session(), command("stop-me"), "tick".to_owned());
    assert_eq!(
        next_frame(&mut feed).await,
        AgentCommandSubscribeFrame::Output {
            session_id: session(),
            command_id: command("stop-me"),
            data: "tick".to_owned(),
        }
    );

    // The person's stop on a running command is the provider's act; a second stop answers at once,
    // and the provider's end then ends it by the person, no summary kept.
    fixture
        .sets
        .stop(session(), &command("stop-me"))
        .await
        .expect("stopped");
    fixture
        .sets
        .stop(session(), &command("stop-me"))
        .await
        .expect("stopped again");
    assert_eq!(acts.asked(), ["stop"]);
    fixture.sets.command_ended(
        session(),
        command("stop-me"),
        end(Some(143), Some("killed")),
    );
    let (_, ending, summary) = next_ending(&mut fixture).await;
    assert_eq!(
        (ending.command_id, ending.ending, summary),
        (command("stop-me"), CommandEnding::EndedByPerson, None)
    );

    // A refused stop puts the row back as it was.
    fixture
        .sets
        .command_started(start("refuse-stop", "top", &acts));
    *acts.stop.lock().unwrap_or_else(PoisonError::into_inner) = Some(DriverError::Refused(
        DomainError::new("gone", RefusalCode::ProviderUnavailable),
    ));
    let refused = fixture.sets.stop(session(), &command("refuse-stop")).await;
    assert_eq!(
        refusal_code(refused.expect_err("refused")),
        RefusalCode::ProviderUnavailable
    );
    fixture
        .sets
        .command_ended(session(), command("refuse-stop"), end(Some(0), None));
    let (_, ending, _) = next_ending(&mut fixture).await;
    assert_eq!(ending.ending, CommandEnding::Finished);

    // The provider's own end: exit 0 finishes with no summary; a provider's stop with its summary
    // fails with the summary as the body.
    fixture.sets.command_started(start("finish", "ls", &acts));
    fixture
        .sets
        .command_ended(session(), command("finish"), end(Some(0), Some("ok")));
    let (_, ending, summary) = next_ending(&mut fixture).await;
    assert_eq!(
        (ending.ending, ending.exit_code, summary),
        (CommandEnding::Finished, exit_code(0), None)
    );
    fixture
        .sets
        .command_started(start("time-limit", "sleep 9999", &acts));
    let summary = "Stopped after 30 minutes";
    fixture
        .sets
        .command_ended(session(), command("time-limit"), end(None, Some(summary)));
    let (_, ending, kept) = next_ending(&mut fixture).await;
    assert_eq!(
        (ending.ending, kept.as_deref()),
        (CommandEnding::Failed, Some(summary))
    );

    // The person's move: a provider that cannot move a command refuses by capability, one that
    // says it no longer waits refuses as not in the foreground, and a moved row is in the
    // background, where a second move is refused without asking the provider.
    let unmovable = CommandStart {
        can_move_to_background: false,
        ..start("unmovable", "cargo build", &acts)
    };
    fixture.sets.command_started(unmovable);
    let refused = fixture
        .sets
        .move_to_background(session(), &command("unmovable"))
        .await;
    assert_eq!(
        refusal_code(refused.expect_err("refused")),
        RefusalCode::ProviderCapabilityUnsupported
    );
    let unmoved_acts = ScriptedActs::answering(false);
    fixture
        .sets
        .command_started(start("unmoved", "npm test", &unmoved_acts));
    let refused = fixture
        .sets
        .move_to_background(session(), &command("unmoved"))
        .await;
    assert_eq!(
        refusal_code(refused.expect_err("refused")),
        RefusalCode::AgentCommandNotInForeground
    );
    fixture
        .sets
        .command_started(start("move-me", "npm run dev", &acts));
    fixture
        .sets
        .move_to_background(session(), &command("move-me"))
        .await
        .expect("moved");
    let refused = fixture
        .sets
        .move_to_background(session(), &command("move-me"))
        .await;
    assert_eq!(
        refusal_code(refused.expect_err("refused")),
        RefusalCode::AgentCommandNotInForeground
    );
    assert_eq!(acts.asked(), ["stop", "stop", "background"]);

    // The person's write: refused for a command that takes no input, the provider's for one that
    // does, and an open prompt's answer, masked by its kind, the end of input answering it empty.
    let refused = fixture
        .sets
        .write(session(), &command("move-me"), input.clone())
        .await;
    assert_eq!(
        refusal_code(refused.expect_err("refused")),
        RefusalCode::AgentCommandTakesNoInput
    );
    let typed = CommandStart {
        accepts_input: true,
        ..start("typed", "python3", &acts)
    };
    fixture.sets.command_started(typed);
    fixture
        .sets
        .write(session(), &command("typed"), input.clone())
        .await
        .expect("written");
    assert_eq!(acts.asked().last(), Some(&"write"));
    fixture
        .sets
        .wrapper_started(session(), 7, WrapperCommand::Line("git push".to_owned()));
    fixture
        .sets
        .command_started(start("asking", "git push", &acts));
    let answered = Arc::new(Mutex::new(None));
    let answer = Arc::clone(&answered);
    fixture.sets.prompt_opened(
        session(),
        7,
        NonEmptyText::new("Password for 'https://me@example.com': ".to_owned()).expect("text"),
        true,
        Box::new(move |text| *answer.lock().unwrap_or_else(PoisonError::into_inner) = Some(text)),
    );
    let set = loop {
        let set = next_set(&mut feed).await;
        if set.iter().any(|row| row.prompt.is_some()) {
            break set;
        }
    };
    let asking = set
        .iter()
        .find(|row| row.command_id == command("asking"))
        .expect("the row");
    assert!(asking.echo_off && asking.waiting_for_input);
    let end_of_input = CommandInput {
        text: None,
        is_end_of_input: true,
    };
    fixture
        .sets
        .write(session(), &command("asking"), end_of_input)
        .await
        .expect("answered");
    assert_eq!(
        answered
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_deref(),
        Some("")
    );
    assert_eq!(acts.asked().last(), Some(&"write"));

    // A reseed of background commands ends the background rows it does not list, leaving the
    // foreground ones; a listed command the set lacks is added in the background.
    fixture.sets.commands_listed(
        session(),
        ReseedScope::BackgroundCommands,
        vec![start("listed", "tail -f log", &acts)],
    );
    let mut ended = Vec::new();
    for _ in 0..2 {
        let (_, ending, _) = next_ending(&mut fixture).await;
        ended.push((ending.command_id, ending.ending, ending.exit_code));
    }
    ended.sort_by(|left, right| left.0.as_str().cmp(right.0.as_str()));
    assert_eq!(
        ended,
        [
            (command("missed"), CommandEnding::Failed, None),
            (command("move-me"), CommandEnding::Failed, None),
        ]
    );

    // The provider's exit ends every row: a stopping one by the person, one whose wrapper reported
    // its exit by that code.
    fixture
        .sets
        .stop(session(), &command("listed"))
        .await
        .expect("stopped");
    fixture.sets.wrapper_exited(session(), 7, exit_code(128));
    fixture.sets.provider_exited(session());
    let mut ended = Vec::new();
    for _ in 0..5 {
        let (_, ending, _) = next_ending(&mut fixture).await;
        ended.push((
            ending.command_id.as_str().to_owned(),
            ending.ending,
            ending.exit_code,
        ));
    }
    ended.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(
        ended,
        [
            ("asking".to_owned(), CommandEnding::Failed, exit_code(128)),
            ("listed".to_owned(), CommandEnding::EndedByPerson, None),
            ("typed".to_owned(), CommandEnding::Failed, None),
            ("unmovable".to_owned(), CommandEnding::Failed, None),
            ("unmoved".to_owned(), CommandEnding::Failed, None),
        ]
    );
}

// Fails when a wrapper pairs by its line alone, so two runs of one command share a row.
#[tokio::test]
async fn two_runs_of_one_command_each_settle_their_own_row() {
    let mut fixture = fixture();
    let acts = ScriptedActs::answering(true);
    fixture
        .sets
        .command_started(start("first", "npm test", &acts));
    fixture
        .sets
        .command_started(start("second", "npm test", &acts));
    let mut feed = fixture.sets.subscribe(session());
    next_set(&mut feed).await;
    for party in [11, 12] {
        fixture.sets.wrapper_started(
            session(),
            party,
            WrapperCommand::Line("npm test".to_owned()),
        );
    }
    fixture.sets.wrapper_output(session(), 12, "second's");
    assert_eq!(
        next_frame(&mut feed).await,
        AgentCommandSubscribeFrame::Output {
            session_id: session(),
            command_id: command("second"),
            data: "second's".to_owned(),
        }
    );
    fixture.sets.wrapper_exited(session(), 11, exit_code(0));
    fixture.sets.wrapper_exited(session(), 12, exit_code(3));
    fixture.sets.provider_exited(session());
    let mut ended = Vec::new();
    for _ in 0..2 {
        let (_, ending, _) = next_ending(&mut fixture).await;
        ended.push((ending.command_id, ending.ending, ending.exit_code));
    }
    assert_eq!(
        ended,
        [
            (command("first"), CommandEnding::Finished, exit_code(0)),
            (command("second"), CommandEnding::Failed, exit_code(3)),
        ]
    );
}

// Fails when output or an ending is addressed by the binding the command started on, which a
// fork move replaces.
#[tokio::test]
async fn a_command_running_across_a_fork_move_reaches_the_new_binding() {
    let mut fixture = fixture();
    let acts = ScriptedActs::answering(true);
    fixture
        .sets
        .command_started(start("long", "cargo test", &acts));
    let mut feed = fixture.sets.subscribe(session());
    next_set(&mut feed).await;
    *fixture
        .binding
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = binding("binding-b");
    fixture
        .sets
        .publish_output(session(), command("long"), "after the move".to_owned());
    assert_eq!(
        next_frame(&mut feed).await,
        AgentCommandSubscribeFrame::Output {
            session_id: session(),
            command_id: command("long"),
            data: "after the move".to_owned(),
        }
    );
    fixture
        .sets
        .command_ended(session(), command("long"), end(Some(0), None));
    let (bound, ending, _) = next_ending(&mut fixture).await;
    assert_eq!(
        (bound, ending.command_id),
        (binding("binding-b"), command("long"))
    );
}
