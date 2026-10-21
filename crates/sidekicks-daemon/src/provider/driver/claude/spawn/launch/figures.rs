//! The figures a session's creation reads from one process that keeps nothing, started in the
//! session's own folder on its model: what `/output-style` and `/advisor` print typed with no
//! argument, the reply reserve, and the context window of the session's model and of each catalog
//! model not read yet. A figure Claude Code refuses is absent, never guessed.

use std::collections::{BTreeMap, HashSet};

use serde::Deserialize;
use serde_json::Value;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use tokio::time::Instant;

use crate::provider::driver::claude::session::errors::ClaudeSessionError;
use crate::provider::driver::claude::session::reply_reserve::{
    CLAUDE_AUTO_COMPACT_WINDOW_KEY, CLAUDE_MAX_OUTPUT_TOKENS_KEY,
    CLAUDE_RESERVE_READ_MAXIMUM_OUTPUT_TOKENS, CLAUDE_RESERVE_READ_WINDOW_TOKENS,
};
use crate::provider::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::provider::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::provider::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeFlagSettings,
};
use crate::provider::driver::claude::session::transport::declarations::ClaudeOfferedModel;
use crate::provider::driver::claude::session::transport::readings::{
    ClaudeCreationFiguresReading, ClaudeLocalCommandReply, ClaudeModelContextRead,
    ClaudeReplyReserveReads, ClaudeSessionFolderReadRequest,
};
use crate::provider::driver::claude::session::transport::user_message::{
    ClaudeWriteAttempt, compose_claude_user_frame,
};
use crate::provider::driver::claude::spawn::launch::control_only::{
    ClaudeShortProcess, ClaudeShortProcessArrival,
};
use crate::provider::driver::claude::spawn::launch::initialize_reply::{
    read_claude_initialize_declaration, read_claude_listed_commands,
};
use crate::provider::driver::claude::spawn::launch::{ClaudeLaunchError, ClaudeProcessLauncher};
use crate::provider::driver::claude::turn_evidence::classify_claude_turn_evidence;
use crate::provider::outbound_text::{OutboundText, OutboundTextOrigin};
use crate::provider::spawned_version::ResolvedProviderExecutable;

/// Reads a session's creation figures from one process that keeps nothing, in `place`'s folder on
/// its model, skipping the context reads of `read_models`. Fails as the start or a request does,
/// or when a command runs a model turn or goes unanswered.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's session creation reads its figures through it"
    )
)]
pub(crate) async fn read_claude_creation_figures(
    launcher: &ClaudeProcessLauncher,
    executable: &ResolvedProviderExecutable,
    place: &ClaudeSessionFolderReadRequest,
    read_models: HashSet<String>,
) -> Result<ClaudeCreationFiguresReading, ClaudeLaunchError> {
    let short = ClaudeShortProcess::start_control_only(
        launcher,
        executable,
        Some(place.working_directory.clone()),
        Some(&place.model),
    )
    .await?;
    let read = async {
        let initialize = short.initialize().await?;
        let listed = read_claude_listed_commands(initialize.as_deref());
        // One at a time: each command is answered by its own `result`.
        let output_style = print_local_command(&short, "output-style", &listed).await?;
        let advisor = print_local_command(&short, "advisor", &listed).await?;
        let declaration = read_claude_initialize_declaration(initialize.as_deref());
        let reply_reserve_reads = read_reply_reserve(&short).await?;
        Ok::<_, ClaudeLaunchError>(ClaudeCreationFiguresReading {
            output_style_names: declaration.output_styles,
            output_style,
            advisor,
            reply_reserve_reads,
            // Last, once both reserve keys are removed, so each read reports the model's own
            // window.
            context_reads: read_context_windows(
                &short,
                &place.model,
                read_models,
                &declaration.models,
            )
            .await?,
        })
    }
    .await;
    short.close().await;
    read
}

