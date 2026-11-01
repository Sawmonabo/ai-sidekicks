//! The session controls Codex carries on the conversation itself: its permission level, moved
//! from its next turn; Build or Plan as its collaboration mode, sent with the session's model and
//! the effort Codex last reported; and `Allow once` on a block its reviewer made at Reviewed,
//! which starts no turn: Codex adds the approval to the turn running on the conversation or, with
//! none running, to the conversation's history.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::controls::methods::SessionMode;

use crate::driver::codex::app_server_protocol::ThreadApproveGuardianDeniedActionParams;
use crate::driver::codex::event_normalizer::CODEX_THREAD_SETTINGS_UPDATED_METHOD;
use crate::driver::codex::permission_level::compose_codex_level_settings;
use crate::driver::codex::run::turn_end_waiters::{CodexTurnEndDeadline, CodexTurnWait};
use crate::driver::codex::session::calls::{call_codex_session, wait_for_codex_turns};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::driver::codex::session::inbound::CodexSessionCall;
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::thread::settings::{
    CodexThreadSettingsUpdateParams, compose_codex_bare_thread_resume_params,
    compose_codex_collaboration_mode, compose_codex_level_config,
};
use crate::driver::codex::thread::view::THREAD_RESUME_METHOD;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};
use crate::driver::run_control::OverrideDenialParams;
use crate::driver::session_control::UpdatePermissionLevelParams;

const THREAD_SETTINGS_UPDATE_METHOD: &str = "thread/settings/update";
const APPROVE_GUARDIAN_DENIED_ACTION_METHOD: &str = "thread/approveGuardianDeniedAction";

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

/// Moves `record`'s conversation to the level of `params.execution_posture` from its next turn
/// through `thread/settings/update`, its profile noted as asked for first; the record then runs at
/// that posture as handed in, and owes a fork onto the level's config where that changed, since
/// only a fork carries it. On a service on its way back nothing is sent: its resume carries the
/// level the record holds, and the fork waits for the next turn. Refused
/// `session.permissionLevel.notOffered` when Codex refuses the level; fails as the request fails,
/// the level left as it was.
pub(crate) async fn move_codex_permission_level(
    record: &mut CodexSessionRecord,
    config_forks: &Arc<CodexConfigForks>,
    params: &UpdatePermissionLevelParams,
) -> Result<(), CodexError> {
    let level = params.execution_posture.permission_level();
    let folders = &record.thread_settings.profile_folders;
    let posture = compose_codex_level_settings(level, folders);
    let config_before = compose_codex_level_config(record.thread_settings.level, folders);
    let config_after = compose_codex_level_config(level, folders);
    let is_coming_back = record.service.is_coming_back();
    if !is_coming_back {
        record.permission_profiles.note_asked(&posture.permissions);
        record
            .service
            .connection()?
            .request(
                THREAD_SETTINGS_UPDATE_METHOD,
                &CodexThreadSettingsUpdateParams {
                    thread_id: record.thread_id.clone(),
                    collaboration_mode: None,
                    permissions: Some(posture.permissions),
                    approval_policy: Some(posture.approval_policy.into()),
                    approvals_reviewer: Some(posture.approvals_reviewer.into()),
                    service_tier: None,
                },
            )
            .await
            .map_err(|error| {
                error.refused_as(
                    RefusalCode::SessionPermissionLevelNotOffered,
                    "Codex refused the permission level",
                )
            })?;
    }
    // A resume after a crash sends the level the record holds, and a turn the daemon starts runs
    // at its posture.
    record.thread_settings.level = level;
    record.execution_posture = params.execution_posture.clone();
    if config_before != config_after {
        if is_coming_back {
            record.is_config_fork_owed = true;
        } else {
            config_forks.owe(record);
        }
    }
    Ok(())
}

/// Keeps the reasoning effort a `thread/settings/updated` of the session's own conversation names,
/// none when it names none, so a mode move sends it back; any other frame changes nothing.
pub(crate) fn observe_codex_reasoning_effort(
    record: &mut CodexSessionRecord,
    method: &str,
    params: &RawValue,
) {
    if method != CODEX_THREAD_SETTINGS_UPDATED_METHOD {
        return;
    }
    let Some(updated) = read_codex_object::<SettingsUpdatedFrame>(params.get()) else {
        return;
    };
    if updated.thread_id.as_deref() != Some(record.thread_id.as_str()) {
        return;
    }
    let Some(settings) = updated.thread_settings else {
        return;
    };
    record.reasoning_effort = settings.effort.filter(|effort| !effort.is_empty());
}

