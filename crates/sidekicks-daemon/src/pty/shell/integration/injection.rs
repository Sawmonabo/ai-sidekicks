//! How each shell is started so that the app's marks script loads beside the person's own startup
//! files and reports the shell's marks with a nonce minted for that shell alone. zsh reads the
//! script through a `ZDOTDIR` folder whose files source the person's own; bash starts as the
//! operating system says, the script running the person's login files itself before it adds its
//! hooks; fish reads it through a vendor configuration folder named first in `XDG_DATA_DIRS`,
//! before the person's `config.fish`. The scripts live in the program and are written into the
//! startup folder, which only this account may open, before each shell starts, a copy whose
//! contents differ replaced in one rename. The nonce goes to the shell in a file of its own, which
//! the script reads and deletes before any login file runs, so it never sits in the shell's
//! environment, where any program of the account could read it. Every other shell starts with no
//! script and reports no marks, as a login shell where the system has one.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::machine::settings::{
    SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME, SHELL_ORIGINAL_XDG_DATA_DIRS_ENVIRONMENT_NAME,
    SHELL_ORIGINAL_ZDOTDIR_ENVIRONMENT_NAME,
};
use sidekicks_platforms::{
    BashStartInput, LOGIN_SHELL_ARGUMENTS, PathRules, RUN_FOLDER_FILE_MODE,
    XDG_DEFAULT_DATA_FOLDERS, create_new_file, create_private_folder, remove_tree, start_bash,
};
use tokio::task::JoinError;

use crate::integration::zsh_startup::prepare_zsh_startup_folder;
use sidekicks_provider::spawn_environment::remove_environment_names;
use sidekicks_std::file::atomic_write::{AtomicWriteError, write_file_atomically_if_changed};
use sidekicks_std::random_hex::random_hex;

/// bash's script, in the startup folder.
const BASH_SCRIPT_FILE_NAME: &str = "startup.bash";
const BASH_SCRIPT: &str = include_str!("scripts/startup.bash");
/// The data folder whose `fish/vendor_conf.d` holds fish's script, in the startup folder.
const FISH_DATA_FOLDER_NAME: &str = "xdg-data";
/// fish's script inside its data folder; fish runs only the first vendor file of one name, so the
/// name is the app's own.
const FISH_SCRIPT_PATH: [&str; 3] = ["fish", "vendor_conf.d", "sidekicks-shell-marks.fish"];
const FISH_SCRIPT: &str = include_str!(concat!(
    "scripts/xdg-data/fish/vendor_conf.d/",
    "sidekicks-shell-marks.fish"
));

/// Sixteen random bytes, written as hex so the nonce is a plain option value in a mark.
const NONCE_BYTE_COUNT: usize = 16;
/// The folder of the startup folder each shell's nonce file is written in.
const NONCE_FOLDER_NAME: &str = "shell-nonces";

