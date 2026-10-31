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
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::{
    LocaleCategory, default_shell, login_shell, stable_working_folder, system_locale,
};
use sidekicks_provider::driver::child_records::SPAWN_NONCE_ENVIRONMENT_NAME;
use sidekicks_provider::spawn_environment::{
    SessionEnvironment, build_project_command_environment, remove_environment_names,
};
use sidekicks_terminal::{CommandLine, ShellCommand, SpawnRequest};
use sidekicks_workspace::working_folder::SessionWorkingFolder;

use crate::integration::injection::{
    ShellMarkNonce, ShellStartupError, ShellStartupFolders, prepare_shell_launch,
};
use crate::refusals::chat_unsupported;
use crate::resize::ShellSize;
use crate::spawn_cwd_translator::{SpawnCwdError, SpawnCwdStrategy, translate_spawn_cwd};

/// The size a shell starts at before any pane sizes it: the conventional terminal's.
pub(crate) const INITIAL_SHELL_SIZE: ShellSize = ShellSize {
    columns: 80,
    rows: 24,
};

/// The terminal type a shell's `TERM` names: the one every pane draws.
const SHELL_TERMINAL_NAME: &str = "xterm-256color";

/// The color depth a shell's `COLORTERM` names: every pane draws 24-bit color.
const SHELL_COLOR_DEPTH: &str = "truecolor";

/// The terminal program a shell's `TERM_PROGRAM` names, and the name its terminal answers a
/// program asking its name and version with.
pub(crate) const SHELL_TERMINAL_PROGRAM: &str = "sidekicks";

/// The `LANG` a shell gets where neither its environment nor the person's settings name a locale
/// with a region.
const FALLBACK_SHELL_LANG: &str = "en_US.UTF-8";

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
    /// This build's release version, which a shell reads as `TERM_PROGRAM_VERSION`.
    pub(crate) release_version: &'a str,
}

/// The plan of one open's terminal start: the terminal's spawn request with both launches, and the
/// started program's name, the shell's title until it sets its own.
pub(crate) struct ShellStartPlan {
    /// Both launches, for the terminal to start.
    pub(crate) request: SpawnRequest,
    /// The base name of the login shell, or of the default shell where the account names none.
    pub(crate) program_name: String,
}

