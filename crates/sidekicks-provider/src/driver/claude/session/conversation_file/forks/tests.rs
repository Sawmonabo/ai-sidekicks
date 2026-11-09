use std::fs;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

use super::{ClaudeForkPoint, read_claude_fork_point, resolve_claude_message};

// Writes conversation `id` into project folder `project` under `config`, one entry per line.
fn write_conversation(config: &Path, project: &str, id: &str, entries: &[Value]) {
    let folder = config.join("projects").join(project);
    fs::create_dir_all(&folder).expect("the project folder is made");
    let lines: Vec<String> = entries.iter().map(Value::to_string).collect();
    fs::write(folder.join(format!("{id}.jsonl")), lines.join("\n")).expect("the file is written");
}

// An entry a fork copied from entry `message_uuid` of conversation `session_id`.
fn copy(uuid: &str, parent_uuid: Option<&str>, session_id: &str, message_uuid: &str) -> Value {
    json!({
        "type": "user",
        "uuid": uuid,
        "parentUuid": parent_uuid,
        "forkedFrom": { "sessionId": session_id, "messageUuid": message_uuid },
    })
}

// A prompt taken mid-turn and sent as `s`, which a fork's copy keeps.
fn queued_prompt(uuid: &str, parent_uuid: &str) -> Value {
    json!({
        "type": "attachment",
        "uuid": uuid,
        "parentUuid": parent_uuid,
        "attachment": { "type": "queued_command", "source_uuid": "s", "prompt": "steer" },
    })
}

// `a` holds `m1 → m2 → m3` and the prompt `q` sent as `s`; `b` forks `a` whole and adds its own
// `n1`; `c` forks `b` whole; `d` forks `b` cut before `m2`'s copy; `e` forks a conversation whose
// file is gone; `f` and `g` each name the other as their source.
fn write_forks(config: &Path) {
    write_conversation(
        config,
        "-project-a",
        "a",
        &[
            json!({"type": "user", "uuid": "m1", "parentUuid": null, "message": {"content": "hi"}}),
            json!({"type": "assistant", "uuid": "m2", "parentUuid": "m1"}),
            json!({"type": "user", "uuid": "m3", "parentUuid": "m2", "message": {"content": "go"}}),
            queued_prompt("q", "m3"),
        ],
    );
    let mut b_entries = vec![
        copy("b1", None, "a", "m1"),
        copy("b2", Some("b1"), "a", "m2"),
        copy("b3", Some("b2"), "a", "m3"),
    ];
    let mut b_queued = queued_prompt("bq", "b3");
    b_queued["forkedFrom"] = json!({ "sessionId": "a", "messageUuid": "q" });
    b_entries.push(b_queued);
    b_entries.push(json!({"type": "user", "uuid": "n1", "parentUuid": "bq"}));
    write_conversation(config, "-project-b", "b", &b_entries);
    let mut c_queued = queued_prompt("cq", "c3");
    c_queued["forkedFrom"] = json!({ "sessionId": "b", "messageUuid": "bq" });
    write_conversation(
        config,
        "-project-a",
        "c",
        &[
            copy("c1", None, "b", "b1"),
            copy("c2", Some("c1"), "b", "b2"),
            copy("c3", Some("c2"), "b", "b3"),
            c_queued,
            copy("cn1", Some("cq"), "b", "n1"),
        ],
    );
    write_conversation(config, "-project-b", "d", &[copy("d1", None, "b", "b1")]);
    write_conversation(config, "-project-b", "e", &[copy("e1", None, "gone", "m1")]);
    write_conversation(config, "-project-b", "f", &[copy("f1", None, "g", "g1")]);
    write_conversation(config, "-project-b", "g", &[copy("g1", None, "f", "f1")]);
}

