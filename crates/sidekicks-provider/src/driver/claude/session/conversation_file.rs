//! Claude Code's own record of one conversation, `<config folder>/projects/<project>/<id>.jsonl`:
//! one JSON entry per line, each with its own `uuid`. Read to find where a resume lands, which
//! message a fork keeps up to, which messages an ended process took and which command holds a
//! message merged into it; titled anew at rest;
//! deleted on a purge with every other file Claude Code keeps for the conversation under the same
//! config folder and the daemon's scratch folder, a batch of conversations of one home listing
//! each folder it searches once.

pub(crate) mod forks;
pub(crate) mod lines;
pub(crate) mod live_chain;
pub(crate) mod peer_replies;
pub(crate) mod title;

use std::collections::HashSet;
use std::fmt;
use std::io;
use std::marker::PhantomData;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::{self, Deserializer, SeqAccess, Visitor};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::PathRules;
use sidekicks_std::missing_entry::MissingEntry;

use crate::driver::claude::session::conversation_file::lines::read_conversation_lines;
use crate::driver::claude::session::plan_files::{ClaudePlan, find_claude_plan_files};
use crate::driver::claude::session::rules::{
    ClaudeProjectFolder, resolve_claude_local_settings_file,
};
use crate::driver::claude::spawn::environment::{
    claude_config_folder, compose_claude_scratch_folder,
};
use crate::lenient_json::{
    Lenient, LenientElement, LenientList, LenientVisitor, lenient_object, read_lenient,
    skip_other_shapes,
};

/// The turns one conversation file holds.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ClaudeConversationOutline {
    /// Index `n` is the uuid of the last entry of turn `n + 1`, so the length is the turn count.
    pub(crate) turn_end_uuids: Vec<String>,
    /// Index `n` is the uuid of the person's prompt that opens turn `n + 1`.
    pub(crate) prompt_uuids: Vec<String>,
}

/// Where Claude Code and the daemon keep the conversations' files of one Claude Code home.
pub(crate) struct ClaudeConversationFolders<'a> {
    /// The configuration folder of the Claude Code home the conversations ran on.
    pub(crate) config_folder: &'a Path,
    /// The home folder of the place the conversations ran in.
    pub(crate) home_folder: &'a Path,
    /// How that place spells paths.
    pub(crate) path_rules: PathRules,
    /// The daemon's data folder, which holds the home's scratch folder.
    pub(crate) data_folder: &'a str,
}

/// One conversation a purge deletes.
pub(crate) struct ClaudeConversation<'a> {
    /// Claude Code's id for it, which names its files.
    pub(crate) provider_session_id: &'a str,
    /// The folder it started in, with what Claude Code reads to place its local settings.
    pub(crate) project_folder: &'a ClaudeProjectFolder<'a>,
}

/// Finds the conversation's file under any project folder of `config_folder`, or `None`. Fails
/// with any read failure but a missing projects folder, and with `InvalidInput` for an id that is
/// not one plain path component.
pub(crate) async fn find_claude_conversation_file(
    config_folder: &Path,
    provider_session_id: &str,
) -> io::Result<Option<PathBuf>> {
    check_session_id(provider_session_id)?;
    let project_folders = list_project_folders(config_folder).await?;
    find_conversation_file_in(&project_folders, provider_session_id).await
}

// The conversation's file in the first of `project_folders` holding it, or `None`; the id is one
// plain path component already checked. Fails as a file's presence cannot be read.
async fn find_conversation_file_in(
    project_folders: &[PathBuf],
    provider_session_id: &str,
) -> io::Result<Option<PathBuf>> {
    let file_name = format!("{provider_session_id}.jsonl");
    for project_folder in project_folders {
        let file = project_folder.join(&file_name);
        if tokio::fs::try_exists(&file).await? {
            return Ok(Some(file));
        }
    }
    Ok(None)
}

// The folders of `<config folder>/projects/`, none where it is missing.
async fn list_project_folders(config_folder: &Path) -> io::Result<Vec<PathBuf>> {
    let Some(mut entries) = tokio::fs::read_dir(config_folder.join("projects"))
        .await
        .none_if_missing()?
    else {
        return Ok(Vec::new());
    };
    let mut folders = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        // A file among the project folders has no conversations, and asking inside it would fail.
        if entry.file_type().await?.is_dir() {
            folders.push(entry.path());
        }
    }
    Ok(folders)
}

