//! The one-shot naming pass: one ephemeral `codex exec` of the account's home in an empty folder
//! of its own, locked down as the title conversation is, its answer read from a file and its
//! printed turn's counts filed as the session's own.

use serde_json::Value;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{
    CODEX_SERVER_LIST_DEADLINE, MODEL_KEY, REASONING_EFFORT_KEY, choose_title_model,
    list_mcp_server_names, lockdown, make_pass_folder, read_title, title_schema,
};
use crate::driver::codex::exec_turn::{ExecTurnEnd, read_exec_turn};
use crate::driver::codex::service::command::{CodexCommandError, run_codex_command};
use crate::driver::codex::service::registry::home_exec_switches;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::start::{
    CodexNativeLaunch, compose_codex_native_launch,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::side_questions::copy_turn::{CopyTurnMeter, SessionUsageFiling};

/// The file the one-shot pass reads its answer's schema from, in its own empty folder.
const TITLE_SCHEMA_FILE_NAME: &str = "title-schema.json";

/// The file the one-shot pass writes its last answer to, beside the schema.
const TITLE_ANSWER_FILE_NAME: &str = "title.json";

// One `codex exec` of the account's home, ephemeral and in an empty folder of its own, under the
// title conversation's config with each MCP server the home lists disabled, its answer held to the
// title's schema, all within `deadline`; the counts of its turn, which it prints, filed through
// `filing` before its answer is read, so a pass that names nothing keeps its spend. `None` with
// nothing launched once `deadline` passed or `cancel` fired before the command started; a cancel
// once it started lets it run to its bounded end, files its counts and answers `None`, since its
// request may have completed. Fails as the launch cannot be composed or the servers cannot be
// listed.
pub(super) async fn name_in_one_shot(
    service: &CodexService,
    prompt: &str,
    session_model: Option<&str>,
    deadline: Instant,
    cancel: &CancellationToken,
    mut filing: SessionUsageFiling,
) -> Result<Option<String>, CodexError> {
    let Some(TitleExec { folder, model, ran }) =
        run_title_exec(service, prompt, session_model, deadline, cancel).await?
    else {
        return Ok(None);
    };
    let printed = match ran {
        Ok(printed) => printed,
        Err(error) => {
            tracing::info!(
                error = &error as &(dyn std::error::Error + 'static),
                "codex's one-shot naming pass gave no name"
            );
            return Ok(None);
        }
    };
    match read_exec_turn(&printed) {
        // No event states the tier, so the row is at the standard one; zero counts meter nothing.
        Some(ExecTurnEnd::Completed { thread_id, counts }) => {
            let delta = CopyTurnMeter::new(thread_id, model.as_deref(), None).meter(counts);
            if let Some(delta) = delta {
                filing.file(delta, service, folder.path()).await;
            }
        }
        // A failed turn and one that printed no end state no counts.
        Some(ExecTurnEnd::Failed) | None => {}
    }
    if cancel.is_cancelled() {
        return Ok(None);
    }
    // The answer is read from its file, since the pass prints more than the answer.
    match tokio::fs::read_to_string(folder.path().join(TITLE_ANSWER_FILE_NAME)).await {
        Ok(answer) => Ok(read_title(&answer)),
        Err(error) => {
            tracing::info!(
                error = &error as &(dyn std::error::Error + 'static),
                "codex's one-shot naming pass wrote no answer"
            );
            Ok(None)
        }
    }
}

/// A one-shot pass's `codex exec` that ran: the folder it ran in, which holds its answer, the
/// model it ran on, `None` for the home's default, and what came of the command.
struct TitleExec {
    /// The pass's own folder, dropped once its spend is filed and its answer read.
    folder: tempfile::TempDir,
    /// The model the pass set, `None` for the home's default.
    model: Option<String>,
    /// What the command printed, or why it failed.
    ran: Result<String, CodexCommandError>,
}

// The one-shot pass's `codex exec` before it starts: its folder, the model it sets and its launch.
struct TitleExecLaunch {
    folder: tempfile::TempDir,
    model: Option<String>,
    native: CodexNativeLaunch,
}

// The one-shot pass's `codex exec`, run to its end within `deadline`; `None` with nothing launched
// once it passed or `cancel` fired first. Once launched, a cancel no longer reaches it. Fails as
// `name_in_one_shot` fails.
async fn run_title_exec(
    service: &CodexService,
    prompt: &str,
    session_model: Option<&str>,
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<Option<TitleExec>, CodexError> {
    let launch = tokio::select! {
        biased;
        () = cancel.cancelled() => return Ok(None),
        launch = compose_title_exec(service, prompt, session_model, deadline) => launch?,
    };
    let Some(TitleExecLaunch {
        folder,
        model,
        native,
    }) = launch
    else {
        return Ok(None);
    };
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() || cancel.is_cancelled() {
        return Ok(None);
    }
    let ran = run_codex_command(&service.dependencies().spawner, native.launch, left).await;
    Ok(Some(TitleExec { folder, model, ran }))
}

// The pass's `codex exec` composed within `deadline`, its schema written into its folder; `None`
// once it passed. Fails as `name_in_one_shot` fails.
async fn compose_title_exec(
    service: &CodexService,
    prompt: &str,
    session_model: Option<&str>,
    deadline: Instant,
) -> Result<Option<TitleExecLaunch>, CodexError> {
    let time_left = || deadline.saturating_duration_since(Instant::now());
    if time_left().is_zero() {
        return Ok(None);
    }
    let folder = make_pass_folder()?;
    let schema_file = folder.path().join(TITLE_SCHEMA_FILE_NAME);
    let answer_file = folder.path().join(TITLE_ANSWER_FILE_NAME);
    tokio::fs::write(&schema_file, title_schema().to_string())
        .await
        .map_err(|error| CodexError::Transport {
            detail: "The schema of Codex's naming pass could not be written.".to_owned(),
            cause: Some(Box::new(error)),
        })?;
    let dependencies = service.dependencies();
    let executable = tokio::select! {
        () = tokio::time::sleep_until(deadline) => return Ok(None),
        executable = dependencies.program.resolve(service.home()) => {
            executable.map_err(CodexError::Driver)?
        }
    };
    let server_names = list_mcp_server_names(
        dependencies,
        &executable,
        &service.home().kind,
        time_left().min(CODEX_SERVER_LIST_DEADLINE),
    )
    .await?;
    // The catalog is read on the service where it is up, a resting session's started for its
    // pass on the service; the one-shot pass starts none.
    let connection = service.connection().ok();
    let title_model = tokio::select! {
        () = tokio::time::sleep_until(deadline) => return Ok(None),
        title_model = choose_title_model(connection.as_deref(), session_model) => title_model,
    };
    let mut overrides = lockdown::compose_lockdown_overrides(&server_names);
    overrides.extend(
        title_model
            .model
            .clone()
            .map(|model| (MODEL_KEY.to_owned(), Value::String(model))),
    );
    overrides.extend(title_model.effort.map(|effort| {
        (
            REASONING_EFFORT_KEY.to_owned(),
            Value::String(effort.to_owned()),
        )
    }));
    let mut arguments = home_exec_switches(&service.home().kind);
    arguments.extend(lockdown::write_exec_overrides(overrides));
    arguments.extend([
        "exec".to_owned(),
        "--ephemeral".to_owned(),
        "--skip-git-repo-check".to_owned(),
        "--sandbox".to_owned(),
        "read-only".to_owned(),
        "--output-schema".to_owned(),
        schema_file.to_string_lossy().into_owned(),
        "--output-last-message".to_owned(),
        answer_file.to_string_lossy().into_owned(),
        // Its events as lines, the turn's counts among them.
        "--json".to_owned(),
        prompt.to_owned(),
    ]);
    let mut native =
        compose_codex_native_launch(&dependencies.data_folder, &executable, arguments).await?;
    folder.path().clone_into(&mut native.launch.working_folder);
    Ok(Some(TitleExecLaunch {
        folder,
        model: title_model.model,
        native,
    }))
}
