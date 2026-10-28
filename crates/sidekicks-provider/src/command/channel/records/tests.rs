use std::collections::HashMap;
use std::io::{BufRead as _, BufReader, Write as _};
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use hpke::Kem as _;
use sidekicks_contracts::command::{
    AgentCommandEndedPayload, AgentCommandSubscribeFrame, CommandId,
};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::BoundedInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_platforms::{InputTerminal, InputWaitReading, TerminalSignal, send_signal};
use tokio::sync::watch;

use super::{RecordFollower, follow_channel_records, tail_output};
use crate::command::channel::tests::{
    end_party, names_in, open_channel, party_command, ready_parties, sealed,
};
use crate::command::channel::{
    ChannelKem, PartyId, PartyRecord, REQUESTS_FOLDER, record_name, write_record,
};
use crate::command::running_set::{
    CommandEndingAppender, CommandInput, RunningCommandFeed, RunningCommandSets, WrapperCommand,
    next_sent_frame, next_sent_set_where, unbound_running_command_sets,
};
use crate::command::waiting_checks::InputWaitReader;
use crate::driver::contract::MockProviderDriver;
use crate::port::running_command_publisher::{CommandStart, RunningCommandPublisher as _};

const SESSION: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e";

/// Endings handed to the test as they are appended.
struct SentEndings(tokio::sync::mpsc::UnboundedSender<AgentCommandEndedPayload>);

impl CommandEndingAppender for SentEndings {
    fn append(
        &self,
        _binding_id: RuntimeBindingId,
        ending: AgentCommandEndedPayload,
        _summary: Option<String>,
    ) -> BoxFuture<'_, ()> {
        self.0.send(ending).expect("the test reads every ending");
        async {}.boxed()
    }
}

/// Input waits for a test whose commands report no terminal.
struct NoTerminals;

impl InputWaitReader for NoTerminals {
    fn may_wait<'a>(
        &'a self,
        _terminal: &'a InputTerminal,
    ) -> BoxFuture<'a, std::io::Result<bool>> {
        async { Ok(false) }.boxed()
    }

    fn read<'a>(
        &'a self,
        _terminal: &'a InputTerminal,
    ) -> BoxFuture<'a, std::io::Result<InputWaitReading>> {
        async { Err(std::io::Error::other("no terminal")) }.boxed()
    }
}

fn session() -> SessionId {
    SessionId::new(SESSION).expect("a session id")
}

/// The start of a row `id` whose line runs `id`.
fn row_start(id: &str) -> CommandStart {
    CommandStart {
        session_id: session(),
        command_id: CommandId::new(id.to_owned()).expect("a command id"),
        run_id: RunId::new("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0f").expect("a run id"),
        name: NonEmptyText::new(id.to_owned()).expect("a name"),
        started_at: WireInstant::now(),
        line: Some(id.to_owned()),
        process_id: None,
        is_backgrounded: false,
        can_move_to_background: false,
        accepts_input: false,
    }
}

/// A row `id` paired to the wrapper `party`, whose output the tail reads from a new file.
struct TailedRow {
    file: std::fs::File,
    exited: watch::Sender<bool>,
    tail: tokio::task::JoinHandle<()>,
    _folder: tempfile::TempDir,
}

fn tailed_row(sets: &Arc<RunningCommandSets>, id: &str, party: PartyId) -> TailedRow {
    sets.command_started(row_start(id));
    let paired = sets.wrapper_started(session(), party, WrapperCommand::Line(id.to_owned()));
    let folder = tempfile::tempdir().expect("a folder");
    let path = folder.path().join("output");
    let file = std::fs::File::create(&path).expect("the output file is made");
    let (exited, ended) = watch::channel(false);
    let tail = tokio::spawn(tail_output(
        path,
        Arc::clone(sets),
        session(),
        party,
        paired,
        ended,
    ));
    TailedRow {
        file,
        exited,
        tail,
        _folder: folder,
    }
}

/// The data of the next output frame `feed` sends.
async fn next_output(feed: &mut RunningCommandFeed) -> String {
    loop {
        if let AgentCommandSubscribeFrame::Output { data, .. } = next_sent_frame(feed).await {
            return data;
        }
    }
}

