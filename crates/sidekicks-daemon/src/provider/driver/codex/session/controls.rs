//! The session controls Codex carries on the conversation itself: Build or Plan as its
//! collaboration mode, sent with the session's model and effort.

use sidekicks_contracts::session::controls::methods::SessionMode;

use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::thread::settings::{
    CodexThreadSettingsUpdateParams, compose_codex_collaboration_mode,
};
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;

const THREAD_SETTINGS_UPDATE_METHOD: &str = "thread/settings/update";

/// Moves the conversation `thread_id` to `mode` from its next turn, as Codex's own collaboration
/// mode on `model` at `reasoning_effort`, with the mode's built-in instructions; the level and its
/// profile stay as they are. Fails as the request fails.
pub(crate) async fn update_codex_session_mode(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    mode: SessionMode,
    model: &str,
    reasoning_effort: Option<&str>,
) -> Result<(), CodexError> {
    connection
        .request(
            THREAD_SETTINGS_UPDATE_METHOD,
            &CodexThreadSettingsUpdateParams {
                thread_id: thread_id.to_owned(),
                collaboration_mode: Some(compose_codex_collaboration_mode(
                    mode,
                    model.to_owned(),
                    reasoning_effort,
                )),
                permissions: None,
                approval_policy: None,
                approvals_reviewer: None,
                service_tier: None,
            },
        )
        .await?;
    Ok(())
}
