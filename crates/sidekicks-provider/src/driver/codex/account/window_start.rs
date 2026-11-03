//! Codex's smallest turn on an account: one ephemeral `codex exec` of the account's own home on
//! Codex's small model at low effort, in an empty folder of its own, every feature, tool and MCP
//! server off, as the title pass runs its throwaway conversation. It starts the account's closed
//! usage windows; its token count is the turn's spend.

use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use secrecy::SecretString;
use serde::Deserialize;
use serde_json::Value;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::ProviderAccountFolders;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::account::CodexAccountLegs;
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
use crate::driver::contract::account::{
    ProviderObservation, ProviderWindowTurnLegs, TokenLimitsReading, WindowTurnAnswer,
};
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

    /// Out of scope with no turn: a Codex sign-in reads its own limits, and an API key has none
    /// to read.
    fn read_token_limits<'call>(
        &'call self,
        _provider_account_id: &'call ProviderAccountId,
        _folders: &'call ProviderAccountFolders,
        _token: &'call SecretString,
    ) -> BoxFuture<'call, Result<TokenLimitsReading, DriverError>> {
        async {
            Ok(TokenLimitsReading {
                observation: ProviderObservation::OutOfScope,
                spend: None,
            })
        }
        .boxed()
    }
}

// Runs the turn in `folders`' Codex home and no other, and answers its spend, or the refusal of a
// turn Codex reported failed. Fails as the program cannot be resolved, the servers cannot be
// listed, the folder cannot be made, the command fails, or it reports no turn's end.
async fn start_codex_window(
    legs: &CodexAccountLegs,
    provider_account_id: ProviderAccountId,
    folders: ProviderAccountFolders,
) -> Result<WindowTurnAnswer, DriverError> {
    let dependencies = &legs.dependencies;
    let home = CodexServiceHome {
        codex_home: folders.configuration_folder,
        kind: CodexHomeKind::Account(provider_account_id),
    };
    let executable = dependencies.program.resolve(&home).await?;
    let server_names =
        list_mcp_server_names(dependencies, &executable, CODEX_SERVER_LIST_DEADLINE).await?;
    let mut overrides = compose_lockdown_overrides(&server_names);
    overrides.extend([
        (
            MODEL_KEY.to_owned(),
            Value::String(CODEX_SMALL_MODEL.to_owned()),
        ),
        (
            REASONING_EFFORT_KEY.to_owned(),
            Value::String(CODEX_SMALL_MODEL_EFFORT.to_owned()),
        ),
    ]);
    let mut arguments = write_exec_overrides(overrides);
    arguments.extend(CODEX_WINDOW_TURN_ARGUMENTS.map(str::to_owned));
    let folder = tempfile::tempdir().map_err(|error| CodexError::Transport {
        detail: "The folder of Codex's window-start turn could not be made.".to_owned(),
        cause: Some(Box::new(error)),
    })?;
    let mut launch =
        compose_codex_native_launch(&dependencies.data_folder, &executable, arguments).await?;
    launch.working_folder = folder.path().to_owned();
    let printed = run_codex_command(&dependencies.spawner, launch, CODEX_WINDOW_TURN_DEADLINE)
        .await
        .map_err(|error| CodexError::Transport {
            detail: "Codex's window-start turn did not run.".to_owned(),
            cause: Some(Box::new(error)),
        })?;
    read_exec_turn(&printed)
}

// One event line `codex exec --json` writes.
#[derive(Deserialize)]
struct ExecEvent {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    usage: Option<ExecUsage>,
}

// A turn's counts as `codex exec` writes them, its input holding the cached input.
#[derive(Deserialize)]
#[expect(
    clippy::struct_field_names,
    reason = "each count is named as Codex names it"
)]
struct ExecUsage {
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    cache_write_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    reasoning_output_tokens: Option<u64>,
}

impl From<ExecUsage> for UsageAxisCounts {
    // Codex totals a turn as its input and output, the cache inside the input.
    fn from(usage: ExecUsage) -> Self {
        Self {
            input: usage.input_tokens,
            cached_input: usage.cached_input_tokens,
            cache_write_input: usage.cache_write_input_tokens,
            output: usage.output_tokens,
            reasoning_output: usage.reasoning_output_tokens,
            total: usage
                .input_tokens
                .zip(usage.output_tokens)
                .and_then(|(input, output)| input.checked_add(output)),
        }
    }
}

// The turn's end in what `codex exec --json` printed: `turn.completed`'s counts as the spend, or
// `turn.failed` as a refusal. A line that is no event is passed over. Fails when it printed no
// turn's end, or counts past the wire's range.
fn read_exec_turn(printed: &str) -> Result<WindowTurnAnswer, DriverError> {
    for line in printed.lines() {
        let Ok(event) = serde_json::from_str::<ExecEvent>(line) else {
            continue;
        };
        match event.event_type.as_str() {
            "turn.completed" => {
                let model_id = FreeFormText::new(CODEX_SMALL_MODEL.to_owned()).ok();
                let counts = event.usage.map(UsageAxisCounts::from).unwrap_or_default();
                return compose_one_turn_spend(DESCRIPTOR.provider_id(), model_id, counts)
                    .map(WindowTurnAnswer::Spent)
                    .ok_or_else(|| {
                        DriverError::Internal(
                            "Codex's window-start counts are past the wire's range".into(),
                        )
                    });
            }
            "turn.failed" => return Ok(WindowTurnAnswer::Refused),
            _ => {}
        }
    }
    Err(CodexError::Transport {
        detail: "Codex's window-start turn reported no end.".to_owned(),
        cause: None,
    }
    .into())
}

#[cfg(test)]
mod tests;