/// Waits for a set from `feed` in which the row `id` shows a prompt where `is_shown`, or none.
async fn until_prompt_shown(feed: &mut RunningCommandFeed, id: &str, is_shown: bool) {
    let command_id = CommandId::new(id.to_owned()).expect("a command id");
    next_sent_set_where(feed, |set| {
        set.iter()
            .any(|row| row.command_id == command_id && row.prompt.is_some() == is_shown)
    })
    .await;
}

/// Polls `holds` every 20 ms, failing the test with `what` after 5 s.
async fn until(what: &str, holds: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !holds() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_elapsed| panic!("{what}"));
}

async fn tail_ends(tail: tokio::task::JoinHandle<()>) {
    tokio::time::timeout(Duration::from_secs(5), tail)
        .await
        .expect("the tail ends")
        .expect("the tail ran");
}

// Fails when the last bytes written before the command's exit are lost, a character split across
// two reads is decoded apart, or the bytes held back at the end are dropped. Mutations: drop the
// `drain` call; treat `InvalidData` in `drain` as a failure that skips `decoder.finish`; decode
// each read lossily on its own.
#[tokio::test]
async fn the_output_tail_reads_every_byte_written_before_the_exit() {
    let sets = unbound_running_command_sets();
    let mut feed = sets.subscribe(session());
    let mut row = tailed_row(&sets, "cmd", 7);
    row.file.write_all(b"first \xE2\x82").expect("written");
    let mut output = next_output(&mut feed).await;
    row.file.write_all(b"\xAC last").expect("written");
    row.exited.send_replace(true);
    // The tail reads the last bytes before the file is cut, as the end of its writer leaves it.
    while output.len() < "first € last".len() {
        output.push_str(&next_output(&mut feed).await);
    }
    row.file.set_len(0).expect("the file is cut");
    tail_ends(row.tail).await;
    assert_eq!(output, "first € last");

    // A file cut after the read, its writer then ended, ends the output with what was held back.
    let mut row = tailed_row(&sets, "cut", 8);
    row.file.write_all(b"held \xE2").expect("written");
    assert_eq!(next_output(&mut feed).await, "held ");
    row.file.set_len(0).expect("the file is cut");
    row.exited.send_replace(true);
    tail_ends(row.tail).await;
    assert_eq!(next_output(&mut feed).await, "\u{FFFD}");
}

// Fails when a wrapper that dies without its `Exited` record is held for good: its pairing, its
// output tail and its place on the channel. Mutation: drop the `process_ended.send(party)` call.
#[tokio::test]
async fn a_wrapper_killed_after_its_start_is_let_go() {
    let folder = tempfile::tempdir().expect("a folder");
    let keys = ChannelKem::gen_keypair();
    let mut party = party_command(&keys, None)
        .spawn()
        .expect("the party starts");
    let mut lines = BufReader::new(party.stdout.take().expect("its output")).lines();
    let party_id = ready_parties(&mut lines, 1)[0];
    let channel = Arc::new(open_channel(folder.path(), std::process::id()));
    let sets = unbound_running_command_sets();
    let watch = channel.watch().await.expect("the channel is watched");
    let follower = tokio::spawn(follow_channel_records(
        session(),
        Arc::clone(&channel),
        watch,
        Arc::clone(&sets),
        Arc::new(NoTerminals),
    ));
    let stdout_path = folder.path().join("output");
    std::fs::write(&stdout_path, b"").expect("the output file is made");
    let starting = PartyRecord::Starting {
        command: "sleep 30".to_owned(),
        stdout_path: Some(stdout_path),
        process: None,
    };
    let record = sealed(&channel, &keys, party_id, 1, &starting);
    write_record(&channel.folder, &record_name(party_id, 1), &record)
        .expect("the record is written");
    until("the wrapper is taken", || {
        sets.unpaired_count(session()) > 0
    })
    .await;
    party.kill().expect("the wrapper is killed");
    until("the wrapper is let go", || {
        sets.unpaired_count(session()) == 0 && channel.party_process(party_id).is_none()
    })
    .await;
    follower.abort();
    end_party(party);
}

