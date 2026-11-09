//! A terminal session's replies read from its transcript: each awaited message delivered as its
//! record lands, and at its idle notice answered by the turn it started, given nothing more where
//! it joined a turn under way, or not delivered where it left no record; a transcript yet to be
//! written is followed from its project folder, a project folder yet to be made from the
//! `projects` folder, a `projects` folder yet to be made from the config folder, and the transcript
//! read once at the notice where no config folder is.
//! Each case follows a transcript through the system's watches, so it runs only where they are.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_platforms::WATCHES_ARRIVALS_AND_APPENDS;
use sidekicks_std::port_registration::PortRegistration;

use super::ClaudePeerReplies;
use crate::driver::claude::live_sessions::ClaudeLiveSession;
use crate::driver::claude::session::scripted::daemon_services::RecordingPorts;
use crate::port::session_message_reading_publisher::{
    SessionMessageReading, SessionMessageReadingPublisher,
};

// How long the watch's task is given to act before the test goes on.
const WRITE_GAP: Duration = Duration::from_millis(50);

// The unwritten stretch a long transcript ends in before a wait begins: a file system hole, which
// takes no disk room yet minutes to read through.
const LONG_TRANSCRIPT_HOLE: u64 = 256 << 30;

// How long an idle notice is given to settle once its reply is written.
const NOTICE_WITHIN: Duration = Duration::from_secs(10);

const PROMPT: &str = "6f1c1e0a-0000-4000-8000-000000000001";
const PROMPT_REPLY: &str = "6f1c1e0a-0000-4000-8000-000000000002";
const MESSAGE_M: &str = "6f1c1e0a-0000-4000-8000-0000000000a1";
const MESSAGE_B: &str = "6f1c1e0a-0000-4000-8000-0000000000b1";
const MESSAGE_C: &str = "6f1c1e0a-0000-4000-8000-0000000000c1";
const QUEUED_B: &str = "6f1c1e0a-0000-4000-8000-000000000003";
const OUR_FIRST: &str = "6f1c1e0a-0000-4000-8000-000000000004";
const OUR_LAST: &str = "6f1c1e0a-0000-4000-8000-000000000005";
const MESSAGE_N: &str = "6f1c1e0a-0000-4000-8000-0000000000d1";
const THEIR_REPLY: &str = "6f1c1e0a-0000-4000-8000-000000000006";

// The publisher the replies publish to, recording each reading.
fn recording_replies() -> (Arc<ClaudePeerReplies>, Arc<RecordingPorts>) {
    let recording = Arc::new(RecordingPorts::default());
    let readings: Arc<PortRegistration<Arc<dyn SessionMessageReadingPublisher>>> =
        Arc::new(PortRegistration::new("session message readings"));
    readings
        .register(recording.clone())
        .expect("the readings register once");
    (Arc::new(ClaudePeerReplies::new(readings)), recording)
}

// A terminal session `session_id` started in `working_folder`, as its registry file under
// `config_folder` names it.
fn terminal_session(
    config_folder: &Path,
    session_id: &str,
    working_folder: &str,
) -> ClaudeLiveSession {
    ClaudeLiveSession {
        session_id: Some(session_id.to_owned()),
        name: None,
        status: None,
        socket: None,
        working_folder: Some(PathBuf::from(working_folder)),
        registry_file: config_folder.join("sessions").join("4101.json"),
        process_id: 4101,
    }
}

// Appends each record to `transcript` as one JSON line.
fn append(transcript: &Path, records: &[Value]) {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(transcript)
        .expect("the transcript opens");
    for record in records {
        writeln!(file, "{record}").expect("the record is written");
    }
}

// A `user` record a peer's message started a turn with.
fn peer_start(uuid: &str, parent: &str, merged: &[&str]) -> Value {
    json!({
        "type": "user", "uuid": uuid, "parentUuid": parent, "isMeta": true,
        "turnOrigin": "peer", "promptSource": "system", "mergedSendUuids": merged,
        "message": {"role": "user", "content": "a peer's message"},
    })
}

// An `assistant` record of message `message_id` holding one text block.
fn reply(uuid: &str, parent: &str, message_id: &str, text: &str) -> Value {
    json!({
        "type": "assistant", "uuid": uuid, "parentUuid": parent,
        "message": {"id": message_id, "content": [{"type": "text", "text": text}]},
    })
}

