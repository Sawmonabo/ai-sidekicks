//! What tests of the command channel and of its users share: this test program started as a
//! party, and a party's records sealed and written where the channel reads them.

use std::io::{BufRead as _, BufReader, Lines};
use std::path::Path;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::Arc;

use hpke::Kem as _;
use sidekicks_ipc::caller_process::system_reader::ProcessTableReader;
use sidekicks_platforms::harness_test_name;

use super::{
    ChannelKem, ChannelPrivateKey, ChannelPublicKey, CommandChannel, Direction,
    PARTY_KEY_ARGUMENT_PREFIX, PartyId, PartyRecord, REQUESTS_FOLDER, public_key_hex,
    record_context, record_name, seal, write_record,
};

/// The process a test starts as a party: it prints `ready <its id>`, starts a party of its own
/// under it where `NESTED_KEY_VARIABLE` names that party's key, and waits for its input to end.
const PARTY_PROCESS_TEST: &str = "a_party_process_waits_for_its_input_to_end";

/// The variable naming the key of a party the started party starts under itself.
const NESTED_KEY_VARIABLE: &str = "SIDEKICKS_TEST_NESTED_PARTY_KEY";

/// A party's private and public key.
pub(crate) type KeyPair = (ChannelPrivateKey, ChannelPublicKey);

/// A new party's keys.
pub(crate) fn new_party_keys() -> KeyPair {
    ChannelKem::gen_keypair()
}

/// This test binary started as a party holding `keys`, its own party under it holding `nested`
/// where given.
pub(crate) fn party_command(keys: &KeyPair, nested: Option<&KeyPair>) -> Command {
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
pub(crate) fn ready_parties(
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
pub(crate) fn end_party(mut party: Child) {
    drop(party.stdin.take());
    party.wait().expect("the party ends once its input does");
}

/// `record` sealed by `keys` to `channel` as `party`'s record numbered `sequence`.
pub(crate) fn sealed(
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

/// A channel in its own folder under `folder`, bound to `provider` where one is given.
pub(crate) fn open_channel_bound_to(folder: &Path, provider: Option<u32>) -> CommandChannel {
    let name = provider.map_or_else(|| "unbound".to_owned(), |provider| provider.to_string());
    let channel = CommandChannel::open(
        folder.join(name),
        Arc::new(ProcessTableReader::for_this_program().expect("a reader")) as _,
    )
    .expect("the channel opens");
    if let Some(provider) = provider {
        channel.bind(provider);
    }
    channel
}

/// A channel in its own folder under `folder`, bound to `provider`.
pub(crate) fn open_channel(folder: &Path, provider: u32) -> CommandChannel {
    open_channel_bound_to(folder, Some(provider))
}

/// The names of the entries in `folder`.
pub(crate) fn names_in(folder: &Path) -> Vec<String> {
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

/// Writes `record`, sealed by `keys`, where `channel` reads `party`'s record numbered `sequence`.
pub(crate) fn write_party_record(
    channel: &CommandChannel,
    keys: &KeyPair,
    party: PartyId,
    sequence: u64,
    record: &PartyRecord,
) {
    let sealed = sealed(channel, keys, party, sequence, record);
    write_record(&channel.folder, &record_name(party, sequence), &sealed)
        .expect("the record writes");
}

/// The names of the requests `channel` sent its parties that they have not taken.
pub(crate) fn sent_requests(channel: &CommandChannel) -> Vec<String> {
    names_in(&channel.folder.join(REQUESTS_FOLDER))
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
