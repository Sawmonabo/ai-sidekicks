use std::sync::{Arc, Mutex};
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
    CommandEndingAppender, CommandInput, PromptAnswer, RunningCommandSets, WrapperCommand,
    next_sent_frame, next_sent_set_where,
};
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::mutex_lock::lock;
use crate::provider::command::waiting_checks::WaitingState;
use crate::provider::driver::contract::{DriverError, MockProviderDriver};
use crate::provider::port::running_command_publisher::{
    CommandStart, ProviderCommandEnd, ReseedScope, RunningCommandPublisher as _,
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

/// What a scripted driver was asked, in order, and the refusal its next stop answers.
#[derive(Default)]
struct DriverScript {
    asked: Mutex<Vec<&'static str>>,
    stop_refusal: Mutex<Option<DriverError>>,
}

impl DriverScript {
    fn note(&self, act: &'static str) {
        lock(&self.asked).push(act);
    }

    fn asked(&self) -> Vec<&'static str> {
        lock(&self.asked).clone()
    }
}

/// A driver whose command acts note themselves in `script`, its stop answering the refusal the
/// script holds and its move answering `moved`.
fn scripted_driver(script: &Arc<DriverScript>, moved: bool) -> MockProviderDriver {
    let mut driver = MockProviderDriver::new();
    let stopping = Arc::clone(script);
    driver.expect_stop_command().returning(move |_| {
        stopping.note("stop");
        let refusal = lock(&stopping.stop_refusal).take();
        // The provider answers after a turn of the runtime, so a second stop can come meanwhile.
        async move {
            tokio::task::yield_now().await;
            refusal.map_or(Ok(()), Err)
        }
        .boxed()
    });
    let moving = Arc::clone(script);
    driver
        .expect_move_command_to_background()
        .returning(move |_| {
            moving.note("background");
            async move { Ok(moved) }.boxed()
        });
    let writing = Arc::clone(script);
    driver.expect_write_command_input().returning(move |_| {
        writing.note("write");
        async { Ok(()) }.boxed()
    });
    driver
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
        Arc::new(move |_session: &SessionId| Some(lock(&bound).clone())),
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

/// A command `id` running `name`.
fn start(id: &str, name: &str) -> CommandStart {
    CommandStart {
        session_id: session(),
        command_id: command(id),
        run_id: RunId::new(RUN).expect("a run id"),
        name: NonEmptyText::new(name.to_owned()).expect("a name"),
        started_at: WireInstant::now(),
        line: Some(name.to_owned()),
        process_id: None,
        is_backgrounded: false,
        can_move_to_background: true,
        accepts_input: false,
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
        is_stopped_by_provider: false,
    }
}

fn refused_stop(acts: &DriverScript) {
    *lock(&acts.stop_refusal) = Some(DriverError::Refused(DomainError::new(
        "gone",
        RefusalCode::ProviderUnavailable,
    )));
}

/// The row `id` in `set`.
fn row<'a>(set: &'a [RunningCommand], id: &str) -> &'a RunningCommand {
    set.iter()
        .find(|row| row.command_id == command(id))
        .expect("the row")
}

