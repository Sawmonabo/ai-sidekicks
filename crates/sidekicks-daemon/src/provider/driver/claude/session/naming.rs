//! A session's name on Claude Code: one asked of Claude Code from the session's first exchange,
//! through `generate_session_title` on its live process, else in a one-turn process that keeps
//! nothing; and the name the session goes by, told to its live process with `rename_session` or,
//! at rest, appended to its conversation file as the entry Claude Code's own rename writes.

use std::time::Duration;

use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::record::Record;
use sidekicks_platforms::PathRules;
use tokio_util::sync::CancellationToken;

use crate::provider::driver::claude::session::conversation_file::conversation_file_of;
use crate::provider::driver::claude::session::conversation_file::title::append_claude_custom_title;
use crate::provider::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionUnavailableReason,
};
use crate::provider::driver::claude::session::establishment::ClaudeSpawnSources;
use crate::provider::driver::claude::session::establishment::context::resolve_claude_spawn_context;
use crate::provider::driver::claude::session::restart::ClaudeEndedConversation;
use crate::provider::driver::claude::session::state::LiveClaudeSession;
use crate::provider::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::provider::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeSessionTitleReply, ClaudeTitleSource,
};
use crate::provider::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::provider::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::provider::driver::claude::spawn::launch::bring_up::ClaudeSessionSpawn;
use crate::provider::driver::claude::spawn::launch::installed_build::ClaudeProcessStarts;
use crate::provider::driver::claude::spawn::launch::one_turn::ClaudeOneTurnRequest;
use crate::provider::driver::claude::spawn::legs::{
    ClaudeSpawnLegServices, ClaudeSpawnLegsRequest, build_claude_spawn_bound_legs,
};
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::session_control::NameSessionParams;
use crate::provider::outbound_text::{OutboundText, OutboundTextOrigin};

/// The model a naming pass runs on when no process of the session is live: the small model
/// Claude Code's own title pass runs on.
const CLAUDE_NAMING_MODEL: &str = "haiku";

/// How long a whole naming pass may run, its title verb and its one-turn pass together: as long
/// as one request to the process may wait.
const CLAUDE_NAMING_DEADLINE: Duration = CLAUDE_REQUEST_DEADLINE;

/// Names the session from its first exchange: Claude Code's title verb on `live` where it answers
/// with a title, else a one-turn pass on `live`'s legs, or, with no live process, on the session's
/// own folder and the home of `rest_account`, the account its stored leg ran on. `None` when both
/// gave no title, `params.cancel` fired, or the pass ran past [`CLAUDE_NAMING_DEADLINE`], where
/// its one-turn process is stopped as a cancel stops it. Fails as the one-turn pass fails.
pub(crate) async fn name_claude_session(
    live: Option<&LiveClaudeSession>,
    starts: &dyn ClaudeProcessStarts,
    sources: &ClaudeSpawnSources,
    rest_account: Option<ProviderAccountId>,
    params: NameSessionParams,
) -> Result<Option<String>, DriverError> {
    let stop = params.cancel.child_token();
    let pass = draw_claude_title(live, starts, sources, rest_account, params, &stop);
    tokio::pin!(pass);
    tokio::select! {
        named = &mut pass => named,
        () = tokio::time::sleep(CLAUDE_NAMING_DEADLINE) => {
            // Awaited on, so the one-turn process ends as a stop ends it.
            stop.cancel();
            pass.await
        }
    }
}

// The title verb on `live`, else the one-turn pass, both ended by `stop`.
async fn draw_claude_title(
    live: Option<&LiveClaudeSession>,
    starts: &dyn ClaudeProcessStarts,
    sources: &ClaudeSpawnSources,
    rest_account: Option<ProviderAccountId>,
    params: NameSessionParams,
    stop: &CancellationToken,
) -> Result<Option<String>, DriverError> {
    let description = compose_naming_description(&params.first_message, &params.first_reply);
    if let Some(live) = live {
        let asked = live
            .channel
            .send_control_request(ClaudeControlRequest::GenerateSessionTitle {
                description: description.clone(),
                persist: false,
            });
        // A build without the verb, a failure or no title takes the one-turn pass.
        let title = tokio::select! {
            () = stop.cancelled() => return Ok(None),
            answer = asked => answer.ok().and_then(|answer| {
                answer
                    .response
                    .and_then(|reply| {
                        serde_json::from_str::<ClaudeSessionTitleReply>(reply.get()).ok()
                    })
                    .and_then(|reply| reply.title)
            }),
        };
        if let Some(title) = title.as_deref().and_then(clean_title) {
            return Ok(Some(title));
        }
    }
    let text = OutboundText {
        text: compose_naming_prompt(&description),
        origin: OutboundTextOrigin::DriverCommand,
    };
    let reply = if let Some(live) = live {
        let legs = super::controls::one_turn_legs(live, None);
        run_naming_turn(
            starts,
            &legs,
            live.admitted_provider_account_id.clone(),
            text,
            stop,
        )
        .await
    } else {
        let legs = compose_naming_legs(sources, params.session_id, rest_account.clone()).await?;
        run_naming_turn(starts, &legs, rest_account, text, stop).await
    };
    match reply {
        Ok(reply) => Ok(clean_title(&reply)),
        Err(ClaudeLaunchError::TurnStopped) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Tells Claude Code the name the session goes by: through `rename_session` on `live`, else, at
/// rest, as a `custom-title` entry in the conversation `ended` wrote. Fails as Claude Code refuses
/// the rename, as the file cannot be found or written, and `NoLiveSession` when the driver knows
/// no conversation of the session.
pub(crate) async fn tell_claude_session_name(
    session_id: SessionId,
    live: Option<&LiveClaudeSession>,
    ended: Option<ClaudeEndedConversation>,
    name: String,
) -> Result<(), DriverError> {
    if let Some(live) = live {
        live.channel
            .send_control_request(ClaudeControlRequest::RenameSession {
                title: name,
                source: ClaudeTitleSource::Host,
                session_id: live.provider_session_id.clone(),
            })
            .await?;
        return Ok(());
    }
    let unknown = || -> DriverError {
        ClaudeSessionError::Unavailable {
            reason: ClaudeSessionUnavailableReason::NoLiveSession,
            detail: Some("The driver knows no conversation of the session to rename.".to_owned()),
            session_id: Some(session_id),
            run_id: None,
        }
        .into()
    };
    let ended = ended.ok_or_else(unknown)?;
    let file = conversation_file_of(&ended.spawn_environment, &ended.provider_session_id)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))?
        .ok_or_else(unknown)?;
    append_claude_custom_title(&file, &ended.provider_session_id, &name)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))
}