fn delivered(message_id: &str) -> SessionMessageReading {
    SessionMessageReading::Delivered {
        message_id: message_id.to_owned(),
    }
}

// The answer to `message_id` from the turn the record `turn_record` started.
fn answered(message_id: &str, turn_record: &str, answer: &str) -> SessionMessageReading {
    SessionMessageReading::Answered {
        message_id: message_id.to_owned(),
        turn_record: turn_record.to_owned(),
        answer: Some(answer.to_owned()),
    }
}

// Killed by pairing the answer by order (M would read "theirs"), by pairing by the nearest peer
// ancestor (B's attachment would take M's answer), by an answer for an absorbed message, by idle
// with no record reading anything but `NotDelivered`, by one assistant message's blocks not
// joined ("s" alone), and by a notice no wait awaits being taken.
#[tokio::test]
async fn a_watched_transcript_answers_the_turn_each_message_started_and_no_other() {
    if !WATCHES_ARRIVALS_AND_APPENDS {
        return;
    }
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let config_folder = scratch.path().join("config");
    let project_folder = config_folder.join("projects").join("-work-app");
    std::fs::create_dir_all(&project_folder).expect("the project folder is made");
    let session_id = "0d9e8f7a-1111-4222-8333-444455556666";
    let transcript = project_folder.join(format!("{session_id}.jsonl"));
    append(
        &transcript,
        &[
            json!({"type": "user", "uuid": PROMPT, "parentUuid": null,
                   "message": {"role": "user", "content": "the person's prompt"}}),
            reply(PROMPT_REPLY, PROMPT, "msg-prompt", "the prompt's answer"),
        ],
    );
    let (replies, recording) = recording_replies();
    let receiver = terminal_session(&config_folder, session_id, "/work/app");
    let mut waits = Vec::new();
    for (message_id, notice_id) in [(MESSAGE_M, "n-m"), (MESSAGE_B, "n-b"), (MESSAGE_C, "n-c")] {
        waits.push(
            replies
                .await_reply(&receiver, message_id.to_owned(), notice_id.to_owned())
                .await
                .expect("the reply is awaited"),
        );
    }

    append(&transcript, &[peer_start(MESSAGE_M, PROMPT_REPLY, &[])]);
    tokio::time::sleep(WRITE_GAP).await;
    append(
        &transcript,
        &[
            json!({"type": "attachment", "uuid": QUEUED_B, "parentUuid": MESSAGE_M,
                 "attachment": {"type": "queued_command", "source_uuid": MESSAGE_B}}),
        ],
    );
    tokio::time::sleep(WRITE_GAP).await;
    // One assistant message in two records, the second split across two writes.
    let last = reply(OUR_LAST, OUR_FIRST, "msg-ours", "s").to_string();
    let (last_head, last_tail) = last.split_at(last.len() / 2);
    append(
        &transcript,
        &[reply(OUR_FIRST, QUEUED_B, "msg-ours", "our")],
    );
    std::fs::OpenOptions::new()
        .append(true)
        .open(&transcript)
        .and_then(|mut file| file.write_all(last_head.as_bytes()))
        .expect("half a record is written");
    tokio::time::sleep(WRITE_GAP).await;
    std::fs::OpenOptions::new()
        .append(true)
        .open(&transcript)
        .and_then(|mut file| writeln!(file, "{last_tail}"))
        .expect("the record's rest is written");
    append(
        &transcript,
        &[
            peer_start(MESSAGE_N, OUR_LAST, &[]),
            reply(THEIR_REPLY, MESSAGE_N, "msg-theirs", "theirs"),
        ],
    );

    assert!(!replies.take_idle_notice("n-unknown").await);
    for notice_id in ["n-m", "n-b", "n-c"] {
        assert!(replies.take_idle_notice(notice_id).await);
    }
    assert_eq!(
        recording.message_readings(),
        vec![
            delivered(MESSAGE_M),
            delivered(MESSAGE_B),
            answered(MESSAGE_M, MESSAGE_M, "ours"),
            SessionMessageReading::NotDelivered {
                message_id: MESSAGE_C.to_owned(),
            },
        ]
    );
}

