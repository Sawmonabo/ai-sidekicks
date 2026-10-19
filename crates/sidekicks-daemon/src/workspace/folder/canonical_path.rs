//! The one key every folder comparison uses. Folders are compared by their resolved path, because
//! git prints a tree's folder as it was recorded while the daemon's rows keep the path they were
//! given, and on macOS one folder has two spellings (`/var` and `/private/var`); the resolved path
//! is then put in the system's comparable form, which folds case on Windows.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_platforms::PathRules;

use crate::file::real_location::resolve_real_location;

/// The key every folder comparison uses: `folder` resolved, or for a folder that no longer exists
/// its nearest existing parent resolved with the rest kept as written, or `folder` as given when
/// not even its root exists (a drive unplugged), then each part in the system's comparable form.
/// Two folders are the same folder exactly when their keys are equal. Fails with a resolve's
/// failure other than a part that names nothing (a permission refusal).
pub(crate) async fn canonical_folder_path(folder: &Path) -> io::Result<PathBuf> {
    let resolved = resolve_real_location(folder).await?;
    Ok(PathRules::NATIVE
        .comparable_components(&resolved)
        .into_iter()
        .collect())
}
