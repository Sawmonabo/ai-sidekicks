//! Whether a Claude Code conversation still holds one of the person's messages, read from the end
//! of its file back. The file only grows: a cut appends an explicit `last-prompt` row naming the
//! entry the conversation now ends at, and each later entry names its parent, so the conversation
//! is the chain from its newest end back through each entry's parent, past a compaction by the
//! boundary's logical parent. As Claude Code's loader reads it, the leaf the newest `last-prompt`
//! row names ends the conversation where an explicit row naming it follows every chain entry;
//! otherwise the newest chain entry does where it descends from that leaf, or no row names a leaf
//! a later compaction left standing, or the leaf names no entry, and the leaf does where not.
//! Claude Code writes an entry once, after its parent, so the one entry holding a message is cut
//! away once the chain reaches an entry written before it.

use std::fs::File;
use std::io::{self, Read as _, Seek as _};
use std::path::Path;

use memchr::memmem::FinderRev;
use serde::Deserialize;

use crate::driver::claude::session::process::CLAUDE_OUTPUT_LINE_MAX_BYTES;
use crate::inbound_json::decode_inbound_json;
use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};

/// How much of the file one read takes, from its end back.
const BLOCK_BYTES: u64 = 1024 * 1024;

/// The entry kinds that sit on a conversation's chain.
const CHAIN_ENTRY_TYPES: [&str; 5] = ["user", "assistant", "system", "attachment", "progress"];

/// The type of a row naming where the conversation ends, as its bytes stand in any such row
/// whatever the order of its members.
const LEAF_ROW_TYPE: &[u8] = b"\"last-prompt\"";

/// The subtype of a compaction's boundary, which drops every leaf a row before it named, as its
/// bytes stand in any boundary.
const COMPACT_BOUNDARY_SUBTYPE: &[u8] = b"\"compact_boundary\"";

/// Where a conversation file has one of the person's messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeMessagePlace {
    /// The chain from the conversation's end reaches an entry that holds it.
    OnLiveChain,
    /// An entry holds it, and the chain from the end, whole down past that entry's place or to
    /// its first entry, does not reach it.
    CutAway,
    /// No entry holds it, or the chain breaks before it can be told.
    Unwritten,
}

/// Where the conversation `file` has the person's message `message_id`: as an entry's own uuid,
/// as a prompt Claude Code took mid-turn by its `source_uuid`, or among a merged command's
/// `mergedSendUuids`. Reads from the end on a blocking thread, parsing past the conversation's end
/// only the lines a search of the file's bytes finds naming the message, the entry the chain
/// reaches next, a leaf or a leaf's row, and stops once the chain reaches the message or an entry
/// written before the one holding it; fails as the file cannot be opened or read.
pub(crate) async fn read_claude_message_place(
    file: &Path,
    message_id: &str,
) -> io::Result<ClaudeMessagePlace> {
    let file = file.to_owned();
    let message_id = message_id.to_owned();
    tokio::task::spawn_blocking(move || {
        read_message_place(
            &file,
            &message_id,
            BLOCK_BYTES,
            CLAUDE_OUTPUT_LINE_MAX_BYTES,
        )
    })
    .await
    .map_err(io::Error::other)?
}

// `read_claude_message_place`'s read, on the blocking thread it runs on: `block_bytes` at a time
// from the end back, a line longer than `line_max_bytes` skipped unread.
fn read_message_place(
    file: &Path,
    message_id: &str,
    block_bytes: u64,
    line_max_bytes: usize,
) -> io::Result<ClaudeMessagePlace> {
    let mut opened = File::open(file)?;
    let mut end = opened.metadata()?.len();
    let mut walk = ChainWalk::new(message_id);
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
        if let Some(place) = walk.read_block(&block[lines_start..]) {
            return Ok(place);
        }
        if start > 0 {
            // The read's first line, less its newline, ends a line the next read begins.
            let head = &block[..lines_start - 1];
            if head.len() > line_max_bytes {
                is_skipping = true;
            } else {
                tail_bytes = head.len();
                tail.push(head.to_vec());
            }
        }
    }
    Ok(walk.finish())
}