/// Reads a conversation file's turns line by line; a line that is not a JSON object is skipped.
/// Holds one line at a time, in a buffer up to twice the longest line, as the buffer doubles.
pub(crate) async fn read_claude_conversation_outline(
    file: &Path,
) -> io::Result<ClaudeConversationOutline> {
    let mut outline = ClaudeConversationOutline::default();
    let mut last_uuid: Option<String> = None;
    let mut is_prompt_seen = false;
    read_entries(file, |entry| {
        if entry.is_person_prompt() {
            if is_prompt_seen && let Some(uuid) = &last_uuid {
                outline.turn_end_uuids.push(uuid.clone());
            }
            is_prompt_seen = true;
            outline
                .prompt_uuids
                .push(entry.uuid.clone().unwrap_or_default());
        }
        if let Some(uuid) = entry.uuid.filter(|uuid| !uuid.is_empty()) {
            last_uuid = Some(uuid);
        }
        ControlFlow::Continue(())
    })
    .await?;
    if is_prompt_seen && let Some(uuid) = last_uuid {
        outline.turn_end_uuids.push(uuid);
    }
    Ok(outline)
}

/// Which of `message_uuids` the conversation file holds on a `user` entry, in their given order:
/// the messages Claude Code took. Read only once the process that held them has ended, since a
/// live process keeps a message past its turn's end and takes it later; the caller retries a read
/// that fails. Opens nothing for an empty list, stops once every uuid is found, and fails with
/// the file's open or read failure.
pub(crate) async fn find_claude_taken_messages(
    file: &Path,
    message_uuids: &[String],
) -> io::Result<Vec<String>> {
    if message_uuids.is_empty() {
        return Ok(Vec::new());
    }
    let mut unfound: HashSet<&str> = message_uuids.iter().map(String::as_str).collect();
    let mut found = HashSet::new();
    read_entries(file, |entry| {
        if entry.entry_type.as_deref() == Some("user")
            && let Some(uuid) = entry.uuid
            && unfound.remove(uuid.as_str())
        {
            found.insert(uuid);
        }
        if unfound.is_empty() {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })
    .await?;
    Ok(message_uuids
        .iter()
        .filter(|uuid| found.contains(*uuid))
        .cloned()
        .collect())
}

/// The uuid of the command Claude Code merged the person's message `message_uuid` into with
/// others, the message not being its last: messages that waited together are taken as one `user`
/// entry under the last member's uuid, its `mergedSendUuids` naming the others in send order.
/// `None` where no entry lists the message; stops at the first that does, and fails with the
/// file's open or read failure.
pub(crate) async fn find_claude_command_holding(
    file: &Path,
    message_uuid: &str,
) -> io::Result<Option<String>> {
    let mut found = None;
    read_entries(file, |entry| {
        let holds = entry.entry_type.as_deref() == Some("user")
            && entry.merged_send_uuids.is_some_and(|LenientList(members)| {
                members.iter().any(|uuid| uuid == message_uuid)
            });
        match entry.uuid.filter(|uuid| holds && !uuid.is_empty()) {
            Some(uuid) => {
                found = Some(uuid);
                ControlFlow::Break(())
            }
            None => ControlFlow::Continue(()),
        }
    })
    .await?;
    Ok(found)
}

/// Deletes every file Claude Code keeps for each of `conversations`, where each exists: under the
/// config folder its file history, session environment, task list, debug log, uploads, dev mods,
/// image cache and plan files (in the plans folder the settings of the config folder and of the
/// project name, the local settings of the starting folder and of the repository's root among
/// them), and in every project folder the conversation's files, the copies set aside and its folder
/// of helper transcripts and tool results; under the home's scratch folder, the daemon's
/// `CLAUDE_CODE_TMPDIR`, the conversation's folder in each project. Each project folder, scratch
/// folder and plans folder is listed once for the whole batch. The conversations' files go last,
/// since they name the plan files a purge that fails must find again. Fails with `InvalidInput`,
/// before anything is listed or removed, for an id that is not one plain path component, else with
/// the first read or removal failure.
pub(crate) async fn delete_claude_conversations(
    folders: &ClaudeConversationFolders<'_>,
    conversations: &[ClaudeConversation<'_>],
) -> io::Result<()> {
    for conversation in conversations {
        check_session_id(conversation.provider_session_id)?;
    }
    let config_folder = folders.config_folder;
    let session_ids: Vec<&str> = conversations
        .iter()
        .map(|conversation| conversation.provider_session_id)
        .collect();
    let mut conversation_files = vec![Vec::new(); conversations.len()];
    let mut removed = Vec::new();
    for project_folder in list_project_folders(config_folder).await? {
        let mut entries = tokio::fs::read_dir(&project_folder).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            for (index, session_id) in session_ids.iter().enumerate() {
                match read_project_entry(name, session_id) {
                    Some(ProjectEntry::Conversation) => {
                        conversation_files[index].push(entry.path());
                    }
                    Some(ProjectEntry::SetAside) => removed.push(entry.path()),
                    None => {}
                }
            }
        }
    }
    let scratch_projects = list_scratch_projects(&compose_claude_scratch_folder(
        folders.data_folder,
        config_folder,
    ))
    .await?;
    let mut plans = Vec::new();
    for (conversation, files) in conversations.iter().zip(&conversation_files) {
        let session_id = conversation.provider_session_id;
        removed.extend([
            config_folder.join("file-history").join(session_id),
            config_folder.join("session-env").join(session_id),
            config_folder.join("tasks").join(session_id),
            config_folder
                .join("debug")
                .join(format!("{session_id}.txt")),
            config_folder.join("uploads").join(session_id),
            config_folder.join("dev-mods").join(session_id),
            config_folder.join("image-cache").join(session_id),
        ]);
        removed.extend(
            scratch_projects
                .iter()
                .map(|scratch_project| scratch_project.join(session_id)),
        );
        let mut plan_slug = None;
        for file in files {
            plan_slug = read_claude_plan_slug(file).await?;
            if plan_slug.is_some() {
                break;
            }
        }
        if let Some(plan_slug) = plan_slug {
            plans.push(ClaudePlan {
                project_folder: conversation.project_folder.working_folder,
                root_local_settings: resolve_claude_local_settings_file(
                    conversation.project_folder,
                    folders.home_folder,
                    folders.path_rules,
                )
                .path,
                plan_slug,
            });
        }
    }
    removed.extend(find_claude_plan_files(config_folder, &plans).await?);
    removed.extend(conversation_files.into_iter().flatten());
    for path in removed {
        sidekicks_platforms::remove_tree_awaited(&path).await?;
    }
    Ok(())
}

// Refuses an id that is not one plain path component, `[A-Za-z0-9_-]+`, since the purge joins it
// onto folders it deletes: an empty id would name the folder itself and `..` its parent.
fn check_session_id(provider_session_id: &str) -> io::Result<()> {
    let is_plain = !provider_session_id.is_empty()
        && provider_session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if is_plain {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a Claude Code session id is not one plain path component",
        ))
    }
}

