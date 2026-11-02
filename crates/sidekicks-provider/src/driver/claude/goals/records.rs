//! The goal checks' outcomes on Claude Code, which never reach the stream: each is a `goal_status`
//! attachment Claude Code appends to the conversation file, `{"type":"attachment","attachment":
//! {"type":"goal_status",…}}`, read here from where the last read ended to the file's end.

use std::io;
use std::ops::ControlFlow;
use std::path::Path;

use serde::Deserialize;
use sidekicks_std::missing_entry::MissingEntry;

use crate::driver::claude::session::conversation_file::lines::read_conversation_lines;
use crate::lenient_json::{lenient_object, read_lenient};

/// One `goal_status` record: a set or a compaction's rewrite is a sentinel, unmet; a clear a
/// sentinel, met; a check's outcome met, unmet, or unmet and failed when the goal is impossible.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct GoalStatusRecord {
    /// Whether the goal reads met, or cleared on a sentinel.
    pub(crate) met: bool,
    /// Whether the check found the goal impossible.
    pub(crate) failed: bool,
    /// Whether the record marks a set, a clear or a compaction rather than a check's outcome.
    pub(crate) sentinel: bool,
    /// The goal's condition, where the record names it.
    pub(crate) condition: Option<String>,
    /// The check's reason for its outcome.
    pub(crate) reason: Option<String>,
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
        if line.is_terminated
            && let Some(attachment) = line.entry.attachment
            && attachment.attachment_type.as_deref() == Some(GOAL_STATUS_ATTACHMENT_TYPE)
        {
            records.push(GoalStatusRecord {
                met: attachment.met == Some(true),
                failed: attachment.failed == Some(true),
                sentinel: attachment.sentinel == Some(true),
                condition: attachment.condition,
                reason: attachment.reason,
            });
        }
        ControlFlow::Continue(())
    })
    .await?;
    Ok(GoalStatusTail { records, end })
}

const GOAL_STATUS_ATTACHMENT_TYPE: &str = "goal_status";

// The one member of an entry the goal read uses.
#[derive(Deserialize)]
struct AttachmentEntry {
    #[serde(default, deserialize_with = "read_lenient")]
    attachment: Option<EntryAttachment>,
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
mod tests {
    use std::fs;
    use std::io::Write;
    use std::path::Path;

    use serde_json::{Value, json};

    use super::{GoalStatusRecord, GoalStatusTail, read_goal_status_tail};
    use crate::driver::claude::session::process::CLAUDE_OUTPUT_LINE_MAX_BYTES;

    fn append(file: &Path, text: &str) {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(file)
            .expect("the conversation opens")
            .write_all(text.as_bytes())
            .expect("the conversation is written");
    }

    // A `goal_status` attachment entry carrying `members`, on a line of its own.
    fn goal_status_line(mut members: Value) -> String {
        members["type"] = json!("goal_status");
        format!(
            "{}\n",
            json!({"type": "attachment", "uuid": "g", "attachment": members})
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
            &goal_status_line(json!({"met": false, "sentinel": true, "condition": "ship it"})),
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
            &goal_status_line(json!({
                "met": true,
                "condition": "ship it",
                "reason": "it shipped",
                "iterations": 3,
                "durationMs": 1200,
                "tokens": 40,
            })),
        );

        let first = read_goal_status_tail(&file, 0)
            .await
            .expect("the file reads");

        assert_eq!(
            first,
            GoalStatusTail {
                records: vec![
                    GoalStatusRecord {
                        sentinel: true,
                        condition: Some("ship it".to_owned()),
                        ..GoalStatusRecord::default()
                    },
                    GoalStatusRecord {
                        met: true,
                        condition: Some("ship it".to_owned()),
                        reason: Some("it shipped".to_owned()),
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

        let clear =
            goal_status_line(json!({"met": true, "sentinel": true, "condition": "ship it"}));
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
                    met: true,
                    sentinel: true,
                    condition: Some("ship it".to_owned()),
                    ..GoalStatusRecord::default()
                }],
                end: file_length(&file),
            }
        );
    }

    // Killed by reading a line whole however long it is (the `take` bound dropped): the long record
    // would read as a record. Killed too by dropping the attachment's type check: the queued
    // command after the record would read as an unmet record.
    #[tokio::test]
    async fn a_line_past_the_ceiling_and_another_attachment_read_no_record() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let file = folder.path().join("conversation.jsonl");
        append(
            &file,
            &goal_status_line(json!({
                "met": true,
                "reason": "x".repeat(CLAUDE_OUTPUT_LINE_MAX_BYTES),
            })),
        );

        let past_ceiling = read_goal_status_tail(&file, 0)
            .await
            .expect("the file reads");

        assert_eq!(
            past_ceiling,
            GoalStatusTail {
                records: Vec::new(),
                end: file_length(&file)
            }
        );
        append(
            &file,
            &goal_status_line(json!({"met": false, "condition": "ship it", "reason": "not yet"})),
        );
        append(
            &file,
            concat!(
                r#"{"type":"attachment","attachment":{"type":"queued_command","prompt":"next"}}"#,
                "\n"
            ),
        );

        let after = read_goal_status_tail(&file, past_ceiling.end)
            .await
            .expect("the file reads");

        assert_eq!(
            after,
            GoalStatusTail {
                records: vec![GoalStatusRecord {
                    condition: Some("ship it".to_owned()),
                    reason: Some("not yet".to_owned()),
                    ..GoalStatusRecord::default()
                }],
                end: file_length(&file),
            }
        );
    }
}