/// Reads the reply reserve of `place`'s model from its own process that keeps nothing. Fails as
/// the start or `initialize` does; a refusal on the way is the answer.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's model figures read the reply reserve through it"
    )
)]
pub(crate) async fn read_claude_reply_reserve(
    launcher: &ClaudeProcessLauncher,
    executable: &ResolvedProviderExecutable,
    place: &ClaudeSessionFolderReadRequest,
) -> Result<ClaudeReplyReserveReads, ClaudeLaunchError> {
    let short = ClaudeShortProcess::start_control_only(
        launcher,
        executable,
        Some(place.working_directory.clone()),
        Some(&place.model),
    )
    .await?;
    let read = async {
        short.initialize().await?;
        read_reply_reserve(&short).await
    }
    .await;
    short.close().await;
    Ok(read?)
}

// Two context reads on the window key's window, the second with the maximum reply key added, and
// both keys removed after, so nothing the process does later is capped. A refusal is the answer.
async fn read_reply_reserve(
    short: &ClaudeShortProcess,
) -> Result<ClaudeReplyReserveReads, ClaudeSessionError> {
    let window = CLAUDE_RESERVE_READ_WINDOW_TOKENS.to_string();
    let maximum_output = CLAUDE_RESERVE_READ_MAXIMUM_OUTPUT_TOKENS.to_string();
    let environment = |pairs: &[(&str, &str)]| ClaudeControlRequest::ApplyFlagSettings {
        settings: ClaudeFlagSettings {
            env: Some(
                pairs
                    .iter()
                    .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                    .collect::<BTreeMap<_, _>>(),
            ),
            ..ClaudeFlagSettings::default()
        },
    };
    let steps = [
        environment(&[(CLAUDE_AUTO_COMPACT_WINDOW_KEY, &window)]),
        ClaudeControlRequest::GetContextUsage {},
        environment(&[
            (CLAUDE_AUTO_COMPACT_WINDOW_KEY, &window),
            (CLAUDE_MAX_OUTPUT_TOKENS_KEY, &maximum_output),
        ]),
        ClaudeControlRequest::GetContextUsage {},
        environment(&[
            (CLAUDE_AUTO_COMPACT_WINDOW_KEY, ""),
            (CLAUDE_MAX_OUTPUT_TOKENS_KEY, ""),
        ]),
    ];
    let mut reports = Vec::with_capacity(2);
    for step in steps {
        let is_usage_read = matches!(step, ClaudeControlRequest::GetContextUsage {});
        match short.process.send_control_request(step).await {
            Ok(answer) if is_usage_read => reports.push(answer.response),
            Ok(_) => {}
            Err(ClaudeSessionError::ControlRequestRefused {
                subtype,
                provider_error,
            }) => {
                return Ok(ClaudeReplyReserveReads::Refused {
                    detail: format!("{}: {provider_error}", subtype.as_str()),
                });
            }
            Err(error) => return Err(error),
        }
    }
    let mut reports = reports.into_iter();
    Ok(ClaudeReplyReserveReads::Read {
        window_only: reports.next().flatten(),
        with_maximum_output: reports.next().flatten(),
    })
}

// The members of a context-usage reply the window reads name the model by.
#[derive(Deserialize)]
struct ContextUsageModel {
    #[serde(default)]
    model: Option<Value>,
}

// The context read of the process's own model, then of each catalog model by its full id, never
// an alias, each moved to with `set_model`, which costs Claude Code's one-token model check; a
// refused move or read keeps no window.
async fn read_context_windows(
    short: &ClaudeShortProcess,
    model: &str,
    mut read_models: HashSet<String>,
    offered_models: &[ClaudeOfferedModel],
) -> Result<Vec<ClaudeModelContextRead>, ClaudeSessionError> {
    let mut reads = Vec::new();
    if !read_models.contains(model) {
        let usage = short.read_context_usage().await?;
        let reported_model = usage
            .as_deref()
            .and_then(|usage| serde_json::from_str::<ContextUsageModel>(usage.get()).ok())
            .and_then(|usage| usage.model)
            .and_then(|model| {
                model
                    .as_str()
                    .filter(|model| !model.is_empty())
                    .map(str::to_owned)
            });
        read_models.insert(reported_model.unwrap_or_else(|| model.to_owned()));
        reads.push(ClaudeModelContextRead {
            requested_model: Some(model.to_owned()),
            usage,
        });
    }
    for resolved_model in offered_models
        .iter()
        .filter_map(|offered| offered.resolved_model.as_deref())
    {
        if !read_models.insert(resolved_model.to_owned()) {
            continue;
        }
        let moved = short
            .process
            .send_control_request(ClaudeControlRequest::SetModel {
                model: resolved_model.to_owned(),
            })
            .await;
        let usage = match moved {
            Ok(_) => short.read_context_usage().await?,
            Err(ClaudeSessionError::ControlRequestRefused { .. }) => None,
            Err(error) => return Err(error),
        };
        reads.push(ClaudeModelContextRead {
            requested_model: Some(resolved_model.to_owned()),
            usage,
        });
    }
    Ok(reads)
}