// Fails when a wrapper started under another, as an agent's nested provider runs its own commands,
// is not answered `go`, so it waits out its deadline, or is held past its end. Mutations: drop the
// nested `starting` from `AdmittedParty::open_record`'s filter; skip `watch_process_end` for it.
#[tokio::test]
async fn a_nested_wrapper_is_answered_go_and_let_go_at_its_end() {
    let folder = tempfile::tempdir().expect("a folder");
    let (outer_keys, nested_keys) = (ChannelKem::gen_keypair(), ChannelKem::gen_keypair());
    let mut outer = party_command(&outer_keys, Some(&nested_keys))
        .spawn()
        .expect("the party starts");
    let mut lines = BufReader::new(outer.stdout.take().expect("its output")).lines();
    let ready = ready_parties(&mut lines, 2);
    let outer_id = outer.id();
    let nested_id = *ready
        .iter()
        .find(|id| **id != outer_id)
        .expect("the nested party is ready");
    let channel = Arc::new(open_channel(folder.path(), std::process::id()));
    let sets = unbound_running_command_sets();
    let watch = channel.watch().await.expect("the channel is watched");
    let follower = tokio::spawn(follow_channel_records(
        session(),
        Arc::clone(&channel),
        watch,
        Arc::clone(&sets),
        Arc::new(NoTerminals),
    ));
    let starting = PartyRecord::Starting {
        command: "npm test".to_owned(),
        stdout_path: None,
        process: None,
    };
    let write = |keys, party, sequence| {
        let record = sealed(&channel, keys, party, sequence, &starting);
        write_record(&channel.folder, &record_name(party, sequence), &record)
            .expect("the record is written");
    };
    write(&outer_keys, outer_id, 1);
    until("the outer wrapper is taken", || {
        sets.unpaired_count(session()) > 0
    })
    .await;
    write(&nested_keys, nested_id, 1);
    let requests = channel.folder.join(REQUESTS_FOLDER);
    let go = record_name(nested_id, 1);
    until("the nested wrapper is answered go", || {
        names_in(&requests).contains(&go)
    })
    .await;
    assert_eq!(
        sets.unpaired_count(session()),
        1,
        "the nested wrapper waits for a row"
    );
    end_party(outer);
    until("the nested wrapper is let go", || {
        channel.party_process(nested_id).is_none() && !names_in(&requests).contains(&go)
    })
    .await;
    follower.abort();
}

// Fails when an askpass's answer is removed before the askpass reads it, so its git or ssh waits
// for good, or when an askpass that dies unanswered leaves its prompt on the row and its place on
// the channel. Mutations: forget the askpass in its answer's closure, right after the answer is
// written; drop the `askpass_ended` call at an askpass's process end.
#[tokio::test]
async fn an_askpass_s_answer_waits_for_it_and_its_end_closes_its_prompt() {
    let folder = tempfile::tempdir().expect("a folder");
    let channel = Arc::new(open_channel(folder.path(), std::process::id()));
    let sets = unbound_running_command_sets();
    let mut feed = sets.subscribe(session());
    let watch = channel.watch().await.expect("the channel is watched");
    let follower = tokio::spawn(follow_channel_records(
        session(),
        Arc::clone(&channel),
        watch,
        Arc::clone(&sets),
        Arc::new(NoTerminals),
    ));
    let requests = channel.folder.join(REQUESTS_FOLDER);
    // The first askpass is answered, the second dies unanswered.
    for (row, is_answered) in [("git push", true), ("git fetch", false)] {
        sets.command_started(row_start(row));
        let (outer_keys, askpass_keys) = (ChannelKem::gen_keypair(), ChannelKem::gen_keypair());
        let mut outer = party_command(&outer_keys, Some(&askpass_keys))
            .spawn()
            .expect("the party starts");
        let mut lines = BufReader::new(outer.stdout.take().expect("its output")).lines();
        let ready = ready_parties(&mut lines, 2);
        let outer_id = outer.id();
        let askpass = *ready
            .iter()
            .find(|id| **id != outer_id)
            .expect("the askpass is ready");
        let write = |keys, party, record: &PartyRecord| {
            let sealed = sealed(&channel, keys, party, 1, record);
            write_record(&channel.folder, &record_name(party, 1), &sealed)
                .expect("the record is written");
        };
        let starting = PartyRecord::Starting {
            command: row.to_owned(),
            stdout_path: None,
            process: None,
        };
        write(&outer_keys, outer_id, &starting);
        let go = record_name(outer_id, 1);
        until("the wrapper is answered go", || {
            names_in(&requests).contains(&go)
        })
        .await;
        write(&askpass_keys, askpass, &PartyRecord::Asking {});
        until_prompt_shown(&mut feed, row, true).await;
        if is_answered {
            let answer = CommandInput {
                text: Some("secret".to_owned()),
                is_end_of_input: false,
            };
            let command_id = CommandId::new(row.to_owned()).expect("a command id");
            sets.write(&MockProviderDriver::new(), session(), &command_id, answer)
                .await
                .expect("the prompt takes the answer");
            let answer = record_name(askpass, 1);
            until("the answer is written", || {
                names_in(&requests).contains(&answer)
            })
            .await;
            // Long past the answer's own task, which a removal right after it would run in.
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert!(
                names_in(&requests).contains(&answer),
                "the answer went before the askpass read it"
            );
            assert!(channel.party_process(askpass).is_some());
            end_party(outer);
            until("the answered askpass is let go at its end", || {
                !names_in(&requests).contains(&answer) && channel.party_process(askpass).is_none()
            })
            .await;
        } else {
            send_signal(askpass, TerminalSignal::Kill).expect("the askpass is killed");
            until_prompt_shown(&mut feed, row, false).await;
            until("the dead askpass is let go", || {
                channel.party_process(askpass).is_none()
            })
            .await;
            end_party(outer);
        }
    }
    follower.abort();
}