// Each cell of the running set's table. Fails when a cell's branch is changed: the person's stop
// not ending a command by the person, a summary kept on a finished ending or dropped from a failed
// one, a reseed that keeps an unlisted background row or ends a foreground one outside its scope,
// a move refused or allowed in the wrong state, a write taken by a command that takes no input,
// a refused stop that leaves the row stopping, a second stop answered before the first, a
// provider's own stop read by its exit code, a waiting reading dropped, a wrapper that starts
// before its row left unpaired, or a provider exit that drops the wrapper's code. Mutations:
// `facts.waiting = Some(state)` dropped; `unpaired.paired.send_replace(true)` dropped;
// `end.is_stopped_by_provider` read as false; the `Stopping` arm of `stop` answering `Ok(())` at
// once.
#[tokio::test]
async fn each_cell_of_the_table_moves_a_row_as_its_event_says() {
    let mut fixture = fixture();
    let acts = Arc::new(DriverScript::default());
    let driver = scripted_driver(&acts, true);
    let mut feed = fixture.sets.subscribe(session());
    assert_eq!(next_sent_set_where(&mut feed, |_| true).await, Vec::new());

    // Absent: output is dropped, a stop answers at once, a move and a write are refused.
    fixture
        .sets
        .publish_output(session(), command("absent"), "lost".to_owned());
    fixture
        .sets
        .stop(&driver, session(), &command("absent"))
        .await
        .expect("a command not running is stopped");
    let refused = fixture
        .sets
        .move_to_background(&driver, session(), &command("absent"))
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
        .write(&driver, session(), &command("absent"), input.clone())
        .await;
    assert_eq!(
        refusal_code(refused.expect_err("refused")),
        RefusalCode::AgentCommandTakesNoInput
    );
    assert_eq!(acts.asked(), Vec::<&str>::new());

    // Start: added in the foreground; the same id again is ignored. A start in the background and
    // a move whose start was missed both add a background row.
    fixture.sets.command_started(start("stop-me", "sleep 1"));
    fixture.sets.command_started(start("stop-me", "sleep 2"));
    let set = next_sent_set_where(&mut feed, |_| true).await;
    assert_eq!(set.len(), 1);
    assert!(set[0].waiting_in_foreground && set[0].can_move_to_background);
    fixture
        .sets
        .command_moved_to_background(start("missed", "make"));
    let set = next_sent_set_where(&mut feed, |_| true).await;
    assert!(!set[1].waiting_in_foreground && !set[1].can_move_to_background);

    // Output of a held row is an output frame.
    fixture
        .sets
        .publish_output(session(), command("stop-me"), "tick".to_owned());
    assert_eq!(
        next_sent_frame(&mut feed).await,
        AgentCommandSubscribeFrame::Output {
            session_id: session(),
            command_id: command("stop-me"),
            data: "tick".to_owned(),
        }
    );

    // The person's stop on a running command is the provider's act, sent once: a second stop while
    // it is under way is answered as it is, and the provider's end then ends it by the person, no
    // summary kept. A row stopping is moved by no one.
    let stop_me = command("stop-me");
    let (first, second) = tokio::join!(
        fixture.sets.stop(&driver, session(), &stop_me),
        fixture.sets.stop(&driver, session(), &stop_me),
    );
    first.expect("stopped");
    second.expect("stopped again");
    assert_eq!(acts.asked(), ["stop"]);
    let refused = fixture
        .sets
        .move_to_background(&driver, session(), &command("stop-me"))
        .await;
    assert_eq!(
        refusal_code(refused.expect_err("refused")),
        RefusalCode::AgentCommandNotInForeground
    );
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

    // A refused stop refuses the stop that waited on it too, and puts the row back as it was.
    fixture.sets.command_started(start("refuse-stop", "top"));
    refused_stop(&acts);
    let refuse_stop = command("refuse-stop");
    let (first, second) = tokio::join!(
        fixture.sets.stop(&driver, session(), &refuse_stop),
        fixture.sets.stop(&driver, session(), &refuse_stop),
    );
    for refused in [first, second] {
        assert_eq!(
            refusal_code(refused.expect_err("refused")),
            RefusalCode::ProviderUnavailable
        );
    }
    let set = next_sent_set_where(&mut feed, |set| {
        set.iter()
            .any(|row| row.command_id == command("refuse-stop"))
    })
    .await;
    assert!(row(&set, "refuse-stop").can_move_to_background);
    fixture
        .sets
        .command_ended(session(), command("refuse-stop"), end(Some(0), None));
    let (_, ending, _) = next_ending(&mut fixture).await;
    assert_eq!(ending.ending, CommandEnding::Finished);

    // The provider's own end: exit 0 finishes with no summary; a provider's stop with its summary
    // fails with the summary as the body, even where its wrapper's command exited 0.
    fixture.sets.command_started(start("finish", "ls"));
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
        .command_started(start("time-limit", "sleep 9999"));
    fixture
        .sets
        .wrapper_started(session(), 3, WrapperCommand::Line("sleep 9999".to_owned()));
    fixture.sets.wrapper_exited(session(), 3, exit_code(0));
    let summary = "Stopped after 30 minutes";
    let stopped = ProviderCommandEnd {
        is_stopped_by_provider: true,
        ..end(None, Some(summary))
    };
    fixture
        .sets
        .command_ended(session(), command("time-limit"), stopped);
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
        ..start("unmovable", "cargo build")
    };
    fixture.sets.command_started(unmovable);
    let refused = fixture
        .sets
        .move_to_background(&driver, session(), &command("unmovable"))
        .await;
    assert_eq!(
        refusal_code(refused.expect_err("refused")),
        RefusalCode::ProviderCapabilityUnsupported
    );
    let unmoved_driver = scripted_driver(&Arc::new(DriverScript::default()), false);
    fixture.sets.command_started(start("unmoved", "npm test"));
    let refused = fixture
        .sets
        .move_to_background(&unmoved_driver, session(), &command("unmoved"))
        .await;
    assert_eq!(
        refusal_code(refused.expect_err("refused")),
        RefusalCode::AgentCommandNotInForeground
    );
    fixture
        .sets
        .command_started(start("move-me", "npm run dev"));
    fixture
        .sets
        .move_to_background(&driver, session(), &command("move-me"))
        .await
        .expect("moved");
    let refused = fixture
        .sets
        .move_to_background(&driver, session(), &command("move-me"))
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
        .write(&driver, session(), &command("move-me"), input.clone())
        .await;
    assert_eq!(
        refusal_code(refused.expect_err("refused")),
        RefusalCode::AgentCommandTakesNoInput
    );
    let typed = CommandStart {
        accepts_input: true,
        ..start("typed", "python3")
    };
    fixture.sets.command_started(typed);
    fixture
        .sets
        .write(&driver, session(), &command("typed"), input.clone())
        .await
        .expect("written");
    assert_eq!(acts.asked().last(), Some(&"write"));
    // A wrapper that starts before its row pairs once the row comes.
    let paired =
        fixture
            .sets
            .wrapper_started(session(), 7, WrapperCommand::Line("git push".to_owned()));
    assert!(!*paired.borrow());
    fixture.sets.command_started(start("asking", "git push"));
    assert!(*paired.borrow());
    // A waiting reading reaches the row.
    let reading = WaitingState {
        is_waiting: true,
        is_echo_off: true,
    };
    fixture.sets.waiting_read(session(), 7, reading);
    let set = next_sent_set_where(&mut feed, |set| {
        set.iter()
            .any(|row| row.command_id == command("asking") && row.waiting_for_input)
    })
    .await;
    assert!(row(&set, "asking").echo_off && row(&set, "asking").prompt.is_none());
    fixture.sets.waiting_read(
        session(),
        7,
        WaitingState {
            is_waiting: false,
            is_echo_off: false,
        },
    );
    let answered = Arc::new(Mutex::new(None));
    let answer = Arc::clone(&answered);
    fixture.sets.prompt_opened(
        session(),
        7,
        70,
        NonEmptyText::new("Password for 'https://me@example.com': ".to_owned()).expect("text"),
        true,
        PromptAnswer::new(move |text| {
            *lock(&answer) = Some(text);
        }),
    );
    let set =
        next_sent_set_where(&mut feed, |set| set.iter().any(|row| row.prompt.is_some())).await;
    let asking = row(&set, "asking");
    assert!(asking.echo_off && asking.waiting_for_input);
    let end_of_input = CommandInput {
        text: None,
        is_end_of_input: true,
    };
    fixture
        .sets
        .write(&driver, session(), &command("asking"), end_of_input)
        .await
        .expect("answered");
    assert_eq!(lock(&answered).as_deref(), Some(""));
    assert_eq!(acts.asked().last(), Some(&"write"));

    // A stopping row still takes the person's write.
    fixture
        .sets
        .stop(&driver, session(), &command("typed"))
        .await
        .expect("stopped");
    fixture
        .sets
        .write(&driver, session(), &command("typed"), input.clone())
        .await
        .expect("written while stopping");
    assert_eq!(acts.asked().last(), Some(&"write"));

    // A reseed of background commands ends the background rows it does not list, leaving the
    // foreground ones: failed with no exit code, its wrapper's included, or by the person for one
    // stopping. A listed command the set lacks is added in the background.
    fixture
        .sets
        .stop(&driver, session(), &command("missed"))
        .await
        .expect("stopped");
    fixture
        .sets
        .wrapper_started(session(), 8, WrapperCommand::Line("npm run dev".to_owned()));
    fixture.sets.wrapper_exited(session(), 8, exit_code(5));
    fixture.sets.commands_listed(
        session(),
        ReseedScope::BackgroundCommands,
        vec![start("listed", "tail -f log")],
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
            (command("missed"), CommandEnding::EndedByPerson, None),
            (command("move-me"), CommandEnding::Failed, None),
        ]
    );

    // A reseed of every command ends a foreground row it does not list too.
    fixture.sets.commands_listed(
        session(),
        ReseedScope::EveryCommand,
        ["asking", "listed", "typed", "unmovable"]
            .into_iter()
            .map(|id| start(id, id))
            .collect(),
    );
    let (_, ending, _) = next_ending(&mut fixture).await;
    assert_eq!(
        (ending.command_id, ending.ending, ending.exit_code),
        (command("unmoved"), CommandEnding::Failed, None)
    );

    // The provider's exit ends every row: a stopping one by the person, one whose wrapper reported
    // its exit by that code.
    fixture
        .sets
        .stop(&driver, session(), &command("listed"))
        .await
        .expect("stopped");
    fixture.sets.wrapper_exited(session(), 7, exit_code(128));
    fixture.sets.provider_exited(session());
    let mut ended = Vec::new();
    for _ in 0..4 {
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
            ("typed".to_owned(), CommandEnding::EndedByPerson, None),
            ("unmovable".to_owned(), CommandEnding::Failed, None),
        ]
    );
}

