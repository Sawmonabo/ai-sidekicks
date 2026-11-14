//! Whether a cut Claude Code made took one of the person's messages, read from the end of the
//! conversation's file back. A cut that lands appends an explicit `last-prompt` row marked
//! `rewound` whose `leafUuid` names where the conversation now ends and whose `cutUuid` names the
//! entry the cut began at. An explicit row with no `rewound` naming that same end, as Claude Code's
//! own relaunch writes it, leaves the cut standing; one naming another end, as the row taking back
//! a refused cut does, ends it; and a turn after a cut writes `user` and `assistant` entries. So
//! the cuts that stand are the rows after the last such entry that no later row moved off their
//! end, and a message is cut away only where one of them names the entry holding it. No chain is
//! followed and none of Claude Code's rules for where a conversation ends is read: leaf rows,
//! compactions and parallel tool results leave a message held.

use std::fs::File;
use std::io::{self, Read as _, Seek as _};
use std::path::Path;

use memchr::memmem::FinderRev;
use serde::Deserialize;

use crate::driver::claude::session::process::CLAUDE_OUTPUT_LINE_MAX_BYTES;
use crate::driver::rewind::RewindTargetPresence;
use crate::inbound_json::decode_inbound_json;
use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};

/// How much of the file one read takes, from its end back.
const BLOCK_BYTES: u64 = 1024 * 1024;

/// The entry kinds a cut can begin at.
const CONVERSATION_ENTRY_TYPES: [&str; 5] =
    ["user", "assistant", "system", "attachment", "progress"];

/// Whether a cut Claude Code made took the person's message `message_id` from the conversation
/// `file`: `CutAway` where a standing cut began at the entry holding it, as its own uuid, as a
/// prompt Claude Code took mid-turn by its `source_uuid`, or among a merged command's
/// `mergedSendUuids`; `Held` wherever the rows do not show that, a cut row with no `cutUuid`, an
/// unreadable line or a line past the ceiling among them. Reads from the end on a blocking thread:
/// every line after the last turn's entry, then only the lines a search of the bytes finds naming
/// the message. Fails as the file cannot be opened or read.
pub(crate) async fn read_claude_cut_rows(
    file: &Path,
    message_id: &str,
) -> io::Result<RewindTargetPresence> {
    let file = file.to_owned();
    let message_id = message_id.to_owned();
    tokio::task::spawn_blocking(move || {
        read_cut_rows(
            &file,
            &message_id,
            BLOCK_BYTES,
            CLAUDE_OUTPUT_LINE_MAX_BYTES,
        )
    })
    .await
    .map_err(io::Error::other)?
}

// `read_claude_cut_rows`'s read, on the blocking thread it runs on: `block_bytes` at a time from
// the end back, a line longer than `line_max_bytes` skipped unread.
fn read_cut_rows(
    file: &Path,
    message_id: &str,
    block_bytes: u64,
    line_max_bytes: usize,
) -> io::Result<RewindTargetPresence> {
    let mut opened = File::open(file)?;
    let mut end = opened.metadata()?.len();
    let mut read = CutRowsRead::new(message_id);
    // The bytes read last, with the end of the line they cut joined on; reused across reads.
    let mut block: Vec<u8> = Vec::new();
    // The end of a line begun before the bytes read last, without its newline, as the reads it
    // spans, newest first, so a long line is copied once, when its start is read.
    let mut tail: Vec<Vec<u8>> = Vec::new();
    let mut tail_bytes = 0;
    // Whether the bytes read next end inside a line past the ceiling, dropped up to its start.
    let mut is_skipping = false;
    while end > 0 {
        let start = end.saturating_sub(block_bytes);
        block.resize(
            usize::try_from(end - start).expect("a block's length fits in memory"),
            0,
        );
        opened.seek(io::SeekFrom::Start(start))?;
        opened.read_exact(&mut block)?;
        end = start;
        if is_skipping {
            match memchr::memrchr(b'\n', &block) {
                Some(newline) => {
                    block.truncate(newline + 1);
                    is_skipping = false;
                }
                None => continue,
            }
        }
        // Where the read's whole lines start: the bytes through its first newline end a line
        // begun before it, unless it starts the file.
        let lines_start = match (start, memchr::memchr(b'\n', &block)) {
            (0, _) => 0,
            (_, Some(newline)) => newline + 1,
            (_, None) => {
                tail_bytes += block.len();
                if tail_bytes > line_max_bytes {
                    tail.clear();
                    tail_bytes = 0;
                    is_skipping = true;
                    if let Some(answer) = read.pass_unread_line() {
                        return Ok(answer);
                    }
                } else {
                    tail.push(std::mem::take(&mut block));
                }
                continue;
            }
        };
        for piece in tail.drain(..).rev() {
            block.extend_from_slice(&piece);
        }
        tail_bytes = 0;
        if let Some(answer) = read.read_block(&block[lines_start..]) {
            return Ok(answer);
        }
        if start > 0 {
            // The read's first line, less its newline, ends a line the next read begins.
            let head = &block[..lines_start - 1];
            if head.len() > line_max_bytes {
                is_skipping = true;
                if let Some(answer) = read.pass_unread_line() {
                    return Ok(answer);
                }
            } else {
                tail_bytes = head.len();
                tail.push(head.to_vec());
            }
        }
    }
    Ok(RewindTargetPresence::Held)
}

