//! What a Terminal pane's shell starts as: the person's own login shell, read from the account's
//! record at each open, and the platform's own default shell, which the `shell` mode starts with
//! one line above its prompt where the system will not start the first; the arguments and
//! environment that load each one's marks script beside the person's own startup files; and the
//! one place a shell's environment is put together.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;
use sidekicks_platforms::{default_shell, login_shell, stable_working_folder};
use sidekicks_terminal::{CommandLine, ShellCommand, SpawnRequest};

use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::provider::spawn_environment::{
    SessionEnvironment, build_project_command_environment, remove_environment_names,
};
use crate::pty::orphan::registry::SPAWN_NONCE_ENVIRONMENT_NAME;
use crate::pty::shell::integration::injection::{
    ShellMarkNonce, ShellStartupError, ShellStartupFolders, prepare_shell_launch,
};
use crate::pty::shell::refusals::chat_unsupported;
use crate::pty::shell::resize::ShellSize;
use crate::session::working_folder::SessionWorkingFolder;

/// The size a shell starts at before any pane sizes it: the conventional terminal's.
pub(crate) const INITIAL_SHELL_SIZE: ShellSize = ShellSize {
    columns: 80,
    rows: 24,
};

/// The terminal type a shell's `TERM` names: the one every pane draws.
const SHELL_TERMINAL_NAME: &str = "xterm-256color";

/// What one shell's start is prepared from, read at each open.
pub(crate) struct ShellStartInput<'a> {
    /// The captured base environment with the session's rows, as a project's command gets it.
    pub(crate) environment: SessionEnvironment<'a>,
    /// Whether `Simplify for a screen reader` is on.
    pub(crate) is_screen_reader_mode_on: bool,
    /// The variables each provider reads as the screen-reader switch, from its driver's descriptor.
    pub(crate) screen_reader_environment_names: &'a [&'static str],
    /// The folders every shell's start writes its scripts and nonce file in.
    pub(crate) startup_folders: &'a ShellStartupFolders,
    /// The session's working folder, which the shell starts in.
    pub(crate) folder: &'a Path,
    /// The nonce the orphan registry finds the shell by.
    pub(crate) spawn_nonce: &'a str,
    /// The mark nonce both launches read, minted for this open.
    pub(crate) mark_nonce: &'a ShellMarkNonce,
    /// The daemon's `shell` mode with its arguments.
    pub(crate) shell_mode: CommandLine,
}

/// One open's terminal start and the shell's name until it sets its own title.
pub(crate) struct ShellStart {
    /// Both launches, for the terminal to start.
    pub(crate) request: SpawnRequest,
    /// The base name of the login shell, or of the default shell where the account names none.
    pub(crate) program_name: String,
}

/// Why a shell's start could not be prepared.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ShellStartError {
    /// The account's login shell could not be read.
    #[error("the account's login shell could not be read")]
    LoginShell(#[source] io::Error),
    /// The read of the login shell ended before it finished.
    #[error("the read of the account's login shell ended before it finished")]
    Interrupted(#[source] tokio::task::JoinError),
    /// A startup script or the nonce file could not be written.
    #[error(transparent)]
    Startup(#[from] ShellStartupError),
}

/// The session's working folder where a shell can start in it. Refuses a chat session
/// `terminal.chatUnsupported` and a folder not in place yet or gone from disk
/// `session.workingFolder.missing`; fails as a fault with a folder's other read errors.
pub(crate) async fn check_working_folder(
    session_id: &SessionId,
    session: SessionWorkingFolder,
) -> Result<PathBuf, HandlerError> {
    let refuse = |cause: &str| {
        HandlerError::Refused(
            DomainError::new(cause, RefusalCode::SessionWorkingFolderMissing)
                .with_detail(serde_json::json!({ "sessionId": session_id })),
        )
    };
    if session.shape == SessionShape::Chat {
        return Err(chat_unsupported(session_id).into());
    }
    let Some(folder) = session.working_folder else {
        return Err(refuse(
            "The session's working folder is not ready yet, so no shell can start in it.",
        ));
    };
    let gone = "The session's working folder is gone from disk, so no shell can start in it.";
    match tokio::fs::metadata(&folder).await {
        Ok(facts) if facts.is_dir() => Ok(folder),
        Ok(_) => Err(refuse(gone)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Err(refuse(gone)),
        Err(error) => Err(HandlerError::Internal(Box::new(error))),
    }
}

/// Prepares one pane's shell start: the login shell, read now, with the platform's default shell
/// as the launch the `shell` mode falls back to, each carrying its marks script. Fails when the
/// login shell cannot be read or a script written.
pub(crate) async fn prepare_shell_start(
    input: ShellStartInput<'_>,
) -> Result<ShellStart, ShellStartError> {
    let fallback_path = default_shell().to_string_lossy().into_owned();
    let login_shell = tokio::task::spawn_blocking(login_shell)
        .await
        .map_err(ShellStartError::Interrupted)?
        .map_err(ShellStartError::LoginShell)?
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| !path.is_empty());
    let shell_path = login_shell.unwrap_or_else(|| fallback_path.clone());
    let program_name = Path::new(&shell_path).file_name().map_or_else(
        || shell_path.clone(),
        |name| name.to_string_lossy().into_owned(),
    );
    let shell = shell_command(&input, &shell_path).await?;
    let fallback = shell_command(&input, &fallback_path).await?;
    Ok(ShellStart {
        request: SpawnRequest {
            shell,
            fallback,
            working_directory: stable_working_folder(),
            rows: INITIAL_SHELL_SIZE.rows,
            columns: INITIAL_SHELL_SIZE.columns,
            shell_start: input.shell_mode,
        },
        program_name,
    })
}

// The one place a shell's launch and environment are put together, in order: the captured base
// with the session's rows over it, as a project's command gets it, the pairs that load the marks
// script laid over that, the screen-reader switch, set while it is on and never carried in from
// the base while it is off, then the terminal's type and the orphan registry's nonce.
async fn shell_command(
    input: &ShellStartInput<'_>,
    shell_path: &str,
) -> Result<ShellCommand, ShellStartupError> {
    let rules = input.environment.rules;
    let launch = prepare_shell_launch(
        shell_path,
        build_project_command_environment(&input.environment),
        input.startup_folders,
        input.mark_nonce,
    )
    .await?;
    let mut environment = launch.environment;
    let app_set_names: Vec<&str> = input
        .screen_reader_environment_names
        .iter()
        .copied()
        .chain(["TERM", SPAWN_NONCE_ENVIRONMENT_NAME])
        .collect();
    remove_environment_names(&mut environment, &app_set_names, rules);
    if input.is_screen_reader_mode_on {
        environment.extend(
            input
                .screen_reader_environment_names
                .iter()
                .map(|name| ((*name).to_owned(), "1".to_owned())),
        );
    }
    environment.push(("TERM".to_owned(), SHELL_TERMINAL_NAME.to_owned()));
    environment.push((
        SPAWN_NONCE_ENVIRONMENT_NAME.to_owned(),
        input.spawn_nonce.to_owned(),
    ));
    Ok(ShellCommand {
        program: launch.program,
        arguments: launch.arguments,
        environment,
        folder: input.folder.to_path_buf(),
        raw_command_tail: None,
    })
}