// The members of a `thread/settings/updated` the effort's read reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsUpdatedFrame {
    thread_id: Option<String>,
    thread_settings: Option<EffortSettings>,
}

#[derive(Deserialize)]
struct EffortSettings {
    effort: Option<String>,
}

/// Sends `Allow once` on the blocks Codex's reviewer made.
pub(crate) struct CodexSessionControls {
    slots: Arc<CodexSessionSlots>,
}

impl CodexSessionControls {
    /// Controls reaching each session through `slots`.
    pub(crate) fn new(slots: Arc<CodexSessionSlots>) -> Self {
        Self { slots }
    }

    /// Sends `Allow once` for a block Codex's reviewer made, with the review Codex sent as the
    /// block, on the conversation it was made in, which Codex adds to the turn running there or,
    /// with none, to the conversation's history, starting no turn. A conversation the service has
    /// not loaded is resumed first. On the session's own conversation a turn the daemon is stopping
    /// is waited out first, within the request deadline, past which this fails with
    /// `CodexError::SessionTurnInFlight`, nothing sent. Fails as the requests fail.
    pub(crate) async fn override_denial(
        &self,
        params: OverrideDenialParams,
    ) -> Result<(), CodexError> {
        let event: Value = serde_json::from_str(params.provider_denial.get()).map_err(|error| {
            CodexError::Transport {
                detail: "The stored reviewer block does not read as JSON.".to_owned(),
                cause: Some(Box::new(error)),
            }
        })?;
        let session_id = params.session_id;
        let inbound = self.slots.require_live(session_id)?;
        let denial_thread_id = event
            .get("threadId")
            .and_then(Value::as_str)
            .filter(|thread_id| !thread_id.is_empty())
            .map(str::to_owned);
        let read_session = |thread_id: Option<String>| {
            call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
                thread_id,
                reply,
            })
        };
        let mut reading = read_session(denial_thread_id.clone()).await?;
        let thread_id = denial_thread_id.unwrap_or_else(|| reading.thread_id.clone());
        if thread_id == reading.thread_id {
            // Sent into a turn the daemon is stopping, the approval would go with the input that
            // turn drops as it ends.
            let has_stopped = wait_for_codex_turns(
                &inbound,
                CodexTurnWait::StoppedTurns,
                Some(&CodexTurnEndDeadline::for_request()),
            )
            .await?;
            if !has_stopped {
                return Err(CodexError::SessionTurnInFlight { session_id });
            }
            reading = read_session(Some(thread_id.clone())).await?;
        }
        send_approval(
            &*reading.connection?,
            thread_id,
            event,
            !reading.is_thread_loaded,
        )
        .await
    }
}