/// Why a shell's start could not be planned.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ShellStartPlanError {
    /// The account's login shell could not be read.
    #[error("the account's login shell could not be read")]
    LoginShell(#[source] io::Error),
    /// The read of the login shell ended before it finished.
    #[error("the read of the account's login shell ended before it finished")]
    Interrupted(#[source] tokio::task::JoinError),
    /// A startup script or the nonce file could not be written.
    #[error(transparent)]
    Startup(#[from] ShellStartupError),
    /// The shell's start could not be moved off the session's working folder.
    #[error("the shell's start could not be moved off the session's working folder")]
    SpawnFolder(#[from] SpawnCwdError),
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

/// Plans one pane's shell start: the login shell, read now, with the platform's default shell
/// as the launch the `shell` mode falls back to, each carrying its marks script, the `shell` mode
/// spawned in the stable folder and starting the shell in the session's folder. Fails when the
/// login shell cannot be read, a script written, or the start moved off the session's folder.
pub(crate) async fn plan_shell_start(
    input: ShellStartInput<'_>,
) -> Result<ShellStartPlan, ShellStartPlanError> {
    let fallback_path = default_shell().to_string_lossy().into_owned();
    let login_shell = tokio::task::spawn_blocking(login_shell)
        .await
        .map_err(ShellStartPlanError::Interrupted)?
        .map_err(ShellStartPlanError::LoginShell)?
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| !path.is_empty());
    let shell_path = login_shell.unwrap_or_else(|| fallback_path.clone());
    let program_name = Path::new(&shell_path).file_name().map_or_else(
        || shell_path.clone(),
        |name| name.to_string_lossy().into_owned(),
    );
    let lang = system_lang();
    let shell = shell_command(&input, &shell_path, &lang).await?;
    let fallback = shell_command(&input, &fallback_path, &lang).await?;
    let request = SpawnRequest {
        shell,
        fallback,
        working_directory: input.folder.to_path_buf(),
        rows: INITIAL_SHELL_SIZE.rows,
        columns: INITIAL_SHELL_SIZE.columns,
        shell_start: input.shell_mode,
    };
    Ok(ShellStartPlan {
        request: translate_spawn_cwd(
            request,
            SpawnCwdStrategy::ShellFolder,
            &stable_working_folder(),
        )?,
        program_name,
    })
}

// The `LANG` the person's messages locale names, `<language>_<REGION>.UTF-8`, or the fallback
// where the system names no locale or one without a region.
fn system_lang() -> String {
    system_locale(LocaleCategory::Messages)
        .and_then(|locale| {
            let region = locale.id.region?;
            Some(format!(
                "{}_{}.UTF-8",
                locale.id.language.as_str(),
                region.as_str()
            ))
        })
        .unwrap_or_else(|| FALLBACK_SHELL_LANG.to_owned())
}

// The one place a shell's launch and environment are put together, in order: the captured base
// with the session's rows over it, as a project's command gets it, the pairs that load the marks
// script laid over that, `SHLVL` left out so the shell counts from its own start, the screen-reader
// switch, set while it is on and never carried in from the base while it is off, `LANG` where
// nothing before names one, then the color depth, the terminal program and its version, the
// terminal's type and the orphan registry's nonce, each of these last set over any value before.
async fn shell_command(
    input: &ShellStartInput<'_>,
    shell_path: &str,
    lang: &str,
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
        .chain([
            "SHLVL",
            "COLORTERM",
            "TERM_PROGRAM",
            "TERM_PROGRAM_VERSION",
            "TERM",
            SPAWN_NONCE_ENVIRONMENT_NAME,
        ])
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
    if rules.environment_value(&environment, "LANG").is_none() {
        environment.push(("LANG".to_owned(), lang.to_owned()));
    }
    environment.extend([
        ("COLORTERM".to_owned(), SHELL_COLOR_DEPTH.to_owned()),
        ("TERM_PROGRAM".to_owned(), SHELL_TERMINAL_PROGRAM.to_owned()),
        (
            "TERM_PROGRAM_VERSION".to_owned(),
            input.release_version.to_owned(),
        ),
        ("TERM".to_owned(), SHELL_TERMINAL_NAME.to_owned()),
    ]);
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

#[cfg(test)]
mod tests {
    use sidekicks_platforms::{PathRules, create_private_folder, stable_working_folder};
    use sidekicks_provider::spawn_environment::{ReservedEnvironmentNames, SessionEnvironment};
    use sidekicks_terminal::CommandLine;

    use super::{ShellStartInput, plan_shell_start};
    use crate::integration::injection::{ShellStartupFolders, mint_mark_nonce};

    // Fails when a shell's start is left in the session's folder rather than the `shell` mode
    // spawning in the stable folder and starting the shell in the session's folder; dropping the
    // `translate_spawn_cwd` call in `plan_shell_start` kills it.
    #[tokio::test]
    async fn a_planned_shell_spawns_in_the_stable_folder_and_starts_in_the_session_s_folder() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let worktree = scratch.path().join("work");
        let startup_folder = scratch.path().join("startup");
        let nonce_folder = startup_folder.join("nonces");
        for folder in [&worktree, &nonce_folder] {
            create_private_folder(folder).expect("a folder is made");
        }
        let startup_folders = ShellStartupFolders {
            startup_folder,
            nonce_folder,
        };
        let mark_nonce = mint_mark_nonce(&startup_folders)
            .await
            .expect("the nonce file is written");
        let reserved_names = ReservedEnvironmentNames::of_providers(&[]);

        let plan = plan_shell_start(ShellStartInput {
            environment: SessionEnvironment {
                base: &[],
                every_project_rows: &[],
                project_rows: &[],
                reserved_names: &reserved_names,
                rules: PathRules::NATIVE,
            },
            is_screen_reader_mode_on: false,
            screen_reader_environment_names: &[],
            startup_folders: &startup_folders,
            folder: &worktree,
            spawn_nonce: "spawn-nonce",
            mark_nonce: &mark_nonce,
            shell_mode: CommandLine {
                program: "/daemon".to_owned(),
                arguments: vec!["shell".to_owned()],
            },
            release_version: "0.0.0-test",
        })
        .await
        .expect("the start is planned");

        assert_eq!(plan.request.working_directory, stable_working_folder());
        assert_eq!(plan.request.shell.folder, worktree);
        assert_eq!(plan.request.fallback.folder, worktree);
    }
}
