//! Claude Code's smallest turn on an account: one short line to its smallest model with no tool,
//! no command and thinking off, in a throwaway process on the account's own credential store that
//! keeps no conversation. It starts the account's closed usage windows, and on a pasted token,
//! whose scope has no limits read, its `rate_limit_event` is the account's reading.

use futures::FutureExt;
use futures::future::BoxFuture;
use secrecy::SecretString;
use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::sync::mpsc;

use crate::account::read_folder::run_in_read_folder;
use crate::driver::ProviderAccountFolders;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::account::ClaudeAccountLegs;
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::mcp::organization::has_readable_managed_mcp_file;
use crate::driver::claude::rate_limit_windows::{
    ClaudeUsageProbeModels, read_claude_quota_windows,
};
use crate::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::driver::claude::spawn::arguments::CLAUDE_NO_MCP_SERVERS;
use crate::driver::claude::spawn::environment::{ClaudeAccountFolders, ClaudeProcessHome};
use crate::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::driver::claude::spawn::launch::control_only::{
    ClaudeShortProcess, ClaudeShortProcessArrival,
};
use crate::driver::contract::account::{
    ProviderAccountFigures, ProviderObservation, ProviderTokenLimitsLegs, ProviderWindowTurnLegs,
    TokenLimitsReading, WindowTurnAnswer, WindowTurnSpend,
};
use crate::driver::contract::error::DriverError;
use crate::lenient_json::read_lenient;
use crate::usage_delta_accountant::{UsageAxisCounts, compose_one_turn_spend};

/// The smallest turn's command line before its MCP flag and its line: the stream written as frames
/// so its `rate_limit_event` and `result` can be read, no conversation kept, and every MCP tool
/// denied, since `--tools` reaches only the built-in ones and an administrator's MCP file loads its
/// servers whatever the flag.
pub(super) const CLAUDE_WINDOW_TURN_ARGUMENTS: [&str; 14] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "haiku",
    "--tools",
    "",
    "--system-prompt",
    "Reply with ok.",
    "--disallowedTools",
    "mcp__*",
    "--disable-slash-commands",
    "--no-session-persistence",
];

/// The one line the smallest turn sends, given on the command line.
pub(super) const CLAUDE_WINDOW_TURN_LINE: &str = "ok";

/// The variable that turns the turn's thinking off, and its value.
pub(super) const CLAUDE_THINKING_OFF: (&str, &str) = ("MAX_THINKING_TOKENS", "0");

/// The data folder's folder of the smallest turns' own configuration folders, one per turn.
const CLAUDE_WINDOW_TURN_FOLDER: [&str; 2] = ["claude", "window-start"];

impl ProviderWindowTurnLegs for ClaudeAccountLegs {
    fn start_window(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<WindowTurnAnswer, DriverError>> {
        start_claude_window(self, provider_account_id, folders).boxed()
    }
}

impl ProviderTokenLimitsLegs for ClaudeAccountLegs {
    fn read_token_limits<'call>(
        &'call self,
        provider_account_id: &'call ProviderAccountId,
        folders: &'call ProviderAccountFolders,
        token: &'call SecretString,
    ) -> BoxFuture<'call, Result<TokenLimitsReading, DriverError>> {
        read_claude_token_limits(self, provider_account_id, folders, token).boxed()
    }
}

// Sends the smallest turn on `provider_account_id`'s credential store and answers what it spent,
// or the refusal of a turn that ended in an error. Fails as the folder cannot be made, the build
// cannot be resolved, the process cannot start or it ends with no `result`.
async fn start_claude_window(
    legs: &ClaudeAccountLegs,
    provider_account_id: ProviderAccountId,
    folders: ProviderAccountFolders,
) -> Result<WindowTurnAnswer, DriverError> {
    let turn = run_claude_smallest_turn(legs, &provider_account_id, &folders, None).await?;
    match turn.spend()? {
        Some(spend) => Ok(WindowTurnAnswer::Spent(vec![spend])),
        None => Ok(WindowTurnAnswer::Refused),
    }
}

// Reads the limits of `provider_account_id`'s pasted `token` by the smallest turn, the token
// handed on its pipe: the windows its last `rate_limit_event` names, `Unanswered` where it named
// none, beside what the turn spent where it ended without an error. Fails as
// `start_claude_window` does.
async fn read_claude_token_limits(
    legs: &ClaudeAccountLegs,
    provider_account_id: &ProviderAccountId,
    folders: &ProviderAccountFolders,
    token: &SecretString,
) -> Result<TokenLimitsReading, DriverError> {
    let turn =
        run_claude_smallest_turn(legs, provider_account_id, folders, Some(token.clone())).await?;
    // A pasted token has no limits read, so no read ever named its weekly window's model.
    let probe_models = ClaudeUsageProbeModels::default();
    let windows = turn
        .rate_limit_events
        .iter()
        .rev()
        .map(|members| read_claude_quota_windows(members, &probe_models, provider_account_id))
        .find(|windows| !windows.is_empty());
    Ok(TokenLimitsReading {
        observation: match windows {
            Some(windows) => ProviderObservation::Figures(ProviderAccountFigures {
                windows,
                ..ProviderAccountFigures::default()
            }),
            None => ProviderObservation::Unanswered,
        },
        spend: turn.spend()?,
    })
}

// What the smallest turn wrote: the model its start named, each `rate_limit_event`'s members, and
// its lead `result`.
struct SmallestTurn {
    model_id: Option<String>,
    rate_limit_events: Vec<Map<String, Value>>,
    is_error: bool,
    usage: Option<UsageAxisCounts>,
}