// Killed by a walk that stops at the current conversation, maps a fork's copy by the message's
// own id, drops the `source_uuid` match or the visited set, or reads a gone file as an error.
#[rstest::rstest]
#[case::in_place("a", "m2", Some("m2"))]
#[case::queued_prompt("a", "s", Some("q"))]
#[case::one_fork("b", "m2", Some("b2"))]
#[case::two_forks("c", "m2", Some("c2"))]
#[case::found_only_in_the_fork("c", "n1", Some("cn1"))]
#[case::cut_before_it("d", "m2", None)]
#[case::source_gone("e", "m2", None)]
#[case::a_cycle("f", "m2", None)]
#[tokio::test]
async fn a_message_is_found_through_each_fork_and_a_queued_prompt_by_its_source_id(
    #[case] conversation_id: &str,
    #[case] message_id: &str,
    #[case] expected: Option<&str>,
) {
    let config = tempfile::tempdir().expect("a scratch folder");
    write_forks(config.path());

    let found = tokio::time::timeout(
        Duration::from_secs(5),
        resolve_claude_message(config.path(), conversation_id, message_id),
    )
    .await
    .expect("the walk ends")
    .expect("the files read");

    assert_eq!(found.as_deref(), expected);
}

// What the conversation's file holds: the entries before the prompt `p2`, a folder in the file's
// place, or nothing at all.
#[derive(Clone, Copy)]
enum ConversationFile {
    BeforeThePrompt(&'static [&'static str]),
    FolderInItsPlace,
    Gone,
}

// Killed by a fork point taken from the row before in file order, one that keeps a `progress`
// parent, a read failure read as no fork point, and by any two of the first entry, a missing
// entry and a gone file answered alike.
#[rstest::rstest]
#[case::after_the_turn(ConversationFile::BeforeThePrompt(&["p1", "a1", "t1"]), "p2", Ok(After("t1")))]
#[case::past_a_progress_row(
    ConversationFile::BeforeThePrompt(&["p1", "a1", "t1", "progress"]),
    "p2",
    Ok(After("t1"))
)]
#[case::the_first_entry(ConversationFile::BeforeThePrompt(&[]), "p2", Ok(AtStart))]
#[case::an_entry_the_file_lacks(ConversationFile::BeforeThePrompt(&["p1"]), "zzz", Ok(EntryMissing))]
#[case::a_gone_file(ConversationFile::Gone, "p2", Ok(FileGone))]
#[case::a_folder_in_the_files_place(ConversationFile::FolderInItsPlace, "p2", Err(()))]
#[tokio::test]
async fn the_fork_point_is_the_prompts_parent_past_progress_rows(
    #[case] file: ConversationFile,
    #[case] entry_id: &str,
    #[case] expected: Result<ExpectedForkPoint, ()>,
) {
    let config = tempfile::tempdir().expect("a scratch folder");
    match file {
        ConversationFile::BeforeThePrompt(uuids) => {
            let mut entries = Vec::new();
            let mut parent_uuid: Option<&str> = None;
            for uuid in uuids {
                let entry_type = if *uuid == "progress" {
                    "progress"
                } else {
                    "user"
                };
                entries.push(json!({"type": entry_type, "uuid": uuid, "parentUuid": parent_uuid}));
                parent_uuid = Some(uuid);
            }
            // A row of another chain, written between the turn and the prompt.
            entries.push(json!({"type": "system", "uuid": "aside", "parentUuid": null}));
            entries.push(json!({"type": "user", "uuid": "p2", "parentUuid": parent_uuid}));
            write_conversation(config.path(), "-project", "conversation", &entries);
        }
        ConversationFile::FolderInItsPlace => {
            fs::create_dir_all(
                config
                    .path()
                    .join("projects")
                    .join("-project")
                    .join("conversation.jsonl"),
            )
            .expect("the folder is made");
        }
        ConversationFile::Gone => {
            fs::create_dir_all(config.path().join("projects").join("-project"))
                .expect("the project folder is made");
        }
    }

    let fork_point = read_claude_fork_point(config.path(), "conversation", entry_id).await;

    assert_eq!(
        fork_point.map_err(drop),
        expected.map(ExpectedForkPoint::into_point)
    );
}

// A fork point a case expects, its uuid borrowed.
#[derive(Clone, Copy, Debug)]
enum ExpectedForkPoint {
    AtStart,
    After(&'static str),
    EntryMissing,
    FileGone,
}

use ExpectedForkPoint::{After, AtStart, EntryMissing, FileGone};

impl ExpectedForkPoint {
    fn into_point(self) -> ClaudeForkPoint {
        match self {
            Self::AtStart => ClaudeForkPoint::AtStart,
            Self::After(uuid) => ClaudeForkPoint::After(uuid.to_owned()),
            Self::EntryMissing => ClaudeForkPoint::EntryMissing,
            Self::FileGone => ClaudeForkPoint::FileGone,
        }
    }
}
