//! Readers of a Codex thread's replies: the thread and where it stands, the reasoning effort and
//! the permission profile a start, resume or fork runs under, the turn a turn request names, and
//! the `thread/read` of a thread's name, preview, source, status, folder and, for a helper, its
//! nickname, role and model.

use std::time::Duration;

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::driver::codex::app_server_protocol::ThreadReadParams;
use crate::driver::codex::permission_level::compose_codex_profile_name;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::thread::settings::CodexThreadSettings;
use crate::driver::codex::transport::connection::{
    CodexAppServerConnection, read_codex_given_text, read_codex_object,
};

/// A thread as a thread reply names it.
#[derive(Debug)]
pub(crate) struct CodexThreadView {
    /// The thread's id, never empty.
    pub(crate) id: String,
    /// The Codex session the thread belongs to.
    pub(crate) session_id: String,
    /// Where the thread stands on the service, `None` where the reply names no status it reads.
    pub(crate) status: Option<CodexThreadStatus>,
}

/// Where a thread stands on its service, as a thread reply's `status` names it.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum CodexThreadStatus {
    /// Not loaded: no turn of it runs.
    NotLoaded,
    /// Loaded, with no turn running.
    Idle,
    /// Loaded, but stopped by a failure of the service's own: no turn of it runs.
    SystemError,
    /// Loaded, with a turn running.
    Active,
}