// The chain from the conversation's end, followed back one entry at a time.
struct ChainWalk<'id> {
    message_id: &'id str,
    // Finds the message's id in the file's bytes, from the end back.
    message_finder: FinderRev<'id>,
    // Find a row naming where the conversation ends and a compaction's boundary, from the end back.
    leaf_row_finder: FinderRev<'static>,
    boundary_finder: FinderRev<'static>,
    // Where the chain from the conversation's end stands.
    reach: ChainReach,
    // How far the rows naming a leaf were read.
    leaf_rows: LeafRows,
    // The leaf, with what finds it, while the chain from the newest chain entry has not yet shown
    // whether it descends from it: the conversation ends at that entry where it does or the leaf
    // names no entry, else at the leaf.
    unsettled_leaf: Option<(String, FinderRev<'static>)>,
    // Whether the chain from the newest chain entry reached an entry holding the message while a
    // leaf may still end the conversation below it: the leaf unsettled, or no row naming one read.
    is_held_above_leaf: bool,
    // Whether an entry off the chain holds the message.
    is_held_off_chain: bool,
}

impl<'id> ChainWalk<'id> {
    fn new(message_id: &'id str) -> Self {
        Self {
            message_id,
            message_finder: FinderRev::new(message_id),
            leaf_row_finder: FinderRev::new(LEAF_ROW_TYPE),
            boundary_finder: FinderRev::new(COMPACT_BOUNDARY_SUBTYPE),
            reach: ChainReach::EndUnread,
            leaf_rows: LeafRows::Unread,
            unsettled_leaf: None,
            is_held_above_leaf: false,
            is_held_off_chain: false,
        }
    }

    fn want(&mut self, uuid: String) {
        let finder = FinderRev::new(&uuid).into_owned();
        self.reach = ChainReach::Wanted(uuid, finder);
    }

    // The entry the chain reaches next, if any.
    fn wanted(&self) -> Option<&str> {
        match &self.reach {
            ChainReach::Wanted(uuid, _) => Some(uuid.as_str()),
            ChainReach::EndUnread | ChainReach::Ended { .. } => None,
        }
    }

    fn is_end_read(&self) -> bool {
        !matches!(self.reach, ChainReach::EndUnread)
    }

    // Takes `block`'s whole lines from its end back: every line until the conversation's end is
    // read, then only the lines a search of the bytes finds naming the message, the wanted entry,
    // the unsettled leaf or, until the leaf is known, a row naming one or a compaction's boundary,
    // so the rest is never parsed. Answers once the chain settles where the message stands.
    fn read_block(&mut self, block: &[u8]) -> Option<ClaudeMessagePlace> {
        // Where the lines not yet taken end.
        let mut cursor = block.len();
        let mut message_at = LastHit::default();
        let mut leaf_row_at = LastHit::default();
        let mut boundary_at = LastHit::default();
        let mut leaf_at = LastHit::default();
        while cursor > 0 {
            let region = &block[..cursor];
            let (line_start, line_end) = if self.is_end_read() {
                let wanted_at = match &self.reach {
                    ChainReach::Wanted(_, finder) => finder.rfind(region),
                    ChainReach::EndUnread | ChainReach::Ended { .. } => None,
                };
                let leaf_row = match self.leaf_rows {
                    LeafRows::Settled => None,
                    LeafRows::Unread | LeafRows::Following(_) => leaf_row_at
                        .before(&self.leaf_row_finder, region)
                        .max(boundary_at.before(&self.boundary_finder, region)),
                };
                let leaf = self
                    .unsettled_leaf
                    .as_ref()
                    .and_then(|(_, finder)| leaf_at.before(finder, region));
                let hit = message_at
                    .before(&self.message_finder, region)
                    .max(wanted_at)
                    .max(leaf_row)
                    .max(leaf)?;
                let line_end = memchr::memchr(b'\n', &region[hit..])
                    .map_or(region.len(), |newline| hit + newline);
                (line_start_before(region, hit), line_end)
            } else {
                let line_end = cursor - usize::from(region.last() == Some(&b'\n'));
                (line_start_before(region, line_end), line_end)
            };
            cursor = line_start;
            if let Some(entry) = read_chain_entry(&region[line_start..line_end])
                && let Some(place) = self.visit(entry)
            {
                return Some(place);
            }
        }
        None
    }

