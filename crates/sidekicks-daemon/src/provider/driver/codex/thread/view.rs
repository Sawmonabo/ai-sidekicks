//! Readers of a Codex thread's replies: the thread and its turns, the reasoning effort and the
//! permission profile a start, resume or fork runs under, and the turn a turn request names.

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::provider::driver::codex::permission_level::compose_codex_profile_name;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::thread::settings::CodexThreadSettings;
use crate::provider::driver::codex::transport::connection::read_codex_object;

/// A thread as a thread reply names it.
#[expect(
    dead_code,
    reason = "the Codex session start keeps the thread's id and session and replays its turns"
)]
#[derive(Debug)]
pub(crate) struct CodexThreadView {
    /// The thread's id, never empty.
    pub(crate) id: String,
    /// The Codex session the thread belongs to.
    pub(crate) session_id: String,
    /// The thread's turns as sent, unread; `None` when the reply listed none.
    pub(crate) turns: Option<Box<RawValue>>,
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
    turns: Option<Box<RawValue>>,
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
#[expect(
    dead_code,
    reason = "the Codex session reads the thread its start, resume, fork and read replies name"
)]
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
    Ok(CodexThreadView {
        id,
        session_id,
        turns: thread.turns,
    })
}

/// The reasoning effort a start, resume or fork reply names, or `None` for none or an empty one.
#[expect(
    dead_code,
    reason = "the Codex session records the effort its start, resume and fork replies name"
)]
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
#[expect(
    dead_code,
    reason = "the Codex session checks the profile each start, resume and fork runs under"
)]
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
#[expect(
    dead_code,
    reason = "the Codex run's steer reads the turn its acknowledgement names"
)]
pub(crate) fn read_steered_turn_id(reply: &RawValue) -> Option<String> {
    read_codex_object::<SteerReply>(reply.get())
        .and_then(|reply| reply.turn_id)
        .filter(|turn_id| !turn_id.is_empty())
}

/// Reads the id of the turn the `method` reply `reply` names. Fails with `CodexError::Transport`
/// naming `method` when it carries none.
#[expect(
    dead_code,
    reason = "the Codex run's start reads the turn its reply names"
)]
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
    use crate::provider::driver::codex::session::errors::CodexError;

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