// Sends the approval of `event` on `thread_id`, the conversation resumed first where the service
// has not loaded it.
async fn send_approval(
    connection: &CodexAppServerConnection,
    thread_id: String,
    event: Value,
    needs_resume: bool,
) -> Result<(), CodexError> {
    if needs_resume {
        connection
            .request(
                THREAD_RESUME_METHOD,
                &compose_codex_bare_thread_resume_params(thread_id.clone()),
            )
            .await?;
    }
    connection
        .request(
            APPROVE_GUARDIAN_DENIED_ACTION_METHOD,
            &ThreadApproveGuardianDeniedActionParams { event, thread_id },
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use serde_json::value::RawValue;
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
    use sidekicks_contracts::session::controls::methods::PermissionLevel;

    use super::{CodexSessionControls, move_codex_permission_level};
    use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession};
    use crate::driver::run_control::OverrideDenialParams;
    use crate::driver::session_control::UpdatePermissionLevelParams;
    use crate::driver::test_registry::new_run_id;
    use crate::run::posture::compose_execution_posture;

    // Kills: the move recomposing the posture from its level, which opens Sandboxed to the
    // repository's folder alone and drops the second root the caller composed.
    #[tokio::test]
    async fn a_level_move_runs_at_exactly_the_posture_handed_in() {
        let mut session = TestCodexSession::start().await;
        let path = |text: &str| FilesystemPath::new(text.to_owned()).expect("a test path");
        let composed =
            compose_execution_posture(PermissionLevel::Sandboxed, path("/work/repository"));
        let handed = ExecutionPosture::Sandboxed {
            credential_policy_ref: composed.credential_policy_ref().clone(),
            writable_roots: vec![path("/work/repository"), path("/work/shared")],
        };
        let params = UpdatePermissionLevelParams {
            session_id: session.task.record.session_id,
            execution_posture: handed.clone(),
            is_provider_reported: false,
        };
        let config_forks = Arc::clone(&session.task.calls.runs.config_forks);
        let record = &mut session.task.record;
        let script = &mut session.scripted.script;
        let service = async {
            let update = script.next_sent().await;
            assert_eq!(update["method"], "thread/settings/update");
            assert_eq!(update["params"]["threadId"], TEST_THREAD);
            script.answer(&update, &json!({}));
        };
        let (moved, ()) = tokio::time::timeout(
            Duration::from_secs(10),
            Box::pin(async {
                tokio::join!(
                    move_codex_permission_level(record, &config_forks, &params),
                    service
                )
            }),
        )
        .await
        .expect("the move settles");
        moved.expect("Codex takes the move");

        assert_eq!(session.task.record.execution_posture, handed);
        assert_eq!(
            session.task.record.thread_settings.level,
            PermissionLevel::Sandboxed
        );
    }

    // Kills: the resume dropped, which Codex answers with "thread not found"; and `Allow once` on
    // the session's idle conversation opened as a run waiting for a turn Codex never starts, since
    // Codex records the approval there with no new turn.
    #[tokio::test]
    async fn allow_once_reaches_the_blocked_conversation_and_starts_no_turn() {
        let mut session = TestCodexSession::start().await;
        let controls = CodexSessionControls::new(Arc::clone(&session.slots));
        let denial = json!({
            "threadId": "thread-left",
            "turnId": "turn-3",
            "action": {"type": "command", "command": "rm -rf build"},
        });
        let allow = controls.override_denial(OverrideDenialParams {
            session_id: session.task.record.session_id,
            run_id: new_run_id(),
            provider_denial: RawValue::from_string(denial.to_string()).expect("the denial is JSON"),
        });
        let task = &mut session.task;
        let script = &mut session.scripted.script;
        let flow = async {
            task.handle_next().await;
            let resumed = script.next_sent().await;
            assert_eq!(
                resumed["method"], "thread/resume",
                "the conversation is loaded first"
            );
            assert_eq!(resumed["params"]["threadId"], "thread-left");
            script.answer(&resumed, &json!({"thread": {"id": "thread-left"}}));
            let approved = script.next_sent().await;
            assert_eq!(approved["method"], "thread/approveGuardianDeniedAction");
            assert_eq!(approved["params"]["threadId"], "thread-left");
            assert_eq!(
                approved["params"]["event"], denial,
                "the stored block goes as sent"
            );
            script.answer(&approved, &json!({}));
        };
        let (allowed, ()) = tokio::time::timeout(
            Duration::from_secs(10),
            Box::pin(async { tokio::join!(allow, flow) }),
        )
        .await
        .expect("the approval settles");
        allowed.expect("Codex takes the approval");

        let idle_denial = json!({"threadId": TEST_THREAD, "turnId": "turn-4"});
        let allow_idle = controls.override_denial(OverrideDenialParams {
            session_id: session.task.record.session_id,
            run_id: new_run_id(),
            provider_denial: RawValue::from_string(idle_denial.to_string())
                .expect("the denial is JSON"),
        });
        let script = &mut session.scripted.script;
        let service = async {
            let approved = script.next_sent().await;
            assert_eq!(approved["method"], "thread/approveGuardianDeniedAction");
            assert_eq!(approved["params"]["threadId"], TEST_THREAD);
            script.answer(&approved, &json!({}));
        };
        let (allowed_idle, ()) = tokio::time::timeout(
            Duration::from_secs(10),
            Box::pin(async { tokio::join!(session.task.drive(allow_idle), service) }),
        )
        .await
        .expect("the approval on the idle conversation answers at once, waiting for no turn");
        allowed_idle.expect("Codex records the approval on the idle conversation");
    }
}
