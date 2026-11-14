//! Whether a Claude Code conversation still holds one of the person's messages, read from the end
//! of its file back. The file only grows: a cut appends an explicit `last-prompt` row naming the
//! entry the conversation now ends at, and each later entry names its parent, so the conversation
//! is the chain from its newest end back through each entry's parent, past a compaction by the
//! boundary's logical parent. A message is cut away once an entry holds it and that chain no
//! longer reaches it.

use std::io;
use std::ops::ControlFlow;
use std::path::Path;

use serde::Deserialize;
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};

use super::lines::read_line;
use crate::driver::claude::session::process::CLAUDE_OUTPUT_LINE_MAX_BYTES;
use crate::lenient_json::{LenientList, lenient_object, read_lenient};

/// How much of the file one read takes, from its end back.
const CHUNK_BYTES: u64 = 64 * 1024;

/// The entry kinds that sit on a conversation's chain.
const CHAIN_ENTRY_TYPES: [&str; 5] = ["user", "assistant", "system", "attachment", "progress"];

/// Where a conversation file has one of the person's messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeMessagePlace {
    /// The chain from the conversation's end reaches an entry that holds it.
    OnLiveChain,
    /// An entry holds it, and the chain from the end, whole down to its first entry, does not
    /// reach one.
    CutAway,
    /// No entry holds it, or the chain breaks before it can be told.
    Unwritten,
}

/// Where the conversation `file` has the person's message `message_id`: as an entry's own uuid,
/// as a prompt Claude Code took mid-turn by its `source_uuid`, or among a merged command's
/// `mergedSendUuids`. Reads from the end and stops once the chain reaches the message; fails as
/// the file cannot be opened or read.
pub(crate) async fn read_claude_message_place(
    file: &Path,
    message_id: &str,
) -> io::Result<ClaudeMessagePlace> {
    let mut opened = tokio::fs::File::open(file).await?;
    let mut end = opened.metadata().await?.len();
    let mut walk = ChainWalk::new(message_id);
    // The start of a line begun before the bytes read last, which the next read completes.
    let mut tail: Vec<u8> = Vec::new();
    // Whether the bytes read next end inside a line past the ceiling, dropped up to its start.
    let mut is_skipping = false;
    while end > 0 {
        let start = end.saturating_sub(CHUNK_BYTES);
        let mut bytes =
            vec![0; usize::try_from(end - start).expect("a chunk's length fits in memory")];
        opened.seek(io::SeekFrom::Start(start)).await?;
        opened.read_exact(&mut bytes).await?;
        end = start;
        if is_skipping {
            match memchr::memrchr(b'\n', &bytes) {
                Some(newline) => {
                    bytes.truncate(newline + 1);
                    is_skipping = false;
                }
                None => continue,
            }
        }
        bytes.append(&mut tail);
        // The bytes through the first newline may begin before this read, unless it starts the
        // file.
        let first_line_end = match (start, memchr::memchr(b'\n', &bytes)) {
            (0, _) => 0,
            (_, Some(newline)) => newline + 1,
            (_, None) => bytes.len(),
        };
        for line in bytes[first_line_end..].rsplit(|byte| *byte == b'\n') {
            if line.is_empty() {
                continue;
            }
            let mut place = None;
            let _flow = read_line::<ChainEntry>(line, true, |read| {
                place = walk.visit(read.entry);
                ControlFlow::Break(())
            });
            if let Some(place) = place {
                return Ok(place);
            }
        }
        if start > 0 {
            tail = bytes[..first_line_end].to_vec();
            // The line's newline ends this read's first line, which joins the next read.
            if tail.last() == Some(&b'\n') {
                tail.pop();
            }
            if tail.len() > CLAUDE_OUTPUT_LINE_MAX_BYTES {
                tail.clear();
                is_skipping = true;
            }
        }
    }
    Ok(walk.finish())
}

// The chain from the conversation's end, followed back one entry at a time.
struct ChainWalk<'id> {
    message_id: &'id str,
    // Whether the conversation's end was read: the newest explicit `last-prompt` leaf or chain
    // entry.
    is_end_read: bool,
    // The entry the chain reaches next, `None` once it reached its first entry.
    wanted: Option<String>,
    // Whether the chain reached an entry with no parent that is no compaction's boundary.
    is_rooted: bool,
    // Whether an entry off the chain holds the message.
    is_held_off_chain: bool,
}

impl<'id> ChainWalk<'id> {
    fn new(message_id: &'id str) -> Self {
        Self {
            message_id,
            is_end_read: false,
            wanted: None,
            is_rooted: false,
            is_held_off_chain: false,
        }
    }

    // Takes the next entry back; answers once the chain settles where the message stands.
    fn visit(&mut self, entry: ChainEntry) -> Option<ClaudeMessagePlace> {
        if entry.entry_type.as_deref() == Some("last-prompt") {
            // Only an explicit leaf, as a cut writes, holds the end against a later entry below
            // it; Claude Code moves past any other to the newest message. A cleared
            // conversation's null leaf is left to the cut, which Claude Code refuses.
            if !self.is_end_read && entry.is_explicit == Some(true) && entry.leaf_uuid.is_some() {
                self.is_end_read = true;
                self.wanted = entry.leaf_uuid;
            }
            return None;
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
        if !self.is_end_read {
            self.is_end_read = true;
            self.wanted = Some(uuid.to_owned());
        }
        let is_holding = entry.holds(self.message_id);
        if self.wanted.as_deref() != Some(uuid) {
            self.is_held_off_chain |= is_holding;
            return None;
        }
        if is_holding {
            return Some(ClaudeMessagePlace::OnLiveChain);
        }
        self.wanted = entry
            .parent_uuid
            .clone()
            .or_else(|| entry.logical_parent_uuid.clone());
        if self.wanted.is_none() {
            self.is_rooted = entry.subtype.as_deref() != Some("compact_boundary");
            if self.is_rooted && self.is_held_off_chain {
                return Some(ClaudeMessagePlace::CutAway);
            }
        }
        None
    }

    // Where the message stands once the whole file was read.
    fn finish(self) -> ClaudeMessagePlace {
        if self.is_rooted && self.wanted.is_none() && self.is_held_off_chain {
            ClaudeMessagePlace::CutAway
        } else {
            ClaudeMessagePlace::Unwritten
        }
    }
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