// What an entry of a project folder is to one conversation.
enum ProjectEntry {
    // Its file, `<id>.jsonl`.
    Conversation,
    // Its folder `<id>/` or a copy Claude Code set aside, `<id>.orphaned-<when>-<suffix>.jsonl` or
    // `<id>.jsonl.superseded-<when>`.
    SetAside,
}

#[expect(
    clippy::case_sensitive_file_extension_comparisons,
    reason = "Claude Code writes these names itself, in this spelling"
)]
fn read_project_entry(name: &str, session_id: &str) -> Option<ProjectEntry> {
    let rest = name.strip_prefix(session_id)?;
    if rest == ".jsonl" {
        return Some(ProjectEntry::Conversation);
    }
    let is_set_aside = rest.is_empty()
        || rest
            .strip_prefix(".orphaned-")
            .is_some_and(|rest| rest.ends_with(".jsonl"))
        || rest.starts_with(".jsonl.superseded-");
    is_set_aside.then_some(ProjectEntry::SetAside)
}

// The project folders of each folder Claude Code keeps under the scratch folder, `claude-<uid>/` or
// `claude/`, each holding a conversation's folder by its id: `<scratch>/<child>/<project>/`.
async fn list_scratch_projects(scratch_folder: &Path) -> io::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    let Some(mut children) = tokio::fs::read_dir(scratch_folder)
        .await
        .none_if_missing()?
    else {
        return Ok(found);
    };
    while let Some(child) = children.next_entry().await? {
        if !child.file_type().await?.is_dir() {
            continue;
        }
        let mut projects = tokio::fs::read_dir(child.path()).await?;
        while let Some(project) = projects.next_entry().await? {
            if project.file_type().await?.is_dir() {
                found.push(project.path());
            }
        }
    }
    Ok(found)
}