// Fails when a feed holds a slow reader's output past the command's live tail, or loses the
// newest piece: after 300 KiB the reader's output ends with the last piece written and holds no
// more than the tail. Mutation: in `OutputRing::push`, drop the cut.
#[tokio::test]
async fn a_slow_reader_reads_the_live_tail_ending_with_the_last_piece() {
    let fixture = fixture();
    fixture.sets.command_started(start("loud", "yes"));
    let mut feed = fixture.sets.subscribe(session());
    next_sent_set_where(&mut feed, |_| true).await;
    let piece = "x".repeat(1023) + "\n";
    for _ in 0..300 {
        fixture
            .sets
            .publish_output(session(), command("loud"), piece.clone());
    }
    fixture
        .sets
        .publish_output(session(), command("loud"), "the end".to_owned());
    let AgentCommandSubscribeFrame::Output { data, .. } = next_sent_frame(&mut feed).await else {
        panic!("an output frame comes");
    };
    assert!(data.ends_with("the end"));
    assert!(data.len() <= 64 * 1024, "{} bytes", data.len());
}

// Fails when a wrapper pairs by its line alone, so two runs of one command share a row.
#[tokio::test]
async fn two_runs_of_one_command_each_settle_their_own_row() {
    let mut fixture = fixture();
    fixture.sets.command_started(start("first", "npm test"));
    fixture.sets.command_started(start("second", "npm test"));
    let mut feed = fixture.sets.subscribe(session());
    next_sent_set_where(&mut feed, |_| true).await;
    for party in [11, 12] {
        fixture.sets.wrapper_started(
            session(),
            party,
            WrapperCommand::Line("npm test".to_owned()),
        );
    }
    fixture.sets.wrapper_output(session(), 12, "second's");
    assert_eq!(
        next_sent_frame(&mut feed).await,
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

// Fails when an ending is appended on the binding the command started on, which a fork move
// replaces.
#[tokio::test]
async fn a_command_running_across_a_fork_move_ends_on_the_new_binding() {
    let mut fixture = fixture();
    fixture.sets.command_started(start("long", "cargo test"));
    *lock(&fixture.binding) = binding("binding-b");
    fixture
        .sets
        .command_ended(session(), command("long"), end(Some(0), None));
    let (bound, ending, _) = next_ending(&mut fixture).await;
    assert_eq!(
        (bound, ending.command_id),
        (binding("binding-b"), command("long"))
    );
}
