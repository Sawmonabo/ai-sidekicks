//! The permission profile a Codex thread runs under, as the daemon asked for it and as Codex
//! reports it on `thread/settings/updated`. A report naming a profile the daemon never asked the
//! thread for, or none, is a drift: something other than the daemon moved the conversation's
//! posture, which the daemon reports and asks back.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::driver::codex::permission_level::{
    compose_codex_level_settings, compose_codex_profile_name,
};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::thread::settings::{
    CodexThreadSettings, CodexThreadSettingsUpdateParams,
};
use crate::driver::codex::thread::view::read_active_permission_profile;
use crate::driver::codex::transport::connection::read_codex_object;
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;

/// The method that moves a thread's settings from its next turn.
const CODEX_THREAD_SETTINGS_UPDATE_METHOD: &str = "thread/settings/update";

/// The profile Codex last reported for a thread, and the ones asked for since, oldest first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexThreadPermissionProfiles {
    /// The profile Codex last confirmed.
    confirmed: String,
    /// The profiles asked for since, oldest first.
    pending: Vec<String>,
}

impl CodexThreadPermissionProfiles {
    /// The profiles of a thread just established: its reply ran the level's profile, checked as
    /// it came.
    pub(crate) fn established(settings: &CodexThreadSettings) -> Self {
        Self {
            confirmed: compose_codex_profile_name(settings.level, &settings.profile_folders),
            pending: Vec::new(),
        }
    }

    /// Records a profile about to be asked for, before its request is sent, once per change.
    pub(crate) fn note_asked(&mut self, profile: &str) {
        let newest = self.pending.last().unwrap_or(&self.confirmed);
        if newest != profile {
            self.pending.push(profile.to_owned());
        }
    }

    /// Reads one report of the thread's active profile, `"none"` when it names none: `None` when
    /// the daemon asked for it, the profiles moving on to it, else the drifted profile.
    pub(crate) fn read_drift(&mut self, active_profile: String) -> Option<String> {
        if active_profile == self.confirmed {
            return None;
        }
        let Some(asked_at) = self
            .pending
            .iter()
            .position(|asked| *asked == active_profile)
        else {
            return Some(active_profile);
        };
        self.pending.drain(..=asked_at);
        self.confirmed = active_profile;
        None
    }
}

/// The members of `thread/settings/updated` the check reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSettingsUpdatedParams {
    thread_id: Option<String>,
    thread_settings: Option<ThreadSettingsMembers>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSettingsMembers {
    active_permission_profile: Option<Box<RawValue>>,
}

