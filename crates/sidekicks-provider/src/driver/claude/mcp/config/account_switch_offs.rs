//! The servers an account's own Claude Code config switches off at each attached root, read from
//! the config file a session's process on that account reads, beside the person's own.

use std::path::Path;

use super::{
    ClaudeMcpConfigReading, ClaudePersonConfigFile, Tolerated, read_json_file, read_names,
};
use crate::driver::claude::session::settings_file::ClaudeSettingsReadError;

/// Adds to each root of `reading` the names Claude Code's own per-project switch turns off there
/// in the config file at `person_config`, the one a session's process reads from its account's
/// config folder, each name once, looked up by the root's project key; a root whose key could not
/// be worked out gets none. A file that is absent, not the daemon's to read or not JSON of the
/// expected shape adds none; fails with the path and the system's error on any other read failure.
pub(crate) async fn add_claude_switch_offs(
    reading: &mut ClaudeMcpConfigReading,
    person_config: &Path,
) -> Result<(), ClaudeSettingsReadError> {
    let Some(config) = read_json_file::<ClaudePersonConfigFile>(person_config).await? else {
        return Ok(());
    };
    let Some(projects) = config.projects.read() else {
        return Ok(());
    };
    for root in &mut reading.roots {
        let Some(project_key) = root.project_key.as_deref() else {
            continue;
        };
        let switched_off = projects
            .get(project_key)
            .and_then(Tolerated::read)
            .map(|entry| read_names(&entry.disabled_mcp_servers))
            .unwrap_or_default();
        for name in switched_off {
            if !root.switched_off_server_names.contains(&name) {
                root.switched_off_server_names.push(name);
            }
        }
    }
    Ok(())
}