// The read from the end back: every row after the last turn's entry, then the entry holding the
// message.
struct CutRowsRead<'id> {
    message_id: &'id str,
    // Finds the message's id in the file's bytes, from the end back.
    message_finder: FinderRev<'id>,
    // The entries the standing cuts began at, as their rows name them.
    cut_starts: Vec<String>,
    // The end the explicit rows with no `rewound` read since the last standing cut's row name.
    kept_end: Option<String>,
    // Whether every row after the last turn's entry was read.
    is_tail_read: bool,
}

impl<'id> CutRowsRead<'id> {
    fn new(message_id: &'id str) -> Self {
        Self {
            message_id,
            message_finder: FinderRev::new(message_id),
            cut_starts: Vec::new(),
            kept_end: None,
            is_tail_read: false,
        }
    }

    // Takes `block`'s whole lines from its end back: every line until the tail is read, then
    // only the lines a search of the bytes finds naming the message, so the rest is never parsed.
    // Answers once the rows settle where the message stands.
    fn read_block(&mut self, block: &[u8]) -> Option<RewindTargetPresence> {
        // Where the lines not yet taken end.
        let mut cursor = block.len();
        let mut message_at = LastHit::default();
        while cursor > 0 {
            let region = &block[..cursor];
            let (line_start, line_end) = if self.is_tail_read {
                let hit = message_at.before(&self.message_finder, region)?;
                let line_end = memchr::memchr(b'\n', &region[hit..])
                    .map_or(region.len(), |newline| hit + newline);
                (line_start_before(region, hit), line_end)
            } else {
                let line_end = cursor - usize::from(region.last() == Some(&b'\n'));
                (line_start_before(region, line_end), line_end)
            };
            cursor = line_start;
            let line = &region[line_start..line_end];
            if line.is_empty() {
                continue;
            }
            let entry = read_entry(line);
            let answer = if self.is_tail_read {
                entry.and_then(|entry| self.take_holding(&entry))
            } else {
                self.take_tail_row(entry)
            };
            if answer.is_some() {
                return answer;
            }
        }
        None
    }

    // Takes the next row of the tail back, `None` for a line that does not read as one: a cut's
    // row stands while the later rows keep its end, a row moving the end elsewhere or a turn's
    // entry ends the tail, and an unreadable line ends it too, since it may be either.
    fn take_tail_row(&mut self, entry: Option<ConversationEntry>) -> Option<RewindTargetPresence> {
        let Some(entry) = entry else {
            return self.end_tail();
        };
        match entry.entry_type.as_deref() {
            Some("last-prompt") if entry.is_explicit == Some(true) => {
                if entry.is_rewound != Some(true) {
                    return match (&self.kept_end, entry.leaf_uuid) {
                        (None, Some(end)) => {
                            self.kept_end = Some(end);
                            None
                        }
                        (Some(kept), Some(end)) if *kept == end => None,
                        (Some(_), Some(_)) | (Some(_) | None, None) => self.end_tail(),
                    };
                }
                if let Some(kept) = self.kept_end.take()
                    && entry.leaf_uuid.as_ref() != Some(&kept)
                {
                    return self.end_tail();
                }
                match entry.cut_uuid {
                    // The cut began at the message's own entry.
                    Some(start) if start == self.message_id => Some(RewindTargetPresence::CutAway),
                    Some(start) => {
                        self.cut_starts.push(start);
                        None
                    }
                    None => None,
                }
            }
            Some("user" | "assistant") => self.end_tail().or_else(|| self.take_holding(&entry)),
            Some(_) | None => None,
        }
    }