/// Why a shell's startup files or nonce could not be put in place.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ShellStartupError {
    /// A startup folder could not be made private or cleared.
    #[error("a shell startup folder could not be made")]
    Folder(#[source] io::Error),
    /// A startup script could not be written.
    #[error(transparent)]
    Script(#[from] AtomicWriteError),
    /// The system gave no random bytes for the nonce.
    #[error("the shell's mark nonce could not be minted")]
    Nonce(#[source] getrandom::Error),
    /// The nonce file could not be written.
    #[error("the shell's nonce file could not be written")]
    NonceFile(#[source] io::Error),
    /// The blocking task that made a startup folder or wrote the nonce file ended before it
    /// finished.
    #[error("a shell startup folder's or nonce file's write ended before it finished")]
    Interrupted(#[source] JoinError),
}

/// The folders every shell's start reads from.
#[derive(Clone, Debug)]
pub(crate) struct ShellStartupFolders {
    /// The folder the scripts are written in, which only this account may open.
    pub(crate) startup_folder: PathBuf,
    /// The folder each shell's nonce file is written in, which only this account may open.
    pub(crate) nonce_folder: PathBuf,
}

/// The nonce a shell's marks carry and the file the shell reads it from.
#[derive(Clone, Debug)]
pub(crate) struct ShellMarkNonce {
    /// The nonce.
    pub(crate) nonce: String,
    /// The file in the nonce folder; [`discard_mark_nonce_file`] removes it.
    pub(crate) nonce_file: PathBuf,
}

/// How one shell is started so its script loads beside the person's own startup files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ShellLaunch {
    /// The program started: the shell, or for a bash the one the operating system starts it by.
    pub(crate) program: String,
    /// The login shell's arguments, plus what loads the script.
    pub(crate) arguments: Vec<String>,
    /// The input environment with this launch's pairs laid over it, a pair replacing its name.
    pub(crate) environment: Vec<(String, String)>,
}

/// Prepares the folders every shell's start reads from, inside `startup_folder`: an empty nonce
/// folder only this account may open, so no nonce file an earlier start left behind outlives this
/// start. Fails with [`ShellStartupError::Folder`] when a folder cannot be cleared or made.
#[expect(
    dead_code,
    reason = "the daemon's start prepares the shells' startup folders in its run folder"
)]
pub(crate) fn prepare_shell_startup_folders(
    startup_folder: &Path,
) -> Result<ShellStartupFolders, ShellStartupError> {
    let nonce_folder = startup_folder.join(NONCE_FOLDER_NAME);
    remove_tree(&nonce_folder).map_err(ShellStartupError::Folder)?;
    create_private_folder(&nonce_folder).map_err(ShellStartupError::Folder)?;
    Ok(ShellStartupFolders {
        startup_folder: startup_folder.to_path_buf(),
        nonce_folder,
    })
}

/// Mints a shell's mark nonce and writes it to a new file of its own in the nonce folder, readable
/// by this account alone; both of an open's launches read the one file. Fails when the system
/// gives no random bytes or the file cannot be made.
pub(crate) async fn mint_mark_nonce(
    folders: &ShellStartupFolders,
) -> Result<ShellMarkNonce, ShellStartupError> {
    let nonce = random_hex(NONCE_BYTE_COUNT).map_err(ShellStartupError::Nonce)?;
    // A random name, so no file another start wrote is opened; the make refuses one that exists.
    let file_name = random_hex(NONCE_BYTE_COUNT).map_err(ShellStartupError::Nonce)?;
    let nonce_file = folders.nonce_folder.join(file_name);
    let contents = format!("{nonce}\n");
    let file_path = nonce_file.clone();
    tokio::task::spawn_blocking(move || {
        use std::io::Write as _;
        create_new_file(&file_path, RUN_FOLDER_FILE_MODE)?.write_all(contents.as_bytes())
    })
    .await
    .map_err(ShellStartupError::Interrupted)?
    .map_err(ShellStartupError::NonceFile)?;
    Ok(ShellMarkNonce { nonce, nonce_file })
}

/// Removes a shell's nonce file once the shell has read it or never will; one the script already
/// deleted is no failure. Fails with the removal's other errors.
pub(crate) async fn discard_mark_nonce_file(mark_nonce: &ShellMarkNonce) -> io::Result<()> {
    match tokio::fs::remove_file(&mark_nonce.nonce_file).await {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// The program, arguments and environment that start `shell_path` as a login shell, where the
/// platform has one, with its marks script written into the startup folder and loaded, reading
/// its nonce from `mark_nonce`'s file. A shell is recognized by its program's base name. Fails
/// when a script cannot be written.
pub(crate) async fn prepare_shell_launch(
    shell_path: &str,
    environment: Vec<(String, String)>,
    folders: &ShellStartupFolders,
    mark_nonce: &ShellMarkNonce,
) -> Result<ShellLaunch, ShellStartupError> {
    let rules = PathRules::NATIVE;
    let shell_name = Path::new(shell_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let nonce_pair = (
        SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME.to_owned(),
        mark_nonce.nonce_file.to_string_lossy().into_owned(),
    );
    let (program, arguments, pairs) = match shell_name.as_str() {
        "zsh" => {
            let zsh_folder = prepare_zsh_startup_folder(&folders.startup_folder).await?;
            let person_folder = rules
                .environment_value(&environment, "ZDOTDIR")
                .or_else(|| rules.environment_value(&environment, "HOME"))
                .map(str::to_owned)
                .or_else(|| std::env::home_dir().map(|home| home.to_string_lossy().into_owned()));
            let pairs = person_folder
                .map(|folder| (SHELL_ORIGINAL_ZDOTDIR_ENVIRONMENT_NAME.to_owned(), folder))
                .into_iter()
                .chain([(
                    "ZDOTDIR".to_owned(),
                    zsh_folder.to_string_lossy().into_owned(),
                )])
                .collect();
            (shell_path.to_owned(), vec!["-l".to_owned()], pairs)
        }
        "bash" => {
            let script_path = folders.startup_folder.join(BASH_SCRIPT_FILE_NAME);
            write_script(&script_path, BASH_SCRIPT).await?;
            let script_path = script_path.to_string_lossy();
            let bash = start_bash(&BashStartInput {
                shell_path,
                script_path: &script_path,
                environment: &environment,
            });
            (bash.program, bash.arguments, bash.pairs)
        }
        "fish" => {
            let data_folder = folders.startup_folder.join(FISH_DATA_FOLDER_NAME);
            let script_path = FISH_SCRIPT_PATH
                .iter()
                .fold(data_folder.clone(), |path, part| path.join(part));
            write_script(&script_path, FISH_SCRIPT).await?;
            // The script puts the person's own value back, or erases the variable where none came;
            // the folders fish reads without one stay in reach meanwhile.
            let person_folders = rules.environment_value(&environment, "XDG_DATA_DIRS");
            let data_folders: Vec<String> = match person_folders {
                Some(folders) if !folders.is_empty() => vec![folders.to_owned()],
                _ => XDG_DEFAULT_DATA_FOLDERS
                    .iter()
                    .map(|folder| (*folder).to_owned())
                    .collect(),
            };
            let joined = [data_folder.to_string_lossy().into_owned()]
                .into_iter()
                .chain(data_folders)
                .collect::<Vec<_>>()
                .join(&rules.search_path_separator().to_string());
            let pairs = person_folders
                .map(|folders| {
                    (
                        SHELL_ORIGINAL_XDG_DATA_DIRS_ENVIRONMENT_NAME.to_owned(),
                        folders.to_owned(),
                    )
                })
                .into_iter()
                .chain([("XDG_DATA_DIRS".to_owned(), joined)])
                .collect();
            (shell_path.to_owned(), vec!["-l".to_owned()], pairs)
        }
        _ => {
            let arguments = LOGIN_SHELL_ARGUMENTS
                .iter()
                .map(|argument| (*argument).to_owned())
                .collect();
            return Ok(ShellLaunch {
                program: shell_path.to_owned(),
                arguments,
                environment,
            });
        }
    };
    let pairs: Vec<(String, String)> = [nonce_pair].into_iter().chain(pairs).collect();
    Ok(ShellLaunch {
        program,
        arguments,
        environment: laid_over(environment, pairs, rules),
    })
}

// Writes one script, its folder made private first, unless it already holds the app's contents.
async fn write_script(script_path: &Path, contents: &'static str) -> Result<(), ShellStartupError> {
    if let Some(folder) = script_path.parent() {
        create_startup_folder(folder).await?;
    }
    write_file_atomically_if_changed(script_path, contents.as_bytes(), RUN_FOLDER_FILE_MODE)
        .await?;
    Ok(())
}

/// Makes `folder` and any missing folder above it private to this account, off the runtime's
/// workers. Fails with [`ShellStartupError::Folder`] when a folder cannot be made.
pub(crate) async fn create_startup_folder(folder: &Path) -> Result<(), ShellStartupError> {
    let folder = folder.to_path_buf();
    tokio::task::spawn_blocking(move || create_private_folder(&folder))
        .await
        .map_err(ShellStartupError::Interrupted)?
        .map_err(ShellStartupError::Folder)
}

// `environment` with each pair replacing every pair its name names under the system's matching.
fn laid_over(
    mut environment: Vec<(String, String)>,
    pairs: Vec<(String, String)>,
    rules: PathRules,
) -> Vec<(String, String)> {
    let names: Vec<&str> = pairs.iter().map(|(name, _)| name.as_str()).collect();
    remove_environment_names(&mut environment, &names, rules);
    environment.extend(pairs);
    environment
}