/// The conversation `provider_session_id` a session's stored leg names, at rest on
/// `provider_account_id`'s account, where its file is found: the environment that account's
/// process runs in. Fails as the session's folder or stored settings cannot be read.
pub(crate) async fn stored_claude_conversation(
    sources: &ClaudeSpawnSources,
    session_id: SessionId,
    provider_account_id: Option<ProviderAccountId>,
    provider_session_id: String,
) -> Result<ClaudeEndedConversation, DriverError> {
    let legs = compose_naming_legs(sources, session_id, provider_account_id).await?;
    Ok(ClaudeEndedConversation {
        provider_session_id,
        spawn_environment: legs.spawn_environment,
    })
}

// The legs of a naming pass on a session with no live process: its folder and the home of
// `provider_account_id`'s account, the small model, no tools and no level, since the pass's one
// turn asks for nothing.
async fn compose_naming_legs(
    sources: &ClaudeSpawnSources,
    session_id: SessionId,
    provider_account_id: Option<ProviderAccountId>,
) -> Result<ClaudeSpawnBoundLegs, DriverError> {
    let no_rows: ProviderRowValues = Record::default();
    let context = resolve_claude_spawn_context(
        &*sources.spawn_contexts,
        &sources.pool,
        session_id,
        provider_account_id.clone(),
        &no_rows,
    )
    .await
    .map_err(|error| DriverError::Internal(Box::new(error)))?;
    build_claude_spawn_bound_legs(
        ClaudeSpawnLegsRequest {
            session_id,
            model: CLAUDE_NAMING_MODEL.to_owned(),
            execution_posture: None,
            subagent_policy: None,
            tool_servers: None,
            output_schema: None,
            on_mcp_server_status: None,
            provider_account_id,
            context,
        },
        &ClaudeSpawnLegServices::of(sources),
    )
    .await
    .map_err(|error| DriverError::Internal(Box::new(error)))
}

// One unkept turn from an empty conversation that answers with a title.
async fn run_naming_turn(
    starts: &dyn ClaudeProcessStarts,
    legs: &ClaudeSpawnBoundLegs,
    provider_account_id: Option<ProviderAccountId>,
    text: OutboundText,
    stop: &CancellationToken,
) -> Result<String, ClaudeLaunchError> {
    // A pass stopped while its legs were composed starts no process.
    if stop.is_cancelled() {
        return Err(ClaudeLaunchError::TurnStopped);
    }
    starts
        .run_one_turn(ClaudeOneTurnRequest {
            spawn: ClaudeSessionSpawn {
                legs,
                provider_account_id,
                session_rules: &[],
                step_bound: None,
                in_process_servers: None,
                path_rules: PathRules::NATIVE,
            },
            resume_handle: None,
            permission_mode: None,
            text,
            stop: stop.clone(),
        })
        .await
        .map(|reply| reply.text)
}

// What the session is about, as its first exchange shows it.
fn compose_naming_description(first_message: &str, first_reply: &str) -> String {
    format!("The person wrote:\n{first_message}\n\nThe reply began:\n{first_reply}")
}

// The one-turn pass's message.
fn compose_naming_prompt(description: &str) -> String {
    format!(
        "Write a title of a few words for the conversation that began with this exchange. \
         Answer with the title alone, with no quotes and no other words.\n\n{description}"
    )
}

// The title's first non-blank line, its surrounding quotes and spaces taken off; `None` when
// nothing is left.
fn clean_title(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    let title = line
        .trim_matches(|character: char| matches!(character, '"' | '\'' | '`' | '“' | '”'))
        .trim();
    (!title.is_empty()).then(|| title.to_owned())
}

#[cfg(test)]
mod tests;