/// Checks the profile a `thread/settings/updated` for the thread `thread_id` reports, and when the
/// daemon never asked for it reports the drift and asks Codex for the session's own posture
/// again, which holds from the next turn. A failed ask is reported, the drift standing until the
/// next turn names its posture.
pub(crate) fn correct_codex_permission_profile_drift(
    profiles: &mut CodexThreadPermissionProfiles,
    service: &Arc<CodexService>,
    thread_id: &str,
    settings: &CodexThreadSettings,
    params: &RawValue,
) {
    let Some(updated) = read_codex_object::<ThreadSettingsUpdatedParams>(params.get()) else {
        return;
    };
    if updated.thread_id.as_deref() != Some(thread_id) {
        return;
    }
    let active_profile = updated
        .thread_settings
        .and_then(|members| members.active_permission_profile)
        .and_then(|profile| read_active_permission_profile(&profile))
        .unwrap_or_else(|| "none".to_owned());
    let Some(active_profile) = profiles.read_drift(active_profile) else {
        return;
    };
    let posture = compose_codex_level_settings(settings.level, &settings.profile_folders);
    CodexTransportDiagnostic::PermissionProfileDrifted {
        thread_id: thread_id.to_owned(),
        active_profile,
        expected_profile: posture.permissions.clone(),
    }
    .report();
    profiles.note_asked(&posture.permissions);
    let params = CodexThreadSettingsUpdateParams {
        thread_id: thread_id.to_owned(),
        collaboration_mode: None,
        permissions: Some(posture.permissions),
        approval_policy: Some(posture.approval_policy.into()),
        approvals_reviewer: Some(posture.approvals_reviewer.into()),
        service_tier: None,
    };
    let service = Arc::clone(service);
    let thread_id = thread_id.to_owned();
    tokio::spawn(async move {
        let restored = match service.connection() {
            Ok(connection) => connection
                .request(CODEX_THREAD_SETTINGS_UPDATE_METHOD, &params)
                .await
                .map(drop),
            Err(error) => Err(error),
        };
        if let Err(error) = restored {
            CodexTransportDiagnostic::PermissionProfileRestoreFailed {
                thread_id,
                error: Box::new(error),
            }
            .report();
        }
    });
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use serde_json::json;
    use serde_json::value::RawValue;
    use sidekicks_contracts::session::controls::methods::PermissionLevel;
    use sidekicks_contracts::session::id::SessionId;

    use super::{CodexThreadPermissionProfiles, correct_codex_permission_profile_drift};
    use crate::driver::codex::permission_level::{CodexProfileFolders, compose_codex_profile_name};
    use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
    use crate::driver::codex::thread::settings::CodexThreadSettings;
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    fn ask_settings() -> CodexThreadSettings {
        CodexThreadSettings {
            session_id: SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id"),
            working_directory: PathBuf::from("/work/repository"),
            model: "gpt-5".to_owned(),
            model_context_window: None,
            level: PermissionLevel::Ask,
            profile_folders: CodexProfileFolders {
                working_directory: PathBuf::from("/work/repository"),
                git_common_folder: None,
                deny_paths: Vec::new(),
            },
            command_environment: Vec::new(),
            subagent_policy: None,
            helper_roles: Vec::new(),
            tool_servers: Vec::new(),
            base_instructions: None,
        }
    }

    fn settings_updated(thread_id: &str, profile: Option<&str>) -> Box<RawValue> {
        let profile = profile.map(|id| json!({"id": id}));
        RawValue::from_string(
            json!({"threadId": thread_id, "threadSettings": {"activePermissionProfile": profile}})
                .to_string(),
        )
        .expect("the params are JSON")
    }

    // Fails when a profile the daemon asked for reads as a drift, an earlier ask confirmed after a
    // later one is not let go, or a profile no ask named is taken as asked for.
    #[test]
    fn a_permission_profile_asked_for_is_no_drift_and_any_other_is() {
        let mut profiles = CodexThreadPermissionProfiles {
            confirmed: "ask".to_owned(),
            pending: Vec::new(),
        };
        profiles.note_asked("reviewed");
        profiles.note_asked("sandboxed");

        let readings = [
            profiles.read_drift("ask".to_owned()),
            profiles.read_drift("sandboxed".to_owned()),
            profiles.read_drift("reviewed".to_owned()),
            profiles.read_drift("none".to_owned()),
        ];

        assert_eq!(
            readings,
            [
                None,
                None,
                Some("reviewed".to_owned()),
                Some("none".to_owned())
            ]
        );
        assert_eq!(profiles.confirmed, "sandboxed");
        assert_eq!(profiles.pending, Vec::<String>::new());
    }

    // Fails when a conversation whose profile something other than the daemon moved is left
    // there, or asked back to anything but the session's own posture, or when a report of the
    // session's own profile or another conversation's asks anything.
    #[tokio::test]
    async fn a_permission_profile_drift_asks_the_session_s_posture_back() {
        let mut scripted = start_scripted_codex_service();
        let settings = ask_settings();
        let own_profile = compose_codex_profile_name(settings.level, &settings.profile_folders);
        let mut profiles = CodexThreadPermissionProfiles::established(&settings);
        let service = Arc::clone(&scripted.service);
        let mut report = |thread_id: &str, profile: Option<&str>| {
            correct_codex_permission_profile_drift(
                &mut profiles,
                &service,
                "thread-1",
                &settings,
                &settings_updated(thread_id, profile),
            );
        };

        report("thread-1", Some(&own_profile));
        report("thread-2", Some("rogue"));
        report("thread-1", Some("rogue"));
        let restore = scripted.script.next_sent().await;
        scripted.script.answer(&restore, &json!({}));
        report("thread-1", Some(&own_profile));
        report("thread-1", None);
        let second_restore = scripted.script.next_sent().await;

        assert_eq!(restore["method"], "thread/settings/update");
        assert_eq!(restore["params"]["threadId"], "thread-1");
        assert_eq!(restore["params"]["permissions"], own_profile.as_str());
        assert_eq!(restore["params"]["approvalPolicy"], "on-request");
        assert_eq!(
            second_restore["params"]["permissions"],
            own_profile.as_str()
        );
        assert!(scripted.script.sent.try_recv().is_err());
    }
}
