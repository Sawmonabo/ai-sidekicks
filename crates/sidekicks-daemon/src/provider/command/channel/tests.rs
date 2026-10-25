use std::io::{BufRead as _, BufReader, Lines};
use std::path::Path;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use hpke::Kem as _;
use sidekicks_platforms::pin_running_process;

use super::{
    AdmittedParty, ChannelKem, ChannelPrivateKey, ChannelPublicKey, CommandChannel, Direction,
    PARTY_KEY_ARGUMENT_PREFIX, PartyId, PartyRecord, REQUESTS_FOLDER, public_key_hex,
    record_context, record_name, seal, write_record,
};
use crate::ipc::caller_process::system_reader::ProcessTableReader;
use crate::provider::command::harness_test_name;

/// The process a test starts as a party: it prints `ready <its id>`, starts a party of its own
/// under it where `NESTED_KEY_VARIABLE` names that party's key, and waits for its input to end.
const PARTY_PROCESS_TEST: &str = "a_party_process_waits_for_its_input_to_end";

/// The variable naming the key of a party the started party starts under itself.
const NESTED_KEY_VARIABLE: &str = "SIDEKICKS_TEST_NESTED_PARTY_KEY";

pub(super) type KeyPair = (ChannelPrivateKey, ChannelPublicKey);

fn exited() -> PartyRecord {
    PartyRecord::Exited {
        exit_code: Some(0),
        signal: None,
    }
}

fn starting() -> PartyRecord {
    PartyRecord::Starting {
        command: "npm test".to_owned(),
        stdout_path: None,
        process: None,
    }
}

/// This test binary started as a party holding `keys`, its own party under it holding `nested`
/// where given.
pub(super) fn party_command(keys: &KeyPair, nested: Option<&KeyPair>) -> Command {
    let mut command = Command::new(std::env::current_exe().expect("the test program"));
    command
        .arg(format!(
            "{PARTY_KEY_ARGUMENT_PREFIX}{}",
            public_key_hex(&keys.1)
        ))
        .args([
            "--exact",
            &harness_test_name(module_path!(), PARTY_PROCESS_TEST),
            "--ignored",
            "--nocapture",
            "--quiet",
        ])
        .env_remove(NESTED_KEY_VARIABLE)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if let Some(nested) = nested {
        command.env(NESTED_KEY_VARIABLE, public_key_hex(&nested.1));
    }
    command
}

/// The ids of the next `count` parties that print `ready`.
pub(super) fn ready_parties(
    lines: &mut Lines<BufReader<ChildStdout>>,
    count: usize,
) -> Vec<PartyId> {
    let mut ready = Vec::new();
    while ready.len() < count {
        let line = lines.next().expect("the party prints").expect("a line");
        if let Some(id) = line.strip_prefix("ready ") {
            ready.push(id.parse().expect("a party id"));
        }
    }
    ready
}

/// Ends a party the test started, which ends any party under it.
pub(super) fn end_party(mut party: Child) {
    drop(party.stdin.take());
    party.wait().expect("the party ends once its input does");
}

/// `record` sealed by `keys` to `channel` as `party`'s record numbered `sequence`.
pub(super) fn sealed(
    channel: &CommandChannel,
    keys: &KeyPair,
    party: PartyId,
    sequence: u64,
    record: &PartyRecord,
) -> Vec<u8> {
    let context = record_context(Direction::ToDaemon, party, sequence);
    let plaintext = serde_json::to_vec(record).expect("a record writes");
    seal(keys, &channel.keys.1, &context, &plaintext).expect("it seals")
}

pub(super) fn open_channel(folder: &Path, provider: u32) -> CommandChannel {
    CommandChannel::open(
        folder.join(provider.to_string()),
        provider,
        Arc::new(ProcessTableReader::for_this_program().expect("a reader")) as _,
    )
    .expect("the channel opens")
}