// Each reader names only the member it reads, so a member of another type fails only its reader.
#[derive(Deserialize)]
struct ThreadReply {
    thread: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReasoningEffortReply {
    reasoning_effort: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionProfileReply {
    active_permission_profile: Option<Box<RawValue>>,
}

/// The permission profile a thread runs under, as a start, resume or fork reply and a
/// `thread/settings/updated` notice each name it.
#[derive(Debug, Deserialize)]
pub(crate) struct ActivePermissionProfile {
    /// The profile's id, `None` where it names none.
    pub(crate) id: Option<String>,
}

/// The id of the active profile `profile` holds, `None` where it is unreadable or names none.
pub(crate) fn read_active_permission_profile(profile: &RawValue) -> Option<String> {
    read_codex_object::<ActivePermissionProfile>(profile.get()).and_then(|profile| profile.id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadMembers {
    id: Option<String>,
    session_id: Option<String>,
    status: Option<Box<RawValue>>,
}

// The members a `thread/read` reply's thread is read for, each on its own: `source` is a string or
// an object, so no one type reads it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadReadingMembers {
    name: Option<Box<RawValue>>,
    preview: Option<Box<RawValue>>,
    source: Option<Box<RawValue>>,
    ephemeral: Option<Box<RawValue>>,
    status: Option<Box<RawValue>>,
    cwd: Option<Box<RawValue>>,
    agent_nickname: Option<Box<RawValue>>,
    agent_role: Option<Box<RawValue>>,
    model: Option<Box<RawValue>>,
}

/// A thread as `thread/read` names it, without its turns.
#[derive(Debug)]
pub(crate) struct CodexThreadReading {
    /// The name the thread was given, `None` where it has none or a blank one.
    pub(crate) name: Option<String>,
    /// The thread's preview, `None` where it has none or a blank one.
    pub(crate) preview: Option<String>,
    /// Whether a person typed the thread in a terminal: its source is `cli` and it is kept, unlike
    /// a helper's or a one-off run's.
    pub(crate) is_typed_in_terminal: bool,
    /// Where the thread stands on the service, `None` where the reply names no status it reads.
    pub(crate) status: Option<CodexThreadStatus>,
    /// The folder the thread runs in, `cwd`, `None` where it names none or a blank one.
    pub(crate) folder: Option<String>,
    /// A helper's nickname, `agentNickname`, `None` where it has none or a blank one.
    pub(crate) agent_nickname: Option<String>,
    /// The role a helper was started in, `agentRole`, `None` where it has none or a blank one.
    pub(crate) agent_role: Option<String>,
    /// The model the thread runs on, `None` where it names none or a blank one.
    pub(crate) model: Option<String>,
}

/// The thread the `thread/read` reply `reply` names, or `None` when it carries no readable thread.
/// A member that does not read as its type reads as absent, never making the thread unreadable.
pub(crate) fn read_thread_reading(reply: &RawValue) -> Option<CodexThreadReading> {
    let thread = read_codex_object::<ThreadReply>(reply.get())
        .and_then(|reply| reply.thread)
        .and_then(|thread| read_codex_object::<ThreadReadingMembers>(thread.get()))?;
    let source = thread
        .source
        .and_then(|source| serde_json::from_str::<String>(source.get()).ok());
    let ephemeral = thread
        .ephemeral
        .and_then(|ephemeral| serde_json::from_str::<bool>(ephemeral.get()).ok());
    Some(CodexThreadReading {
        name: thread.name.and_then(|name| read_codex_given_text(&name)),
        preview: thread
            .preview
            .and_then(|preview| read_codex_given_text(&preview)),
        is_typed_in_terminal: source.as_deref() == Some(THREAD_TERMINAL_SOURCE)
            && ephemeral == Some(false),
        status: thread
            .status
            .and_then(|status| read_codex_object::<CodexThreadStatus>(status.get())),
        folder: thread.cwd.and_then(|cwd| read_codex_given_text(&cwd)),
        agent_nickname: thread
            .agent_nickname
            .and_then(|nickname| read_codex_given_text(&nickname)),
        agent_role: thread
            .agent_role
            .and_then(|role| read_codex_given_text(&role)),
        model: thread.model.and_then(|model| read_codex_given_text(&model)),
    })
}

/// Reads `thread_id` through `thread/read` without its turns, waiting at most `timeout`. Answers
/// `None` when the reply carries no readable thread; fails as the request does.
pub(crate) async fn request_thread_reading(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    timeout: Duration,
) -> Result<Option<CodexThreadReading>, CodexError> {
    let reply = connection
        .request_within(
            THREAD_READ_METHOD,
            &ThreadReadParams {
                thread_id: thread_id.to_owned(),
                include_turns: Some(false),
            },
            timeout,
        )
        .await?;
    Ok(read_thread_reading(&reply))
}

// A turn, read by its id.
#[derive(Deserialize)]
struct IdentifiedMember {
    id: Option<String>,
}

// `turn/start`'s reply, `{turn: {id}}`.
#[derive(Deserialize)]
struct TurnReply {
    turn: Option<Box<RawValue>>,
}

// `turn/steer`'s flat acknowledgement, `{turnId}`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SteerReply {
    turn_id: Option<String>,
}

/// Reads the thread from the `method` reply `reply`. Fails with `CodexError::Transport` naming
/// `method` when the reply carries no readable thread or one with no id or no session id.
pub(crate) fn read_thread(reply: &RawValue, method: &str) -> Result<CodexThreadView, CodexError> {
    let thread = read_codex_object::<ThreadReply>(reply.get())
        .and_then(|reply| reply.thread)
        .and_then(|thread| read_codex_object::<ThreadMembers>(thread.get()))
        .ok_or_else(|| CodexError::Transport {
            detail: format!(
                "The Codex app-server \"{method}\" response carried no readable thread."
            ),
            cause: None,
        })?;
    let (Some(id), Some(session_id)) = (thread.id.filter(|id| !id.is_empty()), thread.session_id)
    else {
        return Err(CodexError::Transport {
            detail: format!(
                "The Codex app-server \"{method}\" response carried an unusable thread identity."
            ),
            cause: None,
        });
    };
    let status = thread
        .status
        .and_then(|status| read_codex_object::<CodexThreadStatus>(status.get()));
    Ok(CodexThreadView {
        id,
        session_id,
        status,
    })
}

/// The reasoning effort a start, resume or fork reply names, or `None` for none or an empty one.
pub(crate) fn read_thread_reasoning_effort(reply: &RawValue) -> Option<String> {
    read_codex_object::<ReasoningEffortReply>(reply.get())
        .and_then(|reply| reply.reasoning_effort)
        .filter(|effort| !effort.is_empty())
}

/// Checks that a start, resume or fork reply names `requested_profile` as the permission profile
/// it runs under. Fails with `CodexError::Transport` naming `method` when it names none or
/// another: a conversation never runs without the level it was given.
pub(crate) fn assert_active_permission_profile(
    reply: &RawValue,
    requested_profile: &str,
    method: &str,
) -> Result<(), CodexError> {
    let active_profile = read_codex_object::<PermissionProfileReply>(reply.get())
        .and_then(|reply| reply.active_permission_profile)
        .and_then(|profile| read_active_permission_profile(&profile));
    if active_profile.as_deref() == Some(requested_profile) {
        return Ok(());
    }
    Err(CodexError::Transport {
        detail: format!(
            "The Codex app-server \"{method}\" reply did not run the conversation under the \
             permission profile it was given (asked for {requested_profile}, running under {}).",
            active_profile.as_deref().unwrap_or("none")
        ),
        cause: None,
    })
}

/// Checks that a start, resume or fork reply runs the conversation under the profile `settings`'
/// level selects. Fails as [`assert_active_permission_profile`] does.
pub(crate) fn assert_codex_thread_profile(
    reply: &RawValue,
    settings: &CodexThreadSettings,
    method: &str,
) -> Result<(), CodexError> {
    assert_active_permission_profile(
        reply,
        &compose_codex_profile_name(settings.level, &settings.profile_folders),
        method,
    )
}

/// The turn a `turn/steer` acknowledgement names, or `None`. Never fails, unlike
/// [`read_turn_id`]: an ack that names no turn is an acknowledgement without evidence, not a
/// transport fault.
pub(crate) fn read_steered_turn_id(reply: &RawValue) -> Option<String> {
    read_codex_object::<SteerReply>(reply.get())
        .and_then(|reply| reply.turn_id)
        .filter(|turn_id| !turn_id.is_empty())
}

/// The request that starts a thread.
pub(crate) const THREAD_START_METHOD: &str = "thread/start";

/// The request that resumes a thread.
pub(crate) const THREAD_RESUME_METHOD: &str = "thread/resume";

/// The request that starts a turn on a thread.
pub(crate) const TURN_START_METHOD: &str = "turn/start";

/// Codex's request that reads one conversation.
pub(crate) const THREAD_READ_METHOD: &str = "thread/read";

// The source of a thread a person started with the `codex` command in a terminal.
const THREAD_TERMINAL_SOURCE: &str = "cli";

/// Reads the id of the turn the `method` reply `reply` names. Fails with `CodexError::Transport`
/// naming `method` when it carries none.
pub(crate) fn read_turn_id(reply: &RawValue, method: &str) -> Result<String, CodexError> {
    read_codex_object::<TurnReply>(reply.get())
        .and_then(|reply| reply.turn)
        .and_then(|turn| read_codex_object::<IdentifiedMember>(turn.get()))
        .and_then(|turn| turn.id)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| CodexError::Transport {
            detail: format!("The Codex app-server \"{method}\" response carried no turn id."),
            cause: None,
        })
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::value::RawValue;

    use super::assert_active_permission_profile;
    use crate::driver::codex::session::errors::CodexError;

    // A conversation runs only under the profile it asked for; a reply of any other shape fails,
    // an array among them, which serde would read by position.
    #[rstest]
    #[case::the_profile_asked_for(r#"{"activePermissionProfile":{"id":"asked"}}"#, true)]
    #[case::another_profile(r#"{"activePermissionProfile":{"id":"other"}}"#, false)]
    #[case::no_profile(r#"{"activePermissionProfile":null}"#, false)]
    #[case::a_profile_with_no_id(r#"{"activePermissionProfile":{}}"#, false)]
    #[case::the_profile_in_an_array(r#"[{"activePermissionProfile":{"id":"asked"}}]"#, false)]
    #[case::the_profile_id_in_an_array(r#"{"activePermissionProfile":["asked"]}"#, false)]
    fn a_conversation_runs_only_under_the_profile_it_asked_for(
        #[case] reply: &str,
        #[case] is_accepted: bool,
    ) {
        let reply = RawValue::from_string(reply.to_owned()).expect("the reply is JSON");

        let checked = assert_active_permission_profile(&reply, "asked", "thread/start");

        assert_eq!(checked.is_ok(), is_accepted, "{checked:?}");
        if let Err(error) = checked {
            assert!(matches!(error, CodexError::Transport { .. }));
            assert!(error.to_string().contains("thread/start"), "{error}");
        }
    }
}
