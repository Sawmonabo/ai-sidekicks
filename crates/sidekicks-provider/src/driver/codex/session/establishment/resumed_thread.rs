//! A conversation's resume on its service: the `thread/resume` request, what its reply and the
//! paged turn history read back, and the resume's result once the steps that can fail are done.

use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::driver::codex::app_server_protocol::ThreadResumeParams;
use crate::driver::codex::output_speed::read_codex_declared_tier;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::controls::update_codex_session_mode;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::history::{
    CodexListedTurn, read_codex_resumed_newest_turn, read_codex_turns,
};
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::thread::view::{
    CodexThreadStatus, THREAD_RESUME_METHOD, read_thread, read_thread_reasoning_effort,
};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::session_control::{DriverResumeResult, ResumedRunAnswer};
use crate::spawned_version::to_binding_version_carriers;

/// What a resume reads back: the conversation's turns, the newest of them, whether the session
/// held the conversation on the service before it, where the conversation stands, its declared
/// tier and its effort.
pub(super) struct CodexResumedThread {
    /// The conversation's turns, oldest first, each with its items not loaded.
    pub(super) listed_turns: Vec<CodexListedTurn>,
    /// The newest turn the resume's reply named, the live one where a turn runs.
    pub(super) newest_turn_id: Option<String>,
    /// Whether the session held the conversation on the service before the resume.
    pub(super) was_held: bool,
    /// Where the conversation stands, as the reply reads it.
    pub(super) status: Option<CodexThreadStatus>,
    /// The tier the reply declares.
    pub(super) declared_output_speed: Option<ProviderOutputSpeedState>,
    /// The effort the reply names.
    pub(super) reasoning_effort: Option<String>,
}

/// `thread/resume` of `thread_id` with `params`, and the reply. Fails as the request does, and
/// when the reply names another conversation: Codex started a replacement.
pub(super) async fn request_thread_resume(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    params: &ThreadResumeParams,
) -> Result<Box<RawValue>, CodexError> {
    let reply = connection.request(THREAD_RESUME_METHOD, params).await?;
    let thread = read_thread(&reply, THREAD_RESUME_METHOD)?;
    if thread.id != thread_id {
        return Err(CodexError::Transport {
            detail: format!(
                "Resume handle {thread_id} was answered by thread {}; the provider started a \
                 replacement conversation rather than resuming.",
                thread.id
            ),
            cause: None,
        });
    }
    Ok(reply)
}

/// What the resume `reply` of the record's conversation reads back, its turns read page by page
/// on `connection`, with the reply's newest turn, the live one where a turn runs, added where the
/// pages lack it. Fails as the turns' read does.
pub(super) async fn read_resumed_thread(
    record: &CodexSessionRecord,
    connection: &CodexAppServerConnection,
    reply: &RawValue,
    was_held: bool,
) -> Result<CodexResumedThread, CodexError> {
    let mut listed_turns = read_codex_turns(connection, &record.thread_id).await?;
    let newest_turn = read_codex_resumed_newest_turn(reply);
    let newest_turn_id = newest_turn.as_ref().map(|newest| newest.id.clone());
    if let Some(newest) = newest_turn
        && !listed_turns.iter().any(|listed| listed.id == newest.id)
    {
        listed_turns.push(newest);
    }
    Ok(CodexResumedThread {
        listed_turns,
        newest_turn_id,
        was_held,
        status: read_thread(reply, THREAD_RESUME_METHOD)?.status,
        declared_output_speed: read_codex_declared_tier(record.session_id, reply),
        reasoning_effort: read_thread_reasoning_effort(reply),
    })
}

/// The steps of an adoption that can fail, run before the record changes: the binding's version
/// read, and the session's mode sent on `service`'s connection with the resumed effort. Answers
/// the result under `binding_id`, with `runs`, what Codex holds of each run's turns. Fails with
/// `CodexError::Transport` when the service reported no version, and as the mode's update fails.
pub(super) async fn prepare_adoption(
    record: &CodexSessionRecord,
    service: &CodexService,
    resumed: &CodexResumedThread,
    binding_id: &RuntimeBindingId,
    runs: Vec<ResumedRunAnswer>,
) -> Result<DriverResumeResult, CodexError> {
    let Some(version) = service.version_reading() else {
        return Err(CodexError::Transport {
            detail: "The Codex service reported no version for the resumed session's binding."
                .to_owned(),
            cause: None,
        });
    };
    let connection = service.connection()?;
    update_codex_session_mode(
        &connection,
        &record.thread_id,
        record.session_mode,
        &record.thread_settings.model,
        resumed.reasoning_effort.as_deref(),
    )
    .await?;
    Ok(DriverResumeResult::Resumed {
        binding_id: binding_id.clone(),
        session_position: SafeInt::from_usize(resumed.listed_turns.len()),
        resume_handle: NonEmptyText::new(record.thread_id.clone())
            .expect("a resumed conversation's id is never empty"),
        spawned_version: to_binding_version_carriers(&version),
        runs,
    })
}