// The name of the conversation's plan file, the first `slug` its entries carry that is not empty,
// since an empty one would name every helper's plan file.
async fn read_claude_plan_slug(file: &Path) -> io::Result<Option<String>> {
    let mut found = None;
    read_entries(file, |entry| {
        match entry.slug.filter(|slug| !slug.is_empty()) {
            Some(slug) => {
                found = Some(slug);
                ControlFlow::Break(())
            }
            None => ControlFlow::Continue(()),
        }
    })
    .await?;
    Ok(found)
}

// Hands each line of `file` that is a JSON object to `visit` until it breaks; fails as the file
// cannot be opened or read.
async fn read_entries(
    file: &Path,
    mut visit: impl FnMut(ConversationEntry) -> ControlFlow<()>,
) -> io::Result<()> {
    let opened = tokio::fs::File::open(file).await?;
    read_conversation_lines(opened, file, 0, |line| visit(line.entry)).await?;
    Ok(())
}

// The members of an entry the outline, the taken read, the merged-command read, the purge and the
// fork reads read, each read leniently: a member of another type reads as absent rather than
// dropping the line, and nothing else is kept.
#[derive(Deserialize)]
struct ConversationEntry {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    entry_type: Option<String>,
    #[serde(rename = "isMeta", default, deserialize_with = "read_lenient")]
    is_meta: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    uuid: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    slug: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    message: Option<ConversationMessage>,
    #[serde(rename = "parentUuid", default, deserialize_with = "read_lenient")]
    parent_uuid: Option<String>,
    #[serde(rename = "forkedFrom", default, deserialize_with = "read_lenient")]
    forked_from: Option<ConversationForkSource>,
    #[serde(default, deserialize_with = "read_lenient")]
    attachment: Option<ConversationAttachment>,
    #[serde(rename = "mergedSendUuids", default, deserialize_with = "read_lenient")]
    merged_send_uuids: Option<LenientList<String>>,
}

// The row a fork copied an entry from, in the conversation it forked.
#[derive(Deserialize)]
struct ConversationForkSource {
    #[serde(rename = "sessionId", default, deserialize_with = "read_lenient")]
    session_id: Option<String>,
    #[serde(rename = "messageUuid", default, deserialize_with = "read_lenient")]
    message_uuid: Option<String>,
}

// An attachment entry's kind and, for a prompt Claude Code took mid-turn, the id it was sent with.
#[derive(Deserialize)]
struct ConversationAttachment {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    attachment_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    source_uuid: Option<String>,
}

impl ConversationEntry {
    // A person's prompt: a user entry that is no tool result and no entry Claude Code wrote itself.
    fn is_person_prompt(&self) -> bool {
        self.entry_type.as_deref() == Some("user")
            && self.is_meta != Some(true)
            && self
                .message
                .as_ref()
                .is_some_and(|message| match &message.content {
                    Some(MessageContent::Text) => true,
                    Some(MessageContent::Blocks { has_tool_result }) => !has_tool_result,
                    None => false,
                })
    }

    // The id the person's message was sent with: a prompt taken mid-turn's non-empty
    // `source_uuid`, else the entry's own `uuid`, as Claude Code's rewind and the SDK's fork match.
    fn message_id(&self) -> Option<&str> {
        self.attachment
            .as_ref()
            .filter(|attachment| attachment.attachment_type.as_deref() == Some("queued_command"))
            .and_then(|attachment| attachment.source_uuid.as_deref())
            .filter(|source_uuid| !source_uuid.is_empty())
            .or(self.uuid.as_deref())
    }
}