impl SmallestTurn {
    // What the turn spent; `None` for a turn that ended in an error, which counts as no turn.
    fn spend(&self) -> Result<Option<WindowTurnSpend>, DriverError> {
        if self.is_error {
            return Ok(None);
        }
        let model_id = self
            .model_id
            .clone()
            .and_then(|model_id| FreeFormText::new(model_id).ok());
        // Claude Code's `result` names no tier, so the turn is at the standard rates.
        compose_one_turn_spend(
            DESCRIPTOR.provider_id(),
            model_id,
            None,
            self.usage.unwrap_or_default(),
        )
        .map(Some)
        .ok_or_else(|| {
            DriverError::Internal("the smallest turn's counts are past the wire's range".into())
        })
    }
}

// The members of the `system/init` frame the turn reads.
#[derive(Deserialize)]
struct InitFrame {
    #[serde(default)]
    model: Option<String>,
}

// Runs the smallest turn in a configuration folder of its own over the account's store, in the
// daemon's empty folder, under the account's name so the launcher hands a token account its
// token where `token` is `None`.
async fn run_claude_smallest_turn(
    legs: &ClaudeAccountLegs,
    provider_account_id: &ProviderAccountId,
    folders: &ProviderAccountFolders,
    token: Option<SecretString>,
) -> Result<SmallestTurn, DriverError> {
    run_in_read_folder(
        &legs.sources.0.data_folder,
        &CLAUDE_WINDOW_TURN_FOLDER,
        async |folder| {
            let folders = ClaudeAccountFolders::from(folders);
            let mut executable = legs
                .sources
                .resolve_build_on(
                    ClaudeProcessHome::AccountStore {
                        folder,
                        credential_store_folder: &folders.credential_store_folder,
                    },
                    &[],
                )
                .await?;
            executable
                .environment
                .retain(|(name, _)| name != CLAUDE_THINKING_OFF.0);
            executable.environment.push((
                CLAUDE_THINKING_OFF.0.to_owned(),
                CLAUDE_THINKING_OFF.1.to_owned(),
            ));
            let working_folder = legs.launcher.control_only_folder().await?;
            let mut arguments: Vec<String> = CLAUDE_WINDOW_TURN_ARGUMENTS
                .into_iter()
                .map(str::to_owned)
                .collect();
            // An administrator's MCP file makes Claude Code exit at start under the flag; it then
            // loads only the organization's servers.
            if !has_readable_managed_mcp_file(DESCRIPTOR.managed_settings_folder().as_deref()).await
            {
                arguments.push(CLAUDE_NO_MCP_SERVERS.to_owned());
            }
            arguments.push(CLAUDE_WINDOW_TURN_LINE.to_owned());
            let ClaudeShortProcess { process, arrivals } = ClaudeShortProcess::start(
                &legs.launcher,
                &executable,
                arguments,
                working_folder,
                Some(provider_account_id.clone()),
                token,
                false,
            )
            .await?;
            let mut arrivals = arrivals.into_inner();
            // Its input is closed at once, since a line given on the command line beside a piped
            // input waits for the input's end; it then exits after its `result`.
            let ((), turn) = tokio::join!(
                process.stop(CLAUDE_REQUEST_DEADLINE, None),
                read_smallest_turn(&mut arrivals)
            );
            turn
        },
    )
    .await
}

// Reads the lead's frames until the process exits. Fails with `Unanswered` when it wrote no
// `result`.
async fn read_smallest_turn(
    arrivals: &mut mpsc::UnboundedReceiver<ClaudeShortProcessArrival>,
) -> Result<SmallestTurn, DriverError> {
    let mut model_id = None;
    let mut rate_limit_events = Vec::new();
    let mut result = None;
    while let Some(arrival) = arrivals.recv().await {
        let frame = match arrival {
            ClaudeShortProcessArrival::Frame(frame) => frame,
            // A process given its line on the command line asks nothing on its input.
            ClaudeShortProcessArrival::Request(_) => continue,
            ClaudeShortProcessArrival::Exit => break,
        };
        if frame.observation.subagent_id.is_some() {
            continue;
        }
        match ClaudeWireFrameKind::read(&frame.observation.frame_kind) {
            Some(ClaudeWireFrameKind::SystemInit) => {
                model_id = serde_json::from_str::<InitFrame>(&frame.text)
                    .ok()
                    .and_then(|init| init.model)
                    .filter(|model| !model.is_empty());
            }
            Some(ClaudeWireFrameKind::RateLimitEvent) => {
                if let Ok(members) = serde_json::from_str::<Map<String, Value>>(&frame.text) {
                    rate_limit_events.push(members);
                }
            }
            Some(kind) if kind.is_result() => {
                let is_error = serde_json::from_str::<ResultFrame>(&frame.text)
                    .ok()
                    .and_then(|result| result.is_error)
                    == Some(true);
                let usage = frame
                    .observation
                    .cumulative_usage
                    .as_ref()
                    .map(|usage| usage.cumulative);
                result = Some((is_error, usage));
            }
            Some(_) | None => {}
        }
    }
    let (is_error, usage) = result.ok_or_else(|| {
        DriverError::from(ClaudeLaunchError::Unanswered {
            what: "the smallest turn".to_owned(),
        })
    })?;
    Ok(SmallestTurn {
        model_id,
        rate_limit_events,
        is_error,
        usage,
    })
}

// The member of a lead `result` frame that says the turn ended in an error.
#[derive(Deserialize)]
struct ResultFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    is_error: Option<bool>,
}

#[cfg(test)]
mod tests;
