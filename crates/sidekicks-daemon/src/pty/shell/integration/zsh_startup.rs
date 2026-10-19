//! zsh's startup files, written into a folder inside the daemon's run folder, which only this
//! account may open, for each zsh's `ZDOTDIR` to name. What the system's own startup files write
//! beside them, such as the completion dump a system zshrc's `compinit` saves to `$ZDOTDIR`, then
//! lands in that account's folder and never in the app's own. A copy whose contents differ from
//! the app's is replaced in one rename before each zsh starts, so an update never runs an old
//! file, a cleaner that removed one is undone, and a shell starting meanwhile never reads half of
//! one.

use std::path::{Path, PathBuf};

use sidekicks_platforms::RUN_FOLDER_FILE_MODE;

use crate::file::atomic_write::write_file_atomically_if_changed;
use crate::pty::shell::integration::injection::{ShellStartupError, create_startup_folder};

/// The folder's name in the shell startup folder.
const ZSH_FOLDER_NAME: &str = "zsh";

/// The four files zsh reads from `ZDOTDIR`, in the order it reads them.
const ZSH_STARTUP_FILES: [(&str, &str); 4] = [
    (".zshenv", include_str!("scripts/zsh/.zshenv")),
    (".zprofile", include_str!("scripts/zsh/.zprofile")),
    (".zshrc", include_str!("scripts/zsh/.zshrc")),
    (".zlogin", include_str!("scripts/zsh/.zlogin")),
];

/// Makes `<startup_folder>/zsh` hold this app's zsh startup files, readable by this account alone,
/// and answers its path. Fails when the folder cannot be made or a file written.
pub(crate) async fn prepare_zsh_startup_folder(
    startup_folder: &Path,
) -> Result<PathBuf, ShellStartupError> {
    let folder = startup_folder.join(ZSH_FOLDER_NAME);
    create_startup_folder(&folder).await?;
    for (file_name, contents) in ZSH_STARTUP_FILES {
        write_file_atomically_if_changed(
            &folder.join(file_name),
            contents.as_bytes(),
            RUN_FOLDER_FILE_MODE,
        )
        .await?;
    }
    Ok(folder)
}