    // Takes an entry the search found naming the message; answers once it is the newest entry
    // holding it.
    fn take_holding(&self, entry: &ConversationEntry) -> Option<RewindTargetPresence> {
        let uuid = entry.uuid.as_deref().filter(|uuid| !uuid.is_empty())?;
        let is_conversation_entry = entry.is_sidechain != Some(true)
            && entry
                .entry_type
                .as_deref()
                .is_some_and(|entry_type| CONVERSATION_ENTRY_TYPES.contains(&entry_type));
        if !is_conversation_entry || !entry.holds(self.message_id) {
            return None;
        }
        Some(if self.cut_starts.iter().any(|start| start == uuid) {
            RewindTargetPresence::CutAway
        } else {
            RewindTargetPresence::Held
        })
    }

    // The tail is read: with no standing cut the message is held.
    fn end_tail(&mut self) -> Option<RewindTargetPresence> {
        self.is_tail_read = true;
        self.cut_starts
            .is_empty()
            .then_some(RewindTargetPresence::Held)
    }

    // A line past the ceiling went by unread: in the tail it may take a cut back or be a turn's
    // entry, and past it it may hold the message, so nothing past it shows the message cut.
    fn pass_unread_line(&mut self) -> Option<RewindTargetPresence> {
        if self.is_tail_read {
            return Some(RewindTargetPresence::Held);
        }
        self.end_tail()
    }
}

// The last place a finder found its needle in a block before the lines not yet taken, searched
// again only once the read passes it.
#[derive(Default)]
enum LastHit {
    #[default]
    Unsearched,
    At(usize),
    Absent,
}

impl LastHit {
    fn before(&mut self, finder: &FinderRev<'_>, region: &[u8]) -> Option<usize> {
        let is_stale = match *self {
            Self::Unsearched => true,
            Self::At(at) => at >= region.len(),
            Self::Absent => false,
        };
        if is_stale {
            *self = finder.rfind(region).map_or(Self::Absent, Self::At);
        }
        match *self {
            Self::At(at) => Some(at),
            Self::Unsearched | Self::Absent => None,
        }
    }
}

// Where the line holding `region`'s byte `at` starts.
fn line_start_before(region: &[u8], at: usize) -> usize {
    memchr::memrchr(b'\n', &region[..at]).map_or(0, |newline| newline + 1)
}

// The entry `line` holds where it is one whole JSON object. It is read as it stands first, and
// only a line that read refuses is read again with its invalid UTF-8 and lone surrogate escapes
// repaired, which changes none of the ASCII members the read takes.
fn read_entry(line: &[u8]) -> Option<ConversationEntry> {
    match std::str::from_utf8(line).map(read_whole_object) {
        Ok(Ok(entry)) => entry,
        Ok(Err(_)) | Err(_) => read_whole_object(&decode_inbound_json(line)).ok().flatten(),
    }
}

// The entry `text` holds, `None` where it is another JSON value, every member the entry does not
// name skipped unbuilt; fails where `text` is not one whole JSON value.
fn read_whole_object(text: &str) -> sonic_rs::Result<Option<ConversationEntry>> {
    let mut deserializer = sonic_rs::Deserializer::from_str(text);
    let entry = ConversationEntry::read(&mut deserializer)?;
    deserializer.end()?;
    Ok(entry)
}

// The members of an entry the read takes, each leniently.
#[derive(Deserialize)]
struct ConversationEntry {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    entry_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    uuid: Option<String>,
    #[serde(rename = "isSidechain", default, deserialize_with = "read_lenient")]
    is_sidechain: Option<bool>,
    #[serde(rename = "explicit", default, deserialize_with = "read_lenient")]
    is_explicit: Option<bool>,
    #[serde(rename = "rewound", default, deserialize_with = "read_lenient")]
    is_rewound: Option<bool>,
    #[serde(rename = "cutUuid", default, deserialize_with = "read_lenient")]
    cut_uuid: Option<String>,
    #[serde(rename = "leafUuid", default, deserialize_with = "read_lenient")]
    leaf_uuid: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    attachment: Option<EntryAttachment>,
    #[serde(rename = "mergedSendUuids", default, deserialize_with = "read_lenient")]
    merged_send_uuids: Option<LenientList<String>>,
}

// An attachment's kind and, for a prompt Claude Code took mid-turn, the id it was sent with.
#[derive(Deserialize)]
struct EntryAttachment {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    attachment_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    source_uuid: Option<String>,
}