    // Takes the next entry back; answers once the chain settles where the message stands.
    fn visit(&mut self, entry: ChainEntry) -> Option<ClaudeMessagePlace> {
        if entry.entry_type.as_deref() == Some("last-prompt") {
            return self.read_leaf_row(entry.leaf_uuid, entry.is_explicit == Some(true));
        }
        let uuid = entry.uuid.as_deref().filter(|uuid| !uuid.is_empty())?;
        let is_chain_entry = entry.is_sidechain != Some(true)
            && entry
                .entry_type
                .as_deref()
                .is_some_and(|entry_type| CHAIN_ENTRY_TYPES.contains(&entry_type));
        if !is_chain_entry {
            return None;
        }
        let is_boundary = entry.subtype.as_deref() == Some("compact_boundary");
        if !self.is_end_read() {
            self.want(uuid.to_owned());
            // A row written after the newest entry names the leaf that entry ends at only where it
            // descends from it; a boundary drops the leaves of the rows before it. No entry above
            // the newest holds the message, so taking the leaf answers nothing yet.
            match std::mem::replace(&mut self.leaf_rows, LeafRows::Settled) {
                LeafRows::Following(leaf) => {
                    self.read_leaf(leaf);
                }
                LeafRows::Unread if !is_boundary => self.leaf_rows = LeafRows::Unread,
                LeafRows::Unread | LeafRows::Settled => {}
            }
            if self
                .unsettled_leaf
                .as_ref()
                .is_some_and(|(leaf, _)| leaf == uuid)
            {
                self.unsettled_leaf = None;
            }
        } else if is_boundary && matches!(self.leaf_rows, LeafRows::Unread) {
            self.leaf_rows = LeafRows::Settled;
            if self.is_held_above_leaf {
                return Some(ClaudeMessagePlace::OnLiveChain);
            }
        }
        let is_holding = entry.holds(self.message_id);
        if self.wanted() != Some(uuid) {
            if self
                .unsettled_leaf
                .as_ref()
                .is_none_or(|(leaf, _)| leaf != uuid)
            {
                self.is_held_off_chain |= is_holding;
                return None;
            }
            // The chain from the newer entry passed the leaf's place without reaching it.
            self.end_at_leaf();
        }
        self.take_on_chain(&entry, is_holding)
    }

    // Takes the next row back, naming `leaf` and explicit as `is_explicit` says; answers once the
    // leaf it settles leaves the message held. The newest row naming a leaf names the one leaf.
    // Among the rows after every chain entry, it holds the end where it, or an older row naming the
    // same leaf, is explicit, as a cut writes it. An explicit null leaf drops what older rows
    // named; a cleared conversation's is left to the cut, which Claude Code refuses.
    fn read_leaf_row(
        &mut self,
        leaf: Option<String>,
        is_explicit: bool,
    ) -> Option<ClaudeMessagePlace> {
        let newest = match std::mem::replace(&mut self.leaf_rows, LeafRows::Settled) {
            LeafRows::Settled => return None,
            LeafRows::Unread => None,
            LeafRows::Following(newest) => Some(newest),
        };
        // An explicit row written after every chain entry holds the end at its leaf.
        match (newest, leaf) {
            (newest, None) if !is_explicit => {
                self.leaf_rows = newest.map_or(LeafRows::Unread, LeafRows::Following);
                None
            }
            (Some(newest), Some(leaf)) if newest == leaf => {
                if is_explicit {
                    self.want(newest);
                } else {
                    self.leaf_rows = LeafRows::Following(newest);
                }
                None
            }
            (Some(newest), _) => self.read_leaf(newest),
            (None, Some(leaf)) if self.is_end_read() => self.read_leaf(leaf),
            (None, Some(leaf)) => {
                if is_explicit {
                    self.want(leaf);
                } else {
                    self.leaf_rows = LeafRows::Following(leaf);
                }
                None
            }
            (None, None) => self
                .is_held_above_leaf
                .then_some(ClaudeMessagePlace::OnLiveChain),
        }
    }

    // Takes `leaf`, the leaf the newest row names, once the newest chain entry was read: the end
    // only where the chain from that entry does not reach it. Answers where that chain reaches it
    // next, past an entry holding the message.
    fn read_leaf(&mut self, leaf: String) -> Option<ClaudeMessagePlace> {
        if self.wanted() == Some(leaf.as_str()) {
            return self
                .is_held_above_leaf
                .then_some(ClaudeMessagePlace::OnLiveChain);
        }
        let finder = FinderRev::new(&leaf).into_owned();
        self.unsettled_leaf = Some((leaf, finder));
        None
    }

    // The conversation ends at the unsettled leaf: the chain from the newer entry is no part of it.
    fn end_at_leaf(&mut self) {
        if let Some((leaf, _)) = self.unsettled_leaf.take() {
            self.is_held_off_chain |= std::mem::take(&mut self.is_held_above_leaf);
            self.want(leaf);
        }
    }

