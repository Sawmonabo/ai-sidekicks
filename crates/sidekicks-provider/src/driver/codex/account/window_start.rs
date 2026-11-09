//! Codex's smallest turn on an account: one ephemeral `codex exec` of the account's own home on
//! Codex's small model at low effort, in an empty folder of its own, every feature, tool and MCP
//! server off, as the title pass runs its throwaway conversation. It starts the account's closed
//! usage windows; its spend is each request its export to the daemon stated, at that request's
//! own model and tier, or, where it exported none, its printed token count.

use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::Value;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};

use crate::driver::ProviderAccountFolders;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::exec_turn::{ExecTurnEnd, read_exec_turn};
use crate::driver::codex::lifecycle::naming::lockdown::{
    compose_lockdown_overrides, write_exec_overrides,
};
use crate::driver::codex::lifecycle::naming::{
    CODEX_SERVER_LIST_DEADLINE, CODEX_SMALL_MODEL, CODEX_SMALL_MODEL_EFFORT, MODEL_KEY,
    REASONING_EFFORT_KEY, list_mcp_server_names,
};
use crate::driver::codex::service::command::run_codex_command;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::supervisor::start::compose_codex_native_launch;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::telemetry::exec_export::{CodexExecExport, compose_exec_telemetry};
use crate::driver::contract::account::{ProviderWindowTurnLegs, WindowTurnAnswer, WindowTurnSpend};
use crate::driver::contract::error::DriverError;
use crate::usage_delta_accountant::{UsageAxisCounts, compose_one_turn_spend};

/// The one line the turn sends.
const CODEX_WINDOW_TURN_LINE: &str = "ok";

/// The `exec` arguments after the config overrides: nothing kept, no repository needed, read-only,
/// the events written as lines, and the one line.
pub(super) const CODEX_WINDOW_TURN_ARGUMENTS: [&str; 7] = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    CODEX_WINDOW_TURN_LINE,
];

/// How long the turn may run before it is ended, no shorter than the observer's own bound on it,
/// which ends it first by dropping its wait.
const CODEX_WINDOW_TURN_DEADLINE: Duration = Duration::from_mins(2);

impl ProviderWindowTurnLegs for CodexAccountLegs {
    fn start_window(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<WindowTurnAnswer, DriverError>> {
        start_codex_window(self, provider_account_id, folders).boxed()
    }
}

// Runs the turn in `folders`' Codex home and no other, and answers its spend, or the refusal of a
// turn Codex reported failed. Any response its export to the daemon stated is its spend whatever
// its exit; with none stated, its printed end decides, since a clean exit flushed every record
// that reached the daemon and nothing it prints is counted twice. Fails as the program cannot be
// resolved, the servers cannot be listed, the folder cannot be made, the token cannot be minted,
// the command fails having exported nothing, or it reports no turn's end.
async fn start_codex_window(
    legs: &CodexAccountLegs,
    provider_account_id: ProviderAccountId,
    folders: ProviderAccountFolders,
) -> Result<WindowTurnAnswer, DriverError> {
    let dependencies = &legs.dependencies;
    let home = CodexServiceHome {
        codex_home: folders.configuration_folder,
        kind: CodexHomeKind::Account(provider_account_id.clone()),
    };
    let executable = dependencies.program.resolve(&home).await?;
    let server_names = list_mcp_server_names(
        dependencies,
        &executable,
        &home.kind,
        CODEX_SERVER_LIST_DEADLINE,
    )
    .await?;
    let mut overrides = compose_lockdown_overrides(&server_names);
    let small_model = [
        (MODEL_KEY, CODEX_SMALL_MODEL),
        (REASONING_EFFORT_KEY, CODEX_SMALL_MODEL_EFFORT),
    ];
    overrides
        .extend(small_model.map(|(key, value)| (key.to_owned(), Value::String(value.to_owned()))));
    let telemetry = compose_exec_telemetry(
        &dependencies.exports,
        &home.kind,
        dependencies.telemetry_target.port().map(Arc::as_ref),
        &provider_account_id,
    )
    .map_err(|error| CodexError::Transport {
        detail: "The telemetry token of Codex's window-start turn could not be minted.".to_owned(),
        cause: Some(Box::new(error)),
    })?;
    let mut arguments = telemetry.exec_switches(&home.kind);
    arguments.extend(write_exec_overrides(overrides));
    arguments.extend(CODEX_WINDOW_TURN_ARGUMENTS.map(str::to_owned));
    let folder = tempfile::tempdir().map_err(|error| CodexError::Transport {
        detail: "The folder of Codex's window-start turn could not be made.".to_owned(),
        cause: Some(Box::new(error)),
    })?;
    let mut launch = compose_codex_native_launch(&dependencies.data_folder, &executable, arguments)
        .await?
        .launch;
    launch.working_folder = folder.path().to_owned();
    let export = telemetry.launched(&mut launch.environment);
    let ran = run_codex_command(&dependencies.spawner, launch, CODEX_WINDOW_TURN_DEADLINE).await;
    let exported = export
        .as_ref()
        .map(CodexExecExport::take)
        .unwrap_or_default();
    if !exported.is_empty() {
        return exported
            .iter()
            .map(|response| {
                compose_spend(
                    Some(response.model_id.clone()),
                    response.service_tier.clone(),
                    response.counts,
                )
            })
            .collect::<Result<Vec<_>, _>>()
            .map(WindowTurnAnswer::Spent);
    }
    let printed = ran.map_err(|error| CodexError::Transport {
        detail: "Codex's window-start turn did not run.".to_owned(),
        cause: Some(Box::new(error)),
    })?;
    match read_exec_turn(&printed) {
        // No event states the tier, so the turn is at the standard one.
        Some(ExecTurnEnd::Completed { counts, .. }) => {
            let model_id = FreeFormText::new(CODEX_SMALL_MODEL.to_owned()).ok();
            compose_spend(model_id, None, counts).map(|spend| WindowTurnAnswer::Spent(vec![spend]))
        }
        Some(ExecTurnEnd::Failed) => Ok(WindowTurnAnswer::Refused),
        None => Err(CodexError::Transport {
            detail: "Codex's window-start turn reported no end.".to_owned(),
            cause: None,
        }
        .into()),
    }
}

// One request's spend of `counts` on `model_id` at `speed`. Fails where a count is past the
// wire's range.
fn compose_spend(
    model_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    speed: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
    counts: UsageAxisCounts,
) -> Result<WindowTurnSpend, DriverError> {
    let past_range = "Codex's window-start counts are past the wire's range";
    compose_one_turn_spend(DESCRIPTOR.provider_id(), model_id, speed, counts)
        .ok_or_else(|| DriverError::Internal(past_range.into()))
}

#[cfg(test)]
mod tests;
