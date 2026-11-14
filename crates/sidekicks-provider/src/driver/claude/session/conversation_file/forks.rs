//! A person's message traced through the forks of a Claude Code conversation, and the point a fork
//! keeps a conversation up to so it ends before one of its entries.

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::io;
use std::ops::ControlFlow;
use std::path::Path;

use super::{
    check_session_id, find_claude_conversation_file, find_conversation_file_in,
    list_project_folders, read_entries,
};

/// The uuid of the entry of conversation `conversation_id` that holds the person's message
/// `message_id`: the entry itself, or the copy each fork made of it, followed down the
/// conversations each one forked from. `None` where a conversation's file is gone, the forks loop,
/// no conversation holds the message or a fork was cut before it. Fails with `InvalidInput` for a
/// conversation id that is not one plain path component, and as a file cannot be listed or read.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the undo's cut of a forked Claude Code conversation runs it"
    )
)]
pub(crate) async fn resolve_claude_message(
    config_folder: &Path,
    conversation_id: &str,
    message_id: &str,
) -> io::Result<Option<String>> {
    // Listed once, so each fork walked past is looked up without listing the folders again.
    let project_folders = list_project_folders(config_folder).await?;
    // The conversations walked past, each a fork of the next, with their files.
    let mut forks = Vec::new();
    let mut visited = HashSet::new();
    let mut conversation = conversation_id.to_owned();
    let mut found = loop {
        check_session_id(&conversation)?;
        let Some(file) = find_conversation_file_in(&project_folders, &conversation).await? else {
            return Ok(None);
        };
        let mut hit = None;
        let mut source = None;
        // Matched by the id the message was sent with, which a prompt taken mid-turn keeps apart
        // from its entry's uuid.
        read_entries(&file, |entry| {
            if entry.message_id() == Some(message_id)
                && let Some(uuid) = entry.uuid
            {
                hit = Some(uuid);
                return ControlFlow::Break(());
            }
            if source.is_none() {
                source = entry
                    .forked_from
                    .and_then(|fork_source| fork_source.session_id);
            }
            ControlFlow::Continue(())
        })
        .await?;
        if let Some(uuid) = hit {
            break uuid;
        }
        visited.insert(conversation.clone());
        let Some(source) = source.filter(|source| !visited.contains(source)) else {
            return Ok(None);
        };
        forks.push((std::mem::replace(&mut conversation, source), file));
    };
    for (fork, file) in forks.into_iter().rev() {
        let Some(copy) = find_fork_copy(&file, &conversation, &found).await? else {
            return Ok(None);
        };
        (conversation, found) = (fork, copy);
    }
    Ok(Some(found))
}

// The uuid of the entry of the fork in `file` that copies entry `entry_uuid` of conversation
// `source`, `None` where the fork was cut before it.
async fn find_fork_copy(file: &Path, source: &str, entry_uuid: &str) -> io::Result<Option<String>> {
    let mut copy = None;
    read_entries(file, |entry| {
        let is_copy = entry.forked_from.as_ref().is_some_and(|fork_source| {
            fork_source.session_id.as_deref() == Some(source)
                && fork_source.message_uuid.as_deref() == Some(entry_uuid)
        });
        if is_copy && let Some(uuid) = entry.uuid {
            copy = Some(uuid);
            return ControlFlow::Break(());
        }
        ControlFlow::Continue(())
    })
    .await?;
    Ok(copy)
}

/// Where a fork of a conversation ends so it stops before one of its entries.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ClaudeForkPoint {
    /// The entry is the conversation's first, so the fork keeps none of it.
    AtStart,
    /// The fork keeps the conversation up to the entry with this uuid.
    After(String),
    /// The conversation's file holds no such entry.
    EntryMissing,
    /// The conversation's file is gone.
    FileGone,
}

/// Where a fork keeps conversation `conversation_id` up to so it ends before entry `entry_id`, as
/// Claude Code's own rewind does: after the entry's parent, followed past any `progress` row, or at
/// the start for the first entry. Fails with `InvalidInput` for a conversation id that is not one
/// plain path component, and as the file cannot be listed or read.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the undo's fork before Claude Code's last compaction runs it"
    )
)]
pub(crate) async fn read_claude_fork_point(
    config_folder: &Path,
    conversation_id: &str,
    entry_id: &str,
) -> io::Result<ClaudeForkPoint> {
    let Some(file) = find_claude_conversation_file(config_folder, conversation_id).await? else {
        return Ok(ClaudeForkPoint::FileGone);
    };
    // Each `progress` row met before the entry, with its parent.
    let mut progress_parents: HashMap<String, Option<String>> = HashMap::new();
    // The entry's parent once the entry is met.
    let mut found: Option<Option<String>> = None;
    // Matched by the entry's own uuid, the one the message's trace answers.
    read_entries(&file, |entry| {
        if entry.uuid.as_deref() == Some(entry_id) {
            found = Some(entry.parent_uuid);
            return ControlFlow::Break(());
        }
        if entry.entry_type.as_deref() == Some("progress")
            && let Some(uuid) = entry.uuid
        {
            progress_parents.insert(uuid, entry.parent_uuid);
        }
        ControlFlow::Continue(())
    })
    .await?;
    let Some(mut parent) = found else {
        return Ok(ClaudeForkPoint::EntryMissing);
    };
    // Each row is taken out as it is passed, so a loop of `progress` rows ends.
    while let Some(uuid) = &parent
        && let Some(progress_parent) = progress_parents.remove(uuid)
    {
        parent = progress_parent;
    }
    Ok(parent.map_or(ClaudeForkPoint::AtStart, ClaudeForkPoint::After))
}

/// The conversation the file `file` was forked from, as its first entry names it; `None` for a
/// file whose first entry names none, or that holds no entry. Fails as the file cannot be read.
pub(crate) async fn read_claude_fork_source(file: &Path) -> io::Result<Option<String>> {
    let mut source = None;
    read_entries(file, |entry| {
        source = entry
            .forked_from
            .and_then(|fork_source| fork_source.session_id);
        ControlFlow::Break(())
    })
    .await?;
    Ok(source)
}
