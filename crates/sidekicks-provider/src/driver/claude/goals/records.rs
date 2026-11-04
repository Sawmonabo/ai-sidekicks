//! The goal checks' outcomes on Claude Code, which never reach the stream: each is a `goal_status`
//! attachment Claude Code appends to the conversation file, `{"type":"attachment","attachment":
//! {"type":"goal_status",…}}`, read here from where the last read ended to the file's end, and
//! a fork's predecessor's collected by uuid through the fork point.

use std::collections::HashSet;
use std::io;
use std::ops::ControlFlow;
use std::path::Path;

use serde::Deserialize;
use sidekicks_std::missing_entry::MissingEntry;

use crate::driver::claude::session::conversation_file::lines::{
    ConversationLine, read_conversation_lines,
};
use crate::lenient_json::{lenient_object, read_lenient};

/// One `goal_status` record: a set or a compaction's rewrite is a sentinel, unmet; a clear a
/// sentinel, met; a check's outcome met, unmet, or unmet and failed when the goal is impossible.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct GoalStatusRecord {
    /// Whether the goal reads met, or cleared on a sentinel.
    pub(crate) is_met: bool,
    /// Whether the check found the goal impossible.
    pub(crate) is_failed: bool,
    /// Whether the record marks a set, a clear or a compaction rather than a check's outcome.
    pub(crate) is_sentinel: bool,
    /// The goal's condition, where the record names it.
    pub(crate) condition: Option<String>,
    /// The check's reason for its outcome.
    pub(crate) reason: Option<String>,
    /// The entry's uuid, which a fork's copy of the entry keeps.
    pub(crate) uuid: Option<String>,
}

/// What one read of the conversation file's tail found.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct GoalStatusTail {
    /// The `goal_status` records of the lines read, oldest first.
    pub(crate) records: Vec<GoalStatusRecord>,
    /// The offset after the last line read through its newline, where the next read starts.
    pub(crate) end: u64,
}

/// Reads the conversation `file` from byte `from` to its end and keeps its `goal_status` records in
/// order; every other entry, a line past the ceiling and a last line not yet ended by its newline
/// are passed over, the last left for the next read. A file that does not exist reads no record,
/// `end` at `from`; any other open or read failure surfaces.
pub(crate) async fn read_goal_status_tail(file: &Path, from: u64) -> io::Result<GoalStatusTail> {
    let Some(opened) = tokio::fs::File::open(file).await.none_if_missing()? else {
        return Ok(GoalStatusTail {
            records: Vec::new(),
            end: from,
        });
    };
    let mut records = Vec::new();
    let end = read_conversation_lines::<AttachmentEntry>(opened, file, from, |line| {
        records.extend(read_goal_status_record(line));
        ControlFlow::Continue(())
    })
    .await?;
    Ok(GoalStatusTail { records, end })
}

