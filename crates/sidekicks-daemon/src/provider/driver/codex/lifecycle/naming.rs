//! A Codex session's name: drawn from its first exchange in one short pass of Codex's own, on a
//! throwaway, read-only conversation of the session's service where its conversation is live, else
//! in a one-shot `codex exec`; and told to Codex with `thread/name/set`, so its own session list
//! shows it. A conversation the person's own terminal already named keeps that name.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::mpsc;

use super::CodexDriver;
use crate::provider::driver::codex::app_server_protocol::{
    AskForApproval, SandboxMode, ThreadReadParams, ThreadSetNameParams, ThreadStartParams,
};
use crate::provider::driver::codex::attachments::compose_codex_text_input;
use crate::provider::driver::codex::event_normalizer::{
    CODEX_ITEM_COMPLETED_METHOD, CODEX_TURN_COMPLETED_METHOD,
};
use crate::provider::driver::codex::service::command::run_codex_command;
use crate::provider::driver::codex::service::home::CodexServiceKind;
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::service::supervisor::start::compose_codex_native_launch;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::thread::settings::CodexTurnStartParams;
use crate::provider::driver::codex::thread::view::read_thread;
use crate::provider::driver::codex::transport::connection::{
    CodexConnectionEvents, CodexForgottenRequest, read_codex_object,
};
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::session_control::NameSessionParams;

const THREAD_START_METHOD: &str = "thread/start";

const THREAD_READ_METHOD: &str = "thread/read";

const THREAD_NAME_SET_METHOD: &str = "thread/name/set";

const TURN_START_METHOD: &str = "turn/start";

/// The item type of the pass's reply.
const CODEX_AGENT_MESSAGE_ITEM_TYPE: &str = "agentMessage";

/// The file the one-shot pass reads its answer's schema from, in its own empty folder.
const TITLE_SCHEMA_FILE_NAME: &str = "title-schema.json";

/// The file the one-shot pass writes its last answer to, beside the schema.
const TITLE_ANSWER_FILE_NAME: &str = "title.json";

/// How long either pass may take: a short answer on a small model of the account's own.
const CODEX_NAMING_DEADLINE: Duration = Duration::from_secs(90);

/// The words the pass names the session by.
const TITLE_INSTRUCTIONS: &str = "Name this coding session from its first exchange below, in at \
                                  most six words, as a title would read. Answer with the title \
                                  alone.";

impl CodexDriver {
    /// The session's name from its first exchange: on the session's live service, a name the
    /// person's own terminal gave its conversation first, else a pass there; with no live leg, a
    /// failed pass or no name, a one-shot pass of Codex's program. `None` when both gave no name,
    /// or once `cancel` fired. Fails only as the one-shot pass's launch cannot be composed.
    pub(crate) async fn name_session(
        &self,
        params: NameSessionParams,
    ) -> Result<Option<String>, DriverError> {
        let cancel = params.cancel.clone();
        let prompt = compose_title_prompt(&params);
        let named = async {
            // The one-shot pass runs on the live session's own account, else on the person's own.
            let service = match self.views.conversation(params.session_id) {
                Some((service, thread_id)) => {
                    match name_on_service(&service, &thread_id, &prompt).await {
                        Ok(Some(name)) => return Ok(Some(name)),
                        Ok(None) => {}
                        Err(error) => tracing::info!(
                            error = &error as &(dyn std::error::Error + 'static),
                            session_id = %params.session_id,
                            "a codex session's name could not be drawn on its service"
                        ),
                    }
                    service
                }
                None => self.registry.service_for(None).await?,
            };
            Ok(name_in_one_shot(&service, &prompt).await?)
        };
        tokio::select! {
            () = cancel.cancelled() => Ok(None),
            named = named => named,
        }
    }

    /// Tells Codex the name the session goes by on its live conversation. Fails as Codex refuses
    /// it, an archived conversation among them, and with `CodexError::Transport` for a session
    /// with no live conversation, whose handle the call does not carry.
    pub(crate) async fn tell_session_name(
        &self,
        session_id: SessionId,
        name: String,
    ) -> Result<(), DriverError> {
        let Some((service, thread_id)) = self.views.conversation(session_id) else {
            return Err(CodexError::Transport {
                detail: format!("No live Codex session for \"{session_id}\" to rename."),
                cause: None,
            }
            .into());
        };
        service
            .connection()?
            .request(
                THREAD_NAME_SET_METHOD,
                &ThreadSetNameParams { name, thread_id },
            )
            .await?;
        Ok(())
    }
}

// The person's first message and the reply, under the naming instructions.
fn compose_title_prompt(params: &NameSessionParams) -> String {
    format!(
        "{TITLE_INSTRUCTIONS}\n\nThe person's message:\n{}\n\nThe reply:\n{}",
        params.first_message, params.first_reply
    )
}

// The schema the pass's answer meets: one title.
fn title_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "title": { "type": "string" } },
        "required": ["title"],
        "additionalProperties": false,
    })
}