// Fails when a wrapper whose process ends just after its `Exited` is let go before that record is
// read, so its row ends with no exit code where the provider gives none. Mutation: drop the
// `arrivals_now` pass in `process_ended`.
#[tokio::test]
async fn a_wrapper_s_exit_written_just_before_its_end_settles_its_row() {
    let folder = tempfile::tempdir().expect("a folder");
    let keys = ChannelKem::gen_keypair();
    let mut party = party_command(&keys, None)
        .spawn()
        .expect("the party starts");
    let mut lines = BufReader::new(party.stdout.take().expect("its output")).lines();
    let party_id = ready_parties(&mut lines, 1)[0];
    let channel = Arc::new(open_channel(folder.path(), std::process::id()));
    let (sender, mut endings) = tokio::sync::mpsc::unbounded_channel();
    let binding = RuntimeBindingId::new("binding-a".to_owned()).expect("a binding id");
    let sets = Arc::new(RunningCommandSets::new(
        Arc::new(move |_session: &SessionId| Some(binding.clone())),
        Arc::new(SentEndings(sender)),
    ));
    sets.command_started(row_start("npm test"));
    let mut watch = channel.watch().await.expect("the channel is watched");
    let (process_ended, _ended_parties) = tokio::sync::mpsc::unbounded_channel();
    let mut follower = RecordFollower {
        session_id: session(),
        channel: Arc::clone(&channel),
        set: Arc::clone(&sets),
        waits: Arc::new(NoTerminals),
        wrappers: HashMap::new(),
        askpasses: HashMap::new(),
        process_ended,
        followings: 0,
    };
    let write = |sequence, record: &PartyRecord| {
        let sealed = sealed(&channel, &keys, party_id, sequence, record);
        write_record(&channel.folder, &record_name(party_id, sequence), &sealed)
            .expect("the record is written");
    };
    write(
        1,
        &PartyRecord::Starting {
            command: "npm test".to_owned(),
            stdout_path: None,
            process: None,
        },
    );
    let arrivals = watch.arrivals_now().await.expect("the folder reads");
    for received in channel.take_records(arrivals).await {
        follower.take_record(received).await;
    }
    let following = follower.wrappers[&party_id].following;
    // The `Exited` is in the folder, unread, as the wrapper's process end is taken.
    write(
        2,
        &PartyRecord::Exited {
            exit_code: Some(3),
            signal: None,
        },
    );
    follower
        .process_ended(&mut watch, party_id, following)
        .await
        .expect("the folder reads");
    assert!(
        channel.party_process(party_id).is_none(),
        "the wrapper is let go"
    );
    sets.provider_exited(session());
    let ending = tokio::time::timeout(Duration::from_secs(5), endings.recv())
        .await
        .expect("the ending comes")
        .expect("the endings stay open");
    assert_eq!(ending.exit_code.map(BoundedInt::get), Some(3));
    end_party(party);
}