    // Takes the wanted entry `entry`, which holds the message as `is_holding` says.
    fn take_on_chain(
        &mut self,
        entry: &ChainEntry,
        is_holding: bool,
    ) -> Option<ClaudeMessagePlace> {
        if is_holding {
            if self.unsettled_leaf.is_none() && matches!(self.leaf_rows, LeafRows::Settled) {
                return Some(ClaudeMessagePlace::OnLiveChain);
            }
            self.is_held_above_leaf = true;
        } else if self.is_held_off_chain && !self.is_held_above_leaf {
            // The chain reached an entry written before the one holding the message, and from
            // here reaches only entries written earlier still; a leaf not yet settled, written
            // earlier too, ends no chain that reaches that entry.
            return Some(ClaudeMessagePlace::CutAway);
        }
        match entry
            .parent_uuid
            .clone()
            .or_else(|| entry.logical_parent_uuid.clone())
        {
            Some(parent) => self.want(parent),
            None => {
                self.reach = ChainReach::Ended {
                    is_rooted: entry.subtype.as_deref() != Some("compact_boundary"),
                };
            }
        }
        // The chain from the newer entry descends from the leaf, so that entry ends the
        // conversation.
        if let Some((leaf, _)) = &self.unsettled_leaf
            && self.wanted() == Some(leaf.as_str())
        {
            self.unsettled_leaf = None;
            if self.is_held_above_leaf {
                return Some(ClaudeMessagePlace::OnLiveChain);
            }
        }
        None
    }

    // Where the message stands once the whole file was read. A leaf still unsettled names no
    // entry the file holds and a leaf never read was never named, so the chain from the newest
    // entry is the conversation.
    fn finish(self) -> ClaudeMessagePlace {
        if self.is_held_above_leaf {
            ClaudeMessagePlace::OnLiveChain
        } else if matches!(self.reach, ChainReach::Ended { is_rooted: true })
            && self.is_held_off_chain
        {
            ClaudeMessagePlace::CutAway
        } else {
            ClaudeMessagePlace::Unwritten
        }
    }
}

// Where a walk from the end back stands on the chain.
enum ChainReach {
    // The conversation's end, the leaf an explicit row holds it at or the newest chain entry, is
    // not read yet.
    EndUnread,
    // The chain reaches this entry next, found in the file's bytes, from the end back, by the
    // finder.
    Wanted(String, FinderRev<'static>),
    // The chain reached its first entry, rooted where that entry is no compaction's boundary.
    Ended { is_rooted: bool },
}

// How far a walk from the end back read the rows naming a leaf.
enum LeafRows {
    // None was read.
    Unread,
    // The newest, written after every chain entry read, names this leaf without being explicit;
    // an older row naming the same leaf, written after every chain entry too, can still be.
    Following(String),
    // Which leaf counts, if any, is known.
    Settled,
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
// repaired, which changes none of the ASCII members the walk takes.
fn read_chain_entry(line: &[u8]) -> Option<ChainEntry> {
    match std::str::from_utf8(line).map(read_whole_object) {
        Ok(Ok(entry)) => entry,
        Ok(Err(_)) | Err(_) => read_whole_object(&decode_inbound_json(line)).ok().flatten(),
    }
}

// The entry `text` holds, `None` where it is another JSON value, every member the entry does not
// name skipped unbuilt; fails where `text` is not one whole JSON value.
fn read_whole_object(text: &str) -> sonic_rs::Result<Option<ChainEntry>> {
    let mut deserializer = sonic_rs::Deserializer::from_str(text);
    let entry = ChainEntry::read(&mut deserializer)?;
    deserializer.end()?;
    Ok(entry)
}

// The members of an entry the chain's read reads, each leniently.
#[derive(Deserialize)]
struct ChainEntry {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    entry_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    subtype: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    uuid: Option<String>,
    #[serde(rename = "parentUuid", default, deserialize_with = "read_lenient")]
    parent_uuid: Option<String>,
    #[serde(
        rename = "logicalParentUuid",
        default,
        deserialize_with = "read_lenient"
    )]
    logical_parent_uuid: Option<String>,
    #[serde(rename = "isSidechain", default, deserialize_with = "read_lenient")]
    is_sidechain: Option<bool>,
    #[serde(rename = "leafUuid", default, deserialize_with = "read_lenient")]
    leaf_uuid: Option<String>,
    #[serde(rename = "explicit", default, deserialize_with = "read_lenient")]
    is_explicit: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    attachment: Option<ChainAttachment>,
    #[serde(rename = "mergedSendUuids", default, deserialize_with = "read_lenient")]
    merged_send_uuids: Option<LenientList<String>>,
}