/// The uuids of the `goal_status` records of the conversation `file` from its start through the
/// entry whose uuid is `message_uuid`, or through its end where no entry is; a file that does not
/// exist holds none. Fails as the file cannot be opened or read.
pub(crate) async fn goal_status_uuids_through(
    file: &Path,
    message_uuid: &str,
) -> io::Result<HashSet<String>> {
    let Some(opened) = tokio::fs::File::open(file).await.none_if_missing()? else {
        return Ok(HashSet::new());
    };
    let mut uuids = HashSet::new();
    read_conversation_lines::<AttachmentEntry>(opened, file, 0, |line| {
        let is_through = line.entry.uuid.as_deref() == Some(message_uuid);
        uuids.extend(read_goal_status_record(line).and_then(|record| record.uuid));
        if is_through {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })
    .await?;
    Ok(uuids)
}

// The `goal_status` record `line` holds, where it is one and ended by its newline.
fn read_goal_status_record(
    line: ConversationLine<'_, AttachmentEntry>,
) -> Option<GoalStatusRecord> {
    let attachment = line.entry.attachment.filter(|_| line.is_terminated)?;
    (attachment.attachment_type.as_deref() == Some(GOAL_STATUS_ATTACHMENT_TYPE)).then(|| {
        GoalStatusRecord {
            is_met: attachment.met == Some(true),
            is_failed: attachment.failed == Some(true),
            is_sentinel: attachment.sentinel == Some(true),
            condition: attachment.condition,
            reason: attachment.reason,
            uuid: line.entry.uuid,
        }
    })
}

const GOAL_STATUS_ATTACHMENT_TYPE: &str = "goal_status";

// The members of an entry the goal reads use.
#[derive(Deserialize)]
struct AttachmentEntry {
    #[serde(default, deserialize_with = "read_lenient")]
    attachment: Option<EntryAttachment>,
    #[serde(default, deserialize_with = "read_lenient")]
    uuid: Option<String>,
}

// An attachment's members as a `goal_status` one carries them, each read leniently.
#[derive(Deserialize)]
struct EntryAttachment {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    attachment_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    met: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    failed: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    sentinel: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    condition: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    reason: Option<String>,
}

lenient_object!(AttachmentEntry, EntryAttachment);

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::HashSet;
    use std::fs;
    use std::io::Write;
    use std::path::Path;

    use serde_json::{Value, json};

    use super::{
        GoalStatusRecord, GoalStatusTail, goal_status_uuids_through, read_goal_status_tail,
    };

    /// A `goal_status` record with no uuid and no reason.
    pub(crate) fn record(
        is_met: bool,
        is_failed: bool,
        is_sentinel: bool,
        condition: Option<&str>,
    ) -> GoalStatusRecord {
        GoalStatusRecord {
            is_met,
            is_failed,
            is_sentinel,
            condition: condition.map(str::to_owned),
            reason: None,
            uuid: None,
        }
    }

    /// Appends `text` to the conversation `file`, making it where it is missing.
    pub(crate) fn append(file: &Path, text: &str) {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(file)
            .expect("the conversation opens")
            .write_all(text.as_bytes())
            .expect("the conversation is written");
    }

    /// A `goal_status` attachment entry `uuid` carrying `members`, on a line of its own.
    pub(crate) fn goal_status_line(uuid: &str, mut members: Value) -> String {
        members["type"] = json!("goal_status");
        format!(
            "{}\n",
            json!({"type": "attachment", "uuid": uuid, "attachment": members})
        )
    }

    fn file_length(file: &Path) -> u64 {
        fs::metadata(file).expect("the conversation exists").len()
    }

    // Killed by keeping only one record or reversing their order, by reading from the file's start
    // rather than `from`, by an `end` that does not advance, and by an `end` past a last line whose
    // newline has not landed, which would lose the record once its newline lands.
    #[tokio::test]
    async fn the_tail_keeps_its_records_in_order_and_the_next_read_starts_where_it_ended() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let file = folder.path().join("conversation.jsonl");
        let missing = read_goal_status_tail(&file, 7)
            .await
            .expect("no file reads");
        assert_eq!(
            missing,
            GoalStatusTail {
                records: Vec::new(),
                end: 7
            }
        );
        append(
            &file,
            concat!(
                r#"{"type":"user","uuid":"u1","message":{"content":"/goal ship it"}}"#,
                "\n"
            ),
        );
        append(
            &file,
            &goal_status_line(
                "g",
                json!({"met": false, "sentinel": true, "condition": "ship it"}),
            ),
        );
        append(
            &file,
            concat!(
                r#"{"type":"user","uuid":"r1","message":{"content":[{"type":"tool_result"}]}}"#,
                "\n"
            ),
        );
        append(
            &file,
            &goal_status_line(
                "g",
                json!({
                "met": true,
                "condition": "ship it",
                "reason": "it shipped",
                "iterations": 3,
                "durationMs": 1200,
                "tokens": 40,
                }),
            ),
        );

        let first = read_goal_status_tail(&file, 0)
            .await
            .expect("the file reads");

        assert_eq!(
            first,
            GoalStatusTail {
                records: vec![
                    GoalStatusRecord {
                        is_sentinel: true,
                        condition: Some("ship it".to_owned()),
                        uuid: Some("g".to_owned()),
                        ..GoalStatusRecord::default()
                    },
                    GoalStatusRecord {
                        is_met: true,
                        condition: Some("ship it".to_owned()),
                        reason: Some("it shipped".to_owned()),
                        uuid: Some("g".to_owned()),
                        ..GoalStatusRecord::default()
                    },
                ],
                end: file_length(&file),
            }
        );
        let unchanged = read_goal_status_tail(&file, first.end)
            .await
            .expect("the file reads");
        assert_eq!(
            unchanged,
            GoalStatusTail {
                records: Vec::new(),
                end: first.end
            }
        );

        let clear = goal_status_line(
            "g",
            json!({"met": true, "sentinel": true, "condition": "ship it"}),
        );
        let (unended, newline) = clear.split_at(clear.len() - 1);
        append(&file, unended);
        let unended_read = read_goal_status_tail(&file, first.end)
            .await
            .expect("the file reads");
        assert_eq!(
            unended_read,
            GoalStatusTail {
                records: Vec::new(),
                end: first.end
            }
        );
        append(&file, newline);
        let cleared = read_goal_status_tail(&file, unended_read.end)
            .await
            .expect("the file reads");
        assert_eq!(
            cleared,
            GoalStatusTail {
                records: vec![GoalStatusRecord {
                    is_met: true,
                    is_sentinel: true,
                    condition: Some("ship it".to_owned()),
                    uuid: Some("g".to_owned()),
                    ..GoalStatusRecord::default()
                }],
                end: file_length(&file),
            }
        );
    }

    // Killed by dropping the attachment's type check: the queued command after the record would
    // read as an unmet record.
    #[tokio::test]
    async fn another_attachment_reads_no_record() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let file = folder.path().join("conversation.jsonl");
        append(
            &file,
            &goal_status_line(
                "g",
                json!({"met": false, "condition": "ship it", "reason": "not yet"}),
            ),
        );
        append(
            &file,
            concat!(
                r#"{"type":"attachment","attachment":{"type":"queued_command","prompt":"next"}}"#,
                "\n"
            ),
        );

        let after = read_goal_status_tail(&file, 0)
            .await
            .expect("the file reads");

        assert_eq!(
            after,
            GoalStatusTail {
                records: vec![GoalStatusRecord {
                    condition: Some("ship it".to_owned()),
                    reason: Some("not yet".to_owned()),
                    uuid: Some("g".to_owned()),
                    ..GoalStatusRecord::default()
                }],
                end: file_length(&file),
            }
        );
    }

    // Killed by removing the stop at the fork point: the record after it would join the set.
    #[tokio::test]
    async fn the_uuids_are_collected_through_the_fork_point_alone() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let file = folder.path().join("conversation.jsonl");
        assert_eq!(
            goal_status_uuids_through(&file, "f")
                .await
                .expect("no file reads"),
            HashSet::new()
        );
        append(
            &file,
            &goal_status_line(
                "g1",
                json!({"met": false, "sentinel": true, "condition": "c"}),
            ),
        );
        append(
            &file,
            concat!(
                r#"{"type":"user","uuid":"f","message":{"content":"next"}}"#,
                "\n"
            ),
        );
        append(
            &file,
            &goal_status_line("g2", json!({"met": true, "condition": "c"})),
        );
        let uuids = |uuids: &[&str]| -> HashSet<String> {
            uuids.iter().map(|&uuid| uuid.to_owned()).collect()
        };

        let through_fork_point = goal_status_uuids_through(&file, "f")
            .await
            .expect("the file reads");
        let through_unknown = goal_status_uuids_through(&file, "unknown")
            .await
            .expect("the file reads");

        assert_eq!(through_fork_point, uuids(&["g1"]));
        assert_eq!(through_unknown, uuids(&["g1", "g2"]));
    }
}