#[derive(Deserialize)]
struct TitleAnswer {
    title: String,
}

// The title an answer holds, trimmed; `None` for one that holds none.
fn read_title(answer: &str) -> Option<String> {
    let title = serde_json::from_str::<TitleAnswer>(answer.trim())
        .ok()?
        .title;
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_owned())
}

// The name the person's own terminal gave a joined service's conversation, else one drawn on a
// throwaway conversation of `service` over a connection of its own.
async fn name_on_service(
    service: &CodexService,
    thread_id: &str,
    prompt: &str,
) -> Result<Option<String>, CodexError> {
    let (sender, mut frames) = mpsc::unbounded_channel();
    let connection = service
        .open_detached_connection(Arc::new(TitleConnectionEvents { frames: sender }))
        .await?;
    if service.kind() == CodexServiceKind::Joined {
        let reply = connection
            .request(
                THREAD_READ_METHOD,
                &ThreadReadParams {
                    thread_id: thread_id.to_owned(),
                    include_turns: Some(false),
                },
            )
            .await?;
        let given = read_codex_object::<ThreadReadReply>(reply.get())
            .and_then(|reply| reply.thread?.name)
            .filter(|name| !name.trim().is_empty());
        if given.is_some() {
            return Ok(given);
        }
    }
    let reply = connection
        .request(
            THREAD_START_METHOD,
            &ThreadStartParams {
                ephemeral: Some(true),
                sandbox: Some(SandboxMode::ReadOnly),
                approval_policy: Some(AskForApproval::Never),
                ..ThreadStartParams::default()
            },
        )
        .await?;
    let title_thread_id = read_thread(&reply, THREAD_START_METHOD)?.id;
    connection
        .request(
            TURN_START_METHOD,
            &CodexTurnStartParams {
                thread_id: title_thread_id.clone(),
                input: vec![compose_codex_text_input(prompt.to_owned())],
                approvals_reviewer: None,
                collaboration_mode: None,
                model: None,
                client_user_message_id: None,
                output_schema: Some(title_schema()),
                service_tier: None,
                service_tier_for_turn: None,
            },
        )
        .await?;
    let answered = tokio::time::timeout(CODEX_NAMING_DEADLINE, async {
        let mut answer = None;
        while let Some((method, params)) = frames.recv().await {
            let Some(frame) = read_codex_object::<TitleFrame>(params.get()) else {
                continue;
            };
            if frame.thread_id.as_deref() != Some(title_thread_id.as_str()) {
                continue;
            }
            match method.as_str() {
                CODEX_ITEM_COMPLETED_METHOD => {
                    if let Some(text) = frame
                        .item
                        .filter(|item| {
                            item.item_type.as_deref() == Some(CODEX_AGENT_MESSAGE_ITEM_TYPE)
                        })
                        .and_then(|item| item.text)
                    {
                        answer = Some(text);
                    }
                }
                CODEX_TURN_COMPLETED_METHOD => break,
                _ => {}
            }
        }
        answer
    })
    .await
    .ok()
    .flatten();
    // The throwaway conversation is ephemeral, so it ends with the connection, dropped here.
    Ok(answered.as_deref().and_then(read_title))
}