impl ConversationEntry {
    // Whether the entry holds the person's message `message_id` by any id Claude Code's cut
    // resolves it by.
    fn holds(&self, message_id: &str) -> bool {
        self.uuid.as_deref() == Some(message_id)
            || self.attachment.as_ref().is_some_and(|attachment| {
                attachment.attachment_type.as_deref() == Some("queued_command")
                    && attachment.source_uuid.as_deref() == Some(message_id)
            })
            || self
                .merged_send_uuids
                .as_ref()
                .is_some_and(|LenientList(members)| members.iter().any(|id| id == message_id))
    }
}

lenient_object!(ConversationEntry, EntryAttachment);

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::read_cut_rows;
    use crate::driver::rewind::RewindTargetPresence;

    // A conversation entry of `entry_type`, its message text `text`.
    fn entry(entry_type: &str, uuid: &str, parent: Option<&str>, text: &str) -> Value {
        json!({
            "parentUuid": parent,
            "isSidechain": false,
            "type": entry_type,
            "uuid": uuid,
            "message": {"content": text},
        })
    }

    // A prompt Claude Code took mid-turn, the person's message `source` sent as it.
    fn steer(uuid: &str, parent: &str, source: &str, text: &str) -> Value {
        json!({
            "parentUuid": parent,
            "isSidechain": false,
            "type": "attachment",
            "uuid": uuid,
            "attachment": {"type": "queued_command", "source_uuid": source, "prompt": text},
        })
    }

    // The row a cut that landed writes, keeping `leaf` and beginning at `start`.
    fn cut_row(leaf: &str, start: &str) -> Value {
        json!({
            "type": "last-prompt",
            "leafUuid": leaf,
            "explicit": true,
            "rewound": true,
            "cutUuid": start,
        })
    }

    // Each of `lines` ended by its newline.
    fn file_of(lines: &[Value]) -> String {
        let mut text = String::new();
        for line in lines {
            text.push_str(&line.to_string());
            text.push('\n');
        }
        text
    }

    // Two turns, the second opened by the asked message `asked-m`.
    fn two_turns() -> Vec<Value> {
        vec![
            entry("user", "root-a", None, "first"),
            entry("assistant", "reply-1", Some("root-a"), "one"),
            entry("user", "asked-m", Some("reply-1"), "second"),
            entry("assistant", "reply-2", Some("asked-m"), "two"),
        ]
    }

    // The second turn cut at its own entry, as the live run wrote it.
    fn own_entry_cut() -> String {
        let mut lines = two_turns();
        lines.push(cut_row("reply-1", "asked-m"));
        file_of(&lines)
    }

    // The asked message rode a turn as a steer whose line spans blocks; the cut began at the
    // steer, and Claude Code then noted what the cut stripped and where the conversation ends.
    fn spanning_steer_cut() -> String {
        file_of(&[
            entry("user", "root-a", None, "first"),
            entry("assistant", "reply-1", Some("root-a"), "one"),
            steer("steer-e", "reply-1", "asked-m", &"m".repeat(90)),
            entry("assistant", "reply-2", Some("steer-e"), "two"),
            cut_row("reply-1", "steer-e"),
            json!({"type": "attachment", "uuid": "strip-s", "parentUuid": "reply-1",
                "attachment": {"type": "thinking_stripped"}}),
            json!({"type": "last-prompt", "leafUuid": "strip-s"}),
        ])
    }

    // The reply the cut took is longer than the ceiling.
    fn reply_past_the_ceiling() -> String {
        file_of(&[
            entry("user", "root-a", None, "first"),
            steer("steer-e", "root-a", "asked-m", "second"),
            entry("assistant", "reply-2", Some("steer-e"), &"l".repeat(600)),
            cut_row("root-a", "steer-e"),
        ])
    }

    // The asked message rode one command with another; the cut began at the command.
    fn merged_member_cut() -> String {
        let mut merged = entry("user", "merged-q", Some("reply-1"), "merged");
        merged["mergedSendUuids"] = json!(["asked-m", "sent-n"]);
        file_of(&[
            entry("user", "root-a", None, "first"),
            entry("assistant", "reply-1", Some("root-a"), "one"),
            merged,
            entry("assistant", "reply-2", Some("merged-q"), "two"),
            cut_row("reply-1", "merged-q"),
        ])
    }

    // Two tool results of one parallel batch, Claude Code's routine row naming the first between
    // them, a steer during the batch and a later message, with no cut.
    fn parallel_batch() -> String {
        file_of(&[
            entry("user", "root-a", None, "first"),
            entry("assistant", "call-a", Some("root-a"), "two tools"),
            entry("user", "result-1", Some("call-a"), "first result"),
            json!({"type": "last-prompt", "leafUuid": "result-1"}),
            steer("steer-s", "result-1", "steer-m", "and the docs"),
            entry("user", "result-2", Some("steer-s"), "second result"),
            entry("assistant", "reply-2", Some("result-2"), "done"),
            entry("user", "asked-m", Some("reply-2"), "later"),
            entry("assistant", "reply-3", Some("asked-m"), "three"),
        ])
    }

    // A cut whose row was written and then taken back, the turn kept.
    fn healed_refusal() -> String {
        let mut lines = two_turns();
        lines.push(cut_row("reply-1", "asked-m"));
        lines.push(json!({"type": "last-prompt", "leafUuid": "reply-2", "explicit": true}));
        file_of(&lines)
    }

    // A cut, then the row Claude Code's own relaunch writes, naming the end the cut left.
    fn relaunch_after_cut() -> String {
        let mut lines = two_turns();
        lines.push(cut_row("reply-1", "asked-m"));
        lines.push(json!({"type": "last-prompt", "leafUuid": "reply-1", "explicit": true}));
        file_of(&lines)
    }

    // A turn after the cut.
    fn turn_after_cut() -> String {
        let mut lines = two_turns();
        lines.push(cut_row("reply-1", "asked-m"));
        lines.push(entry("user", "next-n", Some("reply-1"), "next"));
        lines.push(entry("assistant", "reply-3", Some("next-n"), "three"));
        file_of(&lines)
    }

    // A cut that began at another steer of the turn.
    fn another_message_cut() -> String {
        file_of(&[
            entry("user", "root-a", None, "first"),
            entry("assistant", "reply-1", Some("root-a"), "one"),
            steer("steer-e", "reply-1", "asked-m", "second"),
            steer("steer-x", "steer-e", "other-x", "third"),
            entry("assistant", "reply-2", Some("steer-x"), "two"),
            cut_row("reply-1", "steer-x"),
        ])
    }

    // A row still being written after the cut's.
    fn unended_newest_line() -> String {
        format!(
            r#"{}{{"type":"last-prompt","leafUuid":"reply-2","explicit":tr"#,
            own_entry_cut()
        )
    }

    // Killed by a cut's row left unread or read with no search for the entry it began at, by a
    // line copied wrong where it spans blocks, by a skip that keeps a byte of the skipped line,
    // by a merged member or a steer the read leaves out, by a relaunch's row read as taking the
    // cut back, by a leaf row, a row taking a cut back, a later turn or an unended line read past,
    // and by a cut of another message counted as this one's.
    #[rstest]
    #[case::own_entry(own_entry_cut(), 1024, RewindTargetPresence::CutAway)]
    #[case::spanning_steer(spanning_steer_cut(), 1024, RewindTargetPresence::CutAway)]
    #[case::reply_past_the_ceiling(reply_past_the_ceiling(), 256, RewindTargetPresence::CutAway)]
    #[case::merged_member(merged_member_cut(), 1024, RewindTargetPresence::CutAway)]
    #[case::relaunch_after_cut(relaunch_after_cut(), 1024, RewindTargetPresence::CutAway)]
    #[case::parallel_batch(parallel_batch(), 1024, RewindTargetPresence::Held)]
    #[case::healed_refusal(healed_refusal(), 1024, RewindTargetPresence::Held)]
    #[case::turn_after_cut(turn_after_cut(), 1024, RewindTargetPresence::Held)]
    #[case::another_message_cut(another_message_cut(), 1024, RewindTargetPresence::Held)]
    #[case::unended_newest_line(unended_newest_line(), 1024, RewindTargetPresence::Held)]
    fn a_message_reads_cut_only_where_a_standing_cut_began_at_it(
        #[case] text: String,
        #[case] line_max_bytes: usize,
        #[case] expected: RewindTargetPresence,
    ) {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let path = folder.path().join("conversation.jsonl");
        std::fs::write(&path, text).expect("the conversation is written");

        let presence =
            read_cut_rows(&path, "asked-m", 64, line_max_bytes).expect("the conversation reads");

        assert_eq!(presence, expected);
    }
}