#[derive(Deserialize)]
struct ConversationMessage {
    #[serde(default, deserialize_with = "read_lenient")]
    content: Option<MessageContent>,
}

// A message's content as the outline reads it: text, or blocks and whether one is a tool's result.
enum MessageContent {
    Text,
    Blocks { has_tool_result: bool },
}

// One content block's `type`.
#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    block_type: Option<String>,
}

impl<'de> Visitor<'de> for LenientVisitor<MessageContent> {
    type Value = Option<MessageContent>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_str<E: de::Error>(self, _value: &str) -> Result<Self::Value, E> {
        Ok(Some(MessageContent::Text))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut blocks: A) -> Result<Self::Value, A::Error> {
        let mut has_tool_result = false;
        while let Some(block) = blocks.next_element::<LenientElement<ContentBlock>>()? {
            has_tool_result |= block
                .0
                .is_some_and(|block| block.block_type.as_deref() == Some("tool_result"));
        }
        Ok(Some(MessageContent::Blocks { has_tool_result }))
    }

    skip_other_shapes!(
        visit_bool(bool),
        visit_i64(i64),
        visit_u64(u64),
        visit_f64(f64),
        visit_unit()
    );
    skip_other_shapes!(@map);
}

impl Lenient for MessageContent {
    fn read<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Self>, D::Error> {
        deserializer.deserialize_any(LenientVisitor::<Self>(PhantomData))
    }
}

lenient_object!(
    ConversationEntry,
    ConversationMessage,
    ContentBlock,
    ConversationForkSource,
    ConversationAttachment
);

/// The file of conversation `handle` in the Claude Code home `spawn_environment` names; `None`
/// where the home names no folder or holds no such file. Fails as the home cannot be listed.
pub(crate) async fn conversation_file_of(
    spawn_environment: &[(String, String)],
    handle: &str,
) -> io::Result<Option<PathBuf>> {
    let Some(config_folder) = claude_config_folder(spawn_environment, PathRules::NATIVE) else {
        return Ok(None);
    };
    find_claude_conversation_file(&config_folder, handle).await
}