// Killed by the watch reading the transcript from its start (the notice's drain reads through the
// hole and misses its bound), by its lines folded from the start (the earlier record of M is
// delivered before the wait's own lines, and answers "stale"), and by its lines counted from the
// file's start while its reads begin at the wait's (M's lines are passed over: `NotDelivered`).
#[tokio::test]
async fn a_watch_reads_only_what_the_transcript_gains_after_the_wait_begins() {
    if !WATCHES_ARRIVALS_AND_APPENDS {
        return;
    }
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let config_folder = scratch.path().join("config");
    let project_folder = config_folder.join("projects").join("-work-app");
    std::fs::create_dir_all(&project_folder).expect("the project folder is made");
    let session_id = "0d9e8f7a-1111-4222-8333-444455556667";
    let transcript = project_folder.join(format!("{session_id}.jsonl"));
    append(
        &transcript,
        &[
            peer_start(MESSAGE_M, PROMPT_REPLY, &[]),
            reply(OUR_FIRST, MESSAGE_M, "msg-stale", "stale"),
        ],
    );
    let written = std::fs::OpenOptions::new()
        .write(true)
        .open(&transcript)
        .expect("the transcript opens");
    let length = written
        .metadata()
        .expect("the transcript is measured")
        .len();
    written
        .set_len(length + LONG_TRANSCRIPT_HOLE)
        .expect("the transcript is made long");
    let (replies, recording) = recording_replies();
    let receiver = terminal_session(&config_folder, session_id, "/work/app");
    let _wait = replies
        .await_reply(&receiver, MESSAGE_M.to_owned(), "n-m".to_owned())
        .await
        .expect("the reply is awaited");

    tokio::time::sleep(WRITE_GAP).await;
    let before_reply = recording.message_readings();
    append(
        &transcript,
        &[
            peer_start(MESSAGE_M, PROMPT_REPLY, &[]),
            reply(OUR_LAST, MESSAGE_M, "msg-fresh", "fresh"),
        ],
    );
    let taken = tokio::time::timeout(NOTICE_WITHIN, replies.take_idle_notice("n-m")).await;

    assert_eq!(before_reply, Vec::new());
    assert_eq!(taken, Ok(true));
    assert_eq!(
        recording.message_readings(),
        vec![
            delivered(MESSAGE_M),
            answered(MESSAGE_M, MESSAGE_M, "fresh")
        ]
    );
}