// An attachment's kind and, for a prompt Claude Code took mid-turn, the id it was sent with.
#[derive(Deserialize)]
struct ChainAttachment {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    attachment_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    source_uuid: Option<String>,
}

impl ChainEntry {
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

lenient_object!(ChainEntry, ChainAttachment);

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::{ClaudeMessagePlace, read_message_place};

    // A chain entry of `entry_type`, its message text `text`.
    fn entry(entry_type: &str, uuid: &str, parent: Option<&str>, text: &str) -> Value {
        json!({
            "parentUuid": parent,
            "isSidechain": false,
            "type": entry_type,
            "uuid": uuid,
            "message": {"content": text},
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

    // Three prompts in a chain: the root, the asked one and its child.
    fn three_prompts() -> Vec<Value> {
        vec![
            entry("user", "root-a", None, "first"),
            entry("user", "asked-m", Some("root-a"), &"m".repeat(90)),
            entry("user", "child-b", Some("asked-m"), "third"),
        ]
    }

    // The asked prompt's line spans two blocks.
    fn spanning_line() -> String {
        file_of(&three_prompts())
    }

    // Lines off the chain stand between the asked prompt and its child, so the chain wants an entry
    // several blocks before the one it read last.
    fn wanted_in_an_earlier_block() -> String {
        let mut lines = three_prompts();
        let child = lines.pop().expect("three prompts");
        lines.extend((0..3).map(|_| json!({"type": "summary", "summary": "s".repeat(80)})));
        lines.push(child);
        file_of(&lines)
    }

    // A newest entry past the ceiling would end the conversation at a branch without the child,
    // were it read; the child's line, where the skip stops, ends the conversation.
    fn line_past_the_ceiling() -> String {
        let mut lines = three_prompts();
        lines.push(entry("user", "long-l", Some("root-a"), &"l".repeat(600)));
        file_of(&lines)
    }

    // A newest entry still being written would end the conversation at a branch without the asked
    // prompt, were it read before its line is whole.
    fn unended_newest_line() -> String {
        let partial =
            r#"{"parentUuid":"root-a","isSidechain":false,"type":"user","uuid":"partial-c""#;
        format!("{}{partial}", file_of(&three_prompts()))
    }

    // A cut back to the reply holding a merged command, then a late entry on a branch above that
    // reply: the leaf ends the conversation, so the merged prompt stands.
    fn cut_end_and_merged_member() -> String {
        let mut merged = entry("user", "merged-q", Some("prompt-1"), "merged");
        merged["mergedSendUuids"] = json!(["sent-m", "sent-n"]);
        file_of(&[
            entry("user", "root-a", None, "first"),
            entry("user", "prompt-1", Some("root-a"), "second"),
            merged,
            entry("assistant", "reply-1", Some("merged-q"), "answer"),
            entry("user", "prompt-2", Some("reply-1"), "cut away"),
            json!({"type": "last-prompt", "leafUuid": "reply-1", "explicit": true}),
            entry("assistant", "late-x", Some("prompt-1"), "late"),
        ])
    }

    // Killed by a line copied wrong where it spans blocks (the asked prompt goes unread), by a
    // first line read as the end of an earlier one, by a skip that keeps a byte of the skipped line
    // or no skip, by an unended line read as an entry, and by a cut's leaf or a merged member the
    // reader leaves out, or a newer entry taken as the end though not descending from the leaf.
    #[rstest]
    #[case::spanning_line(spanning_line(), 64, 1024, "asked-m")]
    #[case::wanted_in_an_earlier_block(wanted_in_an_earlier_block(), 64, 1024, "asked-m")]
    #[case::first_line_of_the_file(spanning_line(), 64, 1024, "root-a")]
    #[case::line_past_the_ceiling(line_past_the_ceiling(), 64, 256, "child-b")]
    #[case::unended_newest_line(unended_newest_line(), 64, 1024, "asked-m")]
    #[case::cut_end_and_merged_member(cut_end_and_merged_member(), 64, 1024, "sent-m")]
    fn a_message_is_read_on_the_live_chain_across_blocks_and_cuts(
        #[case] text: String,
        #[case] block_bytes: u64,
        #[case] line_max_bytes: usize,
        #[case] message_id: &str,
    ) {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let path = folder.path().join("conversation.jsonl");
        std::fs::write(&path, text).expect("the conversation is written");

        let place = read_message_place(&path, message_id, block_bytes, line_max_bytes)
            .expect("the conversation reads");

        assert_eq!(place, ClaudeMessagePlace::OnLiveChain);
    }
}
