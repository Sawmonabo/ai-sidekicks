//! The level a new Codex session starts at, read from Codex's own settings for the session's
//! folder: `config/read` with the folder as `cwd` on the person's own Codex home, so Codex resolves
//! its own layers and names the layer that set each key. A key set only by Codex's packaged
//! defaults counts as unset; with none of the three set the session starts at YOLO.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;
use serde_json::Value;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};

use crate::driver::codex::app_server_protocol::ConfigReadParams;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::read_codex_object;
use crate::driver::session_control::StartingLevel;

const CONFIG_READ_METHOD: &str = "config/read";

/// The three keys a level is read from.
const SANDBOX_MODE_KEY: &str = "sandbox_mode";
const APPROVAL_POLICY_KEY: &str = "approval_policy";
const APPROVALS_REVIEWER_KEY: &str = "approvals_reviewer";

/// The layer of Codex's packaged defaults, whose values count as unset.
const PACKAGED_DEFAULTS_LAYER: &str = "packagedDefaults";

/// The members of a `config/read` reply the level is read from.
#[derive(Deserialize)]
struct ConfigReadReply {
    config: ConfigValues,
    origins: HashMap<String, ConfigOrigin>,
}

#[derive(Deserialize)]
struct ConfigValues {
    sandbox_mode: Option<String>,
    // A string, or a granular table of the asks it lets through.
    approval_policy: Option<Value>,
    approvals_reviewer: Option<String>,
}

#[derive(Deserialize)]
struct ConfigOrigin {
    name: ConfigLayer,
}

#[derive(Deserialize)]
struct ConfigLayer {
    #[serde(rename = "type")]
    kind: String,
}

/// The level and mode a new session in `working_folder` starts at, as Codex's own settings for
/// the folder on `service`, the person's own Codex home's, set them; always in Build, since no
/// setting starts Codex planning. Fails as the read fails, and with `CodexError::Transport` for a
/// reply it cannot read.
pub(crate) async fn read_codex_starting_level(
    service: &CodexService,
    working_folder: &Path,
) -> Result<StartingLevel, CodexError> {
    service
        .ensure_started(service.dependencies().startup_timeout)
        .await?;
    let reply = service
        .connection()?
        .request(
            CONFIG_READ_METHOD,
            &ConfigReadParams {
                cwd: Some(working_folder.to_string_lossy().into_owned()),
                include_layers: Some(true),
            },
        )
        .await?;
    let read =
        read_codex_object::<ConfigReadReply>(reply.get()).ok_or_else(|| CodexError::Transport {
            detail: "The Codex app-server \"config/read\" response could not be read.".to_owned(),
            cause: None,
        })?;
    Ok(StartingLevel {
        level: compose_starting_level(&read),
        session_mode: SessionMode::Build,
    })
}

// The level the effective values give, or YOLO when no layer past the packaged defaults sets any
// of them; a combination no level matches gives the nearest more careful one.
fn compose_starting_level(read: &ConfigReadReply) -> PermissionLevel {
    let is_set = |key: &str| {
        read.origins
            .get(key)
            .is_some_and(|origin| origin.name.kind != PACKAGED_DEFAULTS_LAYER)
    };
    if ![
        SANDBOX_MODE_KEY,
        APPROVAL_POLICY_KEY,
        APPROVALS_REVIEWER_KEY,
    ]
    .into_iter()
    .any(is_set)
    {
        return PermissionLevel::Yolo;
    }
    let values = &read.config;
    match values.sandbox_mode.as_deref() {
        Some("danger-full-access") => PermissionLevel::Yolo,
        Some("workspace-write") => match values.approval_policy.as_ref().and_then(Value::as_str) {
            Some("never") => PermissionLevel::Sandboxed,
            // Asking on every untrusted command is more careful than any level that writes.
            Some("untrusted") => PermissionLevel::Readonly,
            // On request, or a granular table of the asks it lets through.
            _ if values.approvals_reviewer.as_deref() == Some("auto_review") => {
                PermissionLevel::Reviewed
            }
            _ => PermissionLevel::Ask,
        },
        // Read-only, and a mode Codex added since, which no level is known to match.
        _ => PermissionLevel::Readonly,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::session::controls::methods::PermissionLevel;

    use super::{ConfigReadReply, compose_starting_level};

    fn layer(kind: &str) -> Value {
        json!({"name": {"type": kind, "file": "/config.toml"}, "version": "1"})
    }

    // Killed by reading a packaged default as set, and by each row of the table mapped to another
    // level.
    #[rstest]
    #[case::nothing_set(json!({}), json!({}), PermissionLevel::Yolo)]
    #[case::only_defaults(
        json!({"sandbox_mode": "read-only"}),
        json!({"sandbox_mode": layer("packagedDefaults")}),
        PermissionLevel::Yolo
    )]
    #[case::read_only(
        json!({"sandbox_mode": "read-only"}),
        json!({"sandbox_mode": layer("user")}),
        PermissionLevel::Readonly
    )]
    #[case::sandboxed(
        json!({"sandbox_mode": "workspace-write", "approval_policy": "never"}),
        json!({"sandbox_mode": layer("project")}),
        PermissionLevel::Sandboxed
    )]
    #[case::reviewed(
        json!({
            "sandbox_mode": "workspace-write",
            "approval_policy": "on-request",
            "approvals_reviewer": "auto_review",
        }),
        json!({"approvals_reviewer": layer("user")}),
        PermissionLevel::Reviewed
    )]
    #[case::ask(
        json!({"sandbox_mode": "workspace-write", "approval_policy": "on-request"}),
        json!({"approval_policy": layer("system")}),
        PermissionLevel::Ask
    )]
    #[case::untrusted_is_more_careful(
        json!({"sandbox_mode": "workspace-write", "approval_policy": "untrusted"}),
        json!({"approval_policy": layer("user")}),
        PermissionLevel::Readonly
    )]
    #[case::full_access(
        json!({"sandbox_mode": "danger-full-access", "approval_policy": "on-request"}),
        json!({"sandbox_mode": layer("user")}),
        PermissionLevel::Yolo
    )]
    fn the_starting_level_follows_codex_s_own_settings(
        #[case] config: Value,
        #[case] origins: Value,
        #[case] level: PermissionLevel,
    ) {
        let read: ConfigReadReply =
            serde_json::from_value(json!({"config": config, "origins": origins}))
                .expect("the reply reads");
        assert_eq!(compose_starting_level(&read), level);
    }
}