// Killed by the read at the notice skipped where no watch runs (F reads `NotDelivered`), by a
// merged start answering only the message it is named for (D2 reads `NotDelivered`), by each
// merged message naming its own turn rather than the start record (D2 names itself), by a folder
// watch that never turns to the transcript once it appears, by a missing project folder left
// unwatched (E's `Delivered` waits for its notice), and by a missing `projects` folder left
// unwatched (G's `Delivered` waits for its notice).
#[tokio::test]
async fn a_transcript_written_after_the_send_is_read_with_or_without_a_watch() {
    if !WATCHES_ARRIVALS_AND_APPENDS {
        return;
    }
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let config_folder = scratch.path().join("config");
    let (replies, recording) = recording_replies();

    // The project folder is there, the transcript not yet: its folder is watched.
    let watched_folder = config_folder.join("projects").join("-work-app");
    std::fs::create_dir_all(&watched_folder).expect("the project folder is made");
    let watched_session = "1a2b3c4d-1111-4222-8333-000000000001";
    let message_d = "6f1c1e0a-0000-4000-8000-0000000000e1";
    let message_d2 = "6f1c1e0a-0000-4000-8000-0000000000e2";
    let receiver = terminal_session(&config_folder, watched_session, "/work/app");
    let _wait_d = replies
        .await_reply(&receiver, message_d.to_owned(), "n-d".to_owned())
        .await
        .expect("the reply is awaited");
    let _wait_d2 = replies
        .await_reply(&receiver, message_d2.to_owned(), "n-d2".to_owned())
        .await
        .expect("the reply is awaited");
    // The folder's watch is set before the transcript appears.
    tokio::time::sleep(WRITE_GAP).await;
    append(
        &watched_folder.join(format!("{watched_session}.jsonl")),
        &[
            peer_start(message_d, PROMPT_REPLY, &[message_d, message_d2]),
            reply(OUR_FIRST, message_d, "msg-d", "done"),
        ],
    );
    assert!(replies.take_idle_notice("n-d").await);
    assert!(replies.take_idle_notice("n-d2").await);

    // The project folder is not there yet: the `projects` folder is watched for it, and the
    // transcript is delivered as it lands, before the notice.
    let arriving_session = "1a2b3c4d-1111-4222-8333-000000000002";
    let message_e = "6f1c1e0a-0000-4000-8000-0000000000f1";
    let receiver = terminal_session(&config_folder, arriving_session, "/work/other");
    let _wait_e = replies
        .await_reply(&receiver, message_e.to_owned(), "n-e".to_owned())
        .await
        .expect("the reply is awaited");
    tokio::time::sleep(WRITE_GAP).await;
    // Made beside and renamed in, which every system's folder watch wakes on.
    let staged_folder = config_folder.join("-work-other");
    std::fs::create_dir(&staged_folder).expect("the project folder is made");
    append(
        &staged_folder.join(format!("{arriving_session}.jsonl")),
        &[
            peer_start(message_e, PROMPT_REPLY, &[]),
            reply(OUR_LAST, message_e, "msg-e", "followed from projects"),
        ],
    );
    std::fs::rename(
        &staged_folder,
        config_folder.join("projects").join("-work-other"),
    )
    .expect("the project folder is moved in");
    tokio::time::sleep(WRITE_GAP).await;
    assert_eq!(
        recording.message_readings().last(),
        Some(&delivered(message_e))
    );
    assert!(replies.take_idle_notice("n-e").await);

    // The config folder holds no `projects` folder yet: the config folder is watched for it.
    let fresh_config_folder = scratch.path().join("fresh-config");
    std::fs::create_dir(&fresh_config_folder).expect("the config folder is made");
    let fresh_session = "1a2b3c4d-1111-4222-8333-000000000004";
    let message_g = "6f1c1e0a-0000-4000-8000-0000000000f3";
    let receiver = terminal_session(&fresh_config_folder, fresh_session, "/work/fresh");
    let _wait_g = replies
        .await_reply(&receiver, message_g.to_owned(), "n-g".to_owned())
        .await
        .expect("the reply is awaited");
    tokio::time::sleep(WRITE_GAP).await;
    let staged_projects = scratch.path().join("staged-projects");
    std::fs::create_dir_all(staged_projects.join("-work-fresh"))
        .expect("the project folder is made");
    append(
        &staged_projects
            .join("-work-fresh")
            .join(format!("{fresh_session}.jsonl")),
        &[
            peer_start(message_g, PROMPT_REPLY, &[]),
            reply(
                OUR_LAST,
                message_g,
                "msg-g",
                "followed from the config folder",
            ),
        ],
    );
    std::fs::rename(&staged_projects, fresh_config_folder.join("projects"))
        .expect("the projects folder is moved in");
    tokio::time::sleep(WRITE_GAP).await;
    assert_eq!(
        recording.message_readings().last(),
        Some(&delivered(message_g))
    );
    assert!(replies.take_idle_notice("n-g").await);

    // Not even the config folder is there: nothing is watched, and the notice reads the file.
    let bare_config_folder = scratch.path().join("bare-config");
    let unwatched_session = "1a2b3c4d-1111-4222-8333-000000000003";
    let message_f = "6f1c1e0a-0000-4000-8000-0000000000f2";
    let receiver = terminal_session(&bare_config_folder, unwatched_session, "/work/bare");
    let _wait_f = replies
        .await_reply(&receiver, message_f.to_owned(), "n-f".to_owned())
        .await
        .expect("the reply is awaited");
    // The watch finds no config folder and ends before the folder is made.
    tokio::time::sleep(WRITE_GAP).await;
    let unwatched_folder = bare_config_folder.join("projects").join("-work-bare");
    std::fs::create_dir_all(&unwatched_folder).expect("the project folder is made");
    append(
        &unwatched_folder.join(format!("{unwatched_session}.jsonl")),
        &[
            peer_start(message_f, PROMPT_REPLY, &[]),
            reply(OUR_LAST, message_f, "msg-f", "read at the notice"),
        ],
    );
    assert!(replies.take_idle_notice("n-f").await);

    assert_eq!(
        recording.message_readings(),
        vec![
            delivered(message_d),
            delivered(message_d2),
            answered(message_d, message_d, "done"),
            answered(message_d2, message_d, "done"),
            delivered(message_e),
            answered(message_e, message_e, "followed from projects"),
            delivered(message_g),
            answered(message_g, message_g, "followed from the config folder"),
            delivered(message_f),
            answered(message_f, message_f, "read at the notice"),
        ]
    );
}