pub(super) fn names_in(folder: &Path) -> Vec<String> {
    std::fs::read_dir(folder)
        .expect("the folder lists")
        .map(|entry| {
            entry
                .expect("an entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}

// Fails when a record opens under the other direction's context or another party's key, or
// when a number at or below the last one opened is taken, a replay among them. Mutations: in
// `AdmittedParty::open_record`, `sequence <= self.last_sequence` to `<`; the direction dropped
// from `record_context`.
#[test]
fn a_record_opens_only_under_its_own_context_key_and_a_rising_number() {
    let daemon = ChannelKem::gen_keypair();
    let party_keys = ChannelKem::gen_keypair();
    let forger = ChannelKem::gen_keypair();
    let party = 4242;
    let plaintext = serde_json::to_vec(&exited()).expect("a record writes");
    let sealed = |keys, direction, sequence| {
        seal(
            keys,
            &daemon.1,
            &record_context(direction, party, sequence),
            &plaintext,
        )
        .expect("a record seals")
    };
    let mut admitted = AdmittedParty {
        public_key: party_keys.1.clone(),
        last_sequence: 0,
        next_request: 0,
        is_wrapper: false,
        is_nested: false,
        first_argument: None,
        wrapper: None,
        process: pin_running_process(std::process::id())
            .expect("the test pins itself")
            .expect("it runs"),
    };
    let mut open =
        |sequence, sealed: Vec<u8>| admitted.open_record(&daemon.0, party, sequence, &sealed);
    assert_eq!(open(1, sealed(&party_keys, Direction::ToParty, 1)), None);
    assert_eq!(open(1, sealed(&forger, Direction::ToDaemon, 1)), None);
    assert_eq!(open(2, sealed(&party_keys, Direction::ToDaemon, 1)), None);
    let second = sealed(&party_keys, Direction::ToDaemon, 2);
    assert_eq!(open(2, second.clone()), Some(exited()));
    assert_eq!(open(2, second), None);
    assert_eq!(open(1, sealed(&party_keys, Direction::ToDaemon, 1)), None);
    assert_eq!(
        open(5, sealed(&party_keys, Direction::ToDaemon, 5)),
        Some(exited())
    );
}

// Fails when a party's place under the provider's process goes unchecked, so a process outside
// it that holds a key is admitted, or when a refused askpass is left waiting with no answer.
// Mutations: admit without `parent.id() == self.provider_process_id`; drop the
// `answer_refused_askpass` call.
#[tokio::test]
async fn a_party_outside_the_providers_process_is_refused_and_its_prompt_answered_empty() {
    let folder = tempfile::tempdir().expect("a folder");
    let keys = ChannelKem::gen_keypair();
    let mut party = party_command(&keys, None)
        .spawn()
        .expect("the party starts");
    let mut lines = BufReader::new(party.stdout.take().expect("its output")).lines();
    let party_id = ready_parties(&mut lines, 1)[0];
    let mut outsider = Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .expect("a process outside the party's tree starts");
    for (provider, is_admitted) in [(outsider.id(), false), (std::process::id(), true)] {
        let channel = open_channel(folder.path(), provider);
        let asking = sealed(&channel, &keys, party_id, 1, &PartyRecord::Asking {});
        let opened = channel
            .open_record(party_id, 1, &asking)
            .await
            .expect("the party's place reads");
        assert_eq!(opened.is_some(), is_admitted, "provider {provider}");
        let answered = names_in(&channel.folder.join(REQUESTS_FOLDER));
        let expected = if is_admitted {
            Vec::new()
        } else {
            vec![record_name(party_id, 1)]
        };
        assert_eq!(answered, expected, "provider {provider}");
    }
    end_party(party);
    outsider.kill().expect("the test's own child ends");
    outsider.wait().expect("it is reaped");
}

// Fails when a party started under an admitted party speaks for a command: its exit would settle
// a row, and its start not be told apart as nested. Mutation: drop the nested party's filter in
// `AdmittedParty::open_record`.
#[tokio::test]
async fn a_party_under_an_admitted_party_speaks_only_its_prompt() {
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
    let channel = open_channel(folder.path(), std::process::id());
    let open = |keys, party, sequence, record: PartyRecord| {
        let sealed = sealed(&channel, keys, party, sequence, &record);
        let channel = &channel;
        async move {
            channel
                .open_record(party, sequence, &sealed)
                .await
                .expect("the party's place reads")
        }
    };
    let outer_start = open(&outer_keys, outer_id, 1, starting()).await;
    assert_eq!(
        outer_start.map(|received| received.record),
        Some(starting())
    );
    let nested_start = open(&nested_keys, nested_id, 1, starting())
        .await
        .expect("a nested wrapper's start is taken");
    assert!(nested_start.is_nested);
    assert!(open(&nested_keys, nested_id, 2, exited()).await.is_none());
    let asking = open(&nested_keys, nested_id, 3, PartyRecord::Asking {})
        .await
        .expect("a nested askpass's prompt is taken");
    assert_eq!(asking.wrapper, Some(outer_id));
    end_party(outer);
}

// Fails when one record that cannot be read ends the records' follower, losing the records
// beside it and every later one. Mutation: in `take_records`, return the read's error.
#[tokio::test]
async fn a_record_that_cannot_be_read_is_dropped_and_its_batch_kept() {
    let folder = tempfile::tempdir().expect("a folder");
    let keys = ChannelKem::gen_keypair();
    let mut party = party_command(&keys, None)
        .spawn()
        .expect("the party starts");
    let mut lines = BufReader::new(party.stdout.take().expect("its output")).lines();
    let party_id = ready_parties(&mut lines, 1)[0];
    let channel = open_channel(folder.path(), std::process::id());
    let mut watch = channel.watch().await.expect("the channel is watched");
    let write = |sequence, record: &PartyRecord| {
        let sealed = sealed(&channel, &keys, party_id, sequence, record);
        write_record(&channel.folder, &record_name(party_id, sequence), &sealed)
            .expect("the record is written");
    };
    write(1, &starting());
    // A folder under a record's name, renamed in as a record is, reads as an error.
    let unreadable = folder.path().join("unreadable");
    std::fs::create_dir(&unreadable).expect("a folder is made");
    std::fs::rename(&unreadable, channel.folder.join(record_name(party_id, 2)))
        .expect("it is renamed in");
    write(3, &exited());
    let mut received = Vec::new();
    while received.len() < 2 {
        let records =
            tokio::time::timeout(Duration::from_secs(5), channel.next_records(&mut watch))
                .await
                .expect("records come")
                .expect("the watch holds");
        received.extend(records.into_iter().map(|received| received.record));
    }
    assert_eq!(received, [starting(), exited()]);
    write(4, &PartyRecord::Stopped {});
    let next = tokio::time::timeout(Duration::from_secs(5), channel.next_records(&mut watch))
        .await
        .expect("the next record comes")
        .expect("the watch holds");
    assert_eq!(next[0].record, PartyRecord::Stopped {});
    end_party(party);
}

// Fails when a party's unread requests or a closed conversation's folder are left behind, one
// file or folder per command and per conversation for good. Mutations: drop the
// `remove_party_requests` call in `forget_party`; make `close` remove nothing.
#[tokio::test]
async fn a_forgotten_party_leaves_no_request_and_a_closed_channel_no_folder() {
    let folder = tempfile::tempdir().expect("a folder");
    let keys = ChannelKem::gen_keypair();
    let mut party = party_command(&keys, None)
        .spawn()
        .expect("the party starts");
    let mut lines = BufReader::new(party.stdout.take().expect("its output")).lines();
    let party_id = ready_parties(&mut lines, 1)[0];
    let channel = open_channel(folder.path(), std::process::id());
    let start = sealed(&channel, &keys, party_id, 1, &starting());
    channel
        .open_record(party_id, 1, &start)
        .await
        .expect("the party's place reads")
        .expect("the party is admitted");
    for request in [super::DaemonRequest::Go {}, super::DaemonRequest::Stop {}] {
        channel
            .send_request(party_id, &request)
            .await
            .expect("the request is written");
    }
    let other = record_name(party_id + 1, 1);
    std::fs::write(channel.folder.join(REQUESTS_FOLDER).join(&other), b"")
        .expect("another party's request is written");
    channel.forget_party(party_id).await;
    assert_eq!(names_in(&channel.folder.join(REQUESTS_FOLDER)), [other]);
    let channel_folder = channel.folder.clone();
    channel.close().await.expect("the channel closes");
    assert!(!channel_folder.exists());
    end_party(party);
}

#[test]
#[ignore = "run only as the party process another test starts"]
fn a_party_process_waits_for_its_input_to_end() {
    let nested = std::env::var(NESTED_KEY_VARIABLE).ok().map(|key| {
        Command::new(std::env::current_exe().expect("the test program"))
            .arg(format!("{PARTY_KEY_ARGUMENT_PREFIX}{key}"))
            .args(std::env::args_os().skip(2))
            .env_remove(NESTED_KEY_VARIABLE)
            .stdin(Stdio::piped())
            .spawn()
            .expect("the nested party starts")
    });
    let mut output = std::io::stdout().lock();
    std::io::Write::write_all(
        &mut output,
        format!("ready {}\n", std::process::id()).as_bytes(),
    )
    .expect("it prints");
    std::io::Write::flush(&mut output).expect("it flushes");
    drop(output);
    let mut input = String::new();
    while std::io::stdin().read_line(&mut input).expect("it reads") > 0 {}
    if let Some(nested) = nested {
        end_party(nested);
    }
}