// One `codex exec` of the account's home, ephemeral and in an empty folder of its own, its answer
// held to the title's schema.
async fn name_in_one_shot(
    service: &CodexService,
    prompt: &str,
) -> Result<Option<String>, CodexError> {
    let folder = tempfile::tempdir().map_err(|error| CodexError::Transport {
        detail: "The folder of Codex's naming pass could not be made.".to_owned(),
        cause: Some(Box::new(error)),
    })?;
    let schema_file = folder.path().join(TITLE_SCHEMA_FILE_NAME);
    let answer_file = folder.path().join(TITLE_ANSWER_FILE_NAME);
    tokio::fs::write(&schema_file, title_schema().to_string())
        .await
        .map_err(|error| CodexError::Transport {
            detail: "The schema of Codex's naming pass could not be written.".to_owned(),
            cause: Some(Box::new(error)),
        })?;
    let dependencies = service.dependencies();
    let executable = dependencies
        .program
        .resolve(service.home())
        .await
        .map_err(CodexError::Driver)?;
    let mut launch = compose_codex_native_launch(
        &dependencies.data_folder,
        &executable,
        vec![
            "exec".to_owned(),
            "--ephemeral".to_owned(),
            "--skip-git-repo-check".to_owned(),
            "--sandbox".to_owned(),
            "read-only".to_owned(),
            "--output-schema".to_owned(),
            schema_file.to_string_lossy().into_owned(),
            "--output-last-message".to_owned(),
            answer_file.to_string_lossy().into_owned(),
            prompt.to_owned(),
        ],
    )
    .await?;
    launch.working_folder = folder.path().to_owned();
    // The answer is read from its file, since the pass prints more than the answer.
    match run_codex_command(&dependencies.spawner, launch, CODEX_NAMING_DEADLINE).await {
        Ok(_printed) => match tokio::fs::read_to_string(&answer_file).await {
            Ok(answer) => Ok(read_title(&answer)),
            Err(error) => {
                tracing::info!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "codex's one-shot naming pass wrote no answer"
                );
                Ok(None)
            }
        },
        Err(error) => {
            tracing::info!(
                error = &error as &(dyn std::error::Error + 'static),
                "codex's one-shot naming pass gave no name"
            );
            Ok(None)
        }
    }
}

// The members of a title conversation's frame the pass reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleFrame {
    thread_id: Option<String>,
    item: Option<TitleItem>,
}

#[derive(Deserialize)]
struct TitleItem {
    #[serde(rename = "type")]
    item_type: Option<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
struct ThreadReadReply {
    thread: Option<ReadThread>,
}

#[derive(Deserialize)]
struct ReadThread {
    name: Option<String>,
}

// A title connection's notifications, handed to its pass in arrival order.
struct TitleConnectionEvents {
    frames: mpsc::UnboundedSender<(String, Box<RawValue>)>,
}

impl CodexConnectionEvents for TitleConnectionEvents {
    // A pass that already ended has no use for a late frame.
    fn notification(&self, method: &str, params: Box<RawValue>) {
        let _unread = self.frames.send((method.to_owned(), params));
    }

    // A drop ends the pass's requests and its wait for the answer.
    fn dropped(&self, _reason: &str) {}

    // The pass's conversation asks for nothing.
    fn held_requests_dropped(&self, _dropped: Vec<CodexForgottenRequest>) {}

    // The pass's request fails with Codex's own words.
    fn service_draining(&self, _message: &str) {}
}
