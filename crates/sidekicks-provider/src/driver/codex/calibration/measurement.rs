//! One calibration run: the installed Codex started on a throwaway home in a scratch folder of its
//! own, pointed at a loopback stand-in for the model endpoint and at the catalog its own service
//! printed, asked one turn on the model and window measured, and the compaction limit it logs for
//! that turn read off its JSON trace. The scratch folder goes when the run ends, failed or not.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures::future::ready;
use serde::Deserialize;
use serde_json::{Value, json};
use sidekicks_platforms::{create_private_folder, wrap_child_command};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::driver::codex::calibration::log_reading::{CodexTurnLimit, read_codex_turn_limit};
use crate::driver::codex::calibration::stand_in::ModelEndpointStandIn;
use crate::driver::codex::lifecycle::naming::lockdown::write_exec_overrides;
use crate::driver::codex::model_windows::read_codex_service_model_windows;
use crate::driver::codex::service::command::read_codex_model_catalog_dump;
use crate::driver::codex::service::command_line::{
    CodexServiceCommandLineInput, compose_codex_service_arguments,
};
use crate::driver::codex::service::registry::home_socket_path;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::start::compose_codex_native_launch;
use crate::driver::codex::session::detached_conversation::CodexDetachedFrames;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::thread::view::{THREAD_START_METHOD, TURN_START_METHOD};
use crate::driver::codex::transport::connection::{
    CodexConnectionHandlers, open_codex_connection, read_codex_object,
};
use crate::driver::codex::transport::socket::{CodexSocketWait, dial_codex_service_socket};
use crate::driver::codex::version::CODEX_CLIENT_NAME;

/// The folder under the daemon's data folder that holds each run's scratch folder.
const CALIBRATION_FOLDER_NAME: &str = "codex-calibration";

/// How long one run may take, from Codex's start to its limit line: a start, a handshake and one
/// turn against a loopback endpoint.
const CALIBRATION_RUN_DEADLINE: Duration = Duration::from_secs(60);

/// The model provider entry the run's Codex talks to, which names the stand-in.
const STAND_IN_PROVIDER_ID: &str = "sidekicks_calibration";

/// The trace that carries the limit line, and nothing louder elsewhere.
const LIMIT_TRACE_FILTER: &str = "codex_core::session::turn=trace";

/// The one message of the measured turn.
const CALIBRATION_PROMPT: &str = "Reply with ok.";

