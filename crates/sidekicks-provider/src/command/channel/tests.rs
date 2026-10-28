use std::io::{BufRead as _, BufReader};
use std::process::Command;
use std::time::Duration;

use hpke::Kem as _;
use sidekicks_platforms::pin_running_process;

use super::test_support::{
    end_party, names_in, open_channel, open_channel_bound_to, party_command, ready_parties, sealed,
};
use super::{
    AdmittedParty, ChannelKem, Direction, PartyRecord, REQUESTS_FOLDER, command_channel_root,
    record_context, record_name, remove_channel_folders, seal, write_record,
};

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
// it that holds a key is admitted, when a channel no provider's process is bound to yet admits
// one, or when a refused askpass is left waiting with no answer. Mutations: admit without
// `parent.id() == provider_process_id`; walk an unbound channel with the daemon's own process
// read as the provider's; drop the `answer_refused_askpass` call.
#[tokio::test]
async fn a_party_outside_the_providers_process_or_before_the_bind_is_refused_and_answered_empty() {
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
    for (provider, is_admitted) in [
        (Some(outsider.id()), false),
        (None, false),
        (Some(std::process::id()), true),
    ] {
        let channel = open_channel_bound_to(folder.path(), provider);
        let asking = sealed(&channel, &keys, party_id, 1, &PartyRecord::Asking {});
        let opened = channel
            .open_record(party_id, 1, &asking)
            .await
            .expect("the party's place reads");
        assert_eq!(opened.is_some(), is_admitted, "provider {provider:?}");
        let answered = names_in(&channel.folder.join(REQUESTS_FOLDER));
        let expected = if is_admitted {
            Vec::new()
        } else {
            vec![record_name(party_id, 1)]
        };
        assert_eq!(answered, expected, "provider {provider:?}");
    }
    end_party(party);
    outsider.kill().expect("the test's own child ends");
    outsider.wait().expect("it is reaped");
}

// Fails when a party started under another party speaks for a command: its exit would settle a
// row, and its start not be told apart as nested, also where its record comes before its outer's.
// Mutations: drop the nested party's filter in `AdmittedParty::open_record`; drop the
// `holds_party_key` read from `admit`'s walk.
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
    let early_folder = tempfile::tempdir().expect("a folder");
    let early = open_channel(early_folder.path(), std::process::id());
    let sealed_start = sealed(&early, &nested_keys, nested_id, 1, &starting());
    let early_start = early
        .open_record(nested_id, 1, &sealed_start)
        .await
        .expect("the party's place reads")
        .expect("a nested wrapper's start is taken before its outer's");
    assert!(early_start.is_nested);
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

// Fails when the start's sweep leaves a channel folder a previous run left, or reaches past the
// channels' root into the rest of the data folder. Mutations: return before the loop; read the
// data folder itself.
#[tokio::test]
async fn the_start_removes_left_channel_folders_and_nothing_else() {
    let data_folder = tempfile::tempdir().expect("a folder");
    let left = command_channel_root(data_folder.path()).join("session-1");
    std::fs::create_dir_all(left.join(REQUESTS_FOLDER)).expect("a left channel folder");
    let kept = data_folder.path().join("artifacts");
    std::fs::create_dir_all(&kept).expect("another data folder");

    remove_channel_folders(data_folder.path())
        .await
        .expect("the sweep removes the folders");

    assert!(!left.exists());
    assert!(kept.exists());
}
