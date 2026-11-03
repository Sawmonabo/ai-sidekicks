//! Whether a standalone Codex keeps itself current: its installer writes the build it follows into
//! `auto-update-version` only for an install of the latest release and removes the file for a
//! pinned one.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver's update read, which the provider section's refresh calls"
    )
)]

use std::io;
use std::path::Path;

use sidekicks_std::missing_entry::MissingEntry;

// The standalone install's marker file, under the Codex home.
const AUTO_UPDATE_VERSION_FILE: [&str; 3] = ["packages", "standalone", "auto-update-version"];

/// What the person's standalone Codex install says of its own updates.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexSelfUpdateReading {
    /// The build named in `auto-update-version`, trimmed; `None` where the file is absent, which
    /// leaves a standalone install pinned.
    pub(crate) auto_update_version: Option<String>,
}

/// Reads `auto-update-version` under `codex_home`, the person's own Codex folder. Fails with any
/// read failure but the file's absence.
pub(crate) async fn read_codex_self_update(
    codex_home: &Path,
) -> io::Result<CodexSelfUpdateReading> {
    let file = AUTO_UPDATE_VERSION_FILE
        .iter()
        .fold(codex_home.to_path_buf(), |path, part| path.join(part));
    let text = tokio::fs::read_to_string(&file).await.none_if_missing()?;
    Ok(CodexSelfUpdateReading {
        auto_update_version: text.map(|text| text.trim().to_owned()),
    })
}

#[cfg(test)]
mod tests;