// The members of a frame a command's reply is read from.
#[derive(Deserialize)]
struct CommandReplyFrame {
    #[serde(default)]
    local_command_outcome: Option<Value>,
}

// Sends `/<command>` for Claude Code to run, unmarked so it runs, and answers the text of its
// `result` with the outcome Claude Code stamped on its reply. A reply showing a model turn is
// refused, since its text is the model's.
async fn print_local_command(
    short: &ClaudeShortProcess,
    command: &'static str,
    listed: &HashSet<String>,
) -> Result<ClaudeLocalCommandReply, ClaudeLaunchError> {
    let frame = compose_claude_user_frame(
        &OutboundText {
            text: format!("/{command}"),
            origin: OutboundTextOrigin::DriverCommand,
        },
        mint_uuid_v7().to_string(),
        Vec::new(),
    );
    let mut arrivals = short.arrivals.lock().await;
    // Written beside the wait, so an exit while the text is still being written is read too.
    let (written, answered) = tokio::join!(
        short.process.write_user_frame(frame),
        read_command_reply(&mut arrivals, command)
    );
    if let ClaudeWriteAttempt::Failed { cause, .. } = written {
        return Err(ClaudeSessionError::InputUnwritable(cause).into());
    }
    let (result, outcome) = answered?;
    if !classify_claude_turn_evidence(&result)
        .observations
        .is_empty()
    {
        return Err(ClaudeLaunchError::CommandRanTurn { command });
    }
    Ok(ClaudeLocalCommandReply {
        is_listed: listed.contains(command),
        text: result
            .get("result")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned),
        outcome,
    })
}

// Waits for the command's `result` within the request deadline, keeping the last outcome stamped
// on a frame before it.
async fn read_command_reply(
    arrivals: &mut tokio::sync::mpsc::UnboundedReceiver<ClaudeShortProcessArrival>,
    command: &'static str,
) -> Result<(Value, Option<String>), ClaudeLaunchError> {
    let unanswered = || ClaudeLaunchError::Unanswered {
        what: format!("/{command}"),
    };
    let deadline = Instant::now() + CLAUDE_REQUEST_DEADLINE;
    let mut outcome = None;
    loop {
        let arrival = tokio::time::timeout_at(deadline, arrivals.recv())
            .await
            .map_err(|_elapsed| unanswered())?;
        let frame = match arrival {
            Some(ClaudeShortProcessArrival::Frame(frame)) => frame,
            Some(ClaudeShortProcessArrival::Request(_)) => continue,
            Some(ClaudeShortProcessArrival::Exit) | None => return Err(unanswered()),
        };
        let stamped = serde_json::from_str::<CommandReplyFrame>(&frame.text)
            .ok()
            .and_then(|read| read.local_command_outcome)
            .and_then(|stamp| stamp.get("kind").and_then(Value::as_str).map(str::to_owned))
            .filter(|kind| !kind.is_empty());
        outcome = stamped.or(outcome);
        if frame.observation.frame_kind.split('/').next() == Some("result")
            && frame.observation.subagent_id.is_none()
        {
            let result = serde_json::from_str(&frame.text).unwrap_or(Value::Null);
            return Ok((result, outcome));
        }
    }
}