/// How many turns conversation `handle` holds in the Claude Code home `spawn_environment` names;
/// one with no file yet holds none. Fails as its home cannot be listed or its file read.
pub(crate) async fn read_turn_count(
    spawn_environment: &[(String, String)],
    handle: &str,
) -> io::Result<SafeInt<0>> {
    let count = match conversation_file_of(spawn_environment, handle).await? {
        Some(file) => read_claude_conversation_outline(&file)
            .await?
            .turn_end_uuids
            .len(),
        None => 0,
    };
    Ok(u64::try_from(count)
        .ok()
        .and_then(SafeInt::new)
        .expect("a conversation's turn count is far below the wire's integer cap"))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use sidekicks_platforms::PathRules;

    use super::{
        ClaudeConversation, ClaudeConversationFolders, ClaudeConversationOutline,
        delete_claude_conversations, find_claude_taken_messages, read_claude_conversation_outline,
    };
    use crate::driver::claude::session::rules::{
        CLAUDE_USER_SETTINGS_FILE, ClaudeProjectFolder, ClaudeRepository, local_settings_path,
    };
    use crate::driver::claude::spawn::environment::compose_claude_scratch_folder;

    const SESSION_ID: &str = "3f1c0d4e-0000-4000-8000-000000000001";
    const OTHER_SESSION_ID: &str = "3f1c0d4e-0000-4000-8000-000000000002";

    // Killed by a read that answers an id the file lacks, counts an assistant entry as taken, or
    // answers an empty list for a file it cannot open.
    #[tokio::test]
    async fn the_taken_read_answers_only_the_user_entries_the_file_holds() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let file = folder.path().join("conversation.jsonl");
        fs::write(
            &file,
            concat!(
                r#"{"type":"user","uuid":"taken","message":{"content":"steer"}}"#,
                "\n",
                r#"{"type":"assistant","uuid":"answer","message":{"content":"done"}}"#,
                "\n",
            ),
        )
        .expect("the conversation is written");
        let asked = ["kept".to_owned(), "taken".to_owned(), "answer".to_owned()];

        let taken = find_claude_taken_messages(&file, &asked)
            .await
            .expect("the file reads");

        assert_eq!(taken, vec!["taken".to_owned()]);
        assert!(
            find_claude_taken_messages(&folder.path().join("absent.jsonl"), &asked)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_tool_result_or_an_entry_claude_code_wrote_starts_no_turn() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let file = folder.path().join("conversation.jsonl");
        fs::write(
            &file,
            concat!(
                r#"{"type":"user","uuid":"u1","message":{"content":"first"}}"#,
                "\n",
                r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use"}]}}"#,
                "\n",
                r#"{"type":"user","uuid":"r1","message":"#,
                r#"{"content":[{"type":"tool_result"},"odd"]}}"#,
                "\n",
                r#"{"type":"user","isMeta":true,"uuid":"m1","message":{"content":"caveat"}}"#,
                "\n",
                "not json\n",
                r#"{"type":"assistant","uuid":"a2","isMeta":"yes","message":"#,
                r#"{"content":"done \ud800"}}"#,
                "\r\n",
                // An array is no entry, though its items line up with an entry's members.
                r#"["user",false,"x1",null,{"content":"not a prompt"}]"#,
                "\n",
                r#"{"type":"user","uuid":"u2","message":"#,
                r#"{"content":[{"type":"text","text":"second"}]}}"#,
                "\n",
                r#"{"type":"assistant","uuid":"a3","message":"text"}"#,
            ),
        )
        .expect("the conversation is written");

        let outline = read_claude_conversation_outline(&file)
            .await
            .expect("the outline reads");

        assert_eq!(
            outline,
            ClaudeConversationOutline {
                turn_end_uuids: vec!["a2".to_owned(), "a3".to_owned()],
                prompt_uuids: vec!["u1".to_owned(), "u2".to_owned()],
            }
        );
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().expect("the path has a folder"))
            .expect("the folder is made");
        fs::write(path, text).expect("the file is written");
    }

    #[tokio::test]
    async fn a_purge_deletes_the_conversations_files_and_its_plan_where_the_root_names_the_folder()
    {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let config = scratch.path().join("config");
        let root = scratch.path().join("root");
        let worktree = scratch.path().join("worktree");
        let data = scratch.path().join("data");
        let data_text = data.to_str().expect("the scratch folder is UTF-8");
        let common_git_folder = root.join(".git");
        let project_folder = ClaudeProjectFolder {
            working_folder: &worktree,
            repository: Some(ClaudeRepository {
                root: &root,
                common_git_folder: &common_git_folder,
                is_owned_by_user: true,
            }),
        };
        let project_files = config.join("projects").join("-worktree");
        // A project folder after `/cd` holds only copies set aside.
        let other_project_files = config.join("projects").join("-elsewhere");
        let conversation = project_files.join(format!("{SESSION_ID}.jsonl"));
        // An empty slug would name every helper's plan file.
        write(
            &conversation,
            concat!(r#"{"slug":""}"#, "\n", r#"{"slug":"brave-otter"}"#, "\n"),
        );
        write(
            &local_settings_path(&root),
            r#"{"plansDirectory":"my-plans"}"#,
        );
        let kept = [
            config.join("plans").join("-agent-a1.md"),
            project_files.join("other.jsonl"),
            config.join("uploads").join("other").join("a.png"),
        ];
        let deleted = [
            worktree.join("my-plans").join("brave-otter.md"),
            other_project_files.join(format!("{SESSION_ID}.orphaned-2-y.jsonl")),
            project_files
                .join(SESSION_ID)
                .join("subagents")
                .join("a.jsonl"),
            project_files.join(format!("{SESSION_ID}.orphaned-1-x.jsonl")),
            project_files.join(format!("{SESSION_ID}.jsonl.superseded-1")),
            config.join("file-history").join(SESSION_ID).join("v1"),
            config.join("debug").join(format!("{SESSION_ID}.txt")),
            config.join("uploads").join(SESSION_ID).join("a.png"),
            config.join("dev-mods").join(SESSION_ID).join("m"),
            compose_claude_scratch_folder(data_text, &config)
                .join("claude-501")
                .join("-worktree")
                .join(SESSION_ID)
                .join("images")
                .join("a.png"),
            // A second conversation of the batch, found in the same listings.
            other_project_files.join(format!("{OTHER_SESSION_ID}.jsonl")),
            config.join("tasks").join(OTHER_SESSION_ID).join("t"),
        ];
        for path in kept.iter().chain(&deleted) {
            write(path, "x");
        }

        delete_claude_conversations(
            &ClaudeConversationFolders {
                config_folder: &config,
                home_folder: scratch.path(),
                // The repository's root keeps the local settings, as on macOS and Linux.
                path_rules: PathRules::Posix,
                data_folder: data_text,
            },
            &[SESSION_ID, OTHER_SESSION_ID].map(|provider_session_id| ClaudeConversation {
                provider_session_id,
                project_folder: &project_folder,
            }),
        )
        .await
        .expect("the purge succeeds");

        for path in &kept {
            assert!(path.exists(), "{} is kept", path.display());
        }
        for path in deleted.iter().chain([&conversation]) {
            assert!(!path.exists(), "{} is deleted", path.display());
        }
    }

    #[tokio::test]
    async fn a_failed_purge_keeps_the_conversation_file_for_the_next_one() {
        // Root removes a held file, so the purge would succeed and prove nothing.
        if sidekicks_platforms::is_superuser() {
            return;
        }
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let config = scratch.path().join("config");
        let conversation = config
            .join("projects")
            .join("-project")
            .join(format!("{SESSION_ID}.jsonl"));
        write(&conversation, "{\"slug\":\"brave-otter\"}\n");
        let history = config.join("file-history").join(SESSION_ID);
        fs::create_dir_all(&history).expect("the history folder is made");
        let held = sidekicks_platforms::UnremovableFile::create_in(&history, "v1")
            .expect("a held file is made");

        let project = scratch.path().join("project");
        let outcome = delete_claude_conversations(
            &ClaudeConversationFolders {
                config_folder: &config,
                home_folder: scratch.path(),
                path_rules: PathRules::NATIVE,
                data_folder: scratch
                    .path()
                    .to_str()
                    .expect("the scratch folder is UTF-8"),
            },
            &[ClaudeConversation {
                provider_session_id: SESSION_ID,
                project_folder: &ClaudeProjectFolder {
                    working_folder: &project,
                    repository: None,
                },
            }],
        )
        .await;

        drop(held);
        assert!(outcome.is_err());
        assert!(conversation.exists());
    }

    #[rstest::rstest]
    #[case::an_empty_id("")]
    #[case::the_parent_folder("..")]
    #[case::a_path("a/b")]
    #[tokio::test]
    async fn an_id_that_is_no_plain_name_deletes_nothing(#[case] provider_session_id: &str) {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let config = scratch.path().join("config");
        let data = scratch.path().join("data");
        let kept = [
            config.join("file-history").join(SESSION_ID).join("v1"),
            config.join("projects").join("-project").join("a.jsonl"),
            compose_claude_scratch_folder(
                data.to_str().expect("the scratch folder is UTF-8"),
                &config,
            )
            .join("claude-501")
            .join("-project")
            .join("a"),
            config.join(CLAUDE_USER_SETTINGS_FILE),
        ];
        for path in &kept {
            write(path, "x");
        }
        let project = scratch.path().join("project");

        let outcome = delete_claude_conversations(
            &ClaudeConversationFolders {
                config_folder: &config,
                home_folder: scratch.path(),
                path_rules: PathRules::Posix,
                data_folder: data.to_str().expect("the scratch folder is UTF-8"),
            },
            &[ClaudeConversation {
                provider_session_id,
                project_folder: &ClaudeProjectFolder {
                    working_folder: &project,
                    repository: None,
                },
            }],
        )
        .await;

        assert_eq!(
            outcome.map_err(|failure| failure.kind()),
            Err(std::io::ErrorKind::InvalidInput)
        );
        for path in &kept {
            assert!(path.exists(), "{} is kept", path.display());
        }
    }
}