/// Why a run measured no limit.
#[derive(Debug, thiserror::Error)]
pub(super) enum CodexCalibrationError {
    /// Codex's catalog could not be read, or Codex could not be started or asked.
    #[error("Codex could not be run for the calibration")]
    Codex(#[from] CodexError),
    /// The catalog lists no window for the model.
    #[error("Codex's catalog lists no window for the model")]
    WindowNotListed,
    /// The scratch folder, its home or its catalog file could not be made.
    #[error("the calibration's scratch folder could not be made")]
    Folder(#[source] io::Error),
    /// The scratch folder could not be removed after a run that measured its limit.
    #[error("the calibration's scratch folder could not be removed")]
    FolderRemoval(#[source] io::Error),
    /// The stand-in model endpoint could not be started or failed while serving.
    #[error("the stand-in model endpoint failed")]
    StandIn(#[source] io::Error),
    /// Codex's process could not be started or ended.
    #[error("Codex's calibration process could not be started or ended")]
    Process(#[source] io::Error),
    /// Codex's process ended, or logged another turn's limit, before it logged the calibration
    /// turn's.
    #[error("Codex logged no compaction limit for the calibration turn")]
    NoLimitLogged,
    /// The run outlived its deadline.
    #[error("the calibration run did not end within its deadline")]
    DeadlinePassed(#[source] tokio::time::error::Elapsed),
}

/// What one run measures: the model and, where the session chose its larger one, its window.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct CodexCalibrationRequest {
    /// The model.
    pub(super) model_id: String,
    /// The larger window the session chose, `None` for the model's default.
    pub(super) requested_window: Option<u64>,
}

// The members of a catalog row the run reads beyond its window: the token budget the model turns
// on, whose fallback buffer Codex adds to the limit it logs.
#[derive(Deserialize)]
struct CatalogDump {
    models: Vec<CatalogRow>,
}

#[derive(Deserialize)]
struct CatalogRow {
    slug: String,
    model_messages: Option<ModelMessages>,
}

#[derive(Deserialize)]
struct ModelMessages {
    token_budget: Option<TokenBudget>,
}

#[derive(Deserialize)]
struct TokenBudget {
    #[serde(default)]
    enabled: bool,
    auto_compact_fallback_buffer_tokens: u64,
}

#[derive(Deserialize)]
struct StartedThread {
    thread: StartedEntity,
}

#[derive(Deserialize)]
struct StartedTurn {
    turn: StartedEntity,
}

#[derive(Deserialize)]
struct StartedEntity {
    id: String,
}

/// What a run measures on: the catalog Codex's own service printed, the whole window the
/// session runs and the fallback buffer the model's token budget adds to the logged limit.
pub(super) struct CodexCalibrationCatalog {
    dump: String,
    /// The model's whole window the session runs, in tokens.
    pub(super) window_tokens: u64,
    fallback_buffer_tokens: u64,
}

/// Reads `request`'s window and fallback buffer from `service`'s catalog. Fails when the catalog
/// cannot be read or lists no window for the model.
pub(super) async fn read_codex_calibration_catalog(
    service: &CodexService,
    request: &CodexCalibrationRequest,
) -> Result<CodexCalibrationCatalog, CodexCalibrationError> {
    let dump = read_codex_model_catalog_dump(service).await?;
    let windows =
        read_codex_service_model_windows(ready(Ok::<_, CodexError>(dump.clone())), service.home())
            .await;
    // The window a session runs without a choice: the default, else the largest, as Codex
    // resolves it.
    let window_tokens = request
        .requested_window
        .or_else(|| {
            windows
                .get(&request.model_id)
                .and_then(|window| window.context_window.or(window.max_context_window))
        })
        .ok_or(CodexCalibrationError::WindowNotListed)?;
    let fallback_buffer_tokens = read_fallback_buffer(&dump, &request.model_id);
    Ok(CodexCalibrationCatalog {
        dump,
        window_tokens,
        fallback_buffer_tokens,
    })
}

/// Measures where `service`'s Codex build compacts `model_id` on `catalog`'s window: the limit it
/// logs for one turn plus the fallback buffer the model's token budget adds. Fails as
/// [`CodexCalibrationError`] says.
pub(super) async fn measure_codex_compaction_limit(
    service: &CodexService,
    catalog: &CodexCalibrationCatalog,
    model_id: &str,
) -> Result<u64, CodexCalibrationError> {
    let scratch = service
        .dependencies()
        .data_folder
        .join(CALIBRATION_FOLDER_NAME)
        .join(scratch_folder_name()?);
    let limit = run_in_scratch_folder(scratch, async |folder| {
        tokio::time::timeout(
            CALIBRATION_RUN_DEADLINE,
            run_calibration_turn(
                service,
                folder,
                &catalog.dump,
                model_id,
                catalog.window_tokens,
            ),
        )
        .await
        .map_err(CodexCalibrationError::DeadlinePassed)?
    })
    .await?;
    Ok(limit.saturating_add(catalog.fallback_buffer_tokens))
}

/// Runs `run` in the scratch folder `folder`, made first, and removes the folder after it, failed
/// or not. Fails with the run's own failure, else when the folder could not be made or removed.
async fn run_in_scratch_folder<Output>(
    folder: PathBuf,
    run: impl AsyncFnOnce(&Path) -> Result<Output, CodexCalibrationError>,
) -> Result<Output, CodexCalibrationError> {
    create_private_folder(&folder).map_err(CodexCalibrationError::Folder)?;
    let ran = run(&folder).await;
    let removed = tokio::fs::remove_dir_all(&folder).await;
    match (ran, removed) {
        (Ok(output), Ok(())) => Ok(output),
        (Ok(_output), Err(error)) => Err(CodexCalibrationError::FolderRemoval(error)),
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(removal)) => {
            // The run's own failure is the one returned; the folder it left is named here.
            tracing::warn!(
                error = &removal as &(dyn std::error::Error + 'static),
                folder = %folder.display(),
                "a failed codex calibration run's scratch folder could not be removed"
            );
            Err(error)
        }
    }
}

// The run's Codex on its own home under `folder`: started against the stand-in, asked one turn,
// and its logged limit read; the process and the stand-in end with the run.
async fn run_calibration_turn(
    service: &CodexService,
    folder: &Path,
    dump: &str,
    model_id: &str,
    window_tokens: u64,
) -> Result<u64, CodexCalibrationError> {
    let home = folder.join("home");
    create_private_folder(&home).map_err(CodexCalibrationError::Folder)?;
    let catalog = folder.join("catalog.json");
    tokio::fs::write(&catalog, dump)
        .await
        .map_err(CodexCalibrationError::Folder)?;
    let stand_in = ModelEndpointStandIn::start()
        .await
        .map_err(CodexCalibrationError::StandIn)?;
    let dependencies = service.dependencies();
    let executable = dependencies
        .program
        .resolve(service.home())
        .await
        .map_err(CodexError::Driver)?;
    let mut arguments = compose_codex_service_arguments(&CodexServiceCommandLineInput {
        listen_address: "unix://".to_owned(),
        additional_config_overrides: Vec::new(),
    });
    let provider_entry = format!("model_providers.{STAND_IN_PROVIDER_ID}");
    arguments.extend(write_exec_overrides(vec![
        (
            "model_provider".to_owned(),
            Value::from(STAND_IN_PROVIDER_ID),
        ),
        (
            format!("{provider_entry}.name"),
            Value::from(STAND_IN_PROVIDER_ID),
        ),
        (
            format!("{provider_entry}.base_url"),
            Value::from(stand_in.base_url.clone()),
        ),
        (
            "model_catalog_json".to_owned(),
            Value::from(catalog.display().to_string()),
        ),
    ]));
    let mut launch =
        compose_codex_native_launch(&dependencies.data_folder, &executable, arguments).await?;
    for (name, value) in [
        ("CODEX_HOME", home.display().to_string()),
        ("RUST_LOG", LIMIT_TRACE_FILTER.to_owned()),
        ("LOG_FORMAT", "json".to_owned()),
    ] {
        launch.environment.retain(|(held, _)| held != name);
        launch.environment.push((name.to_owned(), value));
    }
    launch.working_folder = folder.to_owned();
    let mut command = launch.into_command();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let daemon_pid = std::process::id();
    let mut child = dependencies
        .spawner
        .run(move || wrap_child_command(command, daemon_pid).spawn())
        .await
        .and_then(|spawned| spawned)
        .map_err(CodexCalibrationError::Process)?;
    let standard_error = child
        .stderr()
        .take()
        .expect("the calibration process's standard error is piped");
    let (limit_logged, logged_limit) = oneshot::channel();
    // Read to the end, so Codex never blocks on a full pipe; the first limit line is handed on.
    let reading = tokio::spawn(async move {
        let mut lines = BufReader::new(standard_error).lines();
        let mut limit_logged = Some(limit_logged);
        while let Some(line) = lines.next_line().await? {
            if let Some(limit) = read_codex_turn_limit(&line)
                && let Some(sender) = limit_logged.take()
            {
                // The run stops waiting only once it has the limit or its deadline passed.
                let _unheard = sender.send(limit);
            }
        }
        io::Result::Ok(())
    });
    let asked = ask_one_turn(service, &home, model_id, window_tokens, folder).await;
    let measured = match asked {
        Ok(turn_id) => match logged_limit.await {
            Ok(CodexTurnLimit {
                turn_id: logged_turn,
                limit_tokens,
            }) if logged_turn == turn_id => Ok(limit_tokens),
            Ok(_) | Err(_) => Err(CodexCalibrationError::NoLimitLogged),
        },
        Err(error) => Err(error),
    };
    child.start_kill().map_err(CodexCalibrationError::Process)?;
    child.wait().await.map_err(CodexCalibrationError::Process)?;
    reading
        .await
        .map_err(io::Error::other)
        .and_then(|read| read)
        .map_err(CodexCalibrationError::Process)?;
    stand_in
        .stop()
        .await
        .map_err(CodexCalibrationError::StandIn)?;
    measured
}

// Dials the run's Codex once it listens on its home's socket, starts an ephemeral conversation on
// the model and window, and sends its one turn, answering the turn's id.
async fn ask_one_turn(
    service: &CodexService,
    home: &Path,
    model_id: &str,
    window_tokens: u64,
    folder: &Path,
) -> Result<String, CodexCalibrationError> {
    let dependencies = service.dependencies();
    let (sender, receiver) = dial_codex_service_socket(
        &home_socket_path(home),
        CodexSocketWait::UntilListening,
        &dependencies.provider_services,
        &CancellationToken::new(),
    )
    .await?;
    let (events, _frames) = CodexDetachedFrames::new();
    let (connection, _reply) = open_codex_connection(
        sender,
        receiver,
        CodexConnectionHandlers {
            events,
            responder: None,
        },
        CODEX_CLIENT_NAME,
        dependencies.startup_timeout,
    )
    .await?;
    let started = connection
        .request(
            THREAD_START_METHOD,
            &json!({
                "model": model_id,
                "cwd": folder,
                "ephemeral": true,
                "config": { "model_context_window": window_tokens },
            }),
        )
        .await?;
    let thread_id = read_codex_object::<StartedThread>(started.get())
        .ok_or_else(|| unreadable_reply(THREAD_START_METHOD))?
        .thread
        .id;
    let turn = connection
        .request(
            TURN_START_METHOD,
            &json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": CALIBRATION_PROMPT }],
            }),
        )
        .await?;
    Ok(read_codex_object::<StartedTurn>(turn.get())
        .ok_or_else(|| unreadable_reply(TURN_START_METHOD))?
        .turn
        .id)
}

// A reply that names no thread or turn.
fn unreadable_reply(method: &str) -> CodexError {
    CodexError::Transport {
        detail: format!("The Codex app-server \"{method}\" reply named no id."),
        cause: None,
    }
}

// The fallback buffer the model's catalog row adds to its limit: its token budget's, where the
// model turns the budget on, else none.
fn read_fallback_buffer(dump: &str, model_id: &str) -> u64 {
    serde_json::from_str::<CatalogDump>(dump)
        .ok()
        .and_then(|catalog| catalog.models.into_iter().find(|row| row.slug == model_id))
        .and_then(|row| row.model_messages?.token_budget)
        .filter(|budget| budget.enabled)
        .map_or(0, |budget| budget.auto_compact_fallback_buffer_tokens)
}

// A scratch folder name no other run shares.
fn scratch_folder_name() -> Result<String, CodexCalibrationError> {
    let random =
        getrandom::u32().map_err(|error| CodexCalibrationError::Folder(io::Error::other(error)))?;
    Ok(format!("{random:08x}"))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use super::{
        CodexCalibrationError, CodexCalibrationRequest, measure_codex_compaction_limit,
        read_codex_calibration_catalog, run_in_scratch_folder,
    };
    use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
    use crate::driver::codex::service::supervisor::test_service::{
        TestCodexProgram, UnheardEvents, test_codex_service_dependencies,
    };
    use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
    use crate::runtime_binding::test_store::test_provider_account_id;

    // A run that fails after writing into its scratch folder leaves no folder behind and answers
    // its own failure.
    #[tokio::test]
    async fn removes_the_scratch_folder_after_a_failed_run() {
        let parent = tempfile::tempdir().expect("the test makes a folder");
        let scratch = parent.path().join("run");
        let ran: Result<(), _> = run_in_scratch_folder(scratch.clone(), async |folder| {
            std::fs::write(folder.join("catalog.json"), "{}").expect("the run writes its file");
            Err(CodexCalibrationError::NoLimitLogged)
        })
        .await;
        assert!(matches!(ran, Err(CodexCalibrationError::NoLimitLogged)));
        assert!(!scratch.exists(), "the failed run's folder is gone");
    }

    // A downloaded Codex build, named by `SIDEKICKS_TEST_CODEX_PROGRAM`, measured end to end on
    // the model `SIDEKICKS_TEST_CODEX_MODEL` names: a limit inside the model's window.
    #[tokio::test]
    #[ignore = "needs a downloaded Codex release"]
    async fn measures_a_downloaded_codex_builds_limit() {
        let program = std::env::var_os("SIDEKICKS_TEST_CODEX_PROGRAM")
            .expect("SIDEKICKS_TEST_CODEX_PROGRAM names the downloaded Codex program");
        let model_id = std::env::var("SIDEKICKS_TEST_CODEX_MODEL")
            .expect("SIDEKICKS_TEST_CODEX_MODEL names a model of its catalog");
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let environment = ["HOME", "PATH"]
            .into_iter()
            .filter_map(|name| Some((name.to_owned(), std::env::var(name).ok()?)))
            .collect();
        let dependencies = test_codex_service_dependencies(
            folder.path(),
            Arc::new(TestCodexProgram {
                program: PathBuf::from(program),
                environment,
            }),
            Arc::new(UnheardEvents),
        );
        let home = folder.path().join("home");
        std::fs::create_dir_all(&home).expect("the service's home is made");
        let socket = folder.path().join("codex.sock");
        let service = CodexService::new(
            CodexServiceHome {
                codex_home: home,
                kind: CodexHomeKind::Account(test_provider_account_id()),
            },
            CodexServiceSocket {
                path: socket.clone(),
                home_socket: socket,
            },
            CodexServiceKind::Account,
            dependencies,
        );
        let request = CodexCalibrationRequest {
            model_id,
            requested_window: None,
        };
        let catalog = read_codex_calibration_catalog(&service, &request)
            .await
            .expect("the catalog lists the model's window");
        let limit = measure_codex_compaction_limit(&service, &catalog, &request.model_id)
            .await
            .expect("the build logs its limit");
        assert!(
            limit > 0 && limit <= catalog.window_tokens,
            "{limit} lies inside the {} window",
            catalog.window_tokens
        );
    }
}
